/**
 * Pure terminal-protocol helpers for the office TUI: kitty graphics framing,
 * truecolor half-block rendering, and SGR mouse / key parsing. No I/O here, so
 * everything is unit-testable.
 */

export const ESC = '\x1b';

export const enterScreen =
  `${ESC}[?1049h` + // alternate screen
  `${ESC}[?25l` + // hide cursor
  `${ESC}[?1000h${ESC}[?1002h${ESC}[?1003h${ESC}[?1006h` + // mouse: press, drag, motion, SGR
  `${ESC}[2J`;

export const leaveScreen =
  `${ESC}[?1006l${ESC}[?1003l${ESC}[?1002l${ESC}[?1000l` + `${ESC}[?25h` + `${ESC}[?1049l`;

/** Kitty graphics query; a supporting terminal answers `ESC _Gi=31;OK ESC \`. */
export const kittyQuery = `${ESC}_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA${ESC}\\`;

export function isKittyOkReply(data: string): boolean {
  return /\x1b_Gi=31;OK\x1b\\/.test(data);
}

const KITTY_CHUNK = 4096;

/**
 * Transmit-and-display a PNG at the top-left cell, stretched to cols×rows
 * cells. C=1 keeps the cursor still, q=2 silences replies so they never land
 * in our input stream.
 */
export function kittyShowPng(
  png: Buffer,
  opts: { id: number; cols: number; rows: number },
): string {
  const b64 = png.toString('base64');
  let out = `${ESC}[1;1H`;
  for (let i = 0; i < b64.length || i === 0; i += KITTY_CHUNK) {
    const chunk = b64.slice(i, i + KITTY_CHUNK);
    const more = i + KITTY_CHUNK < b64.length ? 1 : 0;
    const ctl =
      i === 0
        ? `a=T,f=100,i=${opts.id},p=1,c=${opts.cols},r=${opts.rows},C=1,q=2,z=-1,m=${more}`
        : `m=${more}`;
    out += `${ESC}_G${ctl};${chunk}${ESC}\\`;
  }
  return out;
}

export function kittyDelete(id: number): string {
  return `${ESC}_Ga=d,d=I,i=${id},q=2${ESC}\\`;
}

export function kittyDeleteAll(): string {
  return `${ESC}_Ga=d,d=A,q=2${ESC}\\`;
}

/** An RGBA image (pngjs layout: 4 bytes per pixel, row-major). */
export interface Rgba {
  width: number;
  height: number;
  data: Uint8Array;
}

/**
 * Render an RGBA image into cols × rows cells using the upper-half-block
 * glyph: each cell shows two vertically stacked pixels (fg = top, bg =
 * bottom). The image is nearest-sampled onto a cols × (rows*2) grid. Only
 * cells that differ from `prev` are emitted; returns the new cell state too.
 */
export function renderHalfBlocks(
  img: Rgba,
  cols: number,
  rows: number,
  prev: Uint32Array | null,
): { out: string; cells: Uint32Array } {
  const cells = new Uint32Array(cols * rows * 2);
  const sample = (x: number, y: number): number => {
    const sx = Math.min(img.width - 1, Math.floor(((x + 0.5) * img.width) / cols));
    const sy = Math.min(img.height - 1, Math.floor(((y + 0.5) * img.height) / (rows * 2)));
    const o = (sy * img.width + sx) * 4;
    return (img.data[o] << 16) | (img.data[o + 1] << 8) | img.data[o + 2];
  };
  let out = '';
  let lastFg = -1;
  let lastBg = -1;
  let cursorAt = -1;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const top = sample(c, r * 2);
      const bottom = sample(c, r * 2 + 1);
      const k = (r * cols + c) * 2;
      cells[k] = top;
      cells[k + 1] = bottom;
      if (prev && prev.length === cells.length && prev[k] === top && prev[k + 1] === bottom) {
        continue;
      }
      const idx = r * cols + c;
      if (cursorAt !== idx) out += `${ESC}[${r + 1};${c + 1}H`;
      if (top !== lastFg) {
        out += `${ESC}[38;2;${top >> 16};${(top >> 8) & 255};${top & 255}m`;
        lastFg = top;
      }
      if (bottom !== lastBg) {
        out += `${ESC}[48;2;${bottom >> 16};${(bottom >> 8) & 255};${bottom & 255}m`;
        lastBg = bottom;
      }
      out += '▀';
      cursorAt = idx + 1;
    }
  }
  if (out) out += `${ESC}[0m`;
  return { out, cells };
}

