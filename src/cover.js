import * as THREE from 'three';
import { mulberry32, hash2, smoothstep, clamp, Noise } from './noise.js';
import { patchMaterial, LITE } from './gfx.js';
import { windPatch, atlasRect, remapUV } from './foliage.js';
import { GeoBuilder } from './trees.js';
import * as TX from './textures.js';
import { ROAD_HALF } from './terrain.js';

const V3 = THREE.Vector3;

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------
function grassCards(count, hw, h, taper, leanMax, seed) {
  // crossed cards whose tops lean outwards and narrow slightly, so a clump reads as bending blades instead of flat panes
  const rnd = mulberry32(seed);
  const b = new GeoBuilder();
  b.group(1);
  const n = new V3(0, 1, 0);
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI + 0.25 + (rnd() - 0.5) * 0.35;
    const cx = Math.cos(a), cz = Math.sin(a);
    const lean = (rnd() < 0.5 ? -1 : 1) * leanMax * (0.35 + rnd() * 0.65);
    const nx = -cz * lean, nz = cx * lean;                        // lean sideways out of the card plane
    const sc = 0.85 + rnd() * 0.3;
    const ids = [
      b.vert({ x: -cx * hw * sc, y: 0, z: -cz * hw * sc }, n, 0, 0, 0.5, [0, 0, 0]),
      b.vert({ x: cx * hw * sc, y: 0, z: cz * hw * sc }, n, 1, 0, 0.5, [0, 0, 0]),
      b.vert({ x: cx * hw * sc * taper + nx, y: h * sc, z: cz * hw * sc * taper + nz }, n, 1, 1, 1.0, [1, 0.5, 0]),
      b.vert({ x: -cx * hw * sc * taper + nx, y: h * sc, z: -cz * hw * sc * taper + nz }, n, 0, 1, 1.0, [1, 0.5, 0]),
    ];
    b.tri(ids[0], ids[1], ids[2]); b.tri(ids[0], ids[2], ids[3]);
  }
  return b.build().leaf;
}
function grassGeometry() { return grassCards(4, 0.4, 0.62, 0.92, 0.16, 11); }
function tallGrassGeometry() { return grassCards(5, 0.5, 1.0, 0.9, 0.24, 23); }

function flowerTexture(seed = 3) {
  const rnd = mulberry32(seed);
  const c = document.createElement('canvas'); c.width = 256; c.height = 256;
  const ctx = c.getContext('2d');
  // stems
  for (let i = 0; i < 9; i++) {
    const x = 30 + rnd() * 196, h = 90 + rnd() * 110;
    ctx.strokeStyle = `hsl(${95 + rnd() * 20},45%,${22 + rnd() * 10}%)`; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(x, 256); ctx.quadraticCurveTo(x + (rnd() - 0.5) * 30, 256 - h * 0.5, x + (rnd() - 0.5) * 24, 256 - h); ctx.stroke();
    const hx = x + (rnd() - 0.5) * 20, hy = 256 - h;
    const kind = i % 3;
    const petal = kind === 0 ? '#f6f2e8' : kind === 1 ? '#f4d23a' : '#b58ae0';
    const r = 12 + rnd() * 7;
    for (let k = 0; k < 8; k++) {
      const a = k / 8 * Math.PI * 2;
      ctx.fillStyle = petal;
      ctx.beginPath(); ctx.ellipse(hx + Math.cos(a) * r * 0.8, hy + Math.sin(a) * r * 0.8, r * 0.55, r * 0.28, a, 0, 7); ctx.fill();
    }
    ctx.fillStyle = kind === 0 ? '#e6b422' : '#7a5a10';
    ctx.beginPath(); ctx.arc(hx, hy, r * 0.35, 0, 7); ctx.fill();
  }
  // leaves at base
  for (let i = 0; i < 14; i++) {
    ctx.fillStyle = `hsl(${90 + rnd() * 25},50%,${20 + rnd() * 14}%)`;
    const x = 40 + rnd() * 176;
    ctx.beginPath(); ctx.ellipse(x, 246, 16, 5, (rnd() - 0.5) * 1.4, 0, 7); ctx.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

function rockGeometry(seed, detail = 3) {
  const rnd = mulberry32(seed * 131 + 7);
  const nz = new Noise(seed * 7 + 1);
  const g = new THREE.IcosahedronGeometry(1, detail);
  const pos = g.attributes.position;
  const sx = 0.8 + rnd() * 0.5, sy = 0.45 + rnd() * 0.35, sz = 0.7 + rnd() * 0.5;
  const v = new V3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const n = nz.n2(v.x * 1.7 + v.y * 0.9, v.z * 1.7 - v.y * 1.1) * 0.28 + nz.n2(v.x * 4.1, v.z * 4.1 + v.y * 3.7) * 0.10 + 1;
    // faceted look: quantise the direction slightly
    v.multiplyScalar(n);
    v.x *= sx; v.y *= sy; v.z *= sz;
    if (v.y < -0.15 * sy) v.y = -0.15 * sy - (v.y + 0.15 * sy) * 0.15; // flat-ish base
    pos.setXYZ(i, v.x, v.y + 0.1, v.z);
  }
  g.computeVertexNormals();
  // ao by height
  const col = new Float32Array(pos.count * 3), wind = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const a = clamp(0.55 + 0.45 * (pos.getY(i) + 0.4) / 1.0, 0.4, 1);
    col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = a;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  // uv: triplanar-ish spherical mapping scaled up
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 3, uv.getY(i) * 2);
  return g;
}

