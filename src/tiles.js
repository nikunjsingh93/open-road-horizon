import * as THREE from 'three';
import { smoothstep } from './noise.js';
import { makeWaterMaterial } from './water.js';

const N = 32;            // quads per tile side
const MIN_SIZE = 256;
const ROOT = 8192;

// Quadtree LOD terrain (world-aligned tiles) for everything beyond the near road strip.
export class FarTerrain {
  constructor(scene, world, materialFactory) {
    this.scene = scene;
    this.world = world;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.tiles = new Map();
    this.wanted = new Map();
    this.queue = [];
    this.mats = {};
    this.materialFactory = materialFactory;
    this.frame = 0;
    this.maxDist = 7500;
    this.stats = { tiles: 0 };
    this.H = new Float32Array((N + 3) * (N + 3));
    this.waterMat = makeWaterMaterial();
  }

  _mat(size) {
    const lvl = Math.round(Math.log2(size / MIN_SIZE));
    if (!this.mats[lvl]) this.mats[lvl] = this.materialFactory(1 + lvl * 1.5);
    return this.mats[lvl];
  }

  _collect(x0, z0, size, cam, out) {
    // distance from camera to node square
    const dx = Math.max(x0 - cam.x, 0, cam.x - (x0 + size));
    const dz = Math.max(z0 - cam.z, 0, cam.z - (z0 + size));
    const d = Math.hypot(dx, dz);
    if (d > this.maxDist) return;
    if (size > MIN_SIZE && d < size * 1.15) {
      const h = size / 2;
      this._collect(x0, z0, h, cam, out); this._collect(x0 + h, z0, h, cam, out);
      this._collect(x0, z0 + h, h, cam, out); this._collect(x0 + h, z0 + h, h, cam, out);
    } else out.push({ x0, z0, size, key: x0 + '_' + z0 + '_' + size, d });
  }

  update(cam, budget = 3) {
    this.frame++;
    if (this.frame % 8 === 1 || this.queue.length === 0 && this.frame % 3 === 0) {
      const out = [];
      const r0 = Math.floor((cam.x - this.maxDist) / ROOT), r1 = Math.floor((cam.x + this.maxDist) / ROOT);
      const q0 = Math.floor((cam.z - this.maxDist) / ROOT), q1 = Math.floor((cam.z + this.maxDist) / ROOT);
      for (let a = r0; a <= r1; a++) for (let b = q0; b <= q1; b++) this._collect(a * ROOT, b * ROOT, ROOT, cam, out);
      this.wanted.clear();
      for (const n of out) this.wanted.set(n.key, n);
      this.queue = out.filter(n => !this.tiles.has(n.key)).sort((a, b) => a.d - b.d);
    }
    let built = 0;
    while (this.queue.length && built < budget) {
      const n = this.queue.shift();
      if (this.tiles.has(n.key) || !this.wanted.has(n.key)) continue;
      this.tiles.set(n.key, this.build(n));
      built++;
    }
    if (this.queue.length === 0) {
      for (const [k, t] of this.tiles) {
        if (!this.wanted.has(k)) { this.group.remove(t.mesh); t.mesh.geometry.dispose(); if (t.water) { this.group.remove(t.water); t.water.geometry.dispose(); } this.tiles.delete(k); }
      }
    }
    this.stats.tiles = this.tiles.size;
  }

  // build everything wanted synchronously (used at startup)
  primeAll(cam) {
    this.update(cam, 0);
    while (this.queue.length) this.update(cam, 1000);
  }

