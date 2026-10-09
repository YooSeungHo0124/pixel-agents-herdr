/** Terminal protocol: screen setup, kitty graphics, text, and input parsing. */

export const ESC = '\x1b';

export const enterScreen =
  `${ESC}[?1049h` + // alternate screen
  `${ESC}[?25l` + // hide cursor
  `${ESC}[?1000h${ESC}[?1002h${ESC}[?1003h${ESC}[?1006h` + // mouse: press, drag, motion, SGR
  `${ESC}[2J`;

export const leaveScreen =
  `${ESC}[?1006l${ESC}[?1003l${ESC}[?1002l${ESC}[?1000l` + `${ESC}[0m${ESC}[?25h` + `${ESC}[?1049l`;

/** Ask for the cell size (`CSI 6;h;w t`) and the text area in pixels (`CSI 4;h;w t`). */
export const sizeQueries = `${ESC}[16t${ESC}[14t`;

const KITTY_CHUNK = 4096;

/**
 * Transmit a PNG and place it at a cell, stretched to cols×rows cells. C=1
 * leaves the cursor alone, q=2 silences replies, z=-1 keeps text on top.
 */
export function kittyPlacePng(
  png: Buffer,
  opts: { id: number; col: number; row: number; cols: number; rows: number },
): string {
  const b64 = png.toString('base64');
  let out = `${ESC}[${opts.row + 1};${opts.col + 1}H`;
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

export function sgrFg(rgb: number): string {
  return `${ESC}[38;2;${(rgb >> 16) & 255};${(rgb >> 8) & 255};${rgb & 255}m`;
}

/** Write text at a 0-based cell. */
export function textAt(row: number, col: number, text: string, fg?: number, bold = false): string {
  return `${ESC}[${row + 1};${col + 1}H${bold ? `${ESC}[1m` : ''}${fg !== undefined ? sgrFg(fg) : ''}${text}${ESC}[0m`;
}

export type MouseKind = 'down' | 'up' | 'move' | 'drag' | 'wheelUp' | 'wheelDown';

export interface MouseEvent {
  kind: MouseKind;
  button: number;
  col: number;
  row: number;
}

export type InputEvent =
  | { type: 'mouse'; mouse: MouseEvent }
  | { type: 'key'; key: string; ctrl: boolean }
  | { type: 'cellSize'; w: number; h: number }
  | { type: 'areaSize'; w: number; h: number };

/**
 * Split a raw stdin chunk into events: SGR mouse reports, window-size replies
 * (`CSI 6;h;w t`, `CSI 4;h;w t`), common CSI keys and plain characters.
 * Kitty replies and unknown sequences are dropped.
 */
export function parseInput(data: string): InputEvent[] {
  const events: InputEvent[] = [];
  let i = 0;
  while (i < data.length) {
    const rest = data.slice(i);
    const mouse = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(rest);
    if (mouse) {
      const code = Number(mouse[1]);
      const button = code & 3;
      let kind: MouseKind;
      if (code & 64) kind = button === 0 ? 'wheelUp' : 'wheelDown';
      else if (code & 32) kind = button === 3 ? 'move' : 'drag';
      else kind = mouse[4] === 'm' ? 'up' : 'down';
      events.push({
        type: 'mouse',
        mouse: { kind, button, col: Number(mouse[2]) - 1, row: Number(mouse[3]) - 1 },
      });
      i += mouse[0].length;
      continue;
    }
    const size = /^\x1b\[([46]);(\d+);(\d+)t/.exec(rest);
    if (size) {
      const h = Number(size[2]);
      const w = Number(size[3]);
      events.push(size[1] === '6' ? { type: 'cellSize', w, h } : { type: 'areaSize', w, h });
      i += size[0].length;
      continue;
    }
    const apc = /^\x1b_[^\x1b]*\x1b\\/.exec(rest);
    if (apc) {
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
        Z: 'BackTab',
      };
      const tilde: Record<string, string> = { '5': 'PageUp', '6': 'PageDown' };
      const key = csi[2] === '~' ? tilde[csi[1]] : names[csi[2]];
      if (key) events.push({ type: 'key', key, ctrl: false });
      i += csi[0].length;
      continue;
    }
    if (rest[0] === '\x1b') {
      events.push({ type: 'key', key: 'Escape', ctrl: false });
      i += 1;
      continue;
    }
    const ch = rest[0];
    const code = ch.charCodeAt(0);
    if (ch === '\r' || ch === '\n') events.push({ type: 'key', key: 'Enter', ctrl: false });
    else if (ch === '\t') events.push({ type: 'key', key: 'Tab', ctrl: false });
    else if (code < 32)
      events.push({ type: 'key', key: String.fromCharCode(code + 96), ctrl: true });
    else events.push({ type: 'key', key: ch, ctrl: false });
    i += 1;
  }
  return events;
}
