/**
 * The office TUI: polls herdr, moves the actors, paints one kitty image per
 * room and overlays labels as terminal text.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { Actor } from './actors.ts';
import { type Graphics, HerdrGraphics, KittyGraphics } from './graphics.ts';
import type { AgentInfo, Snapshot, Source } from './herdr.ts';
import {
  type Cell,
  plan as makePlan,
  type Plan,
  type Room,
  SCALES,
  updateSeats,
} from './layout.ts';
import { encodePng } from './png.ts';
import { Img } from './raster.ts';
import { type Hit, paintBackground, paintRoom, roomLabel, roomTexts } from './scene.ts';
import { type CharacterSheet, loadCharacterDir } from './sheet.ts';
import { enterScreen, leaveScreen, parseInput, sizeQueries, textAt, ESC } from './term.ts';
import { sanitize, strWidth, truncate } from './text.ts';

export interface AppOptions {
  source: Source;
  characterDirs: string[];
  log: (msg: string) => void;
  cell?: Cell;
  scale?: number;
  allWorkspaces?: boolean;
  /** Debug: write the composed office to this PNG every few seconds. */
  frameFile?: string;
  /** The herdr session + pane hosting this TUI (for pane.graphics). */
  host?: { socket: string; paneId: string };
  onExit: () => void;
}

const FRAME_MS = Number(process.env.HERDR_OFFICE_FRAME_MS) || 100;
const POLL_MS = 1000;
const DEFAULT_CELL: Cell = { w: 10, h: 20 };

interface Shown {
  key: string;
}

interface Text {
  row: number;
  col: number;
  text: string;
  fg?: number;
  bold?: boolean;
}

export class OfficeApp {
  private readonly opts: AppOptions;
  private readonly out = process.stdout;
  private sheets = new Map<string, CharacterSheet>();
  private cast: Record<string, string> = {};
  private snapshot: Snapshot = { workspaces: [], agents: [] };
  private actors = new Map<string, Actor>();
  private seats = new Map<string, string[]>();
  private plan: Plan | null = null;
  private planKey = '';
  private cell: Cell;
  private cellKnown = false;
  private viewCols = 80;
  private viewRows = 24;
  private scroll = 0;
  private forcedScale: number | undefined;
  private bgCache = new Map<string, { key: string; img: Img }>();
  private frames = new Map<string, Img>();
  private shown = new Map<string, Shown>();
  private hits = new Map<string, Hit[]>();
  private textsShown: Text[] = [];
  private hover: string | null = null;
  private selected = -1;
  private message = '';
  private messageUntil = 0;
  private error = '';
  private lastTick = Date.now();
  private t = 0;
  private timers: NodeJS.Timeout[] = [];
  private polling = false;
  private stopped = false;
  private graphics: Graphics = new KittyGraphics((s) => this.out.write(s));
  private lastFrameDump = 0;

  constructor(opts: AppOptions) {
    this.opts = opts;
    this.cell = opts.cell ?? DEFAULT_CELL;
    this.cellKnown = !!opts.cell;
    this.forcedScale = opts.scale;
  }

