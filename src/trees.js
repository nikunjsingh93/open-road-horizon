import * as THREE from 'three';
import { mulberry32 } from './noise.js';
import { patchMaterial } from './gfx.js';
import * as TX from './textures.js';

const V3 = THREE.Vector3;

// ---------------------------------------------------------------------------
// Geometry builder
// ---------------------------------------------------------------------------
class Chan {
  constructor() { this.pos = []; this.nor = []; this.uv = []; this.col = []; this.wind = []; this.idx = []; this.n = 0; }
  toGeometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aWind', new THREE.Float32BufferAttribute(this.wind, 3));
    g.setIndex(this.idx);
    g.computeBoundingSphere(); g.computeBoundingBox();
    return g;
  }
}

// two channels: 0 = bark, 1 = leaves
export class GeoBuilder {
  constructor() { this.ch = [new Chan(), new Chan()]; this.cur = this.ch[0]; }
  group(mi) { this.cur = this.ch[mi]; }
  vert(p, n, u, v, c, w) {
    const k = this.cur;
    k.pos.push(p.x, p.y, p.z); k.nor.push(n.x, n.y, n.z); k.uv.push(u, v);
    k.col.push(c, c, c); k.wind.push(w[0], w[1], w[2]);
    return k.n++;
  }
  tri(a, b, c) { this.cur.idx.push(a, b, c); }
  build() { return { bark: this.ch[0].toGeometry(), leaf: this.ch[1].toGeometry() }; }
}

const tmpA = new V3(), tmpB = new V3(), tmpC = new V3(), tmpD = new V3();

// tube along polyline; material index 0 = bark
function addTube(b, pts, radii, radial, H, uRep = 2, vScale = 0.25, ao = 1) {
  b.group(0);
  const rings = [];
  let cum = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const t = tmpA.copy(pts[Math.min(i + 1, pts.length - 1)]).sub(pts[Math.max(i - 1, 0)]).normalize();
    const ref = Math.abs(t.x) < 0.9 ? tmpB.set(1, 0, 0) : tmpB.set(0, 0, 1);
    const u = tmpC.copy(t).cross(ref).normalize();
    const v = tmpD.copy(t).cross(u).normalize();
    if (i > 0) cum += pts[i].distanceTo(pts[i - 1]);
    const ring = [];
    for (let k = 0; k <= radial; k++) {
      const a = (k / radial) * Math.PI * 2;
      const nx = u.x * Math.cos(a) + v.x * Math.sin(a), ny = u.y * Math.cos(a) + v.y * Math.sin(a), nz = u.z * Math.cos(a) + v.z * Math.sin(a);
      const r = radii[i];
      const vi = b.vert({ x: p.x + nx * r, y: p.y + ny * r, z: p.z + nz * r }, { x: nx, y: ny, z: nz }, (k / radial) * uRep, cum * vScale / Math.max(radii[0], 0.15) * 0.35, ao, [Math.min(p.y / H, 1), 0, 0]);
      ring.push(vi);
    }
    rings.push(ring);
  }
  for (let i = 0; i < rings.length - 1; i++) {
    for (let k = 0; k < radial; k++) {
      const a = rings[i][k], bb = rings[i][k + 1], c = rings[i + 1][k], d = rings[i + 1][k + 1];
      b.tri(a, c, bb); b.tri(bb, c, d);
    }
  }
}

// quad card; material index 1 = leaves
function addCard(b, center, ax, ay, hw, hh, normal, ao, wind) {
  b.group(1);
  const c = center;
  const p = [
    [c.x - ax.x * hw - ay.x * hh, c.y - ax.y * hw - ay.y * hh, c.z - ax.z * hw - ay.z * hh, 0, 0],
    [c.x + ax.x * hw - ay.x * hh, c.y + ax.y * hw - ay.y * hh, c.z + ax.z * hw - ay.z * hh, 1, 0],
    [c.x + ax.x * hw + ay.x * hh, c.y + ax.y * hw + ay.y * hh, c.z + ax.z * hw + ay.z * hh, 1, 1],
    [c.x - ax.x * hw + ay.x * hh, c.y - ax.y * hw + ay.y * hh, c.z - ax.z * hw + ay.z * hh, 0, 1],
  ];
  const ids = p.map(q => b.vert({ x: q[0], y: q[1], z: q[2] }, normal, q[3], q[4], ao, wind));
  b.tri(ids[0], ids[1], ids[2]); b.tri(ids[0], ids[2], ids[3]);
}

