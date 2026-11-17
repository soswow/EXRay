/** False-color maps, baked into 256-entry RGBA8 LUTs shared by the image shader and the histogram. */

export type ColormapId = 'turbo' | 'viridis' | 'inferno' | 'gray';
type Fn = (t: number) => [number, number, number];

// Google's polynomial approximation of Turbo (Apache-2.0, Anton Mikhailov / Ruofei Du).
const turbo: Fn = (x) => {
  const v4 = [1, x, x * x, x * x * x];
  const v2 = [v4[2] * v4[2], v4[3] * v4[2]];
  const dot4 = (a: number[]) => a[0] * v4[0] + a[1] * v4[1] + a[2] * v4[2] + a[3] * v4[3];
  const dot2 = (a: number[]) => a[0] * v2[0] + a[1] * v2[1];
  return [
    dot4([0.13572138, 4.6153926, -42.66032258, 132.13108234]) + dot2([-152.94239396, 59.28637943]),
    dot4([0.09140261, 2.19418839, 4.84296658, -14.18503333]) + dot2([4.27729857, 2.82956604]),
    dot4([0.1066733, 12.64194608, -60.58204836, 110.36276771]) + dot2([-89.90310912, 27.34824973]),
  ];
};

// Polynomial fits of the matplotlib maps (CC0, Matt Zucker).
const poly = (c: number[][]): Fn => (t) => {
  const out: [number, number, number] = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    let v = c[6][k];
    for (let i = 5; i >= 0; i--) v = c[i][k] + t * v;
    out[k] = v;
  }
  return out;
};

const viridis = poly([
  [0.2777273272234177, 0.005407344544966578, 0.3340998053353061],
  [0.1050930431085774, 1.404613529898575, 1.384590162594685],
  [-0.3308618287255563, 0.214847559468213, 0.09509516302823659],
  [-4.634230498983486, -5.799100973351585, -19.33244095627987],
  [6.228269936347081, 14.17993336680509, 56.69055260068105],
  [4.776384997670288, -13.74514537774601, -65.35303263337234],
  [-5.435455855934631, 4.645852612178535, 26.3124352495832],
]);

const inferno = poly([
  [0.0002189403691192265, 0.001651004631001012, -0.01948089843709184],
  [0.1065134194856116, 0.5639564367884091, 3.932712388889277],
  [11.60249308247187, -3.972853965665698, -15.9423941062914],
  [-41.70399613139459, 17.43639888205313, 44.35414519872813],
  [77.162935699427, -33.40235894210092, -81.80730925738993],
  [-71.31942824499214, 32.62606426397723, 73.20951985803202],
  [25.13112622477341, -12.24266895238567, -23.07032500287172],
]);

const gray: Fn = (t) => [t, t, t];

export const COLORMAPS: Record<ColormapId, { label: string; fn: Fn }> = {
  turbo: { label: 'Turbo', fn: turbo },
  viridis: { label: 'Viridis', fn: viridis },
  inferno: { label: 'Inferno', fn: inferno },
  gray: { label: 'Gray', fn: gray },
};

const cache = new Map<ColormapId, Uint8Array>();

export function colormapLut(id: ColormapId): Uint8Array {
  let lut = cache.get(id);
  if (!lut) {
    lut = new Uint8Array(256 * 4);
    const fn = COLORMAPS[id].fn;
    for (let i = 0; i < 256; i++) {
      const c = fn(i / 255);
      for (let k = 0; k < 3; k++) lut[i * 4 + k] = Math.round(Math.min(1, Math.max(0, c[k])) * 255);
      lut[i * 4 + 3] = 255;
    }
    cache.set(id, lut);
  }
  return lut;
}

/** CSS color for t in [0, 1]. */
export function colormapCss(lut: Uint8Array, t: number): string {
  const i = Math.round(Math.min(1, Math.max(0, t)) * 255) * 4;
  return `rgb(${lut[i]},${lut[i + 1]},${lut[i + 2]})`;
}
