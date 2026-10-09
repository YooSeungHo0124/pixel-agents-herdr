/**
 * Painting: a static background per room (floor, wall, furniture, label
 * plates) and the per-frame layer on top (empty desks, actors, bubbles).
 */
import type { Actor, Bubble } from './actors.ts';
import type { Plan, Room } from './layout.ts';
import { BASE } from './layout.ts';
import { Img, opaqueBounds, type Rgb } from './raster.ts';
import type { CharacterSheet } from './sheet.ts';
import { strWidth } from './text.ts';

const C = {
  outline: 0x2a2233,
  wall: 0xeee3cc,
  wallShade: 0xd8c7a6,
  wainscot: 0xc4a77c,
  baseboard: 0x6b4f3a,
  windowFrame: 0xfafafa,
  sky: 0x9fd3f0,
  skyLight: 0xc9e8f8,
  desk: 0x9a6a45,
  deskTop: 0x6e472d,
  deskLeg: 0x5a3a24,
  plate: 0x2b2438,
  plateEdge: 0xe0b24a,
  chair: 0x3f5f9a,
  chairDark: 0x2c4473,
  laptop: 0x9aa3b2,
  laptopDark: 0x6b7385,
  rug: 0xb5534a,
  rugEdge: 0xe8c07a,
  leaf: 0x3f9a4a,
  leafDark: 0x2c7236,
  pot: 0xb86a3c,
  cooler: 0x7cc4f0,
  coolerBase: 0xe6e6e6,
  alert: 0xffb02e,
  bubble: 0xffffff,
  bubbleAlt: 0xffe066,
  red: 0xe0362c,
  green: 0x2fa84f,
  grey: 0x8a8a99,
  marker: 0xffd23f,
} as const;

const FLOORS: [Rgb, Rgb][] = [
  [0xc9925e, 0xa8774a],
  [0xb98a62, 0x96694a],
  [0xd2a274, 0xae8158],
  [0xa9b6c4, 0x8794a3],
  [0xc4b08a, 0xa2906c],
];

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Text the terminal draws over a room (room-local cells). */
export interface RoomText {
  row: number;
  col: number;
  text: string;
  fg: Rgb;
  bold?: boolean;
}

export function roomLabel(room: Room, actors: Actor[]): { text: string; alert: number } {
  const mine = actors.filter((a) => a.roomId === room.ws.id && !a.leaving);
  return {
    text: ` ${room.ws.label} · ${mine.length} `,
    alert: mine.filter((a) => a.status === 'blocked').length,
  };
}

export function roomTexts(room: Room, actors: Actor[], titles: Map<string, string>): RoomText[] {
  const out: RoomText[] = [];
  const label = roomLabel(room, actors);
  out.push({ row: 1, col: 2, text: label.text, fg: 0xffe9b0, bold: true });
  if (label.alert) {
    out.push({
      row: 1,
      col: 2 + strWidth(label.text) + 1,
      text: ` ! ${label.alert} `,
      fg: 0xff6b5e,
      bold: true,
    });
  }
  for (const s of room.slots) {
    const t = titles.get(s.paneId);
    if (!t) continue;
    out.push({ row: s.titleRow, col: s.titleCol, text: t, fg: 0xf2ecff });
  }
  return out;
}

