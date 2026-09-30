import { Noise, smoothstep, clamp, mix, mulberry32, hash2 } from './noise.js';

// World styles: each one reshapes the terrain around the road (the seed only changes the random layout).
// 'mix' strings several of them together: a stretch of every style, blended into each other, a few km each.
const FREE = { hill: 1, wallStart: 650, wallAmp: 1, lake: 1, forest: 0 };
export const STYLES = {
  mix:       { label: 'Mix (default)',  mix: true, ...FREE },
  meadows:   { label: 'Meadows',        hill: 1.0, wallStart: 650, wallAmp: 1.0,  lake: 1.0, forest: 0 },
  lakes:     { label: 'Lakes',          hill: 0.8, wallStart: 800, wallAmp: 0.7,  lake: 2.1, forest: 0 },
  highlands: { label: 'Highlands',      hill: 2.3, wallStart: 420, wallAmp: 1.2,  lake: 0.6, forest: 0 },
  forest:    { label: 'Deep forest',    hill: 0.9, wallStart: 850, wallAmp: 0.6,  lake: 0.8, forest: 0.34 },
  mountain:  { label: 'Mountain road',  guide: 'mountain', ...FREE },
  coast:     { label: 'Coastal cliffs', guide: 'coast',    ...FREE, forest: -0.05 },
};
const ZONE_LEN = 3600;             // mix mode: metres per style zone
const ZONE_TYPES = ['meadows', 'coast', 'lakes', 'mountain', 'highlands', 'forest'];
const TRAIL_SPACING = 1150;        // a side track roughly every km
const TRAIL_STEP = 9;              // metres between trail samples
const THASH = 40;

export const ROAD_HALF = 3.85;      // paved half width (2 lanes)
export const LANE = 3.4;
export const DS = 2.0;               // road sample spacing
const REACH = 124;                   // beyond this the free (uncarved) terrain is used
const HASH = 128;                    // spatial hash cell (m): a 3x3 lookup always finds the road within 128 m

