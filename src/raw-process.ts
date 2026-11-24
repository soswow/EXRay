/**
 * Pure RAW processing helpers (no LibRaw): CFA cells, orientation, masked-pixel noise,
 * demosaicing.
 *
 * Mosaic data is described by a repeating cell of cw × ch photosites anchored at the top-left
 * visible pixel; `site` gives each cell's color as 0 R, 1 G, 2 B.
 */
function gcd(a: number, b: number): number {
  return b ? gcd(b, a % b) : a;
}
export const lcm = (a: number, b: number) => (a / gcd(a, b)) * b;

/** Smallest cell (dividing cw × ch) over which `same(x, y, x % w, y % h)` holds everywhere. */
export function minimalPeriod(cw: number, ch: number, key: (x: number, y: number) => string): { w: number; h: number } {
  const ok = (w: number, h: number) => {
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) if (key(x, y) !== key(x % w, y % h)) return false;
    return true;
  };
  let bw = cw, bh = ch;
  for (let w = 1; w <= cw; w++) {
    if (cw % w) continue;
    for (let h = 1; h <= ch; h++) {
      if (ch % h || w * h >= bw * bh) continue;
      if (ok(w, h)) [bw, bh] = [w, h];
    }
  }
  return { w: bw, h: bh };
}

export function patternName(colors: number[], w: number, h: number, xtrans: boolean): string {
  if (xtrans) return 'X-Trans';
  if (w === 2 && h === 2) return colors.map((c) => 'RGBG'[c] ?? '?').join('');
  return `${w}×${h} CFA`;
}

// ---------- orientation ----------

/**
 * LibRaw's `flip`: 0 none, 3 rotate 180°, 5 rotate 90° counter-clockwise, 6 rotate 90° clockwise.
 * Returns the source coordinate for a destination pixel, and the destination size.
 */
export function orientation(flip: number, W: number, H: number) {
  switch (flip) {
    case 3:
      return { w: W, h: H, src: (x: number, y: number) => [W - 1 - x, H - 1 - y] as const };
    case 5:
      return { w: H, h: W, src: (x: number, y: number) => [W - 1 - y, x] as const };
    case 6:
      return { w: H, h: W, src: (x: number, y: number) => [y, H - 1 - x] as const };
    default:
      return null;
  }
}

/** Rotates interleaved 16-bit pixels (n values each). */
export function orientPixels<T extends Uint16Array<ArrayBuffer>>(src: T, W: number, H: number, n: number, flip: number): Uint16Array<ArrayBuffer> {
  const o = orientation(flip, W, H);
  if (!o) return src;
  const dst = new Uint16Array(src.length);
  for (let y = 0; y < o.h; y++) {
    for (let x = 0; x < o.w; x++) {
      const [sx, sy] = o.src(x, y);
      const s = (sy * W + sx) * n, d = (y * o.w + x) * n;
      for (let c = 0; c < n; c++) dst[d + c] = src[s + c];
    }
  }
  return dst;
}

/** The CFA cell as seen after rotating the image; values per cell are carried along. */
export function orientCell<T>(cell: T[], cw: number, ch: number, W: number, H: number, flip: number) {
  const o = orientation(flip, W, H);
  if (!o) return { cell, cw, ch };
  const [nw, nh] = o.w === W ? [cw, ch] : [ch, cw];
  const out: T[] = [];
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      const [sx, sy] = o.src(x, y);
      out.push(cell[(((sy % ch) + ch) % ch) * cw + (((sx % cw) + cw) % cw)]);
    }
  }
  return { cell: out, cw: nw, ch: nh };
}

// ---------- noise from masked (optical black) pixels ----------

export interface MaskedNoise {
  /** Robust standard deviation (MAD × 1.4826) of masked photosites, in DN, pooled over CFA cells. */
  sigma: number;
  pixels: number;
  region: string;
  /** Mean DN and photosite count per CFA cell (same cell indexing as `cellIndex`). */
  cellMean: number[];
  cellCount: number[];
}

/** A rectangle of masked photosites, in raw coordinates; x1/y1 exclusive. */
export interface MaskedRegion {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  name: string;
}

/**
 * Masked border regions: the camera's own optical-black areas when known, else LibRaw's left
 * and top margins. Rows/columns within `guard` of an edge are skipped, since they often hold
 * transition or dummy values.
 */
export function maskedRegions(
  rawW: number,
  rawH: number,
  left: number,
  top: number,
  known: { x: number; y: number; w: number; h: number; name: string }[],
  guard = 4,
): MaskedRegion[] {
  const out: MaskedRegion[] = [];
  const add = (x0: number, x1: number, y0: number, y1: number, name: string) => {
    if (x1 - x0 - 2 * guard >= 8 && y1 - y0 - 2 * guard >= 8) out.push({ x0: x0 + guard, x1: x1 - guard, y0: y0 + guard, y1: y1 - guard, name });
  };
  if (known.length) for (const k of known) add(k.x, k.x + k.w, k.y, k.y + k.h, k.name);
  else {
    add(0, left, top, rawH, `left ${left} px (LibRaw margin)`);
    add(left, rawW, 0, top, `top ${top} px (LibRaw margin)`);
  }
  return out;
}

