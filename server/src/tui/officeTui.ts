import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PNG } from 'pngjs';

import {
  contentBounds,
  enterScreen,
  type InputEvent,
  kittyDelete,
  kittyDeleteAll,
  kittyQuery,
  kittyShowPng,
  leaveScreen,
  type MouseEvent,
  parseInput,
  renderHalfBlocks,
} from './terminalProtocol.js';

/**
 * The office, drawn inside a terminal pane.
 *
 * A headless Chrome loads the same SPA the browser would (tokened URL, so
 * clicks are privileged and focus herdr panes), and every frame is copied to
 * the terminal: as a real image through the kitty graphics protocol when the
 * terminal supports it (herdr does), else as truecolor half-block cells. Mouse
 * and keys are forwarded back to the page, so hover labels, click-to-focus,
 * zoom, the layout editor and settings all keep working.
 */

/** Minimal slice of playwright-core we use; loaded lazily so the server never needs it. */
interface PwMouse {
  move(x: number, y: number): Promise<void>;
  down(o: { button: 'left' | 'middle' | 'right' }): Promise<void>;
  up(o: { button: 'left' | 'middle' | 'right' }): Promise<void>;
  wheel(dx: number, dy: number): Promise<void>;
}
interface PwPage {
  goto(url: string): Promise<unknown>;
  setViewportSize(s: { width: number; height: number }): Promise<void>;
  screenshot(o: { type: 'png' }): Promise<Buffer>;
  waitForSelector(sel: string, o: { timeout: number }): Promise<unknown>;
  addStyleTag(o: { content: string }): Promise<unknown>;
  mouse: PwMouse;
  keyboard: {
    press(key: string): Promise<void>;
    down(key: string): Promise<void>;
    up(key: string): Promise<void>;
  };
}
interface PwContext {
  pages(): PwPage[];
  newPage(): Promise<PwPage>;
  close(): Promise<void>;
}

export type TuiMode = 'kitty' | 'blocks';

export interface OfficeTuiOptions {
  url: string;
  /** Force a renderer instead of detecting kitty graphics support. */
  mode?: TuiMode;
  log: (msg: string) => void;
  /** Called when the user quits (Ctrl+C / Ctrl+Q). */
  onQuit: () => void;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
}

/** Page pixels per terminal cell. Kitty scales the image into the cells, so
 *  only the aspect matters there; blocks mode samples 1:1 at the default zoom. */
const CELL_PX: Record<TuiMode, { w: number; h: number }> = {
  kitty: cellFromEnv() ?? { w: 10, h: 20 },
  blocks: { w: 2, h: 4 },
};
const FRAME_INTERVAL_MS: Record<TuiMode, number> = { kitty: 150, blocks: 120 };
const KITTY_DETECT_MS = 600;
/** Ctrl+wheel steps that take any saved zoom down to the minimum (1x). */
const BLOCKS_ZOOM_OUT_STEPS = 10;
const CENTER_PASSES = 3;
const CENTER_SETTLE_MS = 400;
const KITTY_SCALE = Number(process.env.PIXEL_AGENTS_TUI_SCALE) || 2;
/** Debug aid: also write every drawn frame to this PNG path. */
const DEBUG_FRAME_FILE = process.env.PIXEL_AGENTS_TUI_FRAME_FILE;

function cellFromEnv(): { w: number; h: number } | undefined {
  const m = /^(\d+)x(\d+)$/.exec(process.env.PIXEL_AGENTS_TUI_CELL ?? '');
  return m ? { w: Number(m[1]), h: Number(m[2]) } : undefined;
}

const BUTTONS = ['left', 'middle', 'right'] as const;

export class OfficeTui {
  private readonly opts: OfficeTuiOptions;
  private readonly stdin: NodeJS.ReadStream;
  private readonly stdout: NodeJS.WriteStream;
  private mode: TuiMode = 'blocks';
  private context: PwContext | null = null;
  private page: PwPage | null = null;
  private stopped = false;
  private frameTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPng: Buffer | null = null;
  private kittyId = 1;
  private cells: Uint32Array | null = null;
  private pendingMove: MouseEvent | null = null;
  private inputChain: Promise<void> = Promise.resolve();
  private readonly onData = (d: Buffer): void => this.handleInput(d.toString('latin1'));
  private readonly onResize = (): void => void this.applySize();

  constructor(opts: OfficeTuiOptions) {
    this.opts = opts;
    this.stdin = opts.stdin ?? process.stdin;
    this.stdout = opts.stdout ?? process.stdout;
  }

  private get cols(): number {
    return Math.max(20, this.stdout.columns || 80);
  }
  private get rows(): number {
    return Math.max(8, this.stdout.rows || 24);
  }

