/**
 * Office floor plan: one room per herdr workspace, packed left-to-right in
 * rows. Every room sits on whole terminal cells so text labels (drawn as real
 * terminal text over the image) line up with the plates painted under them.
 *
 * Geometry inside a room is in BASE pixels (the 128 px tall character frame
 * at scale 1); multiply by `scale` for image pixels.
 */
import type { AgentInfo, WorkspaceInfo } from './herdr.ts';

export const BASE = {
  pad: 20,
  wallH: 100,
  slotW: 150,
  /** Seat (feet / desk edge) below the top of a desk row. */
  seatDrop: 118,
  panelH: 30,
  aisleH: 100,
  loungeH: 160,
  bottomPad: 14,
  minW: 560,
  maxPerRow: 8,
} as const;

export interface Cell {
  w: number;
  h: number;
}

export interface Slot {
  paneId: string;
  /** Desk centre x and the seat line (desk edge) y, base px, room-local. */
  cx: number;
  seatY: number;
  /** Where the agent stands in front of its desk (feet), base px. */
  standY: number;
  /** Terminal cell row/col (room-local) for the title text, and its width in cells. */
  titleRow: number;
  titleCol: number;
  titleCols: number;
}

export interface Room {
  ws: WorkspaceInfo;
  /** Top-left terminal cell (absolute, before scrolling) and size in cells. */
  col: number;
  row: number;
  cols: number;
  rows: number;
  /** Room size in image pixels (= cells × cell size). */
  pxW: number;
  pxH: number;
  /** Room size in base px. */
  w: number;
  h: number;
  /** Wall height, base px. */
  wallH: number;
  slots: Slot[];
  lounge: { x0: number; x1: number; y0: number; y1: number };
  chairs: { x: number; y: number }[];
  plant: { x: number; y: number };
  cooler: { x: number; y: number };
}

export interface Plan {
  scale: number;
  cell: Cell;
  rooms: Room[];
  /** Total rows the plan needs (may exceed the viewport → scrolling). */
  totalRows: number;
}

const GAP_COLS = 2;
const GAP_ROWS = 1;
const MARGIN_COL = 1;

/** Lounge beside the desks instead of below them (for wide, short viewports). */
const SIDE_LOUNGE_W = 330;

function planRoom(
  ws: WorkspaceInfo,
  paneIds: string[],
  scale: number,
  cell: Cell,
  maxCols: number,
  side: boolean,
): Omit<Room, 'col' | 'row'> {
  const rowPx = cell.h / scale; // one text row in base px
  const loungeW = side ? SIDE_LOUNGE_W : 0;
  const fitPerRow = ((maxCols * cell.w) / scale - BASE.pad * 2 - loungeW) / BASE.slotW;
  const perRow = Math.max(1, Math.min(BASE.maxPerRow, Math.floor(fitPerRow), paneIds.length || 1));
  const deskRows = Math.max(1, Math.ceil(paneIds.length / perRow));
  // The side layout is for short viewports: a lower wall and a tighter aisle.
  const wallH = side ? 72 : BASE.wallH;
  const aisleH = side ? 84 : BASE.aisleH;
  const blockH = BASE.seatDrop + BASE.panelH + rowPx * 2 + aisleH;
  const deskW = BASE.pad * 2 + perRow * BASE.slotW;
  const w = side ? deskW + loungeW : Math.max(BASE.minW, deskW);
  const desksBottom = wallH + deskRows * blockH;
  const h = side
    ? Math.max(desksBottom, wallH + 230) + BASE.bottomPad
    : desksBottom + BASE.loungeH + BASE.bottomPad;
  const cols = Math.ceil((w * scale) / cell.w);
  const rows = Math.ceil((h * scale) / cell.h);
  const pxW = cols * cell.w;
  const pxH = rows * cell.h;
  const wFull = pxW / scale;
  const hFull = pxH / scale;
  const deskArea = side ? deskW : wFull;
  const slots: Slot[] = paneIds.map((paneId, i) => {
    const r = Math.floor(i / perRow);
    const c = i % perRow;
    const inRow = Math.min(perRow, paneIds.length - r * perRow);
    const left = (deskArea - inRow * BASE.slotW) / 2;
    const cx = left + BASE.slotW * (c + 0.5);
    const top = wallH + r * blockH;
    const seatY = top + BASE.seatDrop;
    // Title text goes on the first whole cell row under the desk panel.
    const titleRow = Math.ceil(((seatY + BASE.panelH) * scale) / cell.h);
    const standY = (titleRow + 1) * rowPx + aisleH - 6;
    const titleCols = Math.max(4, Math.floor((BASE.slotW * scale) / cell.w) - 1);
    const titleCol = Math.round((cx * scale) / cell.w - titleCols / 2);
    return { paneId, cx, seatY, standY, titleRow, titleCol, titleCols };
  });
  if (side) {
    const x0 = deskW + 10;
    const y1 = hFull - BASE.bottomPad - 4;
    return {
      ws,
      cols,
      rows,
      pxW,
      pxH,
      w: wFull,
      h: hFull,
      wallH,
      slots,
      lounge: { x0: x0 + 60, x1: wFull - BASE.pad - 50, y0: wallH + 112, y1 },
      chairs: [0, 1].map((i) => ({ x: wFull - BASE.pad - 50 - i * 100, y: y1 })),
      plant: { x: x0 + 24, y: y1 },
      cooler: { x: wFull - BASE.pad - 30, y: wallH + 70 },
    };
  }
  const loungeY1 = desksBottom + BASE.loungeH - 6;
  const chairs = [0, 1].map((i) => ({ x: wFull - BASE.pad - 70 - i * 110, y: loungeY1 }));
  return {
    ws,
    cols,
    rows,
    pxW,
    pxH,
    w: wFull,
    h: hFull,
    wallH,
    slots,
    lounge: { x0: BASE.pad + 70, x1: wFull - BASE.pad - 60, y0: desksBottom + 60, y1: loungeY1 },
    chairs,
    plant: { x: BASE.pad + 28, y: loungeY1 },
    cooler: { x: BASE.pad + 30, y: desksBottom + 56 },
  };
}

