import { Noise, smoothstep, clamp, mix } from './noise.js';

export const ROAD_HALF = 3.85;      // paved half width (2 lanes)
export const LANE = 3.4;
export const DS = 2.0;               // road sample spacing
const HASH = 64;                     // spatial hash cell (m)

// ---------------------------------------------------------------------------
// Road: an infinite deterministic curve (arc-length parameterised), + a heightfield
// that carves terrain around it.
// ---------------------------------------------------------------------------
export class World {
  constructor(seed = 7) {
    this.seed = seed;
    this.noise = new Noise(seed);
    this.noise2 = new Noise(seed * 31 + 5);
    this.xs = [0]; this.zs = [0]; this.th = [0]; this.raw = [0]; this.ys = [];
    this.gen = 0;              // number of samples generated
    this.finalized = 0;        // number with final (smoothed) y
    this.hash = new Map();
    this.waterY = -4;          // lakes
    this._tmp = { s: 0, t: 0, d: 0, y: 0, x: 0, z: 0, th: 0, i: 0 };
    this.xs[0] = 0; this.zs[0] = 0; this.th[0] = 0;
    this.raw[0] = Math.max(this.natural(0, 0), this.waterY + 2.4);
    this._insertHash(0);
    this.gen = 1;
    this.ensure(1200);
  }

  // ---- natural terrain (no road) ----
  natural(x, z) {
    const n = this.noise, n2 = this.noise2;
    // valley walls: the road wanders inside a broad valley, mountains on either side
    const xw = x + 280 * n2.n2(z * 0.0007, 3.3) + 90 * n2.n2(z * 0.003, 9.1);
    const wall = smoothstep(650, 1500, Math.abs(xw));
    // rolling hills
    let h = 16 * n.fbm(x * 0.0011, z * 0.0011, 4) + 4.5 * n.fbm(x * 0.0053 + 40, z * 0.0053, 3) + 0.6 * n.n2(x * 0.03, z * 0.03);
    // mountains
    if (wall > 0) {
      // domain-warped ridged multifractal on a slowly varying massif envelope: broad shoulders, sharp branching ridges and gullies
      const wx = x + 170 * n.fbm(x * 0.0011 + 3, z * 0.0011, 3), wz = z + 170 * n.fbm(x * 0.0011 + 9, z * 0.0011 + 5, 3);
      // big soft rolling massifs (pastoral highlands rather than alpine spikes) with faint ridge lines on top
      const m = 0.5 + 0.5 * n2.fbm(wx * 0.00052 + 11, wz * 0.00052, 4);
      const r = n2.ridgedMF(wx * 0.0011 + 5, wz * 0.0011, 4);
      const env = 0.5 + 0.5 * n.fbm(x * 0.00042 + 20, z * 0.00042 - 6, 2);
      h += wall * (40 + 250 * Math.pow(m, 1.6) * (0.55 + 0.7 * env) + 70 * r * m + 22 * n.fbm(x * 0.004, z * 0.004, 3));
    }
    // lake basins
    const lake = smoothstep(0.35, 0.6, n2.n2(x * 0.0009 + 71, z * 0.0009 + 13)) * (1 - wall);
    h -= lake * 15;
    return h;
  }

  // forest density 0..1 (low frequency), used by shader & scatter
  forest(x, z) {
    const a = this.noise2.fbm(x * 0.0022 + 5, z * 0.0022 - 8, 3);
    const b = this.noise.n2(x * 0.012, z * 0.012) * 0.15;
    return smoothstep(-0.12, 0.28, a + b);
  }

  // ---- road generation ----
  _kappa(s) {
    const n = this.noise2;
    let a = n.fbm1(s / 380 + 1000, 3);
    let k = Math.sign(a) * Math.pow(Math.abs(a), 1.25) * 1.9;
    k = clamp(k, -1, 1) / 105;
    k += 0.0022 * n.n1(s / 95 + 300);
    return k;
  }

  ensure(sMax) {
    const need = Math.ceil(sMax / DS) + 80;
    while (this.gen < need) {
      const i = this.gen;
      const s = i * DS;
      let th = this.th[i - 1];
      const x = this.xs[i - 1], z = this.zs[i - 1];
      // steer gently back to the valley centre
      const des = -clamp(x / 520, -1, 1) * 0.95;
      const k = this._kappa(s) + 0.0026 * (des - th);
      th += k * DS;
      this.th[i] = th;
      this.xs[i] = x + Math.sin(th) * DS;
      this.zs[i] = z - Math.cos(th) * DS;
      this.raw[i] = Math.max(this.natural(this.xs[i], this.zs[i]), this.waterY + 2.4);
      this._insertHash(i);
      this.gen++;
    }
    // finalize road height with gaussian smoothing (sigma 22 m)
    const R = 44, sig = 11;
    const wts = [];
    let wsum = 0;
    for (let k = -R; k <= R; k++) { const w = Math.exp(-(k * k) / (2 * sig * sig)); wts.push(w); wsum += w; }
    while (this.finalized + R < this.gen - 1) {
      const i = this.finalized;
      let v = 0;
      for (let k = -R; k <= R; k++) {
        const j = i + k < 0 ? 0 : i + k;
        v += this.raw[j] * wts[k + R];
      }
      this.ys[i] = v / wsum + 0.0;
      this.finalized++;
    }
  }

