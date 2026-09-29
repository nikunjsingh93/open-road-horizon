// Seeded RNG + noise helpers (no dependencies)

export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hash2(ix, iz, seed = 0) {
  let h = (ix * 374761393 + iz * 668265263 + seed * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296;
}

// ---- 2D simplex noise ----
const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;
const grad2 = new Float32Array([1, 1, -1, 1, 1, -1, -1, -1, 1, 0, -1, 0, 0, 1, 0, -1]);

export class Noise {
  constructor(seed = 1) {
    const rnd = mulberry32(seed);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = (rnd() * (i + 1)) | 0;
      const t = p[i]; p[i] = p[j]; p[j] = t;
    }
    this.perm = new Uint8Array(512);
    this.permMod8 = new Uint8Array(512);
    for (let i = 0; i < 512; i++) {
      this.perm[i] = p[i & 255];
      this.permMod8[i] = this.perm[i] & 7;
    }
  }

  // returns approx [-1, 1]
  n2(x, y) {
    const perm = this.perm, pm = this.permMod8;
    const s = (x + y) * F2;
    const i = Math.floor(x + s), j = Math.floor(y + s);
    const t = (i + j) * G2;
    const x0 = x - (i - t), y0 = y - (j - t);
    let i1, j1;
    if (x0 > y0) { i1 = 1; j1 = 0; } else { i1 = 0; j1 = 1; }
    const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
    const ii = i & 255, jj = j & 255;
    let n0 = 0, n1 = 0, n2 = 0;
    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 > 0) { const g = pm[ii + perm[jj]] * 2; t0 *= t0; n0 = t0 * t0 * (grad2[g] * x0 + grad2[g + 1] * y0); }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 > 0) { const g = pm[ii + i1 + perm[jj + j1]] * 2; t1 *= t1; n1 = t1 * t1 * (grad2[g] * x1 + grad2[g + 1] * y1); }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 > 0) { const g = pm[ii + 1 + perm[jj + 1]] * 2; t2 *= t2; n2 = t2 * t2 * (grad2[g] * x2 + grad2[g + 1] * y2); }
    return 70 * (n0 + n1 + n2);
  }

  // 1D smooth value noise, [-1,1]
  n1(x) {
    const i = Math.floor(x), f = x - i;
    const a = this.perm[i & 255] / 127.5 - 1, b = this.perm[(i + 1) & 255] / 127.5 - 1;
    const u = f * f * f * (f * (f * 6 - 15) + 10);
    return a + (b - a) * u;
  }

  fbm(x, y, oct = 5, lac = 2.0, gain = 0.5) {
    let a = 1, f = 1, s = 0, n = 0;
    for (let i = 0; i < oct; i++) { s += a * this.n2(x * f, y * f); n += a; a *= gain; f *= lac; }
    return s / n;
  }

  ridged(x, y, oct = 5) {
    let a = 1, f = 1, s = 0, n = 0;
    for (let i = 0; i < oct; i++) {
      const v = 1 - Math.abs(this.n2(x * f, y * f));
      s += a * v * v; n += a; a *= 0.5; f *= 2.05;
    }
    return s / n;
  }

  // ridged multifractal: finer octaves only grow on the ridges of the coarser ones, giving branching ridge / valley networks
  ridgedMF(x, y, oct = 6) {
    let a = 0.5, f = 1, s = 0, w = 1, n = 0;
    for (let i = 0; i < oct; i++) {
      let v = 1 - Math.abs(this.n2(x * f + i * 7.1, y * f - i * 3.3));
      v *= v; v *= w;
      w = Math.min(Math.max(v * 2.0, 0), 1);
      s += v * a; n += a; a *= 0.5; f *= 2.07;
    }
    return s / n;
  }

  fbm1(x, oct = 3) {
    let a = 1, f = 1, s = 0, n = 0;
    for (let i = 0; i < oct; i++) { s += a * this.n1(x * f + i * 17.3); n += a; a *= 0.5; f *= 2; }
    return s / n;
  }
}

export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
export const mix = lerp;
