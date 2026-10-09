/**
 * Character sheets: 7 columns (walk1, walk2, walk3, type1, type2, read1, read2)
 * × 3 or 4 rows (down, up, right[, left]). Without a left row, left is the
 * mirrored right row. This is the pixel-agents layout, so a 112×96 sheet
 * works as-is; hi-res sheets (frames 128 px tall, possibly wider than half
 * their height) are the native size here.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { decodePng } from './png.ts';
import { Img, scaleArea, scaleNearest } from './raster.ts';

export type Dir = 'down' | 'up' | 'right' | 'left';

/** Frame height every sheet is normalised to (32 logical px at 4x). */
export const NATIVE_FRAME_H = 128;

export const FRAME = { stand: 0, walk: [1, 0, 2, 0], type: [3, 4], read: [5, 6] } as const;

const COLS = 7;

/** Rows in a sheet: the count whose frame aspect (h / w) is a whole number. */
export function sheetRows(width: number, height: number): 3 | 4 {
  const frameW = width / COLS;
  const fits = (rows: number): boolean =>
    height % rows === 0 && Number.isInteger(height / rows / frameW);
  if (fits(3)) return 3;
  if (fits(4)) return 4;
  return height % 4 === 0 && height % 3 !== 0 ? 4 : 3;
}

export class CharacterSheet {
  readonly name: string;
  /** frames[row][col]; rows are down, up, right[, left]. */
  private readonly frames: Img[][];
  private readonly hasLeft: boolean;
  private readonly scaledCache = new Map<number, CharacterSheet>();

  constructor(name: string, frames: Img[][]) {
    this.name = name;
    this.frames = frames;
    this.hasLeft = frames.length >= 4;
  }

  get frameW(): number {
    return this.frames[0][0].width;
  }

  get frameH(): number {
    return this.frames[0][0].height;
  }

  static fromImage(name: string, sheet: Img): CharacterSheet {
    if (sheet.width % COLS !== 0) throw new Error(`${name}: width must split into 7 frames`);
    const rows = sheetRows(sheet.width, sheet.height);
    const fw = sheet.width / COLS;
    const fh = sheet.height / rows;
    // Normalise to 128 px tall frames: upscale low-res sheets with crisp pixels.
    const up = Math.max(1, Math.round(NATIVE_FRAME_H / fh));
    const frames: Img[][] = [];
    for (let r = 0; r < rows; r++) {
      const row: Img[] = [];
      for (let c = 0; c < COLS; c++) row.push(scaleNearest(sheet.crop(c * fw, r * fh, fw, fh), up));
      frames.push(row);
    }
    return new CharacterSheet(name, frames);
  }

  static load(file: string): CharacterSheet {
    return CharacterSheet.fromImage(
      path.basename(file, path.extname(file)),
      decodePng(fs.readFileSync(file)),
    );
  }

  /** The frame to draw for a direction and column, plus whether to mirror it. */
  frame(dir: Dir, col: number): { img: Img; flip: boolean } {
    if (dir === 'left' && !this.hasLeft) return { img: this.frames[2][col], flip: true };
    const row = { down: 0, up: 1, right: 2, left: 3 }[dir];
    return { img: this.frames[row][col], flip: false };
  }

  /** This sheet resized by `factor` (cached). */
  scaled(factor: number): CharacterSheet {
    if (factor === 1) return this;
    const key = Math.round(factor * 1000);
    let s = this.scaledCache.get(key);
    if (!s) {
      s = new CharacterSheet(
        this.name,
        this.frames.map((row) => row.map((f) => scaleArea(f, factor))),
      );
      this.scaledCache.set(key, s);
    }
    return s;
  }
}

/** Every `*.png` sheet in a directory, keyed by file name without extension. */
export function loadCharacterDir(
  dir: string,
  log: (msg: string) => void,
): Map<string, CharacterSheet> {
  const out = new Map<string, CharacterSheet>();
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.png'));
  } catch {
    return out;
  }
  for (const f of names.sort()) {
    try {
      const sheet = CharacterSheet.load(path.join(dir, f));
      out.set(sheet.name, sheet);
    } catch (err) {
      log(`skip ${f}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}
