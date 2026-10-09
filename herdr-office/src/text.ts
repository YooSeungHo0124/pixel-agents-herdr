/** Terminal cell width of text (Hangul / CJK / emoji take two cells). */

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

function isZeroWidth(cp: number): boolean {
  return (
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    cp === 0x2060
  );
}

function charWidth(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  if (cp < 32 || isZeroWidth(cp)) return 0;
  return isWide(cp) ? 2 : 1;
}

export function strWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += charWidth(ch);
  return w;
}

/** Cut `s` to at most `max` cells, ending with "…" when shortened. */
export function truncate(s: string, max: number): string {
  if (strWidth(s) <= max) return s;
  let out = '';
  let w = 0;
  for (const ch of s) {
    const cw = charWidth(ch);
    if (w + cw > max - 1) break;
    out += ch;
    w += cw;
  }
  return out + '…';
}

/** Strip control characters so titles can't inject escape sequences. */
export function sanitize(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();
}
