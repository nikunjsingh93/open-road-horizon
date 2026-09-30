import { Noise, smoothstep, clamp, mix, mulberry32, hash2 } from './noise.js';

// World styles: each one reshapes the terrain around the road (the seed only changes the random layout).
export const STYLES = {
  meadows:   { label: 'Meadows',        hill: 1.0, wallStart: 650, wallAmp: 1.0,  lake: 1.0, forest: 0 },
  lakes:     { label: 'Lakes',          hill: 0.8, wallStart: 800, wallAmp: 0.7,  lake: 2.1, forest: 0 },
  highlands: { label: 'Highlands',      hill: 2.3, wallStart: 420, wallAmp: 1.2,  lake: 0.6, forest: 0 },
  forest:    { label: 'Deep forest',    hill: 0.9, wallStart: 850, wallAmp: 0.6,  lake: 0.8, forest: 0.34 },
  mountain:  { label: 'Mountain road',  guide: 'mountain', hill: 0.8, wallStart: 1e9, wallAmp: 0, lake: 0, forest: 0 },
  coast:     { label: 'Coastal cliffs', guide: 'coast',    hill: 0.8, wallStart: 1e9, wallAmp: 0, lake: 0, forest: -0.05 },
};
const TRAIL_SPACING = 1150;        // a side track roughly every km
const TRAIL_STEP = 9;              // metres between trail samples
const THASH = 40;

export const ROAD_HALF = 3.85;      // paved half width (2 lanes)
export const LANE = 3.4;
export const DS = 2.0;               // road sample spacing
const HASH = 64;                     // spatial hash cell (m)

