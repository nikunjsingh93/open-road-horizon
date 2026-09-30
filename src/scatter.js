import * as THREE from 'three';
import { mulberry32, hash2, smoothstep, clamp } from './noise.js';
import { TreeLibrary, SPECIES, SPECIES_LIST, tintsFor, TF } from './foliage.js';

const CELL = 128;
const V3 = THREE.Vector3;

// ---------------------------------------------------------------------------
// Tree scatter: near cells -> BatchedMesh instances (per-instance LOD);
// far cells -> baked (merged) low-poly meshes.
// ---------------------------------------------------------------------------
export class TreeScatter {
  constructor(scene, world, opts = {}) {
    this.scene = scene; this.world = world;
    this.nearR = opts.nearR ?? 300;
    this.farR = opts.farR ?? 1500;
    this.keep = opts.keep ?? 1;                 // fraction of trees actually created (low quality thins the forest)
    this.useLod0 = opts.lod0 !== false;         // the detailed LOD0 trees (high / ultra only)
    this.castShadow = opts.castShadow !== false;
    this.lod0R = opts.lod0R ?? 95;   // LOD0 -> LOD1 dither band is [lod0R-30, lod0R]
    this.xfade = 60;                 // near instances -> merged far mesh band is [nearR-60, nearR]
    this.spacing = opts.spacing ?? 6.2;
    this.season = opts.season ?? 'summer';
    this.lib = new TreeLibrary(3, this.season);
    this.tints = {};
    for (const n of SPECIES_LIST) this.tints[n] = tintsFor(n, this.season);
    this.group = new THREE.Group();
    scene.add(this.group);
    this.cells = new Map();
    this.placements = new Map();
    this.queue = [];
    this.frame = 0;
    this.stats = { near: 0, far: 0, trees: 0 };
    this._initBatches();
    this.m4 = new THREE.Matrix4(); this.q = new THREE.Quaternion(); this.s = new V3(); this.p = new V3();
    this.col = new THREE.Color();
    this.up = new V3(0, 1, 0);
    this.lodCursor = 0;
    this.nearList = [];
  }

  _initBatches() {
    const lib = this.lib;
    // one BatchedMesh per (LOD, species bark) and per LOD leaves so each LOD has its own fade material
    const cap = [{ leaf: 5000, bark: 3500 }, { leaf: 24000, bark: 14000 }];
    this.leafBatch = []; this.barkBatch = []; this.leafGid = {}; this.barkGid = {};
    for (let lod = 0; lod < 2; lod++) {
      let leafV = 0, leafI = 0;
      const barkV = {}, barkI = {};
      for (const n of SPECIES_LIST) {
        barkV[n] = 0; barkI[n] = 0;
        for (const v of lib.geo[n]) {
          const g = v[lod];
          leafV += g.leaf.attributes.position.count; leafI += g.leaf.index.count;
          barkV[n] += g.bark.attributes.position.count; barkI[n] += g.bark.index.count;
        }
      }
      const lb = new THREE.BatchedMesh(cap[lod].leaf, leafV + 64, leafI + 64, lib.leafMats[lod]);
      lb.sortObjects = false; lb.frustumCulled = false; lb.castShadow = this.castShadow; lb.receiveShadow = true;
      this.group.add(lb); this.leafBatch[lod] = lb;
      this.barkBatch[lod] = {};
      for (const n of SPECIES_LIST) {
        const bm = new THREE.BatchedMesh(cap[lod].bark, barkV[n] + 64, barkI[n] + 64, lib.barkMats[n][lod]);
        bm.sortObjects = false; bm.frustumCulled = false; bm.castShadow = this.castShadow; bm.receiveShadow = true;
        this.group.add(bm); this.barkBatch[lod][n] = bm;
      }
    }
    for (const n of SPECIES_LIST) {
      this.leafGid[n] = []; this.barkGid[n] = [];
      lib.geo[n].forEach((v, vi) => {
        this.leafGid[n][vi] = []; this.barkGid[n][vi] = [];
        for (let lod = 0; lod < 2; lod++) {
          this.leafGid[n][vi][lod] = this.leafBatch[lod].addGeometry(v[lod].leaf);
          this.barkGid[n][vi][lod] = this.barkBatch[lod][n].addGeometry(v[lod].bark);
        }
      });
    }
  }