/** Room background: everything that only changes when the plan changes. */
export function paintBackground(room: Room, plan: Plan, actors: Actor[]): Img {
  const s = plan.scale;
  const { w: cw, h: ch } = plan.cell;
  const img = new Img(room.pxW, room.pxH);
  const P = Math.max(1, Math.round(4 * s)); // one "art pixel"
  const wallH = Math.round(room.wallH * s);
  const [plank, seam] = FLOORS[hash(room.ws.id) % FLOORS.length];

  // Floor planks.
  img.rect(0, wallH, room.pxW, room.pxH - wallH, plank);
  const plankH = Math.max(3, Math.round(32 * s));
  for (let y = wallH, i = 0; y < room.pxH; y += plankH, i++) {
    img.rect(0, y, room.pxW, P, seam);
    const off = (i % 2) * Math.round(56 * s);
    for (let x = off; x < room.pxW; x += Math.max(6, Math.round(112 * s)))
      img.rect(x, y, P, plankH, seam);
  }

  // Wall with wainscot and baseboard.
  img.rect(0, 0, room.pxW, wallH, C.wall);
  img.rect(0, 0, room.pxW, 2 * P, C.wallShade);
  img.rect(0, Math.round(wallH * 0.62), room.pxW, wallH - Math.round(wallH * 0.62), C.wainscot);
  img.rect(0, Math.round(wallH * 0.62), room.pxW, P, C.baseboard);
  img.rect(0, wallH - 2 * P, room.pxW, 2 * P, C.baseboard);

  // Windows on the wall, right of the name plate.
  const labelW = (strWidth(roomLabel(room, actors).text) + 8) * cw;
  const winW = Math.round(84 * s);
  const winH = Math.round(44 * s);
  for (let x = room.pxW - Math.round(BASE.pad * s) - winW; x > labelW; x -= Math.round(200 * s)) {
    const y = Math.round(10 * s);
    img.rect(x - P, y - P, winW + 2 * P, winH + 2 * P, C.windowFrame);
    img.rect(x, y, winW, winH, C.sky);
    img.rect(x + P, y + P, Math.round(winW * 0.35), Math.round(winH * 0.3), C.skyLight);
    img.rect(x + Math.floor(winW / 2) - Math.floor(P / 2), y, P, winH, C.windowFrame);
    img.rect(x, y + Math.floor(winH / 2), winW, P, C.windowFrame);
  }

  // Rug in the lounge.
  const lg = room.lounge;
  const rugX = Math.round((lg.x0 + 30) * s);
  const rugY = Math.round((lg.y0 - 30) * s);
  const rugW = Math.round(Math.max(120, (lg.x1 - lg.x0) * 0.55) * s);
  const rugH = Math.round((lg.y1 - lg.y0 + 20) * s);
  img.rect(rugX, rugY, rugW, rugH, C.rugEdge);
  img.rect(rugX + P, rugY + P, rugW - 2 * P, rugH - 2 * P, C.rug);
  img.rect(rugX + 3 * P, rugY + 3 * P, rugW - 6 * P, rugH - 6 * P, 0xc66a5c);

  // Plant and water cooler.
  // Props scale with the room (4·s px per art pixel), not the 1 px minimum line.
  paintPlant(img, room.plant.x * s, room.plant.y * s, 4 * s);
  paintCooler(img, room.cooler.x * s, room.cooler.y * s, 4 * s);

  // Desk fronts + title plates.
  for (const slot of room.slots) {
    const dw = Math.round(132 * s);
    const x = Math.round(slot.cx * s - dw / 2);
    const y = Math.round((slot.seatY - 4) * s);
    const h = Math.round((BASE.panelH + 4) * s);
    img.rect(x, y, dw, h, C.desk);
    img.rect(x, y, dw, 2 * P, C.deskTop);
    img.rect(x + P, y + h - P, dw - 2 * P, P, C.deskLeg);
    img.rect(x + 3 * P, y + 4 * P, dw - 6 * P, P, C.deskTop);
    const px = slot.titleCol * cw - Math.floor(cw / 2);
    img.rect(px, slot.titleRow * ch, (slot.titleCols + 1) * cw, ch, C.plate, 0.88);
  }

  // Name plate on the wall.
  const lw = (strWidth(roomLabel(room, actors).text) + 2) * cw;
  img.rect(cw, ch - P, lw + 2 * P, ch + 2 * P, C.plateEdge);
  img.rect(cw + P, ch, lw, ch, C.plate);

  // Outline.
  img.rect(0, 0, room.pxW, P, C.outline);
  img.rect(0, room.pxH - P, room.pxW, P, C.outline);
  img.rect(0, 0, P, room.pxH, C.outline);
  img.rect(room.pxW - P, 0, P, room.pxH, C.outline);
  return img;
}

function paintPlant(img: Img, fx: number, fy: number, P: number): void {
  const potW = 9 * P;
  const potH = 7 * P;
  img.rect(fx - potW / 2, fy - potH, potW, potH, C.pot);
  img.rect(fx - potW / 2 - P, fy - potH, potW + 2 * P, 2 * P, 0x8f4f2a);
  const cy = fy - potH;
  img.ellipse(fx - 9 * P, cy - 14 * P, 10 * P, 12 * P, C.leafDark);
  img.ellipse(fx - P, cy - 16 * P, 10 * P, 14 * P, C.leafDark);
  img.ellipse(fx - 6 * P, cy - 22 * P, 12 * P, 18 * P, C.leaf);
  img.ellipse(fx - 4 * P, cy - 18 * P, 3 * P, 6 * P, 0x6cc46f);
}