  async start(): Promise<void> {
    if (this.stdin.isTTY) this.stdin.setRawMode(true);
    this.stdin.resume();
    this.stdout.write(enterScreen);
    this.status('Pixel Agents: starting office…');

    this.mode = this.opts.mode ?? (await this.detectKitty());
    this.opts.log(`[Pixel Agents] tui: renderer=${this.mode}`);
    this.stdin.on('data', this.onData);
    this.stdout.on('resize', this.onResize);

    try {
      await this.launchBrowser();
    } catch (err) {
      this.fail(
        `Could not start headless Chrome: ${err instanceof Error ? err.message : String(err)}\n` +
          `Set PIXEL_AGENTS_CHROME=/path/to/chrome, or run without --tui and open the URL.`,
      );
      return;
    }
    this.scheduleFrame(0);
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.frameTimer) clearTimeout(this.frameTimer);
    this.stdin.off('data', this.onData);
    this.stdout.off('resize', this.onResize);
    if (this.mode === 'kitty') this.stdout.write(kittyDeleteAll());
    this.stdout.write(leaveScreen);
    if (this.stdin.isTTY) this.stdin.setRawMode(false);
    this.stdin.pause();
    await this.context?.close().catch(() => {});
  }

  private status(text: string): void {
    this.stdout.write(`\x1b[2J\x1b[H\x1b[0m${text}`);
  }

  private fail(text: string): void {
    this.opts.log(`[Pixel Agents] tui: ${text}`);
    this.status(`${text}\r\n\r\nPress Ctrl+C to quit.`);
  }

  private detectKitty(): Promise<TuiMode> {
    return new Promise((resolve) => {
      let buf = '';
      const done = (mode: TuiMode): void => {
        clearTimeout(timer);
        this.stdin.off('data', listen);
        resolve(mode);
      };
      const listen = (d: Buffer): void => {
        buf += d.toString('latin1');
        if (parseInput(buf).some((e) => e.type === 'kittyOk')) done('kitty');
      };
      const timer = setTimeout(() => done('blocks'), KITTY_DETECT_MS);
      this.stdin.on('data', listen);
      this.stdout.write(kittyQuery);
    });
  }

  /** Device pixels per CSS pixel: kitty frames are sharp enough to render the
   *  UI at 2x, which also makes the office's default zoom (2×dpr) fill a pane. */
  private get scale(): number {
    return this.mode === 'kitty' ? KITTY_SCALE : 1;
  }

  /** CSS viewport whose device-pixel size is exactly cols×rows cells. */
  private viewport(): { width: number; height: number } {
    const cell = CELL_PX[this.mode];
    return {
      width: Math.round((this.cols * cell.w) / this.scale),
      height: Math.round((this.rows * cell.h) / this.scale),
    };
  }

  private async launchBrowser(): Promise<void> {
    // Lazy: playwright-core is only needed for --tui.
    const { chromium } = require('playwright-core') as {
      chromium: {
        launchPersistentContext(dir: string, o: Record<string, unknown>): Promise<PwContext>;
      };
    };
    const userDataDir = path.join(os.homedir(), '.pixel-agents', 'tui-browser');
    const base = { headless: true, viewport: this.viewport(), deviceScaleFactor: this.scale };
    const attempts: Array<Record<string, unknown>> = process.env.PIXEL_AGENTS_CHROME
      ? [{ ...base, executablePath: process.env.PIXEL_AGENTS_CHROME }]
      : [{ ...base, channel: 'chrome' }, base];
    let lastErr: unknown;
    for (const o of attempts) {
      try {
        this.context = await chromium.launchPersistentContext(userDataDir, o);
        break;
      } catch (err) {
        lastErr = err;
      }
    }
    if (!this.context) throw lastErr;
    this.page = this.context.pages()[0] ?? (await this.context.newPage());
    await this.page.goto(this.opts.url);
    await this.page.waitForSelector('canvas', { timeout: 15_000 }).catch(() => {});
    if (this.mode === 'blocks') await this.prepareBlocks(this.page);
  }

  /**
   * Half-block cells can't show the page's HTML text (labels, toolbars, toasts)
   * legibly, so only the office canvas is kept, zoomed out to fit the pane.
   */
  private async prepareBlocks(page: PwPage): Promise<void> {
    await page
      .addStyleTag({
        content:
          'html, body { background: var(--color-bg) !important; } ' +
          'body * { visibility: hidden !important; } canvas { visibility: visible !important; }',
      })
      .catch(() => {});
    const vp = this.viewport();
    await page.mouse.move(vp.width / 2, vp.height / 2);
    await page.keyboard.down('Control');
    for (let i = 0; i < BLOCKS_ZOOM_OUT_STEPS; i++) await page.mouse.wheel(0, 100);
    await page.keyboard.up('Control');
    await this.centerOffice(page);
  }

  /**
   * Pan so the office sits in the middle of the pane. The camera can start
   * off-centre (a remembered pan, or one kept across the zoom change), which
   * at 1x pushes half the office out of a short pane. A plain wheel pans by
   * delta×dpr and also cancels any camera follow.
   */
  private async centerOffice(page: PwPage): Promise<void> {
    for (let pass = 0; pass < CENTER_PASSES; pass++) {
      await new Promise((r) => setTimeout(r, CENTER_SETTLE_MS));
      const img = PNG.sync.read(await page.screenshot({ type: 'png' }));
      const box = contentBounds(img);
      if (!box) return;
      const dx = box.x + box.width / 2 - img.width / 2;
      const dy = box.y + box.height / 2 - img.height / 2;
      if (Math.abs(dx) < 2 && Math.abs(dy) < 2) return;
      await page.mouse.wheel(dx / this.scale, dy / this.scale);
    }
  }

  private async applySize(): Promise<void> {
    if (!this.page || this.stopped) return;
    this.lastPng = null;
    this.cells = null;
    this.stdout.write('\x1b[2J');
    await this.page.setViewportSize(this.viewport()).catch(() => {});
  }

  private scheduleFrame(delay: number): void {
    if (this.stopped) return;
    this.frameTimer = setTimeout(() => void this.frame(), delay);
  }

  private async frame(): Promise<void> {
    const started = Date.now();
    try {
      await this.flushMove();
      if (this.page) {
        const png = await this.page.screenshot({ type: 'png' });
        if (!this.stopped) this.draw(png);
      }
    } catch (err) {
      this.opts.log(
        `[Pixel Agents] tui: frame failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const spent = Date.now() - started;
    this.scheduleFrame(Math.max(0, FRAME_INTERVAL_MS[this.mode] - spent));
  }

  private draw(png: Buffer): void {
    if (this.lastPng && this.lastPng.equals(png)) return;
    // Wipe the "starting…" text once the first real frame arrives.
    if (!this.lastPng) this.stdout.write('\x1b[2J');
    this.lastPng = png;
    if (DEBUG_FRAME_FILE) fs.writeFile(DEBUG_FRAME_FILE, png, () => {});
    if (this.mode === 'kitty') {
      // Draw the new image before deleting the old one, so there is never a
      // blank frame between them.
      const prevId = this.kittyId;
      this.kittyId = prevId === 1 ? 2 : 1;
      this.stdout.write(
        kittyShowPng(png, { id: this.kittyId, cols: this.cols, rows: this.rows }) +
          kittyDelete(prevId),
      );
      return;
    }
    const img = PNG.sync.read(png);
    const { out, cells } = renderHalfBlocks(img, this.cols, this.rows, this.cells);
    this.cells = cells;
    if (out) this.stdout.write(out);
  }

  private handleInput(data: string): void {
    for (const ev of parseInput(data)) {
      if (ev.type === 'key' && ev.ctrl && (ev.key === 'c' || ev.key === 'q')) {
        this.opts.onQuit();
        return;
      }
      if (ev.type === 'mouse' && (ev.mouse.kind === 'move' || ev.mouse.kind === 'drag')) {
        // Coalesce motion: only the latest position matters.
        this.pendingMove = ev.mouse;
        if (ev.mouse.kind === 'move') continue;
      }
      this.enqueue(ev);
    }
  }

  /** Serialize page input so a click's down/up never interleave with a move. */
  private enqueue(ev: InputEvent): void {
    this.inputChain = this.inputChain
      .then(() => this.forward(ev))
      .catch((err) =>
        this.opts.log(
          `[Pixel Agents] tui: input failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
  }

  private toPage(m: MouseEvent): { x: number; y: number } {
    const cell = CELL_PX[this.mode];
    return {
      x: ((m.col + 0.5) * cell.w) / this.scale,
      y: ((m.row + 0.5) * cell.h) / this.scale,
    };
  }

  private async flushMove(): Promise<void> {
    const m = this.pendingMove;
    if (!m || !this.page) return;
    this.pendingMove = null;
    const p = this.toPage(m);
    await this.page.mouse.move(p.x, p.y);
  }

  private async forward(ev: InputEvent): Promise<void> {
    const page = this.page;
    if (!page) return;
    if (ev.type === 'key') {
      // +/- zoom without needing Ctrl+wheel, which terminals often keep for themselves.
      if (!ev.ctrl && (ev.key === '+' || ev.key === '=' || ev.key === '-')) {
        const vp = this.viewport();
        await page.mouse.move(vp.width / 2, vp.height / 2);
        await page.keyboard.down('Control');
        await page.mouse.wheel(0, ev.key === '-' ? 100 : -100);
        await page.keyboard.up('Control');
        return;
      }
      await page.keyboard.press(ev.ctrl ? `Control+${ev.key}` : ev.key);
      return;
    }
    if (ev.type !== 'mouse') return;
    const m = ev.mouse;
    const p = this.toPage(m);
    switch (m.kind) {
      case 'down':
      case 'up':
        await page.mouse.move(p.x, p.y);
        await page.mouse[m.kind]({ button: BUTTONS[m.button] ?? 'left' });
        break;
      case 'drag':
        await this.flushMove();
        break;
      case 'wheelUp':
      case 'wheelDown': {
        await page.mouse.move(p.x, p.y);
        const dy = m.kind === 'wheelUp' ? -100 : 100;
        if (m.ctrl) await page.keyboard.down('Control');
        await page.mouse.wheel(0, dy);
        if (m.ctrl) await page.keyboard.up('Control');
        break;
      }
      default:
        break;
    }
  }
}
