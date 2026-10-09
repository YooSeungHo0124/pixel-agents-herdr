/**
 * Stage view for half-block text: no office background, just each agent's
 * character as large as the pane allows, grouped in one box per workspace.
 *
 *   working → typing at the laptop (front)
 *   blocked → standing, hopping, red "!" (needs you)
 *   done    → standing with a green check (result not seen yet)
 *   idle    → reading in a chair, now and then standing up to look around
 *   unknown → standing, faded, "?"
 *
 * Units: terminal cells; a cell holds two stacked pixels (see blocks.ts).
 * Half-block pixels are rarely square, so sprites are stretched sideways by
 * `aspect` (pixel height / pixel width) to keep the drawing's proportions.
 */
import type { BlockText } from './blocks.ts';
import type { AgentInfo, AgentStatus, WorkspaceInfo } from './herdr.ts';
import { Img, opaqueBounds, scaleTo } from './raster.ts';
import { type CharacterSheet, type Dir, FRAME } from './sheet.ts';
import { strWidth, truncate } from './text.ts';

/** Sprite scales relative to the sheet's 128 px frames, largest first. */
export const STAGE_SCALES: readonly number[] = [
  1, 0.875, 0.75, 0.625, 0.5625, 0.5, 0.46875, 0.4375, 0.40625, 0.375, 0.34375, 0.3125, 0.28125,
  0.25, 0.21875, 0.1875, 0.15625, 0.125,
];

const MIN_CARD_TEXT = 14;
const CARD_GAP = 2;

export interface StageCard {
  paneId: string;
  /** Top-left cell (absolute, before scrolling) and size in cells. */
  col: number;
  row: number;
  cols: number;
  rows: number;
}

export interface StageSection {
  ws: WorkspaceInfo;
  col: number;
  row: number;
  cols: number;
  rows: number;
  cards: StageCard[];
}

export interface StagePlan {
  scale: number;
  /** Sprite size in pixels (1 px wide, 2 px per cell tall). */
  spriteW: number;
  spriteH: number;
  sections: StageSection[];
  totalRows: number;
}

/** Sprite size (pixels) at a scale, for laying out before any frame is drawn. */
export type SpriteSize = (scale: number) => { w: number; h: number };

function planAt(
  workspaces: WorkspaceInfo[],
  seats: Map<string, string[]>,
  viewCols: number,
  size: { w: number; h: number },
  scale: number,
): StagePlan {
  const spriteRows = Math.ceil(size.h / 2);
  const cardCols = Math.max(size.w, MIN_CARD_TEXT) + CARD_GAP;
  // One row of headroom for the hop and the badge, one for the title.
  const cardRows = spriteRows + 2;
  const perLine = Math.max(1, Math.floor((viewCols - 4) / cardCols));
  // First-fit shelves: a section goes on the first shelf with room left, so
  // small workspaces fill the gaps next to big ones.
  const shelves: { x: number; h: number; items: Omit<StageSection, 'row' | 'cards'>[] }[] = [];
  const meta = new Map<string, { panes: string[]; across: number }>();
  for (const ws of workspaces) {
    const panes = seats.get(ws.id) ?? [];
    const n = Math.max(1, panes.length);
    const across = Math.min(n, perLine);
    const lines = Math.ceil(n / across);
    const label = strWidth(ws.label) + 8;
    const cols = Math.min(viewCols, Math.max(across * cardCols + 2, label));
    const rows = lines * cardRows + 2;
    meta.set(ws.id, { panes, across });
    let shelf = shelves.find((sh) => sh.x + cols <= viewCols);
    if (!shelf) {
      shelf = { x: 0, h: 0, items: [] };
      shelves.push(shelf);
    }
    shelf.items.push({ ws, col: shelf.x, cols, rows });
    shelf.x += cols + 1;
    shelf.h = Math.max(shelf.h, rows);
  }
  const sections: StageSection[] = [];
  let y = 0;
  for (const shelf of shelves) {
    for (const it of shelf.items) {
      const { panes, across } = meta.get(it.ws.id)!;
      const inner = it.cols - 2;
      const left = it.col + 1 + Math.floor((inner - across * cardCols) / 2) + CARD_GAP / 2;
      const cards = panes.map((paneId, i) => ({
        paneId,
        col: left + (i % across) * cardCols,
        row: y + 1 + Math.floor(i / across) * cardRows,
        cols: cardCols - CARD_GAP,
        rows: cardRows,
      }));
      sections.push({ ...it, row: y, rows: shelf.h, cards });
    }
    y += shelf.h;
  }
  return {
    scale,
    spriteW: size.w,
    spriteH: size.h,
    sections,
    totalRows: y,
  };
}