  _buildWater(n, H, W, step) {
    const w = this.world;
    const { x0, z0 } = n;
    const nv = (N + 1) * (N + 1);
    const pos = new Float32Array(nv * 3), dep = new Float32Array(nv), nor = new Float32Array(nv * 3);
    for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) {
      const v = j * (N + 1) + i;
      pos[v * 3] = x0 + i * step; pos[v * 3 + 1] = w.waterY; pos[v * 3 + 2] = z0 + j * step;
      dep[v] = w.waterY - H[(j + 1) * W + i + 1];
      nor[v * 3 + 1] = 1;
    }
    const idx = [];
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const a = j * (N + 1) + i, b = a + 1, c = a + (N + 1), d = c + 1;
      if (Math.max(dep[a], dep[b], dep[c], dep[d]) < -0.6) continue;
      idx.push(a, c, b, b, c, d);
    }
    if (!idx.length) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('aDepth', new THREE.BufferAttribute(dep, 1));
    geo.setIndex(idx);
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, this.waterMat);
    mesh.renderOrder = 4;
    this.group.add(mesh);
    return mesh;
  }

  build(n) {
    const w = this.world;
    const { x0, z0, size } = n;
    const step = size / N;
    const W = N + 3;
    const H = this.H;
    const forest = new Float32Array((N + 1) * (N + 1));
    const dist = new Float32Array((N + 1) * (N + 1));
    for (let j = -1; j <= N + 1; j++) {
      for (let i = -1; i <= N + 1; i++) {
        const x = x0 + i * step, z = z0 + j * step;
        let h = w.heightRI(x, z);
        const d = w._tmp.d;
        // sink under the near strip so the two meshes never z-fight
        if (d < 50) h -= 0.55 * (1 - smoothstep(30, 47, d));
        H[(j + 1) * W + (i + 1)] = h;
        if (i >= 0 && j >= 0 && i <= N && j <= N) {
          forest[j * (N + 1) + i] = w.forest(x, z);
          dist[j * (N + 1) + i] = d;
        }
      }
    }
    let minH = 1e9;
    for (let k = 0; k < H.length; k++) if (H[k] < minH) minH = H[k];
    const skirt = Math.max(3, size * 0.02);
    const nv = (N + 1) * (N + 1);
    const ns = 4 * (N + 1);
    const pos = new Float32Array((nv + ns) * 3);
    const nor = new Float32Array((nv + ns) * 3);
    const info = new Float32Array((nv + ns) * 4);
    for (let j = 0; j <= N; j++) {
      for (let i = 0; i <= N; i++) {
        const v = j * (N + 1) + i;
        const hc = H[(j + 1) * W + i + 1];
        pos[v * 3] = x0 + i * step; pos[v * 3 + 1] = hc; pos[v * 3 + 2] = z0 + j * step;
        const dhdx = (H[(j + 1) * W + i + 2] - H[(j + 1) * W + i]) / (2 * step);
        const dhdz = (H[(j + 2) * W + i + 1] - H[j * W + i + 1]) / (2 * step);
        const l = Math.hypot(dhdx, 1, dhdz);
        nor[v * 3] = -dhdx / l; nor[v * 3 + 1] = 1 / l; nor[v * 3 + 2] = -dhdz / l;
        info[v * 4] = Math.min(dist[v], 60); info[v * 4 + 1] = forest[v];
      }
    }
    // skirts (copy edge vertices lowered)
    const index = [];
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const a = j * (N + 1) + i, b = a + 1, c = a + (N + 1), d = c + 1;
        index.push(a, c, b, b, c, d);
      }
    }
    let sv = nv;
    const edge = (getIdx, flip) => {
      const base = sv;
      for (let k = 0; k <= N; k++) {
        const v = getIdx(k);
        pos[sv * 3] = pos[v * 3]; pos[sv * 3 + 1] = pos[v * 3 + 1] - skirt; pos[sv * 3 + 2] = pos[v * 3 + 2];
        nor[sv * 3] = nor[v * 3]; nor[sv * 3 + 1] = nor[v * 3 + 1]; nor[sv * 3 + 2] = nor[v * 3 + 2];
        info[sv * 4] = info[v * 4]; info[sv * 4 + 1] = info[v * 4 + 1];
        sv++;
      }
      for (let k = 0; k < N; k++) {
        const a = getIdx(k), b = getIdx(k + 1), c = base + k, d = base + k + 1;
        if (flip) index.push(a, b, c, b, d, c); else index.push(a, c, b, b, c, d);
      }
    };
    edge(k => k, true);                        // z = z0 edge (j=0)
    edge(k => N * (N + 1) + k, false);         // z = z0+size edge
    edge(k => k * (N + 1), false);             // x = x0 edge
    edge(k => k * (N + 1) + N, true);          // x = x0+size edge
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('aInfo', new THREE.BufferAttribute(info, 4));
    geo.setIndex(index);
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, this._mat(size));
    mesh.receiveShadow = size <= 512;
    this.group.add(mesh);
    let water = null;
    if (minH < w.waterY + 0.4) water = this._buildWater(n, H, W, step);
    return { mesh, water };
  }
}