function randUnit(rnd, out) {
  const z = rnd() * 2 - 1, a = rnd() * Math.PI * 2, r = Math.sqrt(1 - z * z);
  return out.set(r * Math.cos(a), z, r * Math.sin(a));
}

// ---------------------------------------------------------------------------
// Broad-leaf tree
// ---------------------------------------------------------------------------
export function buildBroadleaf(seed, P, lod) {
  const rnd = mulberry32(seed * 977 + 13);
  const b = new GeoBuilder();
  const H = P.height * (0.92 + rnd() * 0.16);
  const radial = lod === 0 ? 8 : lod === 1 ? 6 : 4;
  const tips = [];
  const trunkR = P.trunkR * H / 12;
  const segLen = lod === 0 ? 0.75 : 1.4;
  const maxDepth = lod === 0 ? 3 : 2;

  function branch(p0, dir, len, r0, depth, isTrunk = false) {
    const segs = Math.max(3, Math.round(len / segLen));
    const pts = [p0.clone()], radii = [r0];
    const p = p0.clone(), d = dir.clone();
    const spawned = [];
    for (let i = 1; i <= segs; i++) {
      const wig = isTrunk ? 0.06 : 0.16;
      d.x += (rnd() - 0.5) * wig; d.z += (rnd() - 0.5) * wig;
      d.y += (isTrunk ? 0.02 : 0.05 * P.upward);
      d.normalize();
      p.addScaledVector(d, len / segs);
      pts.push(p.clone());
      const taper = 1 - (i / segs) * (isTrunk ? 0.55 : 0.82);
      radii.push(Math.max(r0 * taper, 0.012));
      if (depth < maxDepth && i > (isTrunk ? segs - 2 : 1) && i < segs && !isTrunk) {
        if (rnd() < (depth === 0 ? 0.55 : 0.5)) spawned.push({ p: p.clone(), d: d.clone(), r: radii[i], i });
      }
    }
    if (radial > 0) addTube(b, pts, radii, radial, H, 2, 1, 1);
    if (depth >= maxDepth - 1 || pts.length < 4) tips.push({ p: p.clone(), d: d.clone(), depth });
    for (const s of spawned) {
      // child direction: rotate away from parent direction
      const az = rnd() * Math.PI * 2;
      const polar = 0.5 + rnd() * 0.55;
      const ref = Math.abs(s.d.y) < 0.9 ? new V3(0, 1, 0) : new V3(1, 0, 0);
      const u = new V3().crossVectors(s.d, ref).normalize(), v = new V3().crossVectors(s.d, u).normalize();
      const cd = s.d.clone().multiplyScalar(Math.cos(polar)).addScaledVector(u, Math.sin(polar) * Math.cos(az)).addScaledVector(v, Math.sin(polar) * Math.sin(az)).normalize();
      branch(s.p, cd, len * (0.5 + rnd() * 0.25), s.r * 0.75, depth + 1);
    }
    return { pts, d };
  }

  // trunk (with root flare)
  const trunkLen = H * P.trunkFrac;
  const tpts = [], trad = [];
  const lean = new V3((rnd() - 0.5) * 0.12, 0, (rnd() - 0.5) * 0.12);
  const ts = Math.max(4, Math.round(trunkLen / (lod === 0 ? 0.6 : 1.2)));
  for (let i = 0; i <= ts; i++) {
    const t = i / ts;
    tpts.push(new V3(lean.x * t * trunkLen + Math.sin(t * 3 + seed) * 0.08, t * trunkLen - 0.2, lean.z * t * trunkLen + Math.cos(t * 2.4 + seed) * 0.08));
    const flare = 1 + 1.4 * Math.exp(-t * 14);
    trad.push(trunkR * (1 - t * 0.5) * flare);
  }
  if (radial > 0) addTube(b, tpts, trad, radial + 2, H, 2, 1, 1);
  const top = tpts[tpts.length - 1];
  // main limbs
  const limbs = lod === 0 ? P.limbs : Math.max(3, P.limbs - 2);
  for (let i = 0; i < limbs; i++) {
    const az = (i / limbs) * Math.PI * 2 + rnd() * 0.8;
    const polar = P.limbPolar[0] + rnd() * (P.limbPolar[1] - P.limbPolar[0]);
    const d = new V3(Math.sin(polar) * Math.cos(az), Math.cos(polar), Math.sin(polar) * Math.sin(az)).normalize();
    const start = top.clone(); start.y -= rnd() * trunkLen * 0.18;
    branch(start, d, H * (P.limbLen[0] + rnd() * (P.limbLen[1] - P.limbLen[0])), trunkR * 0.42, 0);
  }
  // leaf cards
  let bx = 0, by = 0, bz = 0, bmax = 0;
  for (const t of tips) { bx += t.p.x; by += t.p.y; bz += t.p.z; }
  const cc = new V3(bx / tips.length, by / tips.length, bz / tips.length);
  for (const t of tips) bmax = Math.max(bmax, Math.hypot(t.p.x - cc.x, (t.p.y - cc.y) * 1.2, t.p.z - cc.z));
  const crownR = Math.max(bmax + 1.2, 2.5);
  const cardsPerTip = lod === 0 ? P.cardsPerTip : lod === 1 ? 2 : 1;
  const size = (lod === 0 ? 1.0 : lod === 1 ? 1.7 : 3.4) * P.leafSize;
  const nrm = new V3(), ax = new V3(), ay = new V3(), cen = new V3(), out = new V3(), fn = new V3();
  const emit = (center, s) => {
    randUnit(rnd, fn);
    ax.crossVectors(fn, Math.abs(fn.y) > 0.9 ? tmpA.set(1, 0, 0) : tmpA.set(0, 1, 0)).normalize();
    ay.crossVectors(fn, ax).normalize();
    // slight droop bias
    out.copy(center).sub(cc);
    const dist = Math.min(out.length() / crownR, 1.2);
    out.normalize();
    nrm.copy(fn).multiplyScalar(0.28).addScaledVector(out, 0.9).normalize();
    const yRel = (center.y - cc.y) / crownR;
    const ao = Math.min(1, 0.42 + 0.58 * dist * dist + 0.22 * Math.max(yRel, 0));
    addCard(b, center, ax, ay, s * (0.85 + rnd() * 0.3), s * (0.85 + rnd() * 0.3), nrm, ao, [Math.min(center.y / H, 1), 1, rnd()]);
  };
  for (const t of tips) {
    for (let k = 0; k < cardsPerTip; k++) {
      cen.set((rnd() - 0.5) * 1.6, (rnd() - 0.4) * 1.3, (rnd() - 0.5) * 1.6).multiplyScalar(size).add(t.p);
      emit(cen.clone(), size * (0.9 + rnd() * 0.4));
    }
  }
  const fill = lod === 0 ? P.fill : lod === 1 ? 22 : 10;
  for (let k = 0; k < fill; k++) {
    // points in the crown volume, biased to the shell
    randUnit(rnd, tmpB).multiplyScalar(crownR * (0.55 + rnd() * 0.5));
    cen.set(tmpB.x, tmpB.y * P.crownSquash, tmpB.z).add(cc);
    emit(cen.clone(), size * (1.05 + rnd() * 0.5));
  }
  const g = b.build();
  g.height = H + crownR * 0.6; g.radius = crownR;
  return g;
}