// ---------------------------------------------------------------------------
// Road: an infinite deterministic curve (arc-length parameterised), + a heightfield
// that carves terrain around it.
// ---------------------------------------------------------------------------
export class World {
  constructor(seed = 7, opts = {}) {
    this.seed = seed;
    this.style = STYLES[opts.style] ? opts.style : 'mix';
    this.P = STYLES[this.style];
    this._zseq = ['meadows']; this._zo = { wc: 0, wm: 0, P: this.P };
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

  // ---- style zones ----
  _zoneType(k) {
    if (k <= 0) return 'meadows';
    const q = this._zseq;
    while (q.length <= k) {
      const cyc = (q.length / ZONE_TYPES.length) | 0;
      const rnd = mulberry32(hash2(cyc, 313, this.seed) * 4294967296 | 0);
      const bag = ZONE_TYPES.slice();
      for (let i = bag.length - 1; i > 0; i--) { const j = (rnd() * (i + 1)) | 0; [bag[i], bag[j]] = [bag[j], bag[i]]; }
      if (bag[0] === q[q.length - 1]) [bag[0], bag[1]] = [bag[1], bag[0]];
      for (const t of bag) q.push(t);
    }
    return q[k];
  }

  // style weights at a given z (the road runs towards -z): { wc: coast, wm: mountain, P: free-terrain parameters }
  _zone(z) {
    const o = this._zo;
    if (!this.P.mix) {
      o.wc = this.P.guide === 'coast' ? 1 : 0; o.wm = this.P.guide === 'mountain' ? 1 : 0; o.P = this.P;
      return o;
    }
    const p = Math.max(0, -z / ZONE_LEN), b = Math.round(p);
    const A = STYLES[this._zoneType(b - 1)], B = STYLES[this._zoneType(b)];
    const tA = this._zoneType(b - 1), tB = this._zoneType(b);
    const halfw = (A.guide || B.guide) ? 0.34 : 0.15;
    const t = b <= 0 ? 1 : smoothstep(b - halfw, b + halfw, p);
    o.wc = (tA === 'coast' ? 1 - t : 0) + (tB === 'coast' ? t : 0);
    o.wm = (tA === 'mountain' ? 1 - t : 0) + (tB === 'mountain' ? t : 0);
    const P = o.P === this.P || !o.P._mixed ? (o.P = { _mixed: true }) : o.P;
    for (const k of ['hill', 'wallStart', 'wallAmp', 'lake', 'forest']) P[k] = A[k] + (B[k] - A[k]) * t;
    return o;
  }
  guideWeight(z) { const o = this._zone(z); return o.wc + o.wm; }

  // ---- guided (road-hugging) styles: the road follows a guide curve and the landscape is built relative to it ----
  _guideRaw(z) {
    const n = this.noise2, A = 140 * this.curvy;
    return A * (0.62 * n.n1(z / 1000 + 40) + 0.28 * n.n1(z / 430 + 90) + 0.10 * n.n1(z / 175 + 17));
  }
  guideX(z) { if (this._g0 === undefined) this._g0 = this._guideRaw(0); return this._guideRaw(z) - this._g0; }
  guideSlope(z) { return (this.guideX(z + 1.5) - this.guideX(z - 1.5)) / 3; }

  // Height offset (relative to the road bench) of a hillside flank. q > 0: metres up-slope from the road, q < 0: down-slope.
  //  - up-slope: a gentle bench, then a broad ridged massif with gullies running down the fall line (no sheer wall next to the road)
  //  - down-slope: the ground falls away in ledges and gullies to 'floor' (sea level for the coast), never a vertical face
  _flank(x, z, q, E, upAmp, drop, dropDist, seaFloor) {
    const n = this.noise, n2 = this.noise2, H = this.hilly;
    if (q >= 0) {
      const L = q;
      const big = upAmp * Math.pow(smoothstep(6, 1050, L), 1.2);
      const r = n2.ridgedMF(x * 0.0011 + 7, z * 0.0011 - 3, 5);
      const massif = big * (0.55 + 0.9 * r);
      const gul = 16 * (n2.ridgedMF(x * 0.0035 + 21, z * 0.022, 3) - 0.42) * smoothstep(25, 260, L) * H;
      const bump = 26 * n.fbm(x * 0.006, z * 0.006, 3) * smoothstep(12, 160, L) * H + 6 * n.fbm(x * 0.035, z * 0.035, 3) * smoothstep(6, 70, L);
      return massif + gul + bump;
    }
    const D = -q, t = D / dropDist;
    const prof = Math.pow(smoothstep(0.02, 1, Math.min(t, 1)), 0.85);
    let off = -drop * prof;
    const mid = Math.sin(Math.PI * Math.min(t, 1));
    off += mid * (5 * n.fbm(x * 0.035, z * 0.035, 3) + 11 * (n2.ridgedMF(x * 0.005 + 3, z * 0.03, 3) - 0.4));    // ledges + gullies
    if (t > 1) off = -drop - (seaFloor ? 34 * smoothstep(1, 1.7, t) : 4 * n.fbm(x * 0.004, z * 0.004, 3) * Math.min(1, (t - 1) * 0.5));
    return off;
  }

  _coast(x, z) {
    const n = this.noise, H = this.hilly;
    const E = 52 + 22 * n.n1(z / 1300 + 5) * H;
    const u = x - this.guideX(z) - 8;                       // + = landward (right), the road sits at u = -8
    const shoreD = 60 + 55 * (0.5 + 0.5 * n.n1(z / 380 + 3)) + 22 * n.n1(z / 95);
    let h = E + this._flank(x, z, u + 8, E, (230 + 60 * H) * H, E + 1.5, shoreD, true);
    // sea stacks and skerries just off the shore
    if (u < -8) {
      const t = (-u - 8) / shoreD;
      if (t > 0.92 && t < 2.3) {
        // broad, flat-topped rock shelves and skerries with ragged edges (not needles)
        const sn = n.fbm(x * 0.011 + 9, z * 0.011 - 4, 3) + 0.12 * n.n2(x * 0.08, z * 0.08);
        const blob = smoothstep(0.04, 0.34, sn);
        const top = 3 + 9 * (0.5 + 0.5 * n.n2(x * 0.03, z * 0.03)) + 2.5 * n.n2(x * 0.15, z * 0.15);
        const shelf = -9 + blob * (top + 9) * smoothstep(0.92, 1.15, t) * (1 - smoothstep(1.7, 2.3, t));
        if (shelf > h) h = shelf;
      }
    }
    return h + 1.0 * n.n2(x * 0.09, z * 0.09);
  }

  _mount(x, z) {
    const n = this.noise, n2 = this.noise2, H = this.hilly;
    const E = 105 + 55 * n.n1(z / 1500 + 5) * H;
    const u = x - this.guideX(z) - 8;
    const sg = Math.tanh(3.2 * n2.n1(z / 2100 + 60));       // which side is the mountain: swaps along the route
    const w8 = Math.pow(Math.abs(sg), 0.7);
    const q = (u + 8) * Math.sign(sg || 1);
    const drop = w8 * (85 + 35 * n.n1(z / 800));
    return E + this._flank(x, z, q, E, w8 * (260 + 80 * H) * H, drop, 150 + 70 * n.n1(z / 500), false) * (0.35 + 0.65 * w8) + 1.0 * n.n2(x * 0.09, z * 0.09);
  }

  // ---- natural terrain (no road) ----
  _free(x, z, P) {
    const n = this.noise, n2 = this.noise2, H = this.hilly;
    // valley walls: the road wanders inside a broad valley, mountains on either side
    const xw = x + 280 * n2.n2(z * 0.0007, 3.3) + 90 * n2.n2(z * 0.003, 9.1);
    const wall = smoothstep(P.wallStart, P.wallStart + 850, Math.abs(xw));
    // rolling hills
    let h = (16 * P.hill * H) * n.fbm(x * 0.0011, z * 0.0011, 4) + (4.5 * H) * n.fbm(x * 0.0053 + 40, z * 0.0053, 3) + 0.6 * n.n2(x * 0.03, z * 0.03);
    // mountains: soft rolling massifs with faint ridge lines on top
    if (wall > 0) {
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

  natural(x, z) {
    const o = this._zone(z), wc = o.wc, wm = o.wm, wg = wc + wm;
    if (wg >= 0.999) return (wc > 0 ? wc * this._coast(x, z) : 0) + (wm > 0 ? wm * this._mount(x, z) : 0);
    const P = o.P;
    const free = this._free(x, z, P);
    if (wg <= 0.001) return free;
    const g = (wc > 0 ? wc * this._coast(x, z) : 0) + (wm > 0 ? wm * this._mount(x, z) : 0);
    return free * (1 - wg) + g;
  }

  // forest density 0..1 (low frequency), used by shader & scatter
  forest(x, z) {
    const a = this.noise2.fbm(x * 0.0022 + 5, z * 0.0022 - 8, 3);
    const b = this.noise.n2(x * 0.012, z * 0.012) * 0.15;
    return smoothstep(-0.12, 0.28, a + b + this._zone(z).P.forest);
  }

  // ---- road generation ----
  _kappa(s) {
    const n = this.noise2;
    let a = n.fbm1(s / 380 + 1000, 3);
    let k = Math.sign(a) * Math.pow(Math.abs(a), 1.25) * 1.9;
    k = clamp(k, -1, 1) / 105;
    k += 0.0022 * n.n1(s / 95 + 300);
    return k * this.curvy * (1 - 0.75 * this._gw);
  }

  ensure(sMax) {
    const need = Math.ceil(sMax / DS) + 80;
    while (this.gen < need) {
      const i = this.gen;
      const s = i * DS;
      let th = this.th[i - 1];
      const x = this.xs[i - 1], z = this.zs[i - 1];
      // the road starts hugging the guide curve ~1.5 km before a coast / mountain zone begins (so it is already in place)
      const gw = this.guideWeight(z - 1500);
      this._gw = gw;
      let k;
      {
        const des = -clamp(x / 520, -1, 1) * 0.95;
        k = this._kappa(s) + 0.0026 * (des - th) * (1 - gw) - 0.0011 * th * (1 - gw);   // (weak pull to keep heading down the valley)
        if (gw > 0.01) {
          // hug the guide curve (coast line / ridge line): heading follows its tangent, position error is pulled in quickly
          const thT = Math.atan(-this.guideSlope(z));
          const err = x - this.guideX(z);
          const desG = thT - clamp(err / 30, -1, 1) * 0.7;
          k += 0.085 * (desG - th) * gw;
        }
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
    const G = 0.115;                                 // max track grade (11.5 %)
    const rnd0 = rnd;
    const walk = (side, i) => {
      const th = this.th[i], rx = Math.cos(th), rz = Math.sin(th);   // right vector
      const fx = Math.sin(th), fz = -Math.cos(th);                   // forward vector
      let px = this.xs[i] + rx * side * (ROAD_HALF + 1.2), pz = this.zs[i] + rz * side * (ROAD_HALF + 1.2);
      let ang = Math.atan2(rz * side * 0.93 + fz * 0.35, rx * side * 0.93 + fx * 0.35);
      const pts = [px, pz], hs = [this.ys[i]];
      let yc = this.ys[i], climbed = 0;
      const steps = 170 + ((rnd() * 70) | 0);
      const target0 = 0.07 + rnd() * 0.04;
      const dtheta = [-0.34, -0.24, -0.15, -0.07, 0, 0.07, 0.15, 0.24, 0.34];   // max turn per 9 m step: radius >= 26 m
      let wander = 0, bad = 0, lastTurn = 0;
      const q2 = this._tq2 || (this._tq2 = {});
      // the walk follows the terrain as it really is (road benches / cliff clamps included), not the raw noise
      for (let st = 0; st < steps; st++) {
        wander += (rnd() - 0.5) * 0.06; wander *= 0.9;
        const tg = climbed > 240 ? 0.0 : target0;
        let best = -1e9, bd = 0, bx = 0, bz = 0, byn = 0;
        for (const dth of dtheta) {
          const dt2 = st < 3 ? 0 : clamp(dth + wander, -0.34, 0.34);   // leave the road in a straight line first
          const a2 = ang + dt2;
          const ca = Math.cos(a2), sa = Math.sin(a2);
          const nx = px + ca * TRAIL_STEP, nz = pz + sa * TRAIL_STEP;
          const h = this.roadHeight(nx, nz);
          const yn = clamp(h, yc - G * TRAIL_STEP, yc + G * TRAIL_STEP);       // the track can only climb / fall so fast
          const cutfill = Math.abs(h - yn);                                    // how far the ground is from the track
          // cross slope: the ground to either side of the track must not be a wall
          const hl = this.roadHeight(nx - sa * 4, nz + ca * 4), hr = this.roadHeight(nx + sa * 4, nz - ca * 4);
          const cross = Math.max(Math.abs(hl - yn), Math.abs(hr - yn)) / 4;
          let score = -Math.abs((yn - yc) / TRAIL_STEP - tg) * 10 - Math.abs(dt2) * 1.2 - Math.abs(dt2 - lastTurn) * 5 - cutfill * 0.3 - Math.max(0, cross - 0.65) * 5;
          // never fold back onto the track itself
          for (let m = 0; m < pts.length / 2 - 4; m++) { const ddx = pts[m * 2] - nx, ddz = pts[m * 2 + 1] - nz; const dd = ddx * ddx + ddz * ddz; if (dd < 900) { score -= dd < 400 ? 100 : 12; if (dd < 400) break; } }
          if (h < this.waterY + 1.6) score -= 40;
          if (st > 2) { const r = this.nearest(nx, nz, q2); if (r && r.d < 40) { score -= (40 - r.d) * (st < 14 ? 0.12 : 0.6); if (st >= 4 && r.d < 18) score -= 100; } }   // never come back to the main road
          if (score > best) { best = score; bd = dth; bx = nx; bz = nz; byn = yn; }
        }
        if (best < -45) { if (++bad > 2) { this._whyEnd = [st, Math.round(best)]; break; } } else bad = 0;
        lastTurn = clamp(bd + wander, -0.34, 0.34);
        ang += lastTurn;
        px = bx; pz = bz;
        climbed += Math.max(byn - yc, 0);
        yc = byn;
        pts.push(px, pz); hs.push(yc);
      }
      return { pts, hs };
    };
    // try several junction positions (and both sides) and keep the longest track
    let side = 1, pts = [], hs = [], bestS = sPos;
    const offs = [0, 60, -60, 130, -130, 220, -220, 340, -340];
    for (const off of offs) {
      const ii = Math.max(20, Math.min(Math.floor((sPos + off) / DS), this.finalized - 3));
      for (const sd of (rnd() < 0.5 ? [-1, 1] : [1, -1])) {
        const r = walk(sd, ii);
        if (r.hs.length > hs.length) { hs = r.hs; pts = r.pts; side = sd; bestS = ii * DS; }
      }
      if (hs.length >= 120) break;
    }
    (this.trailLog || (this.trailLog = [])).push([k, Math.round(sPos), hs.length]);
    if (hs.length < 25) return;                     // nowhere sensible to go from here
    const n = hs.length;
    // smooth the height profile, limit the grade, and blend the first samples into the road level
    const ys = hs.slice();
    for (let pass = 0; pass < 2; pass++) for (let j = 1; j < n - 1; j++) ys[j] = (ys[j - 1] + 2 * ys[j] + ys[j + 1]) / 4;
    for (let j = 1; j < n; j++) { const mx = G * TRAIL_STEP; ys[j] = clamp(ys[j], ys[j - 1] - mx, ys[j - 1] + mx); }
    for (let j = 0; j < Math.min(n, 8); j++) { const a2 = j / 7; ys[j] = hs[0] + (ys[j] - hs[0]) * a2 * a2 * (3 - 2 * a2); }
    ys[0] = hs[0];
    const tr = { pts, ys, n, side, s: bestS };
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
    const W = 2.4, blend = 3.4 + Math.min(1.7 * Math.abs(h - q.y), 16);
    const a = smoothstep(W, W + blend, q.d);
    const bed = q.y - 0.05 - 0.05 * smoothstep(1.6, 3.2, q.d);
    return bed + (h - bed) * a;
  }

  // terrain height with the main road carved in but without side tracks (used to lay the tracks out)
  roadHeight(x, z) {
    const nat = this.natural(x, z);
    const r = this.nearest(x, z, this._tr || (this._tr = {}));
    return (!r || r.d > REACH) ? nat : this._carve(nat, r.y, r.d, x, z);
  }

  // full terrain height at (x, z) given road info r (from nearest / nearestHint) - road carve first, then side tracks
  shape(nat, x, z, r) {
    let h = (!r || r.d > REACH) ? nat : this._carve(nat, r.y, r.d, x, z);
    if (this.trailsOn && this.trails.length) h = this._trailCarve(h, x, z); else this.tdist = 99;
    return h;
  }

  // carved terrain height
  height(x, z) {
    const nat = this.natural(x, z);
    const r = this.nearest(x, z, this._tmp);
    return this.shape(nat, x, z, r);
  }

  // soft min / max (log-sum-exp) so clamped surfaces have no creases
  static smin(a, b, k) { return Math.min(a, b) - k * Math.log(1 + Math.exp(-Math.abs(a - b) / k)); }
  static smax(a, b, k) { return Math.max(a, b) + k * Math.log(1 + Math.exp(-Math.abs(a - b) / k)); }

  _carve(nat, roadY, d, x, z) {
    const o = this._zone(z), wg = o.wc + o.wm;
    const bed = roadY - 0.07 - 0.14 * smoothstep(4.1, 9, d);
    let free = nat;
    if (wg < 0.999) {
      const blend = 34 + Math.min(2.0 * Math.abs(nat - roadY), 28);
      free = bed + (nat - bed) * smoothstep(5.2, blend, d);
    }
    if (wg <= 0.001) return free;
    // guided styles: a level bench (shoulder + ditch), then the hillside is held between a cut slope and a fill / cliff slope
    // so there is never a wall standing on the road edge
    const rise = Math.max(0, d - 6.6);
    const hi = bed + 0.75 * rise;
    const lo = bed - (1.05 + 0.5 * (o.wc / wg)) * rise;
    let h = World.smax(World.smin(nat, hi, 1.4), lo, 1.4);
    h = nat + (h - nat) * (1 - smoothstep(REACH - 40, REACH - 4, d));   // clamp fades out before the lookup radius ends
    h = bed + (h - bed) * smoothstep(4.8, 7.4, d);
    return free * (1 - wg) + h * wg;
  }

  heightRI(x, z) { // also returns road info in this._tmp (valid until next call)
    const nat = this.natural(x, z);
    const r = this.nearest(x, z, this._tmp);
    if (!r || r.d > REACH) this._tmp.d = 999;
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