  // ----- placement -----
  cellKey(cx, cz) { return cx + ',' + cz; }

  place(cx, cz) {
    const key = this.cellKey(cx, cz);
    let list = this.placements.get(key);
    if (list) return list;
    const w = this.world;
    const rnd = mulberry32(hash2(cx, cz, w.seed) * 4294967296 | 0);
    const ox = cx * CELL, oz = cz * CELL;
    const sp = this.spacing;
    const n = Math.ceil(CELL / sp);
    list = [];
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const x = ox + (i + rnd()) * sp, z = oz + (j + rnd()) * sp;
        const f = w.forest(x, z);
        const dens = f * f * 0.92 + 0.012;
        const r1 = rnd(), r2 = rnd(), r3 = rnd(), r4 = rnd();
        if (r1 > dens) continue;
        const h = w.heightRI(x, z);
        const d = w._tmp.d;
        if (w.tdist < 6.5) continue;
        if (h < 22 && w.guideWeight(z) > 0.3) continue;     // no trees on coastal skerries / shore rocks                       // keep side tracks clear
        if (d < 8.0) continue;
        if (d < 26 && r3 > smoothstep(8, 26, d) * 0.85 + 0.15) continue;
        if (h < w.waterY + 0.9) continue;
        if (h > 300 || (h > 190 && r1 > dens * (1 - smoothstep(190, 300, h)))) continue;   // tree line
        const hx = w.natural(x + 1.6, z) - w.natural(x - 1.6, z), hz = w.natural(x, z + 1.6) - w.natural(x, z - 1.6);
        if (Math.hypot(hx, hz) / 3.2 > 0.75) continue;
        // species
        const cn = w.noise.n2(x * 0.0035 + 40, z * 0.0035) + h * 0.0035;
        let sp_;
        if (cn > 0.12 + (r4 - 0.5) * 0.25) sp_ = 'spruce';
        else if (w.noise2.n2(x * 0.006 - 9, z * 0.006 + 5) + (r4 - 0.5) * 0.3 > 0.28) sp_ = 'birch';
        else sp_ = 'oak';
        const S = SPECIES[sp_];
        const scale = sp_ === 'spruce' ? 0.7 + r3 * 0.6 : 0.75 + r3 * 0.55;
        if (d < (sp_ === 'spruce' ? 10.5 + scale * 3.5 : 8.0 + scale * 2.0 + r2 * 2.5)) continue;
        list.push({ sp: sp_, v: (rnd() * 3) | 0, x, y: h - 0.12, z, s: scale * (0.9 + 0.2 * f), rot: rnd() * 6.283, tint: (rnd() * this.tints[sp_].length) | 0, shade: 0.85 + rnd() * 0.3, r: rnd() });
      }
    }
    this.placements.set(key, list);
    return list;
  }

  // trunk collision: returns the deepest overlapping trunk for a circle (x,z,r) or null
  collide(x, z, r, out) {
    const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
    let best = null, bp = 0;
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      const list = this.placements.get(this.cellKey(cx + dx, cz + dz));
      if (!list) continue;
      for (let i = 0; i < list.length; i++) {
        const t = list[i];
        if (t.r > this.keep) continue;
        const ddx = x - t.x, ddz = z - t.z;
        if (Math.abs(ddx) > 3 || Math.abs(ddz) > 3) continue;
        const rr = r + (t.sp === 'spruce' ? 0.34 : t.sp === 'birch' ? 0.2 : 0.42) * t.s;
        const d2 = ddx * ddx + ddz * ddz;
        if (d2 < rr * rr) { const d = Math.sqrt(d2) || 1e-3; const pen = rr - d; if (pen > bp) { bp = pen; best = t; out.nx = ddx / d; out.nz = ddz / d; out.pen = pen; } }
      }
    }
    return best;
  }

  // ----- near cell: batched instances (LOD1 always, LOD0 added lazily close to the camera) -----
  buildNear(cell) {
    const list = this.place(cell.cx, cell.cz);
    const inst = [];
    const bark = this.barkBatch[1], leaf = this.leafBatch[1];
    for (const t of list) {
      if (t.r > this.keep) continue;
      const bi = bark[t.sp].addInstance(this.barkGid[t.sp][t.v][1]);
      const li = leaf.addInstance(this.leafGid[t.sp][t.v][1]);
      this._compose(t);
      bark[t.sp].setMatrixAt(bi, this.m4); leaf.setMatrixAt(li, this.m4);
      const tc = this.tints[t.sp][t.tint];
      this.col.setRGB(tc[0] * t.shade, tc[1] * t.shade, tc[2] * t.shade);
      leaf.setColorAt(li, this.col);
      bark[t.sp].setColorAt(bi, this.col.setRGB(t.shade, t.shade, t.shade));
      inst.push({ t, bi, li, b0: -1, l0: -1, vis1: true });
    }
    cell.inst = inst;
    this.nearList.push(cell);
  }

  _compose(t) {
    this.q.setFromAxisAngle(this.up, t.rot);
    this.p.set(t.x, t.y, t.z); this.s.setScalar(t.s);
    this.m4.compose(this.p, this.q, this.s);
  }

  _addLod0(o) {
    const t = o.t, bark = this.barkBatch[0][t.sp], leaf = this.leafBatch[0];
    try {
      o.b0 = bark.addInstance(this.barkGid[t.sp][t.v][0]);
      o.l0 = leaf.addInstance(this.leafGid[t.sp][t.v][0]);
    } catch (e) { this._dropLod0(o); return; }   // batch full: keep LOD1 only
    this._compose(t);
    bark.setMatrixAt(o.b0, this.m4); leaf.setMatrixAt(o.l0, this.m4);
    const tc = this.tints[t.sp][t.tint];
    leaf.setColorAt(o.l0, this.col.setRGB(tc[0] * t.shade, tc[1] * t.shade, tc[2] * t.shade));
    bark.setColorAt(o.b0, this.col.setRGB(t.shade, t.shade, t.shade));
  }

  _dropLod0(o) {
    if (o.b0 >= 0) { this.barkBatch[0][o.t.sp].deleteInstance(o.b0); o.b0 = -1; }
    if (o.l0 >= 0) { this.leafBatch[0].deleteInstance(o.l0); o.l0 = -1; }
  }

  destroyNear(cell) {
    for (const o of cell.inst) {
      this.barkBatch[1][o.t.sp].deleteInstance(o.bi);
      this.leafBatch[1].deleteInstance(o.li);
      this._dropLod0(o);
    }
    cell.inst = null;
    const i = this.nearList.indexOf(cell); if (i >= 0) this.nearList.splice(i, 1);
  }

  // ----- far cell: merged mesh -----
  buildFar(cell) {
    const list = this.place(cell.cx, cell.cz);
    const lib = this.lib;
    const camDist = cell.dist;
    const thin = camDist > 850 ? 0.5 : 1;
    const scaleUp = camDist > 850 ? 1.35 : 1;
    const sink = Math.min(5.5, Math.max(0.12, (camDist - 200) * 0.0055));
    let nv = 0, ni = 0;
    const use = [];
    for (const t of list) {
      if ((thin < 1 && t.r > thin) || t.r > this.keep) continue;
      use.push(t);
      const g = lib.geo[t.sp][t.v][2].leaf;
      nv += g.attributes.position.count; ni += g.index.count;
    }
    if (!use.length) { cell.mesh = null; return; }
    const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), uv = new Float32Array(nv * 2), col = new Float32Array(nv * 3), wind = new Float32Array(nv * 3);
    const idx = nv > 65000 ? new Uint32Array(ni) : new Uint16Array(ni);
    let vo = 0, io = 0;
    for (const t of use) {
      const S = SPECIES[t.sp];
      const g = lib.geo[t.sp][t.v][2].leaf;
      const gp = g.attributes.position.array, gn = g.attributes.normal.array, gu = g.attributes.uv.array, gc = g.attributes.color.array;
      const cnt = g.attributes.position.count;
      const c = Math.cos(t.rot), s = Math.sin(t.rot);
      const sc = t.s * scaleUp;
      const tc = this.tints[t.sp][t.tint];
      for (let k = 0; k < cnt; k++) {
        const x = gp[k * 3], y = gp[k * 3 + 1], z = gp[k * 3 + 2];
        pos[(vo + k) * 3] = (x * c + z * s) * sc + t.x; pos[(vo + k) * 3 + 1] = y * sc + t.y - sink; pos[(vo + k) * 3 + 2] = (-x * s + z * c) * sc + t.z;
        const nx = gn[k * 3], nz = gn[k * 3 + 2];
        nor[(vo + k) * 3] = nx * c + nz * s; nor[(vo + k) * 3 + 1] = gn[k * 3 + 1]; nor[(vo + k) * 3 + 2] = -nx * s + nz * c;
        uv[(vo + k) * 2] = gu[k * 2]; uv[(vo + k) * 2 + 1] = gu[k * 2 + 1];
        col[(vo + k) * 3] = gc[k * 3] * tc[0] * t.shade; col[(vo + k) * 3 + 1] = gc[k * 3 + 1] * tc[1] * t.shade; col[(vo + k) * 3 + 2] = gc[k * 3 + 2] * tc[2] * t.shade;
      }
      const gi = g.index.array;
      for (let k = 0; k < gi.length; k++) idx[io + k] = gi[k] + vo;
      vo += cnt; io += gi.length;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aWind', new THREE.BufferAttribute(wind, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, lib.leafMatFar);
    mesh.castShadow = false; mesh.receiveShadow = false;
    this.group.add(mesh);
    cell.mesh = mesh;
  }

  destroyFar(cell) {
    if (cell.mesh) { this.group.remove(cell.mesh); cell.mesh.geometry.dispose(); cell.mesh = null; }
  }

  destroy(cell) {
    if (cell.inst) this.destroyNear(cell);
    if (cell.mesh) this.destroyFar(cell);
    cell.hasFar = false;
  }

  update(cam, budget = 1) {
    this.frame++;
    const cx0 = Math.floor(cam.x / CELL), cz0 = Math.floor(cam.z / CELL);
    const xfA = this.nearR - this.xfade, xfB = this.nearR;
    TF.uFar.value.set(this.farR - 110, this.farR - 5);       // far trees dither out before the last cell ends: no visible pop at the edge
    if (this.useLod0) TF.uTF.value.set(this.lod0R - 30, this.lod0R, xfA, xfB); else TF.uTF.value.set(-300, -200, xfA, xfB);
    if (this.frame % 6 === 1) {
      const R = Math.ceil(this.farR / CELL) + 1;
      const want = new Set();
      this.queue = [];
      for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) {
        const cx = cx0 + dx, cz = cz0 + dz;
        const x0 = cx * CELL, z0 = cz * CELL;
        const mx = x0 + CELL * 0.5, mz = z0 + CELL * 0.5;
        const dist = Math.hypot(mx - cam.x, mz - cam.z);
        if (dist > this.farR + CELL) continue;
        // nearest / farthest distance from the camera to this cell's square
        const ndx = Math.max(x0 - cam.x, 0, cam.x - (x0 + CELL)), ndz = Math.max(z0 - cam.z, 0, cam.z - (z0 + CELL));
        const minD = Math.hypot(ndx, ndz);
        const maxD = Math.hypot(Math.max(Math.abs(x0 - cam.x), Math.abs(x0 + CELL - cam.x)), Math.max(Math.abs(z0 - cam.z), Math.abs(z0 + CELL - cam.z)));
        const key = this.cellKey(cx, cz);
        let cell = this.cells.get(key);
        if (!cell) { cell = { cx, cz, inst: null, mesh: null, hasFar: false, dist }; this.cells.set(key, cell); }
        cell.dist = dist;
        want.add(key);
        // near instances while any part of the cell can be inside the near radius; merged far mesh while any part is beyond the fade start
        const needNear = cell.inst ? minD < this.nearR + 30 : minD < this.nearR;
        const needFar = cell.hasFar ? maxD > xfA - 30 : maxD > xfA;
        if (needNear !== !!cell.inst) this.queue.push({ cell, op: 'near', on: needNear });
        if (needFar !== cell.hasFar) this.queue.push({ cell, op: 'far', on: needFar });
      }
      this.queue.sort((a, b) => a.cell.dist - b.cell.dist);
      for (const [key, cell] of this.cells) {
        if (!want.has(key)) { this.destroy(cell); this.cells.delete(key); }
      }
      // forget placements that are very far
      if (this.placements.size > 900) {
        for (const key of this.placements.keys()) { if (!this.cells.has(key)) { this.placements.delete(key); if (this.placements.size < 650) break; } }
      }
    }
    let done = 0;
    while (this.queue.length && done < budget) {
      const { cell, op, on } = this.queue.shift();
      if (this.cells.get(this.cellKey(cell.cx, cell.cz)) !== cell) continue;
      if (op === 'near') {
        if (!!cell.inst === on) continue;
        if (on) this.buildNear(cell); else this.destroyNear(cell);
      } else {
        if (cell.hasFar === on) continue;
        if (on) { this.buildFar(cell); cell.hasFar = true; } else { this.destroyFar(cell); cell.hasFar = false; }
      }
      done++;
    }
    // per-instance LOD update (amortised)
    this.updateLod(cam);
    let near = 0, far = 0, trees = 0;
    for (const c of this.cells.values()) { if (c.inst) { near++; trees += c.inst.length; } if (c.hasFar) far++; }
    this.stats.near = near; this.stats.far = far; this.stats.trees = trees;
  }

  updateLod(cam) {
    const list = this.nearList;
    if (!list.length) return;
    let budget = 3000;
    const hideR = this.lod0R - 30 - 6, addR = this.lod0R + 14, dropR = this.lod0R + 36;
    const hide2 = hideR * hideR, add2 = addR * addR, drop2 = dropR * dropR;
    let ci = this.lodCursor % list.length;
    let processed = 0;
    while (budget > 0 && processed < list.length) {
      const cell = list[ci];
      for (const o of cell.inst) {
        const dx = o.t.x - cam.x, dz = o.t.z - cam.z, d2 = dx * dx + dz * dz;
        if (o.b0 < 0) { if (this.useLod0 && d2 < add2) this._addLod0(o); }
        else if (d2 > drop2) this._dropLod0(o);
        // the LOD1 copy is completely faded out inside the LOD0 zone: skip drawing it
        const vis = d2 > hide2 || o.b0 < 0;
        if (vis !== o.vis1) { o.vis1 = vis; this.barkBatch[1][o.t.sp].setVisibleAt(o.bi, vis); this.leafBatch[1].setVisibleAt(o.li, vis); }
      }
      budget -= cell.inst.length; processed++;
      ci = (ci + 1) % list.length;
    }
    this.lodCursor = ci;
  }

  // build everything around a point synchronously
  prime(cam) {
    for (let i = 0; i < 6; i++) { this.update(cam, 2000); }
    // classification happens each 6th frame
    this.frame = 0; this.update(cam, 2000);
    // LOD pass for all
    for (let i = 0; i < 10; i++) this.updateLod(cam);
  }
}