// ---------------------------------------------------------------------------
// Conifer (spruce/fir)
// ---------------------------------------------------------------------------
export function buildConifer(seed, P, lod) {
  const rnd = mulberry32(seed * 7919 + 3);
  const b = new GeoBuilder();
  const H = P.height * (0.88 + rnd() * 0.24);
  const radial = lod === 0 ? 7 : lod === 1 ? 5 : 4;
  const R0 = P.trunkR * H / 18;
  const pts = [], rad = [];
  const n = Math.max(6, Math.round(H / (lod === 0 ? 1.1 : 2.4)));
  const bendX = (rnd() - 0.5) * 0.9, bendZ = (rnd() - 0.5) * 0.9;
  const trunkAt = (y) => { const t = y / H; return new V3(bendX * t * t * 1.2, y, bendZ * t * t * 1.2); };
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    pts.push(trunkAt(t * H - 0.2));
    rad.push(R0 * (1 - t * 0.93) * (1 + 1.0 * Math.exp(-t * 18)) + 0.015);
  }
  addTube(b, pts, rad, radial, H, 2, 1, 1);
  const y0 = H * P.skirt;
  const whorlStep = lod === 0 ? 0.62 : lod === 1 ? 1.5 : 3.2;
  const nb = lod === 0 ? 8 : lod === 1 ? 6 : 5;
  const Lmax = H * P.spread;
  const brDir = new V3(), ax = new V3(), ay = new V3(), nrm = new V3(), cen = new V3(), up = new V3(0, 1, 0);
  const layers = lod === 0 ? 2 : 1;
  let whorl = 0;
  for (let y = y0; y < H * 0.985; y += whorlStep * (0.85 + rnd() * 0.3)) {
    const t = (y - y0) / (H - y0);
    const L = Lmax * Math.pow(1 - t, 0.85) * (0.9 + rnd() * 0.2) + 0.5;
    const az0 = rnd() * Math.PI * 2;
    for (let i = 0; i < nb; i++) {
      const az = az0 + (i / nb) * Math.PI * 2 + (rnd() - 0.5) * 0.5;
      const droop = (0.35 + (1 - t) * 0.25) * P.droop + (rnd() - 0.5) * 0.2;
      brDir.set(Math.cos(az), -droop * 0.5, Math.sin(az)).normalize();
      const base = trunkAt(y);
      for (let l = 0; l < layers; l++) {
        // branch card: v axis along branch, u axis across (horizontal, perpendicular to azimuth)
        const across = new V3(-Math.sin(az), 0, Math.cos(az));
        const roll = l === 0 ? 0 : 0.9 * (rnd() < 0.5 ? 1 : -1);
        const w = L * (lod === 0 ? 0.36 : 0.5);
        const axV = across.clone();
        const ayV = brDir.clone();
        // roll around branch axis for second layer
        if (roll !== 0) axV.applyAxisAngle(brDir, roll);
        // split into two segments to bend tips downward
        const segs = 2;
        for (let sg = 0; sg < segs; sg++) {
          const s0 = sg / segs, s1 = (sg + 1) / segs;
          const bend = 0.28 * P.droop;
          const c0 = base.clone().addScaledVector(brDir, L * s0); c0.y -= bend * L * s0 * s0;
          const c1 = base.clone().addScaledVector(brDir, L * s1); c1.y -= bend * L * s1 * s1;
          const mid = c0.clone().add(c1).multiplyScalar(0.5);
          // normal: outward + up
          nrm.set(Math.cos(az) * 0.55, 0.85, Math.sin(az) * 0.55).normalize();
          const ao = Math.min(1, 0.32 + 0.68 * (s0 + 0.5 / segs) * (0.5 + 0.5 * (1 - t) ) + 0.25 * t);
          // build quad with explicit UV rows (v from s0..s1)
          b.group(1);
          const hw0 = w * (0.55 + 0.45 * (1 - s0)), hw1 = w * (0.55 + 0.45 * (1 - s1));
          const a0 = c0.clone().addScaledVector(axV, -hw0), a1 = c0.clone().addScaledVector(axV, hw0);
          const a2 = c1.clone().addScaledVector(axV, hw1), a3 = c1.clone().addScaledVector(axV, -hw1);
          const wv = [Math.min(y / H, 1), 1, rnd()];
          const i0 = b.vert(a0, nrm, 0, s0, ao, wv), i1 = b.vert(a1, nrm, 1, s0, ao, wv), i2 = b.vert(a2, nrm, 1, s1, ao, wv), i3 = b.vert(a3, nrm, 0, s1, ao, wv);
          b.tri(i0, i1, i2); b.tri(i0, i2, i3);
        }
      }
    }
    whorl++;
  }
  // leader tip
  const tip = trunkAt(H);
  for (let k = 0; k < 3; k++) {
    const az = k * 2.1;
    ax.set(Math.cos(az), 0, Math.sin(az)); ay.set(0, 1, 0);
    nrm.set(0, 1, 0);
    cen.copy(tip).addScaledVector(ay, -0.5);
    addCard(b, cen, ax, ay, 0.5, 1.0, nrm, 1, [1, 1, rnd()]);
  }
  const g = b.build();
  g.height = H; g.radius = Lmax;
  return g;
}