  async start(): Promise<void> {
    this.loadCharacters();
    if (!this.sheets.size) throw new Error('no character sheets found');
    this.viewCols = this.out.columns || 80;
    this.viewRows = (this.out.rows || 24) - 1;
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (d: string) => this.onInput(d));
    process.stdin.resume();
    this.out.on('resize', () => this.onResize());
    await this.probeHost();
    this.out.write(enterScreen + (this.cellKnown ? '' : sizeQueries));
    this.graphics.clearAll();
    if (!this.cellKnown) await new Promise((r) => setTimeout(r, 400));
    this.opts.log(
      `graphics: ${this.graphics instanceof HerdrGraphics ? 'herdr pane.graphics' : 'kitty escapes'}`,
    );
    this.opts.log(
      `cell ${this.cell.w}x${this.cell.h} (${this.cellKnown ? 'reported' : 'assumed'}), view ${this.viewCols}x${this.viewRows}`,
    );
    await this.poll();
    this.timers.push(setInterval(() => void this.poll(), POLL_MS));
    this.timers.push(setInterval(() => this.frame(), FRAME_MS));
    // herdr knows the pane's cell size only while a client shows it; keep
    // asking so a hidden-at-start office (or a font zoom) picks it up.
    if (this.opts.host) this.timers.push(setInterval(() => void this.probeHost(), 3000));
  }

  private probing = false;
  private probeLogged = false;

  private async probeHost(): Promise<void> {
    const host = this.opts.host;
    if (!host || this.probing) return;
    this.probing = true;
    try {
      const quiet = this.probeLogged || this.graphics instanceof HerdrGraphics;
      this.probeLogged = true;
      const probed = await HerdrGraphics.probe(
        host.socket,
        host.paneId,
        quiet ? () => undefined : this.opts.log,
      );
      if (!probed) return;
      const switching = !(this.graphics instanceof HerdrGraphics);
      if (switching) {
        this.graphics.clearAll();
        this.graphics = probed.graphics;
        this.opts.log('graphics: herdr pane.graphics');
      }
      const cellChanged =
        !this.opts.cell && (probed.cell.w !== this.cell.w || probed.cell.h !== this.cell.h);
      if (cellChanged) {
        this.cell = probed.cell;
        this.cellKnown = true;
      }
      if ((switching || cellChanged) && this.plan) this.relayoutIfNeeded(true);
    } finally {
      this.probing = false;
    }
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.graphics.clearAll();
    this.out.write(leaveScreen);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
  }

  // ── characters ──────────────────────────────────────────────

  private loadCharacters(): void {
    for (const dir of this.opts.characterDirs) {
      const found = loadCharacterDir(dir, this.opts.log);
      if (!found.size) continue;
      this.sheets = found;
      try {
        this.cast = JSON.parse(fs.readFileSync(path.join(dir, 'cast.json'), 'utf-8'));
      } catch {
        this.cast = {};
      }
      this.opts.log(`characters from ${dir}: ${[...found.keys()].join(', ')}`);
      return;
    }
  }

  /** cast.json maps an agent kind (or pane id) to a sheet; else a stable pick per pane. */
  private sheetFor = (a: Actor): CharacterSheet => {
    const named = this.cast[a.paneId] ?? this.cast[a.info.kind] ?? this.cast.default;
    if (named && this.sheets.has(named)) return this.sheets.get(named)!;
    const list = [...this.sheets.values()];
    let h = 0;
    for (const ch of a.paneId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return list[h % list.length];
  };

  // ── herdr ───────────────────────────────────────────────────

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const snap = await this.opts.source.poll();
      for (const a of snap.agents) a.title = sanitize(a.title);
      for (const w of snap.workspaces) w.label = sanitize(w.label);
      this.snapshot = snap;
      this.error = '';
      this.syncActors(snap.agents);
    } catch (err) {
      this.error = `herdr 연결 실패: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      this.polling = false;
    }
  }

  private syncActors(agents: AgentInfo[]): void {
    const live = new Set(agents.map((a) => a.paneId));
    for (const info of agents) {
      const actor = this.actors.get(info.paneId);
      if (!actor) {
        this.actors.set(info.paneId, new Actor(info));
        continue;
      }
      if (actor.roomId !== info.workspaceId) actor.moveTo(info.workspaceId);
      actor.info = info;
      actor.leaving = false;
    }
    for (const [id, actor] of this.actors) if (!live.has(id)) actor.leaving = true;
    this.seats = updateSeats(this.seats, agents);
    this.relayoutIfNeeded();
  }

  private visibleWorkspaces(): Snapshot['workspaces'] {
    if (this.opts.allWorkspaces) return this.snapshot.workspaces;
    return this.snapshot.workspaces.filter((w) => (this.seats.get(w.id)?.length ?? 0) > 0);
  }

  private relayoutIfNeeded(force = false): void {
    const ws = this.visibleWorkspaces();
    const key = JSON.stringify([
      ws.map((w) => [w.id, w.label, this.seats.get(w.id) ?? []]),
      this.viewCols,
      this.viewRows,
      this.cell,
      this.forcedScale,
    ]);
    if (!force && key === this.planKey) return;
    this.planKey = key;
    this.plan = makePlan(ws, this.seats, this.viewCols, this.viewRows, this.cell, this.forcedScale);
    this.scroll = Math.max(0, Math.min(this.scroll, this.plan.totalRows - this.viewRows));
    this.bgCache.clear();
    this.frames.clear();
    this.hits.clear();
    // Old placements may sit where the new layout has nothing.
    this.graphics.clearAll();
    this.out.write(`${ESC}[2J`);
    this.shown.clear();
    this.textsShown = [];
    this.opts.log(
      `layout: scale ${this.plan.scale}, ${this.plan.rooms.length} rooms, ${this.plan.totalRows} rows`,
    );
  }

  // ── frame ───────────────────────────────────────────────────

  private frame(): void {
    const now = Date.now();
    const dt = Math.min(0.25, (now - this.lastTick) / 1000);
    this.lastTick = now;
    this.t += dt;
    const plan = this.plan;
    if (!plan) return;

    const rooms = new Map(plan.rooms.map((r) => [r.ws.id, r]));
    for (const [id, actor] of this.actors) {
      const room = rooms.get(actor.roomId);
      const slot = room?.slots.find((s) => s.paneId === id);
      if (actor.leaving) {
        actor.fade = Math.max(0, actor.fade - dt * 2.5);
        if (actor.fade <= 0 || !room) this.actors.delete(id);
        continue;
      }
      if (!room || !slot) continue;
      const taken = new Set(
        [...this.actors.values()]
          .filter((o) => o !== actor && o.roomId === actor.roomId)
          .map((o) => o.chairIndex)
          .filter((i) => i >= 0),
      );
      actor.update(dt, room, slot, taken);
    }

    let out = '';
    const actors = [...this.actors.values()];
    for (const room of plan.rooms.slice(0, this.graphics.maxLayers))
      out += this.drawRoom(room, plan, actors);
    out += this.drawTexts(plan, actors);
    if (out) this.out.write(out);
    if (this.opts.frameFile && now - this.lastFrameDump > 2000) {
      this.lastFrameDump = now;
      this.dumpFrame(plan);
    }
  }

  private drawRoom(room: Room, plan: Plan, actors: Actor[]): string {
    const id = room.ws.id;
    const label = roomLabel(room, actors).text;
    let bg = this.bgCache.get(id);
    if (!bg || bg.key !== label) {
      bg = { key: label, img: paintBackground(room, plan, actors) };
      this.bgCache.set(id, bg);
    }
    let buf = this.frames.get(id);
    if (!buf) {
      buf = new Img(room.pxW, room.pxH);
      this.frames.set(id, buf);
    }
    this.hits.set(
      id,
      paintRoom(buf, bg.img, room, plan, actors, this.sheetFor, this.hover, this.t),
    );

    // Visible rows of this room after scrolling.
    const top = room.row - this.scroll;
    const r0 = Math.max(0, -top);
    const r1 = Math.min(room.rows, this.viewRows - top);
    const prev = this.shown.get(id);
    const layer = `room-${id.replace(/[^A-Za-z0-9_-]/g, '_')}`;
    if (r1 <= r0) {
      if (prev) {
        this.shown.delete(id);
        this.graphics.clear(layer);
      }
      return '';
    }
    const digest = crypto.createHash('sha1').update(buf.data).digest('hex');
    const key = `${digest}:${top}:${r0}:${r1}`;
    if (prev?.key === key) return '';
    const img =
      r0 === 0 && r1 === room.rows
        ? buf
        : buf.crop(0, r0 * plan.cell.h, room.pxW, (r1 - r0) * plan.cell.h);
    this.graphics.show(layer, encodePng(img), img.width, img.height, {
      col: room.col,
      row: top + r0,
      cols: room.cols,
      rows: r1 - r0,
    });
    this.shown.set(id, { key });
    return '';
  }

  private titleFor(paneId: string): string {
    const a = this.actors.get(paneId);
    return a ? a.info.title : '';
  }

  private drawTexts(plan: Plan, actors: Actor[]): string {
    const texts: Text[] = [];
    for (const room of plan.rooms) {
      const titles = new Map<string, string>();
      for (const slot of room.slots)
        titles.set(slot.paneId, truncate(this.titleFor(slot.paneId), slot.titleCols));
      for (const t of roomTexts(room, actors, titles)) {
        const row = room.row + t.row - this.scroll;
        if (row < 0 || row >= this.viewRows) continue;
        const col = room.col + t.col;
        const text = truncate(t.text, Math.max(0, this.viewCols - col));
        texts.push({ row, col, text, fg: t.fg, bold: t.bold });
      }
    }
    texts.push(this.statusLine(actors));
    const same =
      texts.length === this.textsShown.length &&
      texts.every((t, i) => {
        const p = this.textsShown[i];
        return p.row === t.row && p.col === t.col && p.text === t.text && p.fg === t.fg;
      });
    if (same) return '';
    let out = '';
    for (const p of this.textsShown) out += textAt(p.row, p.col, ' '.repeat(strWidth(p.text)));
    for (const t of texts) out += textAt(t.row, t.col, t.text, t.fg, t.bold);
    this.textsShown = texts;
    return out;
  }

  private statusLine(actors: Actor[]): Text {
    const live = actors.filter((a) => !a.leaving);
    const count = (s: string): number => live.filter((a) => a.status === s).length;
    let text = ` herdr office · 작업 ${count('working')} · 확인필요 ${count('blocked')} · 완료 ${count('done')} · 대기 ${count('idle')} `;
    const now = Date.now();
    const hovered = this.hover ? this.actors.get(this.hover) : undefined;
    if (this.error) text += `· ${this.error}`;
    else if (now < this.messageUntil) text += `· ${this.message}`;
    else if (hovered) {
      const ws =
        this.snapshot.workspaces.find((w) => w.id === hovered.roomId)?.label ?? hovered.roomId;
      text += `· ${ws} / ${hovered.paneId} · ${hovered.info.kind} · ${STATUS_KO[hovered.status]} · ${hovered.info.title} (클릭: 이동)`;
    } else text += '· 클릭: pane 이동 · 휠: 스크롤 · +/-: 크기 · q: 종료';
    text = truncate(text, this.viewCols - 1);
    return {
      row: this.viewRows,
      col: 0,
      text: text + ' '.repeat(Math.max(0, this.viewCols - 1 - strWidth(text))),
      fg: 0xd8d0f0,
    };
  }

  private dumpFrame(plan: Plan): void {
    const W = this.viewCols * plan.cell.w;
    const H = Math.max(plan.totalRows, 1) * plan.cell.h;
    const full = new Img(W, H);
    full.rect(0, 0, W, H, 0x1e1e2e);
    for (const room of plan.rooms) {
      const buf = this.frames.get(room.ws.id);
      if (buf) full.blit(buf, room.col * plan.cell.w, room.row * plan.cell.h);
    }
    try {
      fs.writeFileSync(this.opts.frameFile!, encodePng(full));
    } catch {
      // debug only
    }
  }

  // ── input ───────────────────────────────────────────────────

  private onResize(): void {
    this.viewCols = this.out.columns || this.viewCols;
    this.viewRows = (this.out.rows || this.viewRows + 1) - 1;
    this.relayoutIfNeeded(true);
  }

  private flash(msg: string): void {
    this.message = msg;
    this.messageUntil = Date.now() + 3000;
  }

  private hitAt(col: number, row: number): { room: Room; paneId: string | null } | null {
    const plan = this.plan;
    if (!plan) return null;
    for (const room of plan.rooms) {
      const r = row + this.scroll - room.row;
      const c = col - room.col;
      if (r < 0 || c < 0 || r >= room.rows || c >= room.cols) continue;
      const px = (c + 0.5) * plan.cell.w;
      const py = (r + 0.5) * plan.cell.h;
      const hits = this.hits.get(room.ws.id) ?? [];
      let found: string | null = null;
      for (const h of hits) {
        if (px >= h.x && px < h.x + h.w && py >= h.y && py < h.y + h.h) found = h.paneId;
      }
      if (!found) {
        // Clicking a desk or its title also counts as that agent.
        for (const s of room.slots) {
          const x0 = (s.cx - 70) * plan.scale;
          const x1 = (s.cx + 70) * plan.scale;
          const y0 = (s.seatY - 20) * plan.scale;
          if (px >= x0 && px < x1 && py >= y0 && r <= s.titleRow) found = s.paneId;
        }
      }
      return { room, paneId: found };
    }
    return null;
  }

  private focus(paneId: string): void {
    const a = this.actors.get(paneId);
    this.flash(`→ ${paneId} ${a ? a.info.title : ''} 로 이동`);
    this.opts.source
      .focusAgent(paneId)
      .catch((err) => this.flash(`이동 실패: ${err instanceof Error ? err.message : err}`));
  }

  private ordered(): string[] {
    const out: string[] = [];
    for (const room of this.plan?.rooms ?? []) for (const s of room.slots) out.push(s.paneId);
    return out;
  }

  private onInput(data: string): void {
    for (const ev of parseInput(data)) {
      if (ev.type === 'cellSize') {
        if (ev.w > 0 && ev.h > 0) {
          this.cell = { w: ev.w, h: ev.h };
          this.cellKnown = true;
          this.relayoutIfNeeded();
        }
        continue;
      }
      if (ev.type === 'areaSize') {
        if (!this.cellKnown && ev.w > 0 && ev.h > 0) {
          this.cell = {
            w: Math.round(ev.w / (this.out.columns || 80)),
            h: Math.round(ev.h / (this.out.rows || 24)),
          };
          this.cellKnown = true;
          this.relayoutIfNeeded();
        }
        continue;
      }
      if (ev.type === 'mouse') {
        const m = ev.mouse;
        if (m.kind === 'wheelUp' || m.kind === 'wheelDown') {
          const max = Math.max(0, (this.plan?.totalRows ?? 0) - this.viewRows);
          this.scroll = Math.max(0, Math.min(max, this.scroll + (m.kind === 'wheelUp' ? -3 : 3)));
          continue;
        }
        const hit = this.hitAt(m.col, m.row);
        if (m.kind === 'move' || m.kind === 'drag') {
          this.hover = hit?.paneId ?? null;
          continue;
        }
        if (m.kind === 'down' && m.button === 0 && hit) {
          if (hit.paneId) this.focus(hit.paneId);
          else if (m.row + this.scroll - hit.room.row <= 2) {
            this.flash(`→ ${hit.room.ws.label} 워크스페이스로 이동`);
            this.opts.source.focusWorkspace(hit.room.ws.id).catch(() => undefined);
          }
        }
        continue;
      }
      const k = ev.key;
      if ((ev.ctrl && (k === 'c' || k === 'q')) || k === 'q') {
        this.opts.onExit();
        return;
      }
      const list = this.ordered();
      if (k === 'Tab' || k === 'ArrowRight' || k === 'ArrowDown') {
        if (list.length) this.selected = (this.selected + 1) % list.length;
        this.hover = list[this.selected] ?? null;
      } else if (k === 'BackTab' || k === 'ArrowLeft' || k === 'ArrowUp') {
        if (list.length) this.selected = (this.selected - 1 + list.length) % list.length;
        this.hover = list[this.selected] ?? null;
      } else if (k === 'Enter' && this.hover) {
        this.focus(this.hover);
      } else if (k === '+' || k === '=' || k === '-') {
        const cur = this.forcedScale ?? this.plan?.scale ?? 1;
        const i = SCALES.indexOf(cur as (typeof SCALES)[number]);
        const next =
          k === '-' ? SCALES[Math.min(SCALES.length - 1, i + 1)] : SCALES[Math.max(0, i - 1)];
        this.forcedScale = next;
        this.flash(`크기 ${Math.round(next * 100)}%`);
        this.relayoutIfNeeded();
      } else if (k === '0') {
        this.forcedScale = undefined;
        this.flash('크기 자동');
        this.relayoutIfNeeded();
      } else if (k === 'PageDown' || k === 'PageUp') {
        const max = Math.max(0, (this.plan?.totalRows ?? 0) - this.viewRows);
        const step = Math.max(1, this.viewRows - 2) * (k === 'PageDown' ? 1 : -1);
        this.scroll = Math.max(0, Math.min(max, this.scroll + step));
      } else if (k === 'r') {
        this.relayoutIfNeeded(true);
      }
    }
  }
}

const STATUS_KO: Record<string, string> = {
  working: '작업 중',
  blocked: '확인 필요',
  done: '완료(미확인)',
  idle: '대기',
  unknown: '알 수 없음',
};