  _insertHash(i) {
    const cx = Math.floor(this.xs[i] / HASH), cz = Math.floor(this.zs[i] / HASH);
    const key = cx * 100003 + cz;
    let a = this.hash.get(key);
    if (!a) { a = []; this.hash.set(key, a); }
    a.push(i);
  }

  // interpolated road centre sample by arc length; writes into out
  at(s, out = this._tmp) {
    this.ensure(s + 200);
    let f = s / DS;
    if (f < 0) f = 0;
    const i = Math.min(Math.floor(f), this.finalized - 2);
    const u = f - i;
    out.x = this.xs[i] + (this.xs[i + 1] - this.xs[i]) * u;
    out.z = this.zs[i] + (this.zs[i + 1] - this.zs[i]) * u;
    out.y = this.ys[i] + (this.ys[i + 1] - this.ys[i]) * u;
    out.th = this.th[i] + (this.th[i + 1] - this.th[i]) * u;
    out.s = s;
    return out;
  }

  // nearest point on the road polyline to (x, z). returns null if none within ~ HASH.
  nearest(x, z, out = this._tmp) {
    const cx = Math.floor(x / HASH), cz = Math.floor(z / HASH);
    let best = 1e18, bi = -1;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const a = this.hash.get((cx + dx) * 100003 + (cz + dz));
        if (!a) continue;
        for (let k = 0; k < a.length; k++) {
          const i = a[k];
          const ddx = this.xs[i] - x, ddz = this.zs[i] - z;
          const d2 = ddx * ddx + ddz * ddz;
          if (d2 < best) { best = d2; bi = i; }
        }
      }
    }
    if (bi < 0 || bi >= this.finalized - 1) return null;
    return this._project(x, z, bi, out);
  }

  // refine using neighbouring segments, given nearest sample index
  _project(x, z, bi, out) {
    let bestD = 1e18;
    for (let i = Math.max(bi - 1, 0); i <= bi; i++) {
      const ax = this.xs[i], az = this.zs[i];
      const bx = this.xs[i + 1] - ax, bz = this.zs[i + 1] - az;
      let u = ((x - ax) * bx + (z - az) * bz) / (bx * bx + bz * bz);
      u = clamp(u, 0, 1);
      const px = ax + bx * u, pz = az + bz * u;
      const d2 = (x - px) * (x - px) + (z - pz) * (z - pz);
      if (d2 < bestD) {
        bestD = d2;
        out.i = i; out.u = u;
        out.s = (i + u) * DS;
        out.px = px; out.pz = pz;
        out.y = this.ys[i] + (this.ys[i + 1] - this.ys[i]) * u;
        const th = this.th[i] + (this.th[i + 1] - this.th[i]) * u;
        out.th = th;
        // right vector = (cos th, sin th)
        const side = (x - px) * Math.cos(th) + (z - pz) * Math.sin(th);
        out.t = side;
      }
    }
    out.d = Math.sqrt(bestD);
    return out;
  }

  // Nearest with a hint (fast path for the vehicle): search around index hint
  nearestHint(x, z, hint, out = this._tmp) {
    let bi = clamp(hint | 0, 1, this.finalized - 3);
    let best = 1e18;
    const lo = Math.max(1, bi - 30), hi = Math.min(this.finalized - 3, bi + 30);
    for (let i = lo; i <= hi; i++) {
      const dx = this.xs[i] - x, dz = this.zs[i] - z;
      const d2 = dx * dx + dz * dz;
      if (d2 < best) { best = d2; bi = i; }
    }
    return this._project(x, z, bi, out);
  }

  // carved terrain height
  height(x, z) {
    const nat = this.natural(x, z);
    const r = this.nearest(x, z, this._tmp);
    if (!r || r.d > 64) return nat;
    return this._carve(nat, r.y, r.d);
  }

  _carve(nat, roadY, d) {
    const blend = 34 + Math.min(2.0 * Math.abs(nat - roadY), 28);
    const a = smoothstep(5.2, blend, d);
    // shoulder slightly lower than tarmac, then blends into natural terrain
    const bed = roadY - 0.07 - 0.14 * smoothstep(4.1, 9, d);
    return bed + (nat - bed) * a;
  }

  heightRI(x, z) { // also returns road info in this._tmp (valid until next call)
    const nat = this.natural(x, z);
    const r = this.nearest(x, z, this._tmp);
    if (!r || r.d > 64) { this._tmp.d = 999; return nat; }
    return this._carve(nat, r.y, r.d);
  }

  normal(x, z, out, e = 0.8) {
    const hl = this.height(x - e, z), hr = this.height(x + e, z);
    const hd = this.height(x, z - e), hu = this.height(x, z + e);
    let nx = hl - hr, ny = 2 * e, nz = hd - hu;
    const l = Math.hypot(nx, ny, nz);
    out.x = nx / l; out.y = ny / l; out.z = nz / l;
    return out;
  }
}