/** Estimates read noise and per-cell black from masked photosites, which receive no light. */
export function maskedNoise(
  raw: Uint16Array,
  rawW: number,
  regions: MaskedRegion[],
  cellIndex: (x: number, y: number) => number,
  cells: number,
): MaskedNoise | null {
  if (!regions.length) return null;
  // Per-cell histograms of DN, so median and MAD are exact.
  const hists = Array.from({ length: cells }, () => new Uint32Array(65536));
  const counts = new Array(cells).fill(0);
  let pixels = 0;
  for (const r of regions) {
    for (let y = r.y0; y < r.y1; y++) {
      for (let x = r.x0; x < r.x1; x++) {
        const c = cellIndex(x, y);
        hists[c][raw[y * rawW + x]]++;
        counts[c]++;
        pixels++;
      }
    }
  }
  if (pixels < 2000) return null;

  const quantile = (h: Uint32Array, n: number, q: number) => {
    const target = q * (n - 1);
    let acc = 0;
    for (let v = 0; v < h.length; v++) {
      acc += h[v];
      if (acc > target) return v;
    }
    return h.length - 1;
  };
  let varSum = 0, used = 0;
  const cellMean: number[] = [];
  for (let c = 0; c < cells; c++) {
    const n = counts[c], h = hists[c];
    let s = 0, s2 = 0;
    for (let v = 0; v < 65536; v++) if (h[v]) { s += v * h[v]; s2 += v * v * h[v]; }
    cellMean.push(n ? s / n : NaN);
    if (n < 100) continue;
    const med = quantile(h, n, 0.5);
    // MAD from a histogram of |v - med|.
    const dev = new Uint32Array(65536);
    for (let v = 0; v < 65536; v++) if (h[v]) dev[Math.abs(v - med)] += h[v];
    const mad = quantile(dev, n, 0.5);
    // With integer data and very low noise the MAD can be 0; fall back to the standard deviation.
    let sigma = mad * 1.4826;
    if (sigma < 0.5) sigma = Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2));
    varSum += sigma * sigma * n;
    used += n;
  }
  if (!used) return null;
  return { sigma: Math.sqrt(varSum / used), pixels, region: regions.map((r) => r.name).join(' + '), cellMean, cellCount: counts };
}

/** The same repeating cell, re-anchored so that its (0, 0) is the old cell's (ox, oy). */
export function shiftCell<T>(cell: T[], cw: number, ch: number, ox: number, oy: number): T[] {
  const out: T[] = [];
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) out.push(cell[(((y + oy) % ch) + ch) % ch * cw + ((((x + ox) % cw) + cw) % cw)]);
  }
  return out;
}

// ---------- demosaic ----------

/**
 * Generic bilinear-style demosaic that works for any CFA: each missing color is the mean of the
 * same-colored photosites in the 3×3 neighborhood (5×5 if there are none). For Bayer this is
 * exactly bilinear interpolation.
 *
 * `norm` holds the photosite values (rows top-down) at stride `inStride`, so it can live in the
 * output's alpha lane. Writes R, G, B of `out` (rows bottom-up unless `topDown`); alpha is left
 * for the caller.
 */
export function demosaic(
  norm: Float32Array,
  inStride: number,
  inOffset: number,
  W: number,
  H: number,
  site: number[],
  cw: number,
  ch: number,
  out: Float32Array,
  topDown = false,
) {
  // Per cell and color: the neighbor offsets to average.
  const offsets: { dx: number[]; dy: number[]; idx: Int32Array }[] = [];
  for (let cy = 0; cy < ch; cy++) {
    for (let cx = 0; cx < cw; cx++) {
      for (let k = 0; k < 3; k++) {
        const dx: number[] = [], dy: number[] = [];
        if (site[cy * cw + cx] === k) {
          dx.push(0);
          dy.push(0);
        } else {
          for (let r = 1; r <= 2 && !dx.length; r++) {
            for (let oy = -r; oy <= r; oy++) {
              for (let ox = -r; ox <= r; ox++) {
                const sx = (((cx + ox) % cw) + cw) % cw, sy = (((cy + oy) % ch) + ch) % ch;
                if (site[sy * cw + sx] === k) {
                  dx.push(ox);
                  dy.push(oy);
                }
              }
            }
          }
        }
        offsets.push({ dx, dy, idx: Int32Array.from(dx.map((x, i) => (dy[i] * W + x) * inStride)) });
      }
    }
  }

  // Only the R, G and B lanes are written, so input stored in the alpha lane stays intact.
  for (let y = 0; y < H; y++) {
    const outRow = (topDown ? y : H - 1 - y) * W * 4, cy = (y % ch) * cw;
    const yInner = y >= 2 && y < H - 2;
    for (let x = 0; x < W; x++) {
      const p = (y * W + x) * inStride + inOffset, o = outRow + x * 4, cell = (cy + (x % cw)) * 3;
      if (yInner && x >= 2 && x < W - 2) {
        for (let k = 0; k < 3; k++) {
          const idx = offsets[cell + k].idx, n = idx.length;
          if (n === 1) {
            out[o + k] = norm[p + idx[0]];
          } else {
            let s = 0;
            for (let j = 0; j < n; j++) s += norm[p + idx[j]];
            out[o + k] = s / n;
          }
        }
      } else {
        for (let k = 0; k < 3; k++) {
          const { dx, dy } = offsets[cell + k];
          let s = 0, n = 0;
          for (let j = 0; j < dx.length; j++) {
            const xx = x + dx[j], yy = y + dy[j];
            if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
            s += norm[(yy * W + xx) * inStride + inOffset];
            n++;
          }
          // Near corners every usual neighbor can be outside the image (e.g. X-Trans):
          // widen the search until a photosite of this color turns up.
          for (let r = 1; !n && r <= 6; r++) {
            for (let yy = Math.max(0, y - r); yy <= Math.min(H - 1, y + r); yy++) {
              for (let xx = Math.max(0, x - r); xx <= Math.min(W - 1, x + r); xx++) {
                if (site[(yy % ch) * cw + (xx % cw)] !== k) continue;
                s += norm[(yy * W + xx) * inStride + inOffset];
                n++;
              }
            }
          }
          out[o + k] = n ? s / n : 0;
        }
      }
    }
  }
}