export type MouseKind = 'down' | 'up' | 'move' | 'drag' | 'wheelUp' | 'wheelDown';

export interface MouseEvent {
  kind: MouseKind;
  /** 0 = left, 1 = middle, 2 = right (meaningless for wheel/move). */
  button: number;
  /** 0-based cell column / row. */
  col: number;
  row: number;
  ctrl: boolean;
  shift: boolean;
}

export type InputEvent =
  | { type: 'mouse'; mouse: MouseEvent }
  | { type: 'key'; key: string; ctrl: boolean }
  | { type: 'kittyOk' };

/**
 * Split a raw stdin chunk into input events. Handles SGR mouse reports
 * (`ESC [ < b ; x ; y M|m`), kitty graphics replies, common CSI keys, and
 * plain characters. Unknown escape sequences are dropped.
 */
export function parseInput(data: string): InputEvent[] {
  const events: InputEvent[] = [];
  let i = 0;
  while (i < data.length) {
    const rest = data.slice(i);
    const mouse = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(rest);
    if (mouse) {
      const code = Number(mouse[1]);
      const col = Number(mouse[2]) - 1;
      const row = Number(mouse[3]) - 1;
      const released = mouse[4] === 'm';
      const ctrl = (code & 16) !== 0;
      const shift = (code & 4) !== 0;
      const button = code & 3;
      let kind: MouseKind;
      if (code & 64) kind = button === 0 ? 'wheelUp' : 'wheelDown';
      else if (code & 32) kind = button === 3 ? 'move' : 'drag';
      else kind = released ? 'up' : 'down';
      events.push({ type: 'mouse', mouse: { kind, button, col, row, ctrl, shift } });
      i += mouse[0].length;
      continue;
    }
    const apc = /^\x1b_G([^\x1b]*)\x1b\\/.exec(rest);
    if (apc) {
      if (/^i=31;OK/.test(apc[1])) events.push({ type: 'kittyOk' });
      i += apc[0].length;
      continue;
    }
    const csi = /^\x1b\[([0-9;?]*)([A-Za-z~])/.exec(rest);
    if (csi) {
      const names: Record<string, string> = {
        A: 'ArrowUp',
        B: 'ArrowDown',
        C: 'ArrowRight',
        D: 'ArrowLeft',
        H: 'Home',
        F: 'End',
      };
      const tilde: Record<string, string> = { '3': 'Delete', '5': 'PageUp', '6': 'PageDown' };
      const key = csi[2] === '~' ? tilde[csi[1]] : names[csi[2]];
      if (key) events.push({ type: 'key', key, ctrl: false });
      i += csi[0].length;
      continue;
    }
    if (rest[0] === '\x1b') {
      // Lone Escape (or an unrecognised sequence start: treat as Escape).
      events.push({ type: 'key', key: 'Escape', ctrl: false });
      i += 1;
      continue;
    }
    const ch = rest[0];
    const code = ch.charCodeAt(0);
    if (ch === '\r' || ch === '\n') events.push({ type: 'key', key: 'Enter', ctrl: false });
    else if (ch === '\x7f') events.push({ type: 'key', key: 'Backspace', ctrl: false });
    else if (ch === '\t') events.push({ type: 'key', key: 'Tab', ctrl: false });
    else if (code < 32) {
      events.push({ type: 'key', key: String.fromCharCode(code + 96), ctrl: true });
    } else events.push({ type: 'key', key: ch, ctrl: false });
    i += 1;
  }
  return events;
}

/**
 * Bounding box of everything that differs from the top-left pixel (the page
 * background), or null for a blank image.
 */
export function contentBounds(
  img: Rgba,
  tolerance = 8,
): { x: number; y: number; width: number; height: number } | null {
  const d = img.data;
  let minX = img.width;
  let minY = img.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const o = (y * img.width + x) * 4;
      if (
        Math.abs(d[o] - d[0]) > tolerance ||
        Math.abs(d[o + 1] - d[1]) > tolerance ||
        Math.abs(d[o + 2] - d[2]) > tolerance
      ) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}
