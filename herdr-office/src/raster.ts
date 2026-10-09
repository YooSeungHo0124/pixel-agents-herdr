/** A tiny RGBA framebuffer with the handful of drawing ops the office needs. */

export type Rgb = number; // 0xRRGGBB

export class Img {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;

  constructor(width: number, height: number, data?: Uint8Array) {
    this.width = width;
    this.height = height;
    this.data = data ?? new Uint8Array(width * height * 4);
  }

  clone(): Img {
    return new Img(this.width, this.height, this.data.slice());
  }

  /** Overwrite this image with `src` (same size). */
  copyFrom(src: Img): void {
    this.data.set(src.data);
  }

  /** Fill a rectangle; alpha < 1 blends over what is there. Clipped. */
  rect(x: number, y: number, w: number, h: number, color: Rgb, alpha = 1): void {
    const x0 = Math.max(0, Math.round(x));
    const y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(this.width, Math.round(x + w));
    const y1 = Math.min(this.height, Math.round(y + h));
    if (x1 <= x0 || y1 <= y0) return;
    const r = (color >> 16) & 255;
    const g = (color >> 8) & 255;
    const b = color & 255;
    const d = this.data;
    if (alpha >= 1) {
      for (let yy = y0; yy < y1; yy++) {
        let o = (yy * this.width + x0) * 4;
        for (let xx = x0; xx < x1; xx++, o += 4) {
          d[o] = r;
          d[o + 1] = g;
          d[o + 2] = b;
          d[o + 3] = 255;
        }
      }
      return;
    }
    const ia = 1 - alpha;
    for (let yy = y0; yy < y1; yy++) {
      let o = (yy * this.width + x0) * 4;
      for (let xx = x0; xx < x1; xx++, o += 4) {
        d[o] = d[o] * ia + r * alpha;
        d[o + 1] = d[o + 1] * ia + g * alpha;
        d[o + 2] = d[o + 2] * ia + b * alpha;
        d[o + 3] = Math.max(d[o + 3], alpha * 255);
      }
    }
  }

  /** Filled ellipse inside the given box. */
  ellipse(x: number, y: number, w: number, h: number, color: Rgb, alpha = 1): void {
    const cx = x + w / 2;
    const cy = y + h / 2;
    const rx = w / 2;
    const ry = h / 2;
    for (let yy = Math.floor(y); yy < Math.ceil(y + h); yy++) {
      const dy = (yy + 0.5 - cy) / ry;
      if (Math.abs(dy) > 1) continue;
      const half = rx * Math.sqrt(1 - dy * dy);
      this.rect(Math.round(cx - half), yy, Math.round(half * 2), 1, color, alpha);
    }
  }

  /**
   * Alpha-composite `src` at (dx, dy). `flip` mirrors horizontally, `alpha`
   * fades the whole sprite, `silhouette` paints every opaque pixel one colour.
   */
  blit(
    src: Img,
    dx: number,
    dy: number,
    opts: { flip?: boolean; alpha?: number; silhouette?: Rgb } = {},
  ): void {
    dx = Math.round(dx);
    dy = Math.round(dy);
    const fade = opts.alpha ?? 1;
    const sil = opts.silhouette;
    const sr = sil === undefined ? 0 : (sil >> 16) & 255;
    const sg = sil === undefined ? 0 : (sil >> 8) & 255;
    const sb = sil === undefined ? 0 : sil & 255;
    const x0 = Math.max(0, -dx);
    const y0 = Math.max(0, -dy);
    const x1 = Math.min(src.width, this.width - dx);
    const y1 = Math.min(src.height, this.height - dy);
    const s = src.data;
    const d = this.data;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const sx = opts.flip ? src.width - 1 - x : x;
        const so = (y * src.width + sx) * 4;
        const a = (s[so + 3] / 255) * fade;
        if (a <= 0.01) continue;
        const o = ((y + dy) * this.width + x + dx) * 4;
        const r = sil === undefined ? s[so] : sr;
        const g = sil === undefined ? s[so + 1] : sg;
        const b = sil === undefined ? s[so + 2] : sb;
        if (a >= 0.99) {
          d[o] = r;
          d[o + 1] = g;
          d[o + 2] = b;
          d[o + 3] = 255;
        } else {
          const ia = 1 - a;
          d[o] = d[o] * ia + r * a;
          d[o + 1] = d[o + 1] * ia + g * a;
          d[o + 2] = d[o + 2] * ia + b * a;
          d[o + 3] = Math.max(d[o + 3], a * 255);
        }
      }
    }
  }

  crop(x: number, y: number, w: number, h: number): Img {
    const out = new Img(w, h);
    for (let yy = 0; yy < h; yy++) {
      const sy = y + yy;
      if (sy < 0 || sy >= this.height) continue;
      const sx0 = Math.max(0, x);
      const sx1 = Math.min(this.width, x + w);
      if (sx1 <= sx0) continue;
      out.data.set(
        this.data.subarray((sy * this.width + sx0) * 4, (sy * this.width + sx1) * 4),
        (yy * w + (sx0 - x)) * 4,
      );
    }
    return out;
  }
}