// ---------------------------------------------------------------------------
// Road: an infinite deterministic curve (arc-length parameterised), + a heightfield
// that carves terrain around it.
// ---------------------------------------------------------------------------
export class World {
  constructor(seed = 7, opts = {}) {
    this.seed = seed;
    this.style = STYLES[opts.style] ? opts.style : 'meadows';
    this.P = STYLES[this.style];
    this.curvy = opts.curvy ?? 1;
    this.hilly = opts.hilly ?? 1;
    this.trailsOn = opts.trails !== false;
    this.trails = []; this.thash = new Map(); this.nextTrail = 0; this.tdist = 99; this._tq = { d: 99, y: 0 };
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

  // ---- guided (road-hugging) styles: the road follows a guide curve and the landscape is built relative to it ----
  _guideRaw(z) {
    const n = this.noise2, A = (this.P.guide === 'coast' ? 120 : 150) * this.curvy;
    return A * (0.62 * n.n1(z / 1000 + 40) + 0.28 * n.n1(z / 430 + 90) + 0.10 * n.n1(z / 175 + 17));
  }
  guideX(z) { if (this._g0 === undefined) this._g0 = this._guideRaw(0); return this._guideRaw(z) - this._g0; }
  guideSlope(z) { return (this.guideX(z + 1.5) - this.guideX(z - 1.5)) / 3; }
  plateau(z) {
    return this.P.guide === 'coast' ? 62 + 16 * this.noise.n1(z / 1300 + 5) * this.hilly : 120 + 55 * this.noise.n1(z / 1500 + 5) * this.hilly;
  }
  _guided(x, z) {
    const n = this.noise, n2 = this.noise2;
    const u = x - this.guideX(z) - 8;                       // + = right of the road, road sits at u = 0
    const base = this.plateau(z) + 2.2 * this.hilly * n.n2(x * 0.02, z * 0.02) + 1.2 * n.n2(x * 0.09, z * 0.09);
    if (this.P.guide === 'coast') {
      // left: a sheer cliff into the sea; right: rock face and mountains
      const rough = 3.5 * n.fbm(x * 0.03, z * 0.03, 3);
      const cliff = smoothstep(4, -26, u + rough);
      const sea = -36 + 4 * n.n2(x * 0.01, z * 0.01);
      let h = base * (1 - cliff) + sea * cliff;
      const m = smoothstep(14, 300, u);
      if (m > 0) {
        const r = n2.ridgedMF(x * 0.0016 + 3, z * 0.0016, 5);
        h += m * (60 + 340 * Math.pow(r, 1.2) + 30 * n.fbm(x * 0.006, z * 0.006, 3)) * this.hilly * 0.9;
      }
      return h;
    }
    // mountain road: the high side and the drop side swap along the route, with flat saddles in between
    const sg = Math.tanh(3.2 * n2.n1(z / 2100 + 60));
    const uu = u * sg;
    const rise = smoothstep(10, 300, uu), drop = smoothstep(4, -34, uu + 3 * n.fbm(x * 0.03, z * 0.03, 3));
    const w8 = Math.pow(Math.abs(sg), 0.7);
    const r = n2.ridgedMF(x * 0.0014 + 9, z * 0.0014, 5);
    let h = base + w8 * rise * (70 + 320 * Math.pow(r, 1.15) + 25 * n.fbm(x * 0.006, z * 0.006, 3)) * this.hilly;
    h -= w8 * drop * (95 + 40 * n.n1(z / 800));
    // beyond the drop, the valley floor rolls away gently
    h += (1 - w8) * 6 * n.fbm(x * 0.004, z * 0.004, 3);
    return h;
  }

  // ---- natural terrain (no road) ----
  natural(x, z) {
    if (this.P.guide) return this._guided(x, z);
    const n = this.noise, n2 = this.noise2, P = this.P, H = this.hilly;
    // valley walls: the road wanders inside a broad valley, mountains on either side
    const xw = x + 280 * n2.n2(z * 0.0007, 3.3) + 90 * n2.n2(z * 0.003, 9.1);
    const wall = smoothstep(P.wallStart, P.wallStart + 850, Math.abs(xw));
    // rolling hills
    let h = (16 * P.hill * H) * n.fbm(x * 0.0011, z * 0.0011, 4) + (4.5 * H) * n.fbm(x * 0.0053 + 40, z * 0.0053, 3) + 0.6 * n.n2(x * 0.03, z * 0.03);
    // mountains
    if (wall > 0) {
      // domain-warped ridged multifractal on a slowly varying massif envelope: soft rolling massifs with faint ridge lines on top
      const wx = x + 170 * n.fbm(x * 0.0011 + 3, z * 0.0011, 3), wz = z + 170 * n.fbm(x * 0.0011 + 9, z * 0.0011 + 5, 3);
      const m = 0.5 + 0.5 * n2.fbm(wx * 0.00052 + 11, wz * 0.00052, 4);
      const r = n2.ridgedMF(wx * 0.0011 + 5, wz * 0.0011, 4);
      const env = 0.5 + 0.5 * n.fbm(x * 0.00042 + 20, z * 0.00042 - 6, 2);
      h += wall * P.wallAmp * H * (40 + 250 * Math.pow(m, 1.6) * (0.55 + 0.7 * env) + 70 * r * m + 22 * n.fbm(x * 0.004, z * 0.004, 3));
    }
    // lake basins
    const sh = (P.lake - 1) * 0.11;
    const lake = smoothstep(0.35 - sh, 0.6 - sh, n2.n2(x * 0.0009 + 71, z * 0.0009 + 13)) * (1 - wall);
    h -= lake * (15 + (P.lake - 1) * 7);
    return h;
  }

  // forest density 0..1 (low frequency), used by shader & scatter
  forest(x, z) {
    const a = this.noise2.fbm(x * 0.0022 + 5, z * 0.0022 - 8, 3);
    const b = this.noise.n2(x * 0.012, z * 0.012) * 0.15;
    return smoothstep(-0.12, 0.28, a + b + this.P.forest);
  }

  // ---- road generation ----
  _kappa(s) {
    const n = this.noise2;
    let a = n.fbm1(s / 380 + 1000, 3);
    let k = Math.sign(a) * Math.pow(Math.abs(a), 1.25) * 1.9;
    k = clamp(k, -1, 1) / 105;
    k += 0.0022 * n.n1(s / 95 + 300);
    return k * this.curvy * (this.P.guide ? 0.25 : 1);
  }

  ensure(sMax) {
    const need = Math.ceil(sMax / DS) + 80;
    while (this.gen < need) {
      const i = this.gen;
      const s = i * DS;
      let th = this.th[i - 1];
      const x = this.xs[i - 1], z = this.zs[i - 1];
      let k;
      if (this.P.guide) {
        // hug the guide curve (coast line / ridge line): heading follows its tangent, position error is pulled in quickly
        const thT = Math.atan(-this.guideSlope(z));
        const err = x - this.guideX(z);
        const des = thT - clamp(err / 30, -1, 1) * 0.7;
        k = this._kappa(s) + 0.085 * (des - th);
      } else {
        // steer gently back to the valley centre
        const des = -clamp(x / 520, -1, 1) * 0.95;
        k = this._kappa(s) + 0.0026 * (des - th);
      }
      th += clamp(k, -0.05, 0.05) * DS;
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
    if (this.trailsOn) while ((this.nextTrail + 1) * TRAIL_SPACING + 150 < (this.finalized - 30) * DS) this._genTrail(this.nextTrail++);
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

  // ---- off-road side tracks ----
  _genTrail(k) {
    const rnd = mulberry32(hash2(k, 991, this.seed) * 4294967296 | 0);
    const sPos = (k + 1) * TRAIL_SPACING + (rnd() - 0.5) * 260;
    let i = Math.min(Math.floor(sPos / DS), this.finalized - 3);
    const th = this.th[i], rx = Math.cos(th), rz = Math.sin(th);   // right vector
    const fx = Math.sin(th), fz = -Math.cos(th);                     // forward vector
    const walk = (side) => {
      let px = this.xs[i] + rx * side * (ROAD_HALF + 1.2), pz = this.zs[i] + rz * side * (ROAD_HALF + 1.2);
      let ang = Math.atan2(rz * side * 0.85 + fz * 0.5, rx * side * 0.85 + fx * 0.5);
      const pts = [px, pz], hs = [this.ys[i]];
      let hCur = this.natural(px, pz), climbed = 0;
      const steps = 150 + ((rnd() * 60) | 0);
      const target0 = 0.075 + rnd() * 0.04;
      const dtheta = [-0.55, -0.3, -0.12, 0, 0.12, 0.3, 0.55];
      let wander = 0;
      for (let st = 0; st < steps; st++) {
        wander += (rnd() - 0.5) * 0.25; wander *= 0.92;
        const tg = climbed > 230 ? 0.0 : target0;
        let best = -1e9, bd = 0, bx = 0, bz = 0, bh = 0;
        for (const dth of dtheta) {
          const a2 = ang + dth * 0.8 + wander * 0.15;
          const nx = px + Math.cos(a2) * TRAIL_STEP, nz = pz + Math.sin(a2) * TRAIL_STEP;
          const h = this.natural(nx, nz);
          const grade = (h - hCur) / TRAIL_STEP;
          let score = -Math.abs(grade - tg) * 14 - Math.abs(dth) * 0.9;
          if (Math.abs(grade) > 0.16) score -= 6;
          if (h < this.waterY + 1.6) score -= 40;
          if (st > 6) { const r = this.nearest(nx, nz, this._tq2 || (this._tq2 = {})); if (r && r.d < 22) score -= 7; }
          if (score > best) { best = score; bd = dth; bx = nx; bz = nz; bh = h; }
        }
        if (best < -30) break;
        ang += bd * 0.8 + wander * 0.15;
        px = bx; pz = bz;
        climbed += Math.max(bh - hCur, 0);
        hCur = bh;
        pts.push(px, pz); hs.push(bh);
      }
      return { pts, hs };
    };
    const side0 = rnd() < 0.5 ? -1 : 1;
    let side = side0, { pts, hs } = walk(side0);
    if (hs.length < 60) { const alt = walk(-side0); if (alt.hs.length > hs.length) { side = -side0; pts = alt.pts; hs = alt.hs; } }
    if (hs.length < 25) return;                     // nowhere sensible to go from here
    const n = hs.length;
    // smooth the height profile, limit the grade, and blend the first samples into the road level
    const ys = hs.slice();
    for (let pass = 0; pass < 6; pass++) {
      for (let j = 1; j < n - 1; j++) ys[j] = (ys[j - 1] + 2 * ys[j] + ys[j + 1]) / 4;
    }
    for (let j = 1; j < n; j++) { const mx = 0.14 * TRAIL_STEP; ys[j] = clamp(ys[j], ys[j - 1] - mx, ys[j - 1] + mx); }
    for (let j = 0; j < Math.min(n, 12); j++) { const a2 = j / 11; ys[j] = hs[0] + (ys[j] - hs[0]) * a2 * a2; }
    ys[0] = hs[0];
    const tr = { pts, ys, n, side, s: sPos };
    this.trails.push(tr);
    const idx = this.trails.length - 1;
    for (let j = 0; j < n; j++) {
      const key = Math.floor(pts[j * 2] / THASH) * 100003 + Math.floor(pts[j * 2 + 1] / THASH);
      let arr = this.thash.get(key);
      if (!arr) { arr = []; this.thash.set(key, arr); }
      arr.push(idx * 4096 + j);
    }
  }

  // nearest point on any side track; out = { d, y, t (trail index), u }. returns false when none within ~THASH
  trailQuery(x, z, out) {
    out.d = 99;
    if (!this.trails.length) return false;
    const cx = Math.floor(x / THASH), cz = Math.floor(z / THASH);
    let best = 1e18, found = false;
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      const arr = this.thash.get((cx + dx) * 100003 + (cz + dz));
      if (!arr) continue;
      for (let m = 0; m < arr.length; m++) {
        const code = arr[m], ti = (code / 4096) | 0, j = code % 4096;
        const tr = this.trails[ti], pts = tr.pts;
        for (let jj = Math.max(j - 1, 0); jj <= j; jj++) {
          if (jj + 1 >= tr.n) continue;
          const ax = pts[jj * 2], az = pts[jj * 2 + 1];
          const bx = pts[jj * 2 + 2] - ax, bz = pts[jj * 2 + 3] - az;
          let u = ((x - ax) * bx + (z - az) * bz) / (bx * bx + bz * bz);
          u = u < 0 ? 0 : u > 1 ? 1 : u;
          const qx = ax + bx * u - x, qz = az + bz * u - z;
          const d2 = qx * qx + qz * qz;
          if (d2 < best) { best = d2; out.y = tr.ys[jj] + (tr.ys[jj + 1] - tr.ys[jj]) * u; out.t = ti; out.u = jj + u; found = true; }
        }
      }
    }
    if (!found) return false;
    out.d = Math.sqrt(best);
    return out.d < THASH * 1.4;
  }

  _trailCarve(h, x, z) {
    const q = this._tq;
    if (!this.trailQuery(x, z, q)) { this.tdist = 99; return h; }
    this.tdist = q.d;
    const W = 2.2, blend = 3.2 + Math.min(0.9 * Math.abs(h - q.y), 9);
    const a = smoothstep(W, W + blend, q.d);
    const bed = q.y - 0.05 - 0.05 * smoothstep(1.6, 3.2, q.d);
    return bed + (h - bed) * a;
  }

  // full terrain height at (x, z) given road info r (from nearest / nearestHint) - road carve first, then side tracks
  shape(nat, x, z, r) {
    let h = (!r || r.d > 64) ? nat : this._carve(nat, r.y, r.d);
    if (this.trailsOn && this.trails.length) h = this._trailCarve(h, x, z); else this.tdist = 99;
    return h;
  }

  // carved terrain height
  height(x, z) {
    const nat = this.natural(x, z);
    const r = this.nearest(x, z, this._tmp);
    return this.shape(nat, x, z, r);
  }

  _carve(nat, roadY, d) {
    const blend = this.P.guide ? 8 + Math.min(0.25 * Math.abs(nat - roadY), 6) : 34 + Math.min(2.0 * Math.abs(nat - roadY), 28);
    const a = smoothstep(5.2, blend, d);
    // shoulder slightly lower than tarmac, then blends into natural terrain
    const bed = roadY - 0.07 - 0.14 * smoothstep(4.1, 9, d);
    return bed + (nat - bed) * a;
  }

  heightRI(x, z) { // also returns road info in this._tmp (valid until next call)
    const nat = this.natural(x, z);
    const r = this.nearest(x, z, this._tmp);
    if (!r || r.d > 64) this._tmp.d = 999;
    return this.shape(nat, x, z, r);
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