function paintCooler(img: Img, fx: number, fy: number, P: number): void {
  img.rect(fx - 5 * P, fy - 12 * P, 10 * P, 12 * P, C.coolerBase);
  img.rect(fx - 5 * P, fy - 12 * P, 10 * P, P, 0xbdbdbd);
  img.rect(fx - P, fy - 9 * P, 2 * P, P, 0x4a90d9);
  img.ellipse(fx - 4 * P, fy - 22 * P, 8 * P, 11 * P, C.cooler);
  img.rect(fx - 2 * P, fy - 20 * P, P, 4 * P, 0xd6f0ff);
}

/** An empty desk: chair back behind the desk edge and a closed-ish laptop. */
function paintEmptyDesk(img: Img, cx: number, seatY: number, P: number, s: number): void {
  const chW = Math.round(56 * s);
  img.rect(cx - chW / 2, seatY - Math.round(64 * s), chW, Math.round(60 * s), C.chairDark);
  img.rect(
    cx - chW / 2 + P,
    seatY - Math.round(64 * s) + P,
    chW - 2 * P,
    Math.round(60 * s) - 2 * P,
    C.chair,
  );
  const lw = Math.round(64 * s);
  const lh = Math.round(40 * s);
  img.rect(cx - lw / 2, seatY - lh - P, lw, lh, C.laptopDark);
  img.rect(cx - lw / 2 + P, seatY - lh, lw - 2 * P, lh - 2 * P, C.laptop);
  img.rect(cx - P, seatY - lh / 2 - P, 2 * P, 2 * P, 0xf2f2f2);
}

/** A free lounge chair seen from the front (matches the reading pose's chair). */
function paintChair(img: Img, cx: number, fy: number, P: number, s: number): void {
  const w = Math.round(64 * s);
  img.rect(cx - w / 2, fy - Math.round(70 * s), w, Math.round(46 * s), C.chairDark);
  img.rect(
    cx - w / 2 + P,
    fy - Math.round(70 * s) + P,
    w - 2 * P,
    Math.round(46 * s) - 2 * P,
    C.chair,
  );
  img.rect(cx - w / 2 - P, fy - Math.round(26 * s), w + 2 * P, Math.round(14 * s), C.chairDark);
  img.rect(cx - w / 2 + P, fy - Math.round(12 * s), P * 2, Math.round(12 * s), C.chairDark);
  img.rect(cx + w / 2 - 3 * P, fy - Math.round(12 * s), P * 2, Math.round(12 * s), C.chairDark);
}

const GLYPHS: Record<Exclude<Bubble, null>, string[]> = {
  alert: ['..#..', '..#..', '..#..', '..#..', '..#..', '.....', '..#..'],
  done: ['.....', '....#', '...##', '#.##.', '###..', '.#...', '.....'],
  unknown: ['.###.', '#...#', '....#', '..##.', '..#..', '.....', '..#..'],
};

function paintBubble(
  img: Img,
  cx: number,
  bottom: number,
  kind: Exclude<Bubble, null>,
  s: number,
  t: number,
): void {
  const g = Math.max(1, Math.round(3.2 * s));
  const w = 9 * g;
  const h = 10 * g;
  const x = Math.round(cx - w / 2);
  const y = Math.round(bottom - h - 2 * g);
  const bg = kind === 'alert' && Math.floor(t * 2) % 2 === 0 ? C.bubbleAlt : C.bubble;
  img.rect(x + g, y - g, w - 2 * g, h + 2 * g, C.outline);
  img.rect(x - g, y + g, w + 2 * g, h - 2 * g, C.outline);
  img.rect(x, y, w, h, C.outline);
  img.rect(x + g, y, w - 2 * g, h, bg);
  img.rect(x, y + g, w, h - 2 * g, bg);
  // Tail.
  img.rect(Math.round(cx - g), y + h, 2 * g, g, bg);
  img.rect(Math.round(cx - g), y + h + g, g, g, C.outline);
  img.rect(Math.round(cx + g), y + h, g, g, C.outline);
  const color = kind === 'alert' ? C.red : kind === 'done' ? C.green : C.grey;
  const rows = GLYPHS[kind];
  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < 5; c++) {
      if (rows[r][c] === '#')
        img.rect(x + 2 * g + c * g, y + Math.round(1.5 * g) + r * g, g, g, color);
    }
  }
}

