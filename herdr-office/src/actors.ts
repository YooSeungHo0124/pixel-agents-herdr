/**
 * One Actor per herdr agent. herdr's status picks what the character is
 * doing; the actor walks there and plays the matching animation:
 *
 *   working → sits at its desk typing
 *   blocked → stands in front of its desk, hopping, red "!" (needs you)
 *   done    → stands in front of its desk with a green check (unseen result)
 *   idle    → wanders the lounge, sometimes sits down to read
 *   unknown → stands faded with a "?"
 *
 * Positions are base px, room-local, at the character's feet.
 */
import type { AgentInfo, AgentStatus } from './herdr.ts';
import type { Room, Slot } from './layout.ts';
import { FRAME, type Dir } from './sheet.ts';

export type Pose = 'walk' | 'stand' | 'type' | 'read';
export type Bubble = 'alert' | 'done' | 'unknown' | null;

interface Point {
  x: number;
  y: number;
}

const SPEED = 150; // base px / s
const WALK_FRAME_S = 0.13;
const TYPE_FRAME_S = 0.28;
const READ_FRAME_S = 0.9;

/** Deterministic per-actor randomness so wandering differs between agents. */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 100000) / 100000;
  };
}

function hash(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}

export class Actor {
  readonly paneId: string;
  info: AgentInfo;
  roomId: string;
  x = 0;
  y = 0;
  dir: Dir = 'down';
  pose: Pose = 'stand';
  /** 0 → 1 while appearing, 1 → 0 while leaving. */
  fade = 0;
  leaving = false;
  private path: Point[] = [];
  private animT = 0;
  private stateT = 0;
  /** What the actor is settled into once its path is done. */
  private goal: {
    kind: 'seat' | 'stand' | 'wander' | 'chair';
    pose: Pose;
    dir: Dir;
    until?: number;
  } | null = null;
  private seated = false;
  private chair = -1;
  private readonly random: () => number;
  private placed = false;
  private chairTarget = -1;

  constructor(info: AgentInfo) {
    this.paneId = info.paneId;
    this.info = info;
    this.roomId = info.workspaceId;
    this.random = rng(hash(info.paneId));
  }

  get status(): AgentStatus {
    return this.info.status;
  }

  /** The column of the sheet to draw now. */
  frameCol(): number {
    switch (this.pose) {
      case 'walk':
        return FRAME.walk[Math.floor(this.animT / WALK_FRAME_S) % FRAME.walk.length];
      case 'type':
        return FRAME.type[Math.floor(this.animT / TYPE_FRAME_S) % FRAME.type.length];
      case 'read':
        return FRAME.read[Math.floor(this.animT / READ_FRAME_S) % FRAME.read.length];
      default:
        return FRAME.stand;
    }
  }

  bubble(): Bubble {
    if (this.pose === 'walk') return null;
    if (this.status === 'blocked') return 'alert';
    if (this.status === 'done') return 'done';
    if (this.status === 'unknown') return 'unknown';
    return null;
  }

  /** Vertical hop (base px, negative = up) for an agent that needs attention. */
  hop(): number {
    if (this.status !== 'blocked' || this.pose !== 'stand') return 0;
    const t = this.animT % 1.2;
    return t < 0.36 ? -Math.sin((t / 0.36) * Math.PI) * 10 : 0;
  }

  get isSeated(): boolean {
    return this.seated;
  }

  get chairIndex(): number {
    return this.chair;
  }

  /** Advance by dt seconds inside `room`, at desk `slot`. */
  update(dt: number, room: Room, slot: Slot, takenChairs: Set<number>): void {
    this.animT += dt;
    this.stateT += dt;
    if (!this.placed) {
      // Appear in front of the desk (walking in from a door would cross rooms).
      this.x = slot.cx;
      this.y = slot.standY;
      this.placed = true;
      if (this.status === 'working') this.sit(slot);
    }
    if (this.leaving) this.fade = Math.max(0, this.fade - dt * 2.5);
    else this.fade = Math.min(1, this.fade + dt * 2.5);

    this.chooseGoal(room, slot, takenChairs);
    this.walk(dt);
  }

  private sit(slot: Slot): void {
    this.x = slot.cx;
    this.y = slot.seatY;
    this.seated = true;
    this.pose = 'type';
    this.dir = 'down';
    this.path = [];
  }

  private standUp(slot: Slot): void {
    if (!this.seated) return;
    this.seated = false;
    this.x = slot.cx;
    this.y = slot.standY;
    this.pose = 'stand';
  }

  private leaveChair(room: Room): void {
    if (this.chair < 0) return;
    const c = room.chairs[this.chair];
    this.chair = -1;
    if (c) this.y = c.y;
    this.pose = 'stand';
  }

  private route(to: Point, aisleY: number): void {
    const pts: Point[] = [];
    const add = (p: Point): void => {
      const last = pts.length ? pts[pts.length - 1] : { x: this.x, y: this.y };
      if (Math.abs(last.x - p.x) > 0.5 || Math.abs(last.y - p.y) > 0.5) pts.push(p);
    };
    if (Math.abs(this.y - to.y) > 0.5) {
      add({ x: this.x, y: aisleY });
      add({ x: to.x, y: aisleY });
    }
    add(to);
    this.path = pts;
  }

