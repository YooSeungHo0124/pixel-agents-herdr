#!/usr/bin/env node
/**
 * herdr-office: a pixel office inside a herdr pane. Every herdr workspace is a
 * room; every agent herdr detects is a character acting out its status.
 *
 *   herdr-office [--demo] [--socket PATH] [--characters DIR] [--scale 1|0.75|0.5]
 *                [--all-workspaces] [--cell WxH] [--frame-file PNG]
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { OfficeApp } from './app.ts';
import { DemoSource, HerdrSource, resolveSocketPath, type Source } from './herdr.ts';
import type { Cell } from './layout.ts';

const HOME_DIR = path.join(os.homedir(), '.herdr-office');
const HERE = path.dirname(fileURLToPath(import.meta.url));

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function has(name: string): boolean {
  return process.argv.includes(name);
}

if (has('--help') || has('-h')) {
  console.log(`herdr-office — herdr 워크스페이스를 방으로, 에이전트를 캐릭터로 보여주는 픽셀 오피스

  --demo               herdr 없이 가짜 에이전트로 실행
  --socket PATH        herdr 소켓 (기본: $HERDR_SOCKET_PATH 또는 ~/.config/herdr/herdr.sock)
  --characters DIR     캐릭터 시트 폴더 (기본: ~/.herdr-office/characters)
  --scale S            캐릭터 크기 고정 (1, 0.75, 0.5, 0.375)
  --all-workspaces     에이전트 없는 워크스페이스도 방으로 표시
  --cell WxH           터미널 셀 픽셀 크기 (자동 감지 실패 시)
  --blocks             글자(반블록) 모드 강제: 어떤 터미널에서도 보임 (GNOME Terminal 등)
  --graphics           이미지 모드 강제: kitty 같은 이미지 지원 터미널에서만 보임
  --kitty              이미지 모드 + herdr pane.graphics 대신 kitty 이스케이프로 직접 그리기
  --frame-file PNG     (디버그) 화면을 PNG로 주기적으로 저장

  조작: 캐릭터 클릭 → 그 pane으로 이동 · Tab/화살표 + Enter · 휠/PgUp/PgDn 스크롤 · +/-/0 크기 · g 글자/이미지 모드 전환 · q 종료`);
  process.exit(0);
}

fs.mkdirSync(HOME_DIR, { recursive: true });
const logFile = path.join(HOME_DIR, 'office.log');
const log = (msg: string): void => {
  try {
    fs.appendFileSync(logFile, `${new Date().toISOString()} ${msg}\n`);
  } catch {
    // logging is best effort
  }
};

const hostSocket = process.env.HERDR_SOCKET_PATH?.trim();
const hostPane = process.env.HERDR_PANE_ID?.trim();
const host =
  hostSocket && hostPane && !has('--kitty') ? { socket: hostSocket, paneId: hostPane } : undefined;

let source: Source;
if (has('--demo')) source = new DemoSource();
else {
  const socket = arg('--socket') ?? resolveSocketPath();
  if (!socket) {
    console.error(
      'herdr 소켓을 찾을 수 없습니다. herdr 안에서 실행하거나 --socket 을 주세요 (또는 --demo).',
    );
    process.exit(1);
  }
  source = new HerdrSource(socket);
}

let cell: Cell | undefined;
const cellArg = arg('--cell') ?? process.env.HERDR_OFFICE_CELL;
if (cellArg) {
  const m = /^(\d+)x(\d+)$/.exec(cellArg);
  if (m) cell = { w: Number(m[1]), h: Number(m[2]) };
}

const characterDirs = [
  arg('--characters') ?? path.join(HOME_DIR, 'characters'),
  // Fallback: the stock pixel-agents cast that ships in this repo.
  path.join(HERE, '..', '..', 'webview-ui', 'public', 'assets', 'characters'),
];

const scaleArg = arg('--scale');
const app = new OfficeApp({
  source,
  characterDirs,
  log,
  cell,
  scale: scaleArg ? Number(scaleArg) : undefined,
  allWorkspaces: has('--all-workspaces'),
  frameFile: arg('--frame-file'),
  host,
  mode: has('--blocks') ? 'blocks' : has('--graphics') || has('--kitty') ? 'graphics' : 'auto',
  onExit: () => {
    app.stop();
    process.exit(0);
  },
});

process.on('SIGTERM', () => {
  app.stop();
  process.exit(0);
});
process.on('uncaughtException', (err) => {
  log(`crash: ${err.stack ?? err}`);
  app.stop();
  console.error(err);
  process.exit(1);
});

app.start().catch((err) => {
  app.stop();
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