const boundsCache = new WeakMap<Img, { x: number; y: number; w: number; h: number } | null>();

function bounds(img: Img): { x: number; y: number; w: number; h: number } | null {
  if (!boundsCache.has(img)) boundsCache.set(img, opaqueBounds(img));
  return boundsCache.get(img) ?? null;
}

export interface Hit {
  paneId: string;
  /** Room-local image px. */
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Paint one frame of a room on top of its background. Returns the actors'
 * on-screen boxes for mouse hit-testing.
 */
export function paintRoom(
  out: Img,
  bg: Img,
  room: Room,
  plan: Plan,
  actors: Actor[],
  sheetFor: (a: Actor) => CharacterSheet,
  hoverPane: string | null,
  t: number,
): Hit[] {
  const s = plan.scale;
  const P = Math.max(1, Math.round(4 * s));
  out.copyFrom(bg);
  const mine = actors.filter((a) => a.roomId === room.ws.id);
  const seated = new Set(mine.filter((a) => a.isSeated).map((a) => a.paneId));
  const chairsTaken = new Set(mine.map((a) => a.chairIndex).filter((i) => i >= 0));
  for (const slot of room.slots) {
    if (!seated.has(slot.paneId)) paintEmptyDesk(out, slot.cx * s, slot.seatY * s, P, s);
  }
  room.chairs.forEach((c, i) => {
    if (!chairsTaken.has(i)) paintChair(out, c.x * s, c.y * s, P, s);
  });

  if (mine.some((a) => a.status === 'blocked' && !a.leaving) && Math.floor(t * 2) % 2 === 0) {
    const b = 2 * P;
    out.rect(0, 0, room.pxW, b, C.alert);
    out.rect(0, room.pxH - b, room.pxW, b, C.alert);
    out.rect(0, 0, b, room.pxH, C.alert);
    out.rect(room.pxW - b, 0, b, room.pxH, C.alert);
  }

  const hits: Hit[] = [];
  const order = [...mine].sort((a, b) => a.y - b.y);
  for (const a of order) {
    const sheet = sheetFor(a).scaled(s);
    const { img, flip } = sheet.frame(a.dir, a.frameCol());
    const fx = Math.round(a.x * s - img.width / 2);
    const fy = Math.round((a.y + a.hop()) * s - img.height);
    const alpha = a.fade * (a.status === 'unknown' ? 0.6 : 1);
    if (alpha <= 0.02) continue;
    if (hoverPane === a.paneId) {
      const o = Math.max(1, Math.round(2 * s));
      for (const [dx, dy] of [
        [-o, 0],
        [o, 0],
        [0, -o],
        [0, o],
      ]) {
        out.blit(img, fx + dx, fy + dy, { flip, silhouette: 0xffffff, alpha });
      }
    }
    out.blit(img, fx, fy, { flip, alpha });
    const bb = bounds(img);
    const top = bb ? fy + bb.y : fy;
    if (bb) {
      const bx = flip ? img.width - bb.x - bb.w : bb.x;
      hits.push({ paneId: a.paneId, x: fx + bx, y: fy + bb.y, w: bb.w, h: bb.h });
    }
    const bubble = a.bubble();
    if (bubble && a.fade > 0.5) paintBubble(out, a.x * s, top, bubble, s, t);
    if (a.info.focused && !bubble) {
      // Little marker over the agent whose pane is focused in herdr.
      const m = Math.max(1, Math.round(3 * s));
      const cx = Math.round(a.x * s);
      const y = top - 5 * m;
      for (let r = 0; r < 3; r++)
        out.rect(cx - (3 - r) * m, y + r * m, (3 - r) * 2 * m, m, C.marker);
    }
  }
  return hits;
}