  private chooseGoal(room: Room, slot: Slot, takenChairs: Set<number>): void {
    const s = this.status;
    if (s === 'working') {
      if (this.seated) {
        if (Math.abs(this.x - slot.cx) > 0.5 || Math.abs(this.y - slot.seatY) > 0.5) {
          // Desk moved (agents left): get up and walk to the new one.
          this.seated = false;
          this.y = this.y + (slot.standY - slot.seatY);
        } else return;
      }
      this.leaveChair(room);
      if (this.goal?.kind !== 'seat' || !this.samePath(slot.cx, slot.standY)) {
        this.goal = { kind: 'seat', pose: 'type', dir: 'down' };
        this.route({ x: slot.cx, y: slot.standY }, slot.standY);
      }
      if (!this.path.length) this.sit(slot);
      return;
    }
    this.standUp(slot);
    if (s === 'blocked' || s === 'done' || s === 'unknown') {
      this.leaveChair(room);
      if (this.goal?.kind !== 'stand' || !this.samePath(slot.cx, slot.standY)) {
        this.goal = { kind: 'stand', pose: 'stand', dir: 'down' };
        this.route({ x: slot.cx, y: slot.standY }, slot.standY);
      }
      if (!this.path.length) {
        this.pose = 'stand';
        this.dir = 'down';
      }
      return;
    }
    // idle: wander, pause, sometimes read in a free lounge chair.
    if (this.path.length) return;
    if (this.goal?.until !== undefined && this.stateT < this.goal.until) {
      if (this.goal.kind === 'chair') {
        this.pose = 'read';
        this.dir = 'down';
      } else {
        this.pose = 'stand';
        if (this.random() < 0.01) this.dir = this.random() < 0.5 ? 'left' : 'right';
      }
      return;
    }
    if (this.goal?.kind === 'wander' && this.goal.until === undefined) {
      // Arrived somewhere: pause a little.
      this.goal = { kind: 'wander', pose: 'stand', dir: this.dir, until: 2 + this.random() * 4 };
      this.stateT = 0;
      this.pose = 'stand';
      return;
    }
    if (this.goal?.kind === 'chair' && this.chair < 0 && this.goal.until === undefined) {
      // Walked to a chair: sit if still free.
      const idx = this.chairTarget;
      if (idx >= 0 && !takenChairs.has(idx)) {
        this.chair = idx;
        takenChairs.add(idx);
        this.goal = { kind: 'chair', pose: 'read', dir: 'down', until: 8 + this.random() * 10 };
        this.stateT = 0;
        this.pose = 'read';
        this.dir = 'down';
        return;
      }
    }
    this.leaveChair(room);
    const free = room.chairs.map((_, i) => i).filter((i) => !takenChairs.has(i));
    const aisleY = (room.lounge.y0 + room.lounge.y1) / 2;
    if (free.length && this.random() < 0.3) {
      const idx = free[Math.floor(this.random() * free.length)];
      this.chairTarget = idx;
      const c = room.chairs[idx];
      this.goal = { kind: 'chair', pose: 'read', dir: 'down' };
      this.route({ x: c.x, y: c.y }, aisleY);
    } else {
      const { x0, x1, y0, y1 } = room.lounge;
      const to = { x: x0 + this.random() * (x1 - x0), y: y0 + this.random() * (y1 - y0) };
      this.goal = { kind: 'wander', pose: 'stand', dir: this.dir };
      // Leaving the desk area goes through the aisle first.
      this.route(to, this.y < room.lounge.y0 ? slot.standY : to.y);
    }
  }

  private samePath(x: number, y: number): boolean {
    const end = this.path.length ? this.path[this.path.length - 1] : { x: this.x, y: this.y };
    return Math.abs(end.x - x) < 0.5 && Math.abs(end.y - y) < 0.5;
  }

  private walk(dt: number): void {
    if (!this.path.length) {
      if (this.pose === 'walk') this.pose = 'stand';
      return;
    }
    let budget = SPEED * dt;
    while (budget > 0 && this.path.length) {
      const p = this.path[0];
      const dx = p.x - this.x;
      const dy = p.y - this.y;
      const dist = Math.hypot(dx, dy);
      if (dist > 0.01) {
        this.dir =
          Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up';
      }
      if (dist <= budget) {
        this.x = p.x;
        this.y = p.y;
        budget -= dist;
        this.path.shift();
      } else {
        this.x += (dx / dist) * budget;
        this.y += (dy / dist) * budget;
        budget = 0;
      }
    }
    this.pose = this.path.length ? 'walk' : 'stand';
  }

  /** Re-home into another workspace's room (pane moved): reappear there. */
  moveTo(roomId: string): void {
    this.roomId = roomId;
    this.placed = false;
    this.seated = false;
    this.chair = -1;
    this.path = [];
    this.goal = null;
    this.fade = 0;
  }
}
