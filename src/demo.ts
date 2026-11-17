/**
 * A synthetic HDR test image with known values, so the app is usable without a file:
 *  - top band: a continuous log ramp spanning 2^-24 .. 2^16 (40 stops)
 *  - a row of 41 flat patches at exact powers of two (2^-24 .. 2^16)
 *  - a "scene": lit sphere, deep shadows, a sun with 1/r² glow and a noise floor
 *  - a strip of special values: 0, negatives, NaN, +Inf, denormals
 * Rows are written bottom-up to match the decoder output.
 */
export function makeDemoImage(width = 1920, height = 1080): Float32Array {
  const data = new Float32Array(width * height * 4);
  let seed = 1234567;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());

  const set = (x: number, yTop: number, r: number, g: number, b: number) => {
    const i = ((height - 1 - yTop) * width + x) * 4;
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = 1;
  };

  const rampH = Math.round(height * 0.12);
  const patchesTop = rampH + 10;
  const patchesH = Math.round(height * 0.1);
  const sceneTop = patchesTop + patchesH + 10;
  const specialsH = 40;
  const sceneBottom = height - specialsH - 10;

  // Sun and sphere positions in the scene area.
  const sunX = width * 0.78, sunY = sceneTop + (sceneBottom - sceneTop) * 0.25;
  const sphX = width * 0.35, sphY = sceneTop + (sceneBottom - sceneTop) * 0.55;
  const sphR = (sceneBottom - sceneTop) * 0.32;
  const L = normalize([0.6, -0.5, 0.62]);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (y < rampH) {
        // Continuous log ramp, slightly tinted per row so channels differ.
        const ev = -24 + (x / (width - 1)) * 40;
        const v = 2 ** ev;
        const tint = y / rampH;
        set(x, y, v * (1 + 0.5 * tint), v, v * (1 - 0.5 * tint));
      } else if (y < patchesTop || (y >= patchesTop + patchesH && y < sceneTop)) {
        set(x, y, 0, 0, 0);
      } else if (y < patchesTop + patchesH) {
        // 41 flat patches, separated by thin black gaps.
        const n = 41;
        const pw = width / n;
        const k = Math.floor(x / pw);
        const inGap = x - k * pw < 2;
        const v = inGap ? 0 : 2 ** (-24 + k);
        set(x, y, v, v, v);
      } else if (y < sceneBottom) {
        // Sky gradient with a noise floor.
        const sy = (y - sceneTop) / (sceneBottom - sceneTop);
        let r = 0.08 + 0.3 * (1 - sy), g = 0.12 + 0.45 * (1 - sy), b = 0.25 + 0.9 * (1 - sy);
        // Ground: deep shadow region.
        if (sy > 0.82) {
          const d = 2 ** (-10 + 6 * (1 - (sy - 0.82) / 0.18));
          r = d * 0.9;
          g = d * 0.8;
          b = d * 0.7;
        }
        // Sun: very bright core with 1/r² glow.
        const dx = x - sunX, dy = y - sunY;
        const d2 = dx * dx + dy * dy;
        const glow = 4000 / (d2 + 30);
        r += glow;
        g += glow * 0.9;
        b += glow * 0.7;
        if (d2 < 22 * 22) {
          r = 2 ** 14;
          g = 2 ** 13.8;
          b = 2 ** 13.4;
        }
        // Sphere with Lambert shading, a specular highlight and an occluded crevice.
        const sx = (x - sphX) / sphR, syy = (y - sphY) / sphR;
        const rr = sx * sx + syy * syy;
        if (rr < 1) {
          const nz = Math.sqrt(1 - rr);
          const n = [sx, syy, nz];
          const ndl = Math.max(0, n[0] * L[0] + n[1] * L[1] + n[2] * L[2]);
          const h = normalize([L[0], L[1], L[2] + 1]);
          const spec = Math.max(0, n[0] * h[0] + n[1] * h[1] + n[2] * h[2]) ** 400 * 600;
          const ambient = 0.002 * nz;
          r = 0.8 * ndl + ambient + spec;
          g = 0.35 * ndl + ambient + spec;
          b = 0.15 * ndl + ambient + spec;
        }
        // Sensor-like noise floor.
        const noise = 2 ** -12;
        r = Math.max(0, r + gauss() * noise);
        g = Math.max(0, g + gauss() * noise);
        b = Math.max(0, b + gauss() * noise);
        set(x, y, r, g, b);
      } else if (y < sceneBottom + 10) {
        set(x, y, 0, 0, 0);
      } else {
        // Special values strip: small blocks of 0, negative, NaN, +Inf and denormal values
        // on a mid-gray (1.0) background.
        const k = Math.floor((x / width) * 12);
        switch (k) {
          case 1: set(x, y, 0, 0, 0); break;
          case 3: set(x, y, -0.5, -0.01, 0.2); break;
          case 5: set(x, y, NaN, NaN, NaN); break;
          case 7: set(x, y, Infinity, Infinity, Infinity); break;
          case 9: { const v = 2 ** -140; set(x, y, v, v, v); break; }
          default: set(x, y, 1, 1, 1);
        }
      }
    }
  }
  return data;
}

function normalize(v: number[]): number[] {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
}
