/**
 * Text-only renderer: every terminal cell shows two stacked pixels with the
 * upper-half-block glyph (fg = top, bg = bottom), so the office works in any
 * truecolor terminal — GNOME Terminal, plain herdr panes — with no image
 * protocol at all. Labels are composited into the same cell grid, and only
 * the cells that changed since the last frame are written.
 */
import type { Img } from './raster.ts';
import { ESC } from './term.ts';

export interface BlockText {
  row: number;
  col: number;
  text: string;
  fg?: number;
  bold?: boolean;
}

interface Cell {
  ch: string; // '' = right half of a wide character
  fg: number; // -1 = terminal default
  bg: number;
  bold: boolean;
}

const BLANK: Cell = { ch: ' ', fg: -1, bg: -1, bold: false };

function sameCell(a: Cell, b: Cell): boolean {
  return a.ch === b.ch && a.fg === b.fg && a.bg === b.bg && a.bold === b.bold;
}

function pixel(img: Img, x: number, y: number): number {
  if (x >= img.width || y >= img.height) return -1;
  const o = (y * img.width + x) * 4;
  if (img.data[o + 3] < 128) return -1;
  return (img.data[o] << 16) | (img.data[o + 1] << 8) | img.data[o + 2];
}

function isWide(ch: string): boolean {
  const cp = ch.codePointAt(0) ?? 0;
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff)
  );
}

export class BlockScreen {
  private prev: Cell[] | null = null;
  private cols = 0;
  private rows = 0;

  /** Forget what is on screen (after a clear or resize). */
  reset(): void {
    this.prev = null;
  }

  /**
   * Turn `img` (cols × rows*2 pixels) plus `texts` into terminal output for
   * the cells that changed.
   */
  render(img: Img, cols: number, rows: number, texts: BlockText[]): string {
    const grid: Cell[] = new Array(cols * rows);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const top = pixel(img, c, r * 2);
        const bottom = pixel(img, c, r * 2 + 1);
        let cell: Cell;
        if (top === bottom) cell = top < 0 ? BLANK : { ch: ' ', fg: -1, bg: top, bold: false };
        else if (top < 0) cell = { ch: '▄', fg: bottom, bg: -1, bold: false };
        else cell = { ch: '▀', fg: top, bg: bottom, bold: false };
        grid[r * cols + c] = cell;
      }
    }
    for (const t of texts) {
      if (t.row < 0 || t.row >= rows) continue;
      let c = t.col;
      for (const ch of t.text) {
        const wide = isWide(ch);
        if (c < 0 || c + (wide ? 1 : 0) >= cols) break;
        const under = grid[t.row * cols + c];
        // Text sits on whatever is behind it: the lower pixel reads best.
        const bg = under.ch === '▀' ? under.bg : under.ch === '▄' ? under.fg : under.bg;
        grid[t.row * cols + c] = { ch, fg: t.fg ?? -1, bg, bold: !!t.bold };
        if (wide) grid[t.row * cols + c + 1] = { ch: '', fg: t.fg ?? -1, bg, bold: !!t.bold };
        c += wide ? 2 : 1;
      }
    }

    const full = !this.prev || this.cols !== cols || this.rows !== rows;
    const prev = this.prev;
    let out = full ? `${ESC}[0m${ESC}[2J` : '';
    let fg = -2;
    let bg = -2;
    let bold = false;
    let cursor = -1;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        const cell = grid[i];
        if (cell.ch === '') continue; // drawn with its left half
        const wideLead = c + 1 < cols && grid[i + 1].ch === '';
        const changed =
          full ||
          !sameCell(cell, prev![i]) ||
          (wideLead && !sameCell(grid[i + 1], prev![i + 1])) ||
          (!wideLead && c + 1 < cols && prev![i + 1].ch === '');
        if (!changed) continue;
        if (cursor !== i) out += `${ESC}[${r + 1};${c + 1}H`;
        if (cell.bold !== bold) {
          out += `${ESC}[0m`;
          fg = -2;
          bg = -2;
          if (cell.bold) out += `${ESC}[1m`;
          bold = cell.bold;
        }
        if (cell.fg !== fg) {
          out +=
            cell.fg < 0
              ? `${ESC}[39m`
              : `${ESC}[38;2;${cell.fg >> 16};${(cell.fg >> 8) & 255};${cell.fg & 255}m`;
          fg = cell.fg;
        }
        if (cell.bg !== bg) {
          out +=
            cell.bg < 0
              ? `${ESC}[49m`
              : `${ESC}[48;2;${cell.bg >> 16};${(cell.bg >> 8) & 255};${cell.bg & 255}m`;
          bg = cell.bg;
        }
        out += cell.ch;
        const width = wideLead ? 2 : 1;
        cursor = c + width >= cols ? -1 : i + width;
      }
    }
    if (out) out += `${ESC}[0m`;
    this.prev = grid;
    this.cols = cols;
    this.rows = rows;
    return out;
  }
}