/** The largest sprite scale at which every workspace fits on screen (or the forced one). */
export function planStage(
  workspaces: WorkspaceInfo[],
  seats: Map<string, string[]>,
  viewCols: number,
  viewRows: number,
  spriteSize: SpriteSize,
  forcedScale?: number,
): StagePlan {
  if (forcedScale !== undefined)
    return planAt(workspaces, seats, viewCols, spriteSize(forcedScale), forcedScale);
  let last: StagePlan | null = null;
  for (const s of STAGE_SCALES) {
    last = planAt(workspaces, seats, viewCols, spriteSize(s), s);
    const wide = last.sections.some((sec) => sec.cards.some((c) => c.cols < last!.spriteW));
    if (last.totalRows <= viewRows && !wide) return last;
  }
  return last!;
}

/** The frames the stage uses, cropped to their common bounds and resized. */
export class StageSprites {
  private readonly sheet: CharacterSheet;
  private readonly box: { x: number; y: number; w: number; h: number };
  private readonly cache = new Map<string, Map<string, Img>>();

  constructor(sheet: CharacterSheet) {
    this.sheet = sheet;
    let box: { x0: number; y0: number; x1: number; y1: number } | null = null;
    for (const [dir, col] of USED) {
      const { img, flip } = sheet.frame(dir, col);
      const b = opaqueBounds(img);
      if (!b) continue;
      const x = flip ? img.width - b.x - b.w : b.x;
      box = box
        ? {
            x0: Math.min(box.x0, x),
            y0: Math.min(box.y0, b.y),
            x1: Math.max(box.x1, x + b.w),
            y1: Math.max(box.y1, b.y + b.h),
          }
        : { x0: x, y0: b.y, x1: x + b.w, y1: b.y + b.h };
    }
    const b = box ?? { x0: 0, y0: 0, x1: sheet.frameW, y1: sheet.frameH };
    this.box = { x: b.x0, y: b.y0, w: b.x1 - b.x0, h: b.y1 - b.y0 };
  }

  size(scale: number, aspect: number): { w: number; h: number } {
    return {
      w: Math.max(1, Math.round(this.box.w * scale * aspect)),
      h: Math.max(1, Math.round(this.box.h * scale)),
    };
  }

  frame(dir: Dir, col: number, scale: number, aspect: number): Img {
    const key = `${scale}:${aspect}`;
    let set = this.cache.get(key);
    if (!set) {
      set = new Map();
      this.cache.set(key, set);
    }
    const id = `${dir}:${col}`;
    let img = set.get(id);
    if (!img) {
      const { img: src, flip } = this.sheet.frame(dir, col);
      const full = new Img(src.width, src.height);
      full.blit(src, 0, 0, { flip });
      const { w, h } = this.size(scale, aspect);
      img = scaleTo(full.crop(this.box.x, this.box.y, this.box.w, this.box.h), w, h);
      set.set(id, img);
    }
    return img;
  }
}

const USED: [Dir, number][] = [
  ['down', FRAME.stand],
  ['down', FRAME.type[0]],
  ['down', FRAME.type[1]],
  ['down', FRAME.read[0]],
  ['down', FRAME.read[1]],
  ['left', FRAME.stand],
  ['right', FRAME.stand],
];

