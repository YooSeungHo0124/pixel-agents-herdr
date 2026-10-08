import { describe, expect, it } from 'vitest';

import {
  contentBounds,
  isKittyOkReply,
  kittyShowPng,
  parseInput,
  renderHalfBlocks,
} from '../src/tui/terminalProtocol.js';

describe('parseInput', () => {
  it('decodes SGR mouse press, release, motion and wheel', () => {
    const events = parseInput('\x1b[<0;11;6M\x1b[<0;11;6m\x1b[<35;3;4M\x1b[<65;1;1M\x1b[<80;2;2M');
    expect(events.map((e) => (e.type === 'mouse' ? e.mouse : e))).toEqual([
      { kind: 'down', button: 0, col: 10, row: 5, ctrl: false, shift: false },
      { kind: 'up', button: 0, col: 10, row: 5, ctrl: false, shift: false },
      { kind: 'move', button: 3, col: 2, row: 3, ctrl: false, shift: false },
      { kind: 'wheelDown', button: 1, col: 0, row: 0, ctrl: false, shift: false },
      { kind: 'wheelUp', button: 0, col: 1, row: 1, ctrl: true, shift: false },
    ]);
  });

  it('decodes keys, ctrl chords and the kitty reply', () => {
    expect(parseInput('r\x03\x1b[A\x1b_Gi=31;OK\x1b\\\x1b')).toEqual([
      { type: 'key', key: 'r', ctrl: false },
      { type: 'key', key: 'c', ctrl: true },
      { type: 'key', key: 'ArrowUp', ctrl: false },
      { type: 'kittyOk' },
      { type: 'key', key: 'Escape', ctrl: false },
    ]);
    expect(isKittyOkReply('\x1b_Gi=31;OK\x1b\\')).toBe(true);
    expect(isKittyOkReply('\x1b[?62;22c')).toBe(false);
  });
});

describe('kittyShowPng', () => {
  it('chunks the payload and only puts placement keys on the first chunk', () => {
    const out = kittyShowPng(Buffer.alloc(6000, 1), { id: 2, cols: 80, rows: 24 });
    const chunks = out.match(/\x1b_G[^;]*;/g) ?? [];
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toContain('a=T,f=100,i=2,p=1,c=80,r=24');
    expect(chunks[0]).toContain('m=1');
    expect(chunks[1]).toBe('\x1b_Gm=0;');
  });
});

describe('renderHalfBlocks', () => {
  const img = {
    width: 2,
    height: 2,
    // red, green / blue, white
    data: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]),
  };

  it('puts the top pixel in the foreground and the bottom one in the background', () => {
    const { out } = renderHalfBlocks(img, 2, 1, null);
    expect(out).toContain('\x1b[38;2;255;0;0m\x1b[48;2;0;0;255m▀');
    expect(out).toContain('\x1b[38;2;0;255;0m\x1b[48;2;255;255;255m▀');
  });

  it('emits nothing for an unchanged frame', () => {
    const first = renderHalfBlocks(img, 2, 1, null);
    expect(renderHalfBlocks(img, 2, 1, first.cells).out).toBe('');
  });
});

describe('contentBounds', () => {
  it('finds the box of pixels that differ from the background corner', () => {
    const data = new Uint8Array(4 * 4 * 4).fill(10);
    const set = (x: number, y: number) => data.set([200, 50, 50, 255], (y * 4 + x) * 4);
    set(1, 2);
    set(2, 3);
    expect(contentBounds({ width: 4, height: 4, data })).toEqual({
      x: 1,
      y: 2,
      width: 2,
      height: 2,
    });
    expect(contentBounds({ width: 4, height: 4, data: new Uint8Array(64).fill(10) })).toBeNull();
  });
});