/** Pack rooms for one scale; returns the plan and the rows it needs. */
export function planAt(
  workspaces: WorkspaceInfo[],
  seats: Map<string, string[]>,
  viewCols: number,
  scale: number,
  cell: Cell,
  side = false,
): Plan {
  const rooms: Room[] = [];
  let col = MARGIN_COL;
  let row = 0;
  let shelfH = 0;
  const maxCols = viewCols - MARGIN_COL * 2;
  for (const ws of workspaces) {
    const r = planRoom(ws, seats.get(ws.id) ?? [], scale, cell, maxCols, side);
    if (col > MARGIN_COL && col + r.cols > viewCols - MARGIN_COL) {
      col = MARGIN_COL;
      row += shelfH + GAP_ROWS;
      shelfH = 0;
    }
    rooms.push({ ...r, col, row });
    col += r.cols + GAP_COLS;
    shelfH = Math.max(shelfH, r.rows);
  }
  return { scale, cell, rooms, totalRows: row + shelfH };
}

/** Scales for image mode (cells are real pixels) and for half-block text mode. */
export const SCALES = [1, 0.75, 0.5, 0.375] as const;
export const BLOCK_SCALES = [0.25, 0.1875, 0.15625, 0.125, 0.1] as const;

/**
 * The largest scale whose plan fits the viewport, trying the lounge below and
 * beside the desks at each scale; the smallest scale scrolls.
 */
export function plan(
  workspaces: WorkspaceInfo[],
  seats: Map<string, string[]>,
  viewCols: number,
  viewRows: number,
  cell: Cell,
  forcedScale?: number,
  scales: readonly number[] = SCALES,
): Plan {
  const candidates = forcedScale ? [forcedScale] : scales;
  let best: Plan | null = null;
  for (const s of candidates) {
    for (const side of [false, true]) {
      const p = planAt(workspaces, seats, viewCols, s, cell, side);
      if (p.totalRows <= viewRows) return p;
      if (!best || p.totalRows < best.totalRows) best = p;
    }
  }
  return best!;
}

/**
 * Stable desk assignment per workspace: agents keep their order of first
 * appearance; a leaving agent frees its desk and the rest shift up.
 */
export function updateSeats(
  prev: Map<string, string[]>,
  agents: AgentInfo[],
): Map<string, string[]> {
  const next = new Map<string, string[]>();
  const byWs = new Map<string, string[]>();
  for (const a of agents) {
    const list = byWs.get(a.workspaceId) ?? [];
    list.push(a.paneId);
    byWs.set(a.workspaceId, list);
  }
  for (const [ws, panes] of byWs) {
    const kept = (prev.get(ws) ?? []).filter((p) => panes.includes(p));
    for (const p of panes) if (!kept.includes(p)) kept.push(p);
    next.set(ws, kept);
  }
  return next;
}