/** Per-agent animation clock: which frame to show for its status. */
export class Performer {
  private status: AgentStatus | null = null;
  private since = 0;
  private readonly seed: number;

  constructor(paneId: string) {
    let h = 2166136261;
    for (let i = 0; i < paneId.length; i++) h = Math.imul(h ^ paneId.charCodeAt(i), 16777619);
    // FNV alone barely moves the high bits for ids that differ in the last
    // character (wH:p1 vs wH:p2), so finish with an avalanche mix.
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    h ^= h >>> 16;
    this.seed = (h >>> 0) / 4294967296;
  }

  pose(status: AgentStatus, t: number): { dir: Dir; col: number; hop: number; alpha: number } {
    if (status !== this.status) {
      this.status = status;
      this.since = t;
    }
    const local = t - this.since;
    const phase = t + this.seed * 10;
    switch (status) {
      case 'working':
        return { dir: 'down', col: FRAME.type[Math.floor(phase / 0.3) % 2], hop: 0, alpha: 1 };
      case 'blocked':
        return { dir: 'down', col: FRAME.stand, hop: Math.abs(Math.sin(phase * 5)), alpha: 1 };
      case 'done':
        // A short happy bounce when it finishes, then wait to be seen.
        return {
          dir: 'down',
          col: FRAME.stand,
          hop: local < 1.5 ? Math.abs(Math.sin(local * 8)) : 0,
          alpha: 1,
        };
      case 'idle': {
        // 14 s loop: read for a while, stand up, look left and right.
        const c = (phase % 14) / 14;
        if (c < 0.65)
          return { dir: 'down', col: FRAME.read[Math.floor(phase / 1.1) % 2], hop: 0, alpha: 1 };
        if (c < 0.75) return { dir: 'down', col: FRAME.stand, hop: 0, alpha: 1 };
        if (c < 0.85) return { dir: 'left', col: FRAME.stand, hop: 0, alpha: 1 };
        if (c < 0.95) return { dir: 'right', col: FRAME.stand, hop: 0, alpha: 1 };
        return { dir: 'down', col: FRAME.stand, hop: 0, alpha: 1 };
      }
      default:
        return { dir: 'down', col: FRAME.stand, hop: 0, alpha: 0.45 };
    }
  }
}

const STATUS_COLOR: Record<AgentStatus, number> = {
  working: 0x7ab8ff,
  blocked: 0xff5f5f,
  done: 0x6fdc8c,
  idle: 0x9a9ab0,
  unknown: 0x6c6c80,
};

const BORDER = 0x5a5a78;
const BORDER_ALERT = 0xffb347;

export interface StageHit {
  paneId: string | null;
  ws: WorkspaceInfo;
}

/**
 * Draw the visible part of the stage: sprites into `screen` (viewCols ×
 * viewRows*2 px), borders, labels and badges as text.
 */