function bushGeometry(seed) {
  const rnd = mulberry32(seed * 977 + 5);
  const b = new GeoBuilder();
  b.group(1);
  const n = new V3(), ax = new V3(), ay = new V3(), c = new V3(), tmp = new V3();
  const R = 0.85, count = 26;
  for (let i = 0; i < count; i++) {
    const z = rnd() * 2 - 1, a = rnd() * Math.PI * 2, r = Math.sqrt(1 - z * z);
    tmp.set(r * Math.cos(a), Math.abs(z) * 0.9, r * Math.sin(a));
    c.copy(tmp).multiplyScalar(R * (0.4 + rnd() * 0.6)); c.y += 0.45;
    n.copy(tmp).normalize().multiplyScalar(0.85).add(new V3(0, 0.3, 0)).normalize();
    ax.set(rnd() - 0.5, 0, rnd() - 0.5).normalize();
    ay.crossVectors(n, ax).normalize(); ax.crossVectors(ay, n).normalize();
    const s = 0.42 + rnd() * 0.25;
    const ao = 0.45 + 0.55 * clamp(tmp.length() * 1.1, 0, 1);
    const ids = [[-1, -1, 0, 0], [1, -1, 1, 0], [1, 1, 1, 1], [-1, 1, 0, 1]].map(q => b.vert(
      { x: c.x + (ax.x * q[0] + ay.x * q[1]) * s, y: c.y + (ax.y * q[0] + ay.y * q[1]) * s, z: c.z + (ax.z * q[0] + ay.z * q[1]) * s }, n, q[2], q[3], ao, [Math.min(c.y / 1.2, 1), 1, rnd()]));
    b.tri(ids[0], ids[1], ids[2]); b.tri(ids[0], ids[2], ids[3]);
  }
  return b.build().leaf;
}

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------
function fadePatch(shader, near, far) {
  shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
    {
      vec3 ipf = vec3(instanceMatrix[3].x, instanceMatrix[3].y, instanceMatrix[3].z);
      float df = distance(ipf, cameraPosition);
      float fadeF = 1.0 - smoothstep(${near.toFixed(1)}, ${far.toFixed(1)}, df);
      vec2 cd = ipf.xz - uCar.xy; float ca = dot(cd, uCar.zw), cs = cd.x * uCar.w - cd.y * uCar.z;
      fadeF *= smoothstep(0.0, 0.5, max(abs(ca) - 2.5, abs(cs) - 1.25));
      transformed *= fadeF;
    }`);
}

function makeGrassMaterial() {
  const tex = TX.makeGrassTexture(9, 512, 512);
  const m = new THREE.MeshStandardMaterial({ map: tex, alphaTest: 0.4, side: THREE.DoubleSide, roughness: 0.85, vertexColors: true, alphaToCoverage: true });
  m.userData.cacheKey = 'grass';
  patchMaterial(m, (sh) => {
    windPatch(sh, { flutter: 0.0, bend: 1.5, translucent: true });
    fadePatch(sh, 55, 95);
  });
  return m;
}

// ---------------------------------------------------------------------------
// Ground cover manager
// ---------------------------------------------------------------------------
const CELL = 32;
export class GroundCover {
  constructor(scene, world, lib, opts = {}) {
    this.scene = scene; this.world = world;
    this.radius = opts.radius ?? 100;
    this.density = opts.density ?? 3.0;
    this.group = new THREE.Group(); scene.add(this.group);
    this.cells = new Map();
    this.frame = 0;
    this.season = opts.season || 'summer';
    this.grassGeo = grassGeometry();
    this.tallGeo = tallGrassGeometry();
    this.grassMat = makeGrassMaterial();
    this.flowerTex = flowerTexture(4);
    this.flowerMat = new THREE.MeshStandardMaterial({ map: this.flowerTex, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.8, vertexColors: true, alphaToCoverage: true });
    this.flowerMat.userData.cacheKey = 'flower';
    patchMaterial(this.flowerMat, (sh) => { windPatch(sh, { flutter: 0, bend: 1.2, translucent: true }); fadePatch(sh, 45, 80); });
    // rocks
    this.rockGeos = [1, 2, 3, 4, 5].map(i => rockGeometry(i, 3));
    this.rockTex = TX.makeRockTexture(4);
    this.rockMat = new THREE.MeshStandardMaterial({ map: this.rockTex, bumpMap: this.rockTex, bumpScale: 3.0, roughness: 0.95, metalness: 0, vertexColors: true });
    this.rockMat.userData.cacheKey = 'rock';
    patchMaterial(this.rockMat, (sh) => { });
    // bushes
    this.bushGeos = [1, 2, 3].map(i => { const g = bushGeometry(i); remapUV(g, atlasRect('oak')); return g; });
    this.bushMat = lib.leafMat;
    this.m4 = new THREE.Matrix4(); this.q = new THREE.Quaternion(); this.p = new V3(); this.sc = new V3(); this.up = new V3(0, 1, 0);
    this.col = new THREE.Color();
    this.queue = [];
    this.h = new Float32Array(17 * 17);
    this.stats = { cells: 0, grass: 0 };
  }

  key(cx, cz) { return cx + ',' + cz; }

  buildCell(cx, cz) {
    const w = this.world;
    const ox = cx * CELL, oz = cz * CELL;
    const rnd = mulberry32(hash2(cx, cz, 77) * 4294967296 | 0);
    // 2 m height grid
    const N = 16, H = this.h;
    const dist = new Float32Array(17 * 17);
    for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) {
      const x = ox + i * 2, z = oz + j * 2;
      H[j * 17 + i] = w.heightRI(x, z); dist[j * 17 + i] = Math.min(w._tmp.d, w.tdist < 3.6 ? -1 : 999);
    }
    const sample = (x, z) => {
      const fx = (x - ox) / 2, fz = (z - oz) / 2;
      const i = Math.min(Math.floor(fx), N - 1), j = Math.min(Math.floor(fz), N - 1);
      const tx = fx - i, tz = fz - j;
      const a = H[j * 17 + i], b = H[j * 17 + i + 1], c = H[(j + 1) * 17 + i], d = H[(j + 1) * 17 + i + 1];
      const dd = Math.min(dist[j * 17 + i], dist[j * 17 + i + 1], dist[(j + 1) * 17 + i], dist[(j + 1) * 17 + i + 1]);
      return [a + (b - a) * tx + (c - a) * tz + (a - b - c + d) * tx * tz, dd];
    };
    const forestC = w.forest(ox + CELL / 2, oz + CELL / 2);
    const season = this.season || 'summer';
    const winter = season === 'winter';
    const spring = season === 'spring';
    const tintMul = season === 'autumn' ? [1.8, 0.98, 0.3] : spring ? [0.9, 1.12, 0.62] : [1, 1, 1];
    const grassList = [], flowerList = [], tallList = [], rockList = [], bushList = [];
    const distToCam = Math.hypot(ox + CELL / 2 - this._cam.x, oz + CELL / 2 - this._cam.z);
    const nearC = distToCam < 46;
    const n = Math.floor(CELL * CELL * this.density * (nearC ? 2.2 : 1));
    const dens = winter ? 0.0 : distToCam > 70 ? 0.6 : 1;
    for (let k = 0; k < n; k++) {
      const x = ox + rnd() * CELL, z = oz + rnd() * CELL;
      const [h, d] = sample(x, z);
      if (d < ROAD_HALF + 0.55 + rnd() * 0.5) continue;
      if (h < w.waterY + 0.35) continue;
      const f = w.forest(x, z);
      const r1 = rnd();
      // sparser under forests (leaf litter), full meadow otherwise
      if (r1 > (1 - f * 0.65) * dens) continue;
      // gravel shoulder: only sparse tufts
      if (d < 7.0 && rnd() > 0.35) continue;
      const nl = w.noise2.n2(x * 0.02, z * 0.02);
      const s = (0.42 + rnd() * 0.5 + Math.max(nl, 0) * 0.45) * (nearC && rnd() < 0.6 ? 0.55 : 1);
      const tint = 0.75 + rnd() * 0.5;
      grassList.push(x, h - 0.02, z, s, rnd() * 6.283, tint, nl);
    }
    // flowers (meadow patches)
    const nfl = (winter || season === 'autumn' || LITE.on) ? 0 : Math.floor(CELL * CELL * (spring ? 0.28 : 0.11));
    for (let k = 0; k < nfl; k++) {
      const x = ox + rnd() * CELL, z = oz + rnd() * CELL;
      const patch = w.noise.n2(x * 0.03 + 9, z * 0.03 - 4);
      if (patch < (spring ? -0.25 : 0.05)) continue;
      const [h, d] = sample(x, z);
      if (d < 6 || h < w.waterY + 0.5) continue;
      if (w.forest(x, z) > 0.5) continue;
      flowerList.push(x, h - 0.02, z, 0.6 + rnd() * 0.5, rnd() * 6.283);
    }
    // tall grass tufts along fields
    const ntall = (winter || LITE.on) ? 0 : Math.floor(CELL * CELL * 0.06);
    for (let k = 0; k < ntall; k++) {
      const x = ox + rnd() * CELL, z = oz + rnd() * CELL;
      const [h, d] = sample(x, z);
      if (d < 5.5 || h < w.waterY + 0.4) continue;
      const f = w.forest(x, z);
      if (rnd() > 0.25 + f * 0.6) continue;
      tallList.push(x, h - 0.03, z, 0.7 + rnd() * 0.9, rnd() * 6.283, 0.7 + rnd() * 0.4);
    }
    // rocks: near the road edge and on slopes
    const gw = w.guideWeight(oz + CELL / 2);
    const nr = 2 + ((rnd() * 4) | 0) + Math.floor(gw * (7 + rnd() * 9));
    for (let k = 0; k < nr; k++) {
      const x = ox + rnd() * CELL, z = oz + rnd() * CELL;
      const [h, d] = sample(x, z);
      if (d < ROAD_HALF + 1.8 || h < w.waterY + 0.2) continue;
      const roc = w.noise2.n2(x * 0.01 + 3, z * 0.01 + 1);
      if (roc < 0.05 && rnd() > 0.15 + gw) continue;
      const big = rnd() < 0.12 + 0.3 * gw;
      rockList.push(x, h - 0.06, z, (big ? 0.9 + rnd() * 1.2 : 0.14 + rnd() * 0.32), rnd() * 6.283, (rnd() * 5) | 0, 0.75 + rnd() * 0.4);
    }
    // bushes
    const nb = Math.floor(CELL * CELL * 0.0075 * (0.4 + forestC + gw * 1.6));
    for (let k = 0; k < nb; k++) {
      const x = ox + rnd() * CELL, z = oz + rnd() * CELL;
      const [h, d] = sample(x, z);
      if (d < 6.0 || h < w.waterY + 0.5) continue;
      bushList.push(x, h - 0.05, z, 0.8 + rnd() * 1.0, rnd() * 6.283, (rnd() * 3) | 0, 0.8 + rnd() * 0.35);
    }
    const cell = { cx, cz, meshes: [] };
    const inst = (geo, mat, list, stride, fn, shadow = false) => {
      const count = list.length / stride;
      if (!count) return;
      const im = new THREE.InstancedMesh(geo, mat, count);
      for (let i = 0; i < count; i++) fn(im, i, list, i * stride);
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      im.castShadow = shadow; im.receiveShadow = true;
      im.frustumCulled = true;
      // cell bounds for culling
      im.computeBoundingSphere();
      this.group.add(im); cell.meshes.push(im);
    };
    const m4 = this.m4, q = this.q, p = this.p, sc = this.sc, col = this.col;
    inst(this.grassGeo, this.grassMat, grassList, 7, (im, i, l, o) => {
      q.setFromAxisAngle(this.up, l[o + 4]); p.set(l[o], l[o + 1], l[o + 2]); sc.set(l[o + 3], l[o + 3] * (0.8 + 0.4 * (l[o + 6] * 0.5 + 0.5)), l[o + 3]);
      m4.compose(p, q, sc); im.setMatrixAt(i, m4);
      const t = l[o + 5];
      col.setRGB(0.80 * t * tintMul[0], 0.86 * t * tintMul[1], 0.5 * t * tintMul[2]); im.setColorAt(i, col);
    });
    inst(this.tallGeo, this.grassMat, tallList, 6, (im, i, l, o) => {
      q.setFromAxisAngle(this.up, l[o + 4]); p.set(l[o], l[o + 1], l[o + 2]); sc.set(l[o + 3], l[o + 3], l[o + 3]);
      m4.compose(p, q, sc); im.setMatrixAt(i, m4);
      const t = l[o + 5];
      col.setRGB(0.80 * t * tintMul[0], 0.86 * t * tintMul[1], 0.5 * t * tintMul[2]); im.setColorAt(i, col);
    });
    inst(this.grassGeo, this.flowerMat, flowerList, 5, (im, i, l, o) => {
      q.setFromAxisAngle(this.up, l[o + 4]); p.set(l[o], l[o + 1], l[o + 2]); sc.set(l[o + 3], l[o + 3], l[o + 3]);
      m4.compose(p, q, sc); im.setMatrixAt(i, m4);
      col.setRGB(1, 1, 1); im.setColorAt(i, col);
    });
    // rocks: group by variant
    for (let v = 0; v < 5; v++) {
      const sub = [];
      for (let i = 0; i < rockList.length; i += 7) if (rockList[i + 5] === v) for (let k = 0; k < 7; k++) sub.push(rockList[i + k]);
      inst(this.rockGeos[v], this.rockMat, sub, 7, (im, i, l, o) => {
        q.setFromAxisAngle(this.up, l[o + 4]); p.set(l[o], l[o + 1], l[o + 2]); sc.setScalar(l[o + 3]);
        m4.compose(p, q, sc); im.setMatrixAt(i, m4);
        const t = l[o + 6]; col.setRGB(t, t * 0.98, t * 0.92); im.setColorAt(i, col);
      }, true);
    }
    for (let v = 0; v < 3; v++) {
      const sub = [];
      for (let i = 0; i < bushList.length; i += 7) if (bushList[i + 5] === v) for (let k = 0; k < 7; k++) sub.push(bushList[i + k]);
      inst(this.bushGeos[v], this.bushMat, sub, 7, (im, i, l, o) => {
        q.setFromAxisAngle(this.up, l[o + 4]); p.set(l[o], l[o + 1], l[o + 2]); sc.setScalar(l[o + 3]);
        m4.compose(p, q, sc); im.setMatrixAt(i, m4);
        const t = l[o + 6]; col.setRGB((0.75 - 0.2 * gw) * t, (0.9 - 0.3 * gw) * t, (0.42 - 0.06 * gw) * t); im.setColorAt(i, col);
      }, true);
    }
    cell.grass = grassList.length / 7;
    return cell;
  }

  destroyCell(cell) {
    for (const im of cell.meshes) { this.group.remove(im); im.dispose(); }
  }

  update(cam, budget = 1) {
    this._cam = cam;
    if (LITE.on) return;                     // low quality: trees only, no grass / rocks / bushes (they pop in and cost fill-rate)
    this.frame++;
    if (this.frame % 5 === 1) {
      const R = Math.ceil(this.radius / CELL);
      const cx0 = Math.floor(cam.x / CELL), cz0 = Math.floor(cam.z / CELL);
      const want = new Set();
      this.queue = [];
      for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) {
        const cx = cx0 + dx, cz = cz0 + dz;
        const d = Math.hypot((cx + 0.5) * CELL - cam.x, (cz + 0.5) * CELL - cam.z);
        if (d > this.radius + CELL * 0.5) continue;
        const k = this.key(cx, cz);
        want.add(k);
        if (!this.cells.has(k)) this.queue.push({ cx, cz, d, k });
      }
      this.queue.sort((a, b) => a.d - b.d);
      for (const [k, c] of this.cells) if (!want.has(k)) { this.destroyCell(c); this.cells.delete(k); }
    }
    let n = 0;
    while (this.queue.length && n < budget) {
      const { cx, cz, k } = this.queue.shift();
      if (this.cells.has(k)) continue;
      this.cells.set(k, this.buildCell(cx, cz)); n++;
    }
    let g = 0; for (const c of this.cells.values()) g += c.grass;
    this.stats.cells = this.cells.size; this.stats.grass = g;
  }

  prime(cam) {
    this._cam = cam;
    this.frame = 0;
    this.update(cam, 0);
    while (this.queue.length) this.update(cam, 50);
  }
}