/**
 * Resize by area averaging (premultiplied alpha), which keeps thin pixel-art
 * features that nearest-neighbour would drop when shrinking. Alpha is snapped
 * to 0/255 so sprite edges stay hard.
 */
export function scaleArea(src: Img, factor: number): Img {
  if (factor === 1) return src.clone();
  const w = Math.max(1, Math.round(src.width * factor));
  const h = Math.max(1, Math.round(src.height * factor));
  const out = new Img(w, h);
  const s = src.data;
  const d = out.data;
  for (let y = 0; y < h; y++) {
    const sy0 = (y * src.height) / h;
    const sy1 = ((y + 1) * src.height) / h;
    for (let x = 0; x < w; x++) {
      const sx0 = (x * src.width) / w;
      const sx1 = ((x + 1) * src.width) / w;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let area = 0;
      for (let yy = Math.floor(sy0); yy < Math.ceil(sy1); yy++) {
        const wy = Math.min(yy + 1, sy1) - Math.max(yy, sy0);
        for (let xx = Math.floor(sx0); xx < Math.ceil(sx1); xx++) {
          const wx = Math.min(xx + 1, sx1) - Math.max(xx, sx0);
          const wgt = wx * wy;
          const o = (yy * src.width + xx) * 4;
          const pa = s[o + 3] / 255;
          r += s[o] * pa * wgt;
          g += s[o + 1] * pa * wgt;
          b += s[o + 2] * pa * wgt;
          a += pa * wgt;
          area += wgt;
        }
      }
      const o = (y * w + x) * 4;
      const cover = a / area;
      if (cover < 0.45) continue;
      d[o] = r / a;
      d[o + 1] = g / a;
      d[o + 2] = b / a;
      d[o + 3] = 255;
    }
  }
  return out;
}

/** Integer nearest-neighbour upscale (crisp pixel art). */
export function scaleNearest(src: Img, k: number): Img {
  if (k === 1) return src.clone();
  const out = new Img(src.width * k, src.height * k);
  for (let y = 0; y < out.height; y++) {
    const sy = Math.floor(y / k);
    for (let x = 0; x < out.width; x++) {
      const so = (sy * src.width + Math.floor(x / k)) * 4;
      const o = (y * out.width + x) * 4;
      out.data[o] = src.data[so];
      out.data[o + 1] = src.data[so + 1];
      out.data[o + 2] = src.data[so + 2];
      out.data[o + 3] = src.data[so + 3];
    }
  }
  return out;
}

/** Opaque bounding box of an image, or null when fully transparent. */
export function opaqueBounds(img: Img): { x: number; y: number; w: number; h: number } | null {
  let minX = img.width;
  let minY = img.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (img.data[(y * img.width + x) * 4 + 3] < 128) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}
