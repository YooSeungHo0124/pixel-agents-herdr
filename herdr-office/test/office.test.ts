import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Actor } from '../src/actors.ts';
import { toSnapshot, type AgentInfo } from '../src/herdr.ts';
import { plan, updateSeats } from '../src/layout.ts';
import { decodePng, encodePng } from '../src/png.ts';
import { Img, scaleArea } from '../src/raster.ts';
import { CharacterSheet, sheetRows } from '../src/sheet.ts';
import { parseInput } from '../src/term.ts';
import { sanitize, strWidth, truncate } from '../src/text.ts';

function agent(
  paneId: string,
  workspaceId: string,
  status: AgentInfo['status'] = 'idle',
): AgentInfo {
  return {
    paneId,
    workspaceId,
    tabId: '',
    kind: 'claude',
    status,
    title: paneId,
    cwd: '',
    focused: false,
  };
}

test('png round-trips RGBA', () => {
  const img = new Img(5, 3);
  img.rect(1, 1, 3, 1, 0x336699);
  img.rect(0, 0, 1, 1, 0xff0000, 0.5);
  const back = decodePng(encodePng(img));
  assert.equal(back.width, 5);
  assert.deepEqual([...back.data], [...img.data]);
});

test('sheet rows: stock, hi-res 3-row and 4-row sheets', () => {
  assert.equal(sheetRows(112, 96), 3);
  assert.equal(sheetRows(896, 384), 3);
  assert.equal(sheetRows(896, 512), 4);
  assert.equal(sheetRows(112, 128), 4);
});

test('a stock 16x32 sheet is normalised to 128 px frames, left mirrors right', () => {
  const sheet = CharacterSheet.fromImage('t', new Img(112, 96));
  assert.equal(sheet.frameH, 128);
  assert.equal(sheet.frameW, 64);
  assert.equal(sheet.frame('left', 0).flip, true);
  assert.equal(sheet.frame('right', 0).flip, false);
  assert.equal(sheet.scaled(0.5).frameH, 64);
});

test('scaleArea keeps hard alpha', () => {
  const img = new Img(4, 4);
  img.rect(0, 0, 2, 4, 0xffffff);
  const half = scaleArea(img, 0.5);
  assert.equal(half.data[3], 255);
  assert.equal(half.data[7], 0);
});

test('snapshot parsing keeps known statuses only', () => {
  const snap = toSnapshot(
    { agents: [{ pane_id: 'w1:p1', workspace_id: 'w1', agent_status: 'weird', agent: 'codex' }] },
    {
      workspaces: [
        { workspace_id: 'w1', label: 'a', number: 2 },
        { workspace_id: 'w0', number: 1 },
      ],
    },
  );
  assert.equal(snap.agents[0].status, 'unknown');
  assert.equal(snap.agents[0].kind, 'codex');
  assert.deepEqual(
    snap.workspaces.map((w) => w.id),
    ['w0', 'w1'],
  );
  assert.equal(snap.workspaces[0].label, 'w0');
});

test('seats are stable and compact when an agent leaves', () => {
  let seats = updateSeats(new Map(), [agent('a', 'w'), agent('b', 'w'), agent('c', 'w')]);
  assert.deepEqual(seats.get('w'), ['a', 'b', 'c']);
  seats = updateSeats(seats, [agent('c', 'w'), agent('d', 'w'), agent('a', 'w')]);
  assert.deepEqual(seats.get('w'), ['a', 'c', 'd']);
});

test('plan packs rooms on cells and shrinks to fit', () => {
  const ws = [1, 2, 3, 4].map((n) => ({ id: `w${n}`, label: `w${n}`, number: n, focused: false }));
  const seats = new Map(ws.map((w) => [w.id, ['p1', 'p2']]));
  const big = plan(ws, seats, 400, 100, { w: 10, h: 20 });
  assert.equal(big.scale, 1);
  for (const r of big.rooms) {
    assert.equal(r.pxW, r.cols * 10);
    assert.equal(r.pxH, r.rows * 20);
  }
  const small = plan(ws, seats, 120, 30, { w: 10, h: 20 });
  assert.ok(small.scale < 1);
  assert.ok(small.rooms.every((r) => r.col + r.cols <= 120));
});

test('a working agent sits at its desk; a blocked one stands with an alert', () => {
  const ws = [{ id: 'w', label: 'w', number: 1, focused: false }];
  const p = plan(ws, new Map([['w', ['a']]]), 200, 60, { w: 10, h: 20 });
  const room = p.rooms[0];
  const slot = room.slots[0];
  const a = new Actor(agent('a', 'w', 'working'));
  a.update(0.1, room, slot, new Set());
  assert.equal(a.isSeated, true);
  assert.equal(a.pose, 'type');
  a.info = agent('a', 'w', 'blocked');
  for (let i = 0; i < 50; i++) a.update(0.1, room, slot, new Set());
  assert.equal(a.isSeated, false);
  assert.equal(a.bubble(), 'alert');
  assert.equal(a.y, slot.standY);
});

test('input parsing: mouse, size replies, keys', () => {
  const ev = parseInput('\x1b[<0;5;7M\x1b[6;22;15t\x1b[<35;1;1Mq\x1b[Z');
  assert.deepEqual(ev[0], { type: 'mouse', mouse: { kind: 'down', button: 0, col: 4, row: 6 } });
  assert.deepEqual(ev[1], { type: 'cellSize', w: 15, h: 22 });
  assert.equal(ev[2].type === 'mouse' && ev[2].mouse.kind, 'move');
  assert.deepEqual(ev[3], { type: 'key', key: 'q', ctrl: false });
  assert.deepEqual(ev[4], { type: 'key', key: 'BackTab', ctrl: false });
});

test('text width and truncation handle Hangul', () => {
  assert.equal(strWidth('짱구a'), 5);
  assert.equal(truncate('비파괴 검사 영상', 7), '비파괴…');
  assert.equal(sanitize('a\x1b[31mb'), 'a[31mb');
});

test('blocks: half-block cells, text on top, and only changed cells redrawn', async () => {
  const { BlockScreen } = await import('../src/blocks.ts');
  const img = new Img(4, 4);
  img.rect(0, 0, 4, 1, 0xff0000);
  img.rect(0, 1, 4, 1, 0x0000ff);
  const screen = new BlockScreen();
  const first = screen.render(img, 4, 2, [{ row: 1, col: 0, text: '짱', fg: 0xffffff }]);
  assert.match(first, /▀/);
  assert.match(first, /짱/);
  assert.equal(screen.render(img, 4, 2, [{ row: 1, col: 0, text: '짱', fg: 0xffffff }]), '');
  img.rect(3, 0, 1, 2, 0x00ff00);
  const diff = screen.render(img, 4, 2, [{ row: 1, col: 0, text: '짱', fg: 0xffffff }]);
  assert.match(diff, /\x1b\[1;4H/);
  assert.doesNotMatch(diff, /짱/);
});

test('a short, wide viewport puts the lounge beside the desks', () => {
  const ws = [1, 2, 3].map((n) => ({ id: `w${n}`, label: `w${n}`, number: n, focused: false }));
  const seats = new Map(ws.map((w) => [w.id, ['p1']]));
  const p = plan(ws, seats, 340, 30, { w: 1, h: 2 }, undefined, [0.25, 0.125]);
  assert.ok(p.totalRows <= 30);
  const room = p.rooms[0];
  assert.ok(room.lounge.x0 > room.slots[0].cx);
});