export function paintStage(
  screen: Img,
  plan: StagePlan,
  scroll: number,
  agents: Map<string, AgentInfo>,
  performers: Map<string, Performer>,
  spritesFor: (a: AgentInfo) => StageSprites,
  aspect: number,
  hoverPane: string | null,
  t: number,
): BlockText[] {
  const texts: BlockText[] = [];
  const viewRows = Math.floor(screen.height / 2);
  const put = (
    row: number,
    col: number,
    text: string,
    fg?: number,
    bold?: boolean,
    bg?: number,
  ): void => {
    const r = row - scroll;
    if (r < 0 || r >= viewRows) return;
    texts.push({ row: r, col, text, fg, bold, bg });
  };
  const blink = Math.floor(t * 2) % 2 === 0;
  for (const sec of plan.sections) {
    const infos = sec.cards.map((c) => agents.get(c.paneId)).filter((a): a is AgentInfo => !!a);
    const alert = infos.some((a) => a.status === 'blocked');
    const color = alert && blink ? BORDER_ALERT : BORDER;
    const inner = sec.cols - 2;
    const count = (s: AgentStatus): number => infos.filter((a) => a.status === s).length;
    let label = ` ${sec.ws.label} `;
    const extra = [
      count('working') ? `작업 ${count('working')}` : '',
      count('blocked') ? `확인 ${count('blocked')}` : '',
      count('done') ? `완료 ${count('done')}` : '',
    ]
      .filter(Boolean)
      .join(' · ');
    if (extra) label += `· ${extra} `;
    label = truncate(label, inner - 1);
    put(sec.row, sec.col, '╭─', color);
    put(sec.row, sec.col + 2, label, sec.ws.focused ? 0xffffff : 0xd8d0f0, true);
    const lw = strWidth(label);
    put(sec.row, sec.col + 2 + lw, '─'.repeat(Math.max(0, inner - 1 - lw)) + '╮', color);
    for (let r = 1; r < sec.rows - 1; r++) {
      put(sec.row + r, sec.col, '│', color);
      put(sec.row + r, sec.col + sec.cols - 1, '│', color);
    }
    put(sec.row + sec.rows - 1, sec.col, '╰' + '─'.repeat(inner) + '╯', color);

    for (const card of sec.cards) {
      const info = agents.get(card.paneId);
      if (!info) continue;
      let perf = performers.get(card.paneId);
      if (!perf) {
        perf = new Performer(card.paneId);
        performers.set(card.paneId, perf);
      }
      const p = perf.pose(info.status, t);
      const img = spritesFor(info).frame(p.dir, p.col, plan.scale, aspect);
      const spriteRows = Math.ceil(img.height / 2);
      // Feet on the row above the title; one headroom row on top.
      const hopPx = Math.round(p.hop * Math.max(2, plan.spriteH * 0.08));
      const x = card.col + Math.floor((card.cols - img.width) / 2);
      const yPx = (card.row + 1 - scroll) * 2 + (spriteRows * 2 - img.height) - hopPx;
      if (hoverPane === card.paneId) {
        for (const [dx, dy] of [
          [-1, 0],
          [1, 0],
          [0, -1],
          [0, 1],
        ])
          screen.blit(img, x + dx, yPx + dy, { silhouette: 0xffffff });
      }
      screen.blit(img, x, yPx, { alpha: p.alpha });

      const badge = BADGES[info.status];
      if (badge && (info.status !== 'blocked' || blink)) {
        const bc = Math.min(card.col + card.cols - strWidth(badge.text), x + img.width - 1);
        put(card.row, Math.max(card.col, bc), badge.text, 0xffffff, true, badge.bg);
      }
      const titleRow = card.row + card.rows - 1;
      const mark = info.focused ? '▸' : '●';
      const title = truncate(info.title || info.kind, card.cols - 2);
      const hovered = hoverPane === card.paneId;
      put(titleRow, card.col, mark, STATUS_COLOR[info.status], true);
      put(
        titleRow,
        card.col + 2,
        title,
        hovered ? 0x1e1e2e : 0xe6e6f0,
        hovered || info.focused,
        hovered ? 0xe6e6f0 : undefined,
      );
    }
  }
  return texts;
}

const BADGES: Partial<Record<AgentStatus, { text: string; bg: number }>> = {
  blocked: { text: ' ! ', bg: 0xd83c3c },
  done: { text: ' ✓ ', bg: 0x2f9e55 },
  unknown: { text: ' ? ', bg: 0x55556a },
};

/** Which card (or section header) is under a cell. */
export function stageHitAt(plan: StagePlan, col: number, row: number): StageHit | null {
  for (const sec of plan.sections) {
    if (row < sec.row || row >= sec.row + sec.rows || col < sec.col || col >= sec.col + sec.cols)
      continue;
    for (const c of sec.cards) {
      if (row >= c.row && row < c.row + c.rows && col >= c.col && col < c.col + c.cols)
        return { paneId: c.paneId, ws: sec.ws };
    }
    return { paneId: null, ws: sec.ws };
  }
  return null;
}
