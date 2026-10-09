/**
 * Where room images go. Inside herdr we use its pane graphics API
 * (`pane.graphics.set`, one layer per room), which herdr composes itself and
 * keeps across redraws; outside herdr we fall back to raw kitty escapes.
 */
import { request } from './herdr.ts';
import { kittyDelete, kittyDeleteAll, kittyPlacePng } from './term.ts';

export interface Placement {
  col: number;
  row: number;
  cols: number;
  rows: number;
}

export interface Graphics {
  readonly maxLayers: number;
  show(layer: string, png: Buffer, width: number, height: number, at: Placement): void;
  clear(layer: string): void;
  clearAll(): void;
}

/** herdr pane graphics: requests are coalesced per layer (latest frame wins). */
export class HerdrGraphics implements Graphics {
  readonly maxLayers: number;
  private readonly socket: string;
  private readonly paneId: string;
  private readonly log: (msg: string) => void;
  private inflight = new Set<string>();
  private pending = new Map<string, Record<string, unknown> | null>();
  private errors = 0;

  constructor(socket: string, paneId: string, maxLayers: number, log: (msg: string) => void) {
    this.socket = socket;
    this.paneId = paneId;
    this.maxLayers = maxLayers;
    this.log = log;
  }

  static async probe(
    socket: string,
    paneId: string,
    log: (msg: string) => void,
  ): Promise<{ graphics: HerdrGraphics; cell: { w: number; h: number } } | null> {
    try {
      const info = (await request(socket, 'pane.graphics.info', { pane_id: paneId })) as Record<
        string,
        unknown
      >;
      const w = Number(info.cell_width_px);
      const h = Number(info.cell_height_px);
      const layers = Number(info.max_layers_per_pane) || 16;
      if (!(w > 0 && h > 0)) return null;
      return { graphics: new HerdrGraphics(socket, paneId, layers, log), cell: { w, h } };
    } catch (err) {
      log(`pane.graphics unavailable: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  show(layer: string, png: Buffer, width: number, height: number, at: Placement): void {
    this.enqueue(layer, {
      pane_id: this.paneId,
      layer_id: layer,
      format: 'png',
      image_width: width,
      image_height: height,
      data_base64: png.toString('base64'),
      z_index: -1,
      placement: {
        viewport_col: at.col,
        viewport_row: at.row,
        grid_cols: at.cols,
        grid_rows: at.rows,
      },
    });
  }

  clear(layer: string): void {
    this.enqueue(layer, null);
  }

  clearAll(): void {
    this.pending.clear();
    void request(this.socket, 'pane.graphics.clear', { pane_id: this.paneId }).catch(
      () => undefined,
    );
  }

  private enqueue(layer: string, params: Record<string, unknown> | null): void {
    this.pending.set(layer, params);
    if (!this.inflight.has(layer)) this.flush(layer);
  }

  private flush(layer: string): void {
    if (!this.pending.has(layer)) return;
    const params = this.pending.get(layer) ?? null;
    this.pending.delete(layer);
    this.inflight.add(layer);
    const req = params
      ? request(this.socket, 'pane.graphics.set', params, 5000)
      : request(this.socket, 'pane.graphics.clear', { pane_id: this.paneId, layer_id: layer });
    req
      .catch((err) => {
        if (this.errors++ < 5)
          this.log(`pane.graphics ${layer}: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        this.inflight.delete(layer);
        this.flush(layer);
      });
  }
}

/** Plain kitty graphics on stdout (for running outside herdr). */
export class KittyGraphics implements Graphics {
  readonly maxLayers = 64;
  private readonly write: (s: string) => void;
  private ids = new Map<string, number>();
  private next = 1;

  constructor(write: (s: string) => void) {
    this.write = write;
  }

  show(layer: string, png: Buffer, _w: number, _h: number, at: Placement): void {
    const id = this.next++;
    let out = kittyPlacePng(png, { id, ...at });
    const prev = this.ids.get(layer);
    if (prev) out += kittyDelete(prev);
    this.ids.set(layer, id);
    this.write(out);
  }

  clear(layer: string): void {
    const prev = this.ids.get(layer);
    if (prev) this.write(kittyDelete(prev));
    this.ids.delete(layer);
  }

  clearAll(): void {
    this.ids.clear();
    this.write(kittyDeleteAll());
  }
}
