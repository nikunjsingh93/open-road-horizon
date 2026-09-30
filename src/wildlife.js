import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { mulberry32, hash2, smoothstep, clamp } from './noise.js';
import { patchMaterial } from './gfx.js';

const V3 = THREE.Vector3;
const CELL = 56;

// ---------------------------------------------------------------------------
// Low-poly animal models built from primitives (facing +Z, feet at y = 0). Vertex colour carries the coat,
// the `aHead` attribute marks head/neck vertices so a vertex shader can nod them (grazing / looking up).
// ---------------------------------------------------------------------------
function part(geo, m, color, head = 0, noise = 0.0, seed = 1) {
  const g = geo.index ? geo.toNonIndexed() : geo.clone();
  g.applyMatrix4(m);
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 3), hd = new Float32Array(n).fill(head);
  const p = g.attributes.position;
  for (let i = 0; i < n; i++) {
    const h = Math.sin(p.getX(i) * 91.7 + p.getY(i) * 47.3 + p.getZ(i) * 61.1 + seed) * 43758.5453;
    const k = 1 + (h - Math.floor(h) - 0.5) * noise;
    col[i * 3] = color[0] * k; col[i * 3 + 1] = color[1] * k; col[i * 3 + 2] = color[2] * k;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('aHead', new THREE.BufferAttribute(hd, 1));
  g.deleteAttribute('uv');
  return g;
}
const M = (px, py, pz, sx = 1, sy = 1, sz = 1, rx = 0, ry = 0, rz = 0) =>
  new THREE.Matrix4().compose(new V3(px, py, pz), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new V3(sx, sy, sz));
const sph = (w = 10, h = 7) => new THREE.SphereGeometry(1, w, h);
const cyl = (r0, r1, h, s = 6) => new THREE.CylinderGeometry(r1, r0, h, s);

function sheepGeo() {
  const wool = [0.55, 0.52, 0.46], dark = [0.09, 0.08, 0.07];
  const g = [
    part(sph(12, 8), M(0, 0.66, 0, 0.34, 0.33, 0.52), wool, 0, 0.35, 1),
    part(sph(8, 6), M(0, 0.86, 0.05, 0.26, 0.2, 0.34), wool, 0, 0.3, 2),
    part(sph(8, 6), M(0, 0.7, 0.68, 0.11, 0.13, 0.17), dark, 1),
    part(sph(6, 4), M(-0.11, 0.78, 0.66, 0.07, 0.03, 0.05, 0, 0, 0.6), dark, 1),
    part(sph(6, 4), M(0.11, 0.78, 0.66, 0.07, 0.03, 0.05, 0, 0, -0.6), dark, 1),
  ];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) g.push(part(cyl(0.045, 0.035, 0.42, 5), M(sx * 0.15, 0.21, sz * 0.27), dark));
  return mergeGeometries(g);
}
function cowGeo() {
  const white = [0.58, 0.57, 0.54], black = [0.05, 0.045, 0.045], pink = [0.55, 0.37, 0.34];
  const patch = (geo, m, seed, head = 0) => {
    // Holstein patches: split the vertices by low-frequency noise into white / black
    const g = part(geo, m, white, head, 0.1, seed);
    const p = g.attributes.position, c = g.attributes.color;
    for (let i = 0; i < p.count; i++) {
      const v = Math.sin(p.getX(i) * 5.3 + 1.7) * Math.cos(p.getZ(i) * 4.1 + seed) + Math.sin(p.getY(i) * 6.1 + p.getX(i) * 2.0);
      if (v > 0.15) { c.setXYZ(i, black[0], black[1], black[2]); }
    }
    return g;
  };
  const g = [
    patch(sph(14, 9), M(0, 1.0, 0, 0.5, 0.46, 0.98), 3),
    patch(sph(9, 7), M(0, 1.06, 1.06, 0.2, 0.22, 0.3, 0.35), 5, 1),
    part(sph(6, 5), M(0, 0.93, 1.33, 0.13, 0.11, 0.09), pink, 1),
    part(cyl(0.05, 0.02, 0.24, 5), M(-0.15, 1.28, 1.02, 1, 1, 1, 0, 0, 0.8), [0.85, 0.82, 0.7], 1),
    part(cyl(0.05, 0.02, 0.24, 5), M(0.15, 1.28, 1.02, 1, 1, 1, 0, 0, -0.8), [0.85, 0.82, 0.7], 1),
    part(sph(6, 5), M(0, 0.68, -0.28, 0.14, 0.13, 0.2), pink),
  ];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) g.push(part(cyl(0.1, 0.075, 0.72, 6), M(sx * 0.26, 0.36, sz * 0.62), black));
  return mergeGeometries(g);
}
function deerGeo() {
  const coat = [0.32, 0.20, 0.11], belly = [0.5, 0.4, 0.29], dk = [0.1, 0.075, 0.055];
  const g = [
    part(sph(12, 8), M(0, 1.02, 0, 0.23, 0.26, 0.56), coat, 0, 0.18, 4),
    part(sph(8, 6), M(0, 0.9, 0.05, 0.19, 0.16, 0.42), belly),
    part(sph(6, 5), M(0, 1.02, -0.56, 0.11, 0.13, 0.08), [0.62, 0.6, 0.55]),
    part(cyl(0.085, 0.06, 0.56, 6), M(0, 1.36, 0.58, 1, 1, 1, 0.6, 0, 0), coat, 1),
    part(sph(8, 6), M(0, 1.62, 0.82, 0.09, 0.1, 0.18, 0.3), coat, 1),
    part(sph(5, 4), M(0, 1.6, 0.98, 0.045, 0.045, 0.05), dk, 1),
    part(sph(5, 4), M(-0.09, 1.72, 0.74, 0.03, 0.09, 0.05, 0, 0, 0.5), coat, 1),
    part(sph(5, 4), M(0.09, 1.72, 0.74, 0.03, 0.09, 0.05, 0, 0, -0.5), coat, 1),
  ];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) g.push(part(cyl(0.035, 0.026, 0.92, 5), M(sx * 0.11, 0.46, sz * 0.4), dk));
  return mergeGeometries(g);
}

const SPECIES = {
  sheep: { make: sheepGeo, r: 0.55, flee: 26, speed: 3.2, pivot: [0, 0.7, 0.5], max: 260 },
  cow:   { make: cowGeo,   r: 1.0,  flee: 16, speed: 2.4, pivot: [0, 1.05, 0.95], max: 120 },
  deer:  { make: deerGeo,  r: 0.7,  flee: 48, speed: 8.5, pivot: [0, 1.25, 0.5], max: 120 },
};

function makeMaterial(name, sp) {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0 });
  m.userData.cacheKey = 'animal_' + name;
  patchMaterial(m, (sh) => {
    sh.uniforms.uPivot = { value: new V3(...sp.pivot) };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float aHead; uniform vec3 uPivot;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        if (aHead > 0.5) {
          vec3 ip = vec3(instanceMatrix[3].x, 0.0, instanceMatrix[3].z);
          float ph = fract(sin(dot(ip.xz, vec2(12.9898, 78.233))) * 43758.5453) * 6.2832;
          // slow grazing nod with occasional head-up moments
          float nod = 0.45 * max(0.0, sin(uTime * 0.35 + ph)) + 0.05 * sin(uTime * 1.7 + ph * 2.0);
          float c = cos(nod), s = sin(nod);
          vec3 q = transformed - uPivot;
          transformed = uPivot + vec3(q.x, q.y * c + q.z * s, -q.y * s + q.z * c);
        }`);
  });
  return m;
}

// ---------------------------------------------------------------------------
export class Wildlife {
  constructor(scene, world, opts = {}) {
    this.scene = scene; this.world = world;
    this.enabled = opts.enabled !== false;
    this.radius = opts.radius ?? 250;
    this.group = new THREE.Group(); scene.add(this.group);
    this.meshes = {};
    for (const [name, sp] of Object.entries(SPECIES)) {
      const mesh = new THREE.InstancedMesh(sp.make(), makeMaterial(name, sp), sp.max);
      mesh.count = 0; mesh.frustumCulled = false; mesh.castShadow = true; mesh.receiveShadow = true;
      this.group.add(mesh); this.meshes[name] = mesh;
    }
    this.cells = new Map();
    this.animals = [];            // animals within range (rebuilt when the camera moves)
    this.lastBuild = new V3(1e9, 0, 1e9);
    this.m4 = new THREE.Matrix4(); this.q = new THREE.Quaternion(); this.p = new V3(); this.s = new V3(); this.up = new V3(0, 1, 0);
    this.frame = 0;
    this._birds = this._makeBirds();
    this.group.add(this._birds.mesh);
    this.setEnabled(this.enabled);
  }

  setEnabled(on) { this.enabled = on; this.group.visible = on; }

  // ---- placement ----
  _cell(cx, cz) {
    const key = cx + ',' + cz;
    let c = this.cells.get(key);
    if (c) return c;
    c = [];
    this.cells.set(key, c);
    const w = this.world;
    const rnd = mulberry32(hash2(cx, cz, w.seed + 5555) * 4294967296 | 0);
    if (rnd() > 0.34) return c;                       // most cells stay empty
    const x0 = cx * CELL + rnd() * CELL, z0 = cz * CELL + rnd() * CELL;
    const h0 = w.heightRI(x0, z0), d0 = w._tmp.d, td = w.tdist;
    const f = w.forest(x0, z0);
    if (h0 < w.waterY + 0.8 || d0 < 10 || d0 > 110 || td < 6) return c;
    let species = null;
    if (f < 0.32) species = rnd() < 0.62 ? 'sheep' : 'cow';
    else if (f < 0.9 && rnd() < 0.7) species = 'deer';
    if (h0 > 210 && species === 'cow') species = 'sheep';
    if (!species) return c;
    const n = species === 'deer' ? 1 + ((rnd() * 3) | 0) : species === 'cow' ? 2 + ((rnd() * 4) | 0) : 3 + ((rnd() * 7) | 0);
    const yaw0 = rnd() * 6.283;
    for (let i = 0; i < n; i++) {
      const a = rnd() * 6.283, r = 1.5 + rnd() * (species === 'sheep' ? 9 : 7);
      const x = x0 + Math.cos(a) * r, z = z0 + Math.sin(a) * r;
      const h = w.heightRI(x, z), d = w._tmp.d, t2 = w.tdist;
      if (h < w.waterY + 0.7 || d < 9 || t2 < 5) continue;
      const nx = w.height(x + 1.2, z) - w.height(x - 1.2, z), nz = w.height(x, z + 1.2) - w.height(x, z - 1.2);
      if (Math.hypot(nx, nz) / 2.4 > 0.45) continue;
      c.push({ sp: species, hx: x, hz: z, x, z, y: h, yaw: yaw0 + (rnd() - 0.5) * 1.6, s: 0.88 + rnd() * 0.26, vx: 0, vz: 0, flee: 0, id: rnd() });
    }
    return c;
  }

  update(cam, dt, time, car) {
    if (!this.enabled) return;
    this.frame++;
    const w = this.world;
    // (re)collect animals in range when the camera has moved
    if (this.frame % 10 === 1 && Math.hypot(cam.x - this.lastBuild.x, cam.z - this.lastBuild.z) > 25) {
      this.lastBuild.set(cam.x, 0, cam.z);
      const R = Math.ceil(this.radius / CELL), cx0 = Math.floor(cam.x / CELL), cz0 = Math.floor(cam.z / CELL);
      const list = [];
      for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) for (const a of this._cell(cx0 + dx, cz0 + dz)) list.push(a);
      this.animals = list;
      if (this.cells.size > 900) { for (const k of this.cells.keys()) { const [a, b] = k.split(',').map(Number); if (Math.abs(a - cx0) > R + 6 || Math.abs(b - cz0) > R + 6) this.cells.delete(k); if (this.cells.size < 600) break; } }
    }
    // behaviour: flee from a fast approaching car
    const cs = car ? car.speed : 0;
    const counts = { sheep: 0, cow: 0, deer: 0 };
    const m4 = this.m4, q = this.q, p = this.p, sc = this.s;
    const r2 = this.radius * this.radius;
    for (const a of this.animals) {
      const sp = SPECIES[a.sp];
      const ddx = a.x - cam.x, ddz = a.z - cam.z;
      if (ddx * ddx + ddz * ddz > r2) continue;
      if (counts[a.sp] >= sp.max) continue;
      if (car) {
        const cx = a.x - car.pos.x, cz = a.z - car.pos.z, cd = Math.hypot(cx, cz);
        if (cd < sp.flee && cs > 3.5 && a.flee <= 0) {
          a.flee = 4 + Math.random() * 3;
          // run away from the car, biased away from the road
          const away = Math.atan2(cz, cx);
          a.dir = away + (Math.random() - 0.5) * 0.9;
        }
      }
      if (a.flee > 0) {
        a.flee -= dt;
        const spd = sp.speed * (a.flee > 1 ? 1 : a.flee);
        a.x += Math.cos(a.dir) * spd * dt; a.z += Math.sin(a.dir) * spd * dt;
        a.yaw = Math.atan2(Math.cos(a.dir), Math.sin(a.dir));       // model faces +Z
        if (this.frame % 3 === 0) a.y = w.height(a.x, a.z);
        if (a.y < w.waterY + 0.3) { a.flee = 0; a.x -= Math.cos(a.dir) * 2; a.z -= Math.sin(a.dir) * 2; }
      }
      const bob = a.flee > 0 ? Math.abs(Math.sin(time * 9 + a.id * 20)) * 0.07 * a.s : 0;
      p.set(a.x, a.y + bob, a.z);
      q.setFromAxisAngle(this.up, a.yaw);
      sc.setScalar(a.s);
      m4.compose(p, q, sc);
      this.meshes[a.sp].setMatrixAt(counts[a.sp]++, m4);
    }
    for (const k in this.meshes) { this.meshes[k].count = counts[k]; this.meshes[k].instanceMatrix.needsUpdate = true; }
    this._updateBirds(cam, time);
  }

  // solid obstacles for the car
  collide(x, z, r, out) {
    let best = null, bp = 0;
    for (const a of this.animals) {
      const dx = x - a.x, dz = z - a.z;
      if (Math.abs(dx) > 3 || Math.abs(dz) > 3) continue;
      const rr = r + SPECIES[a.sp].r * a.s * 0.6;
      const d2 = dx * dx + dz * dz;
      if (d2 < rr * rr) { const d = Math.sqrt(d2) || 1e-3; const pen = rr - d; if (pen > bp) { bp = pen; best = a; out.nx = dx / d; out.nz = dz / d; out.pen = pen; } }
    }
    return best;
  }

  // ---- birds: a few loose flocks circling over the landscape ----
  _makeBirds() {
    const N = 44;
    const g = new THREE.BufferGeometry();
    // a tiny "V": body point + two wing triangles
    const v = new Float32Array([0, 0, 0.5, -0.9, 0, -0.1, 0, 0, -0.25,   0, 0, 0.5, 0, 0, -0.25, 0.9, 0, -0.1]);
    g.setAttribute('position', new THREE.BufferAttribute(v, 3));
    const inst = new Float32Array(N * 4);
    const rnd = mulberry32(4242);
    for (let i = 0; i < N; i++) { const f = i % 4; inst[i * 4] = f; inst[i * 4 + 1] = rnd(); inst[i * 4 + 2] = rnd(); inst[i * 4 + 3] = rnd(); }
    g.setAttribute('aSeed', new THREE.InstancedBufferAttribute(inst, 4));
    const mat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uCam: { value: new V3() }, uDay: { value: 1 }, uFog: { value: new THREE.Color(0.7, 0.8, 0.95) } },
      vertexShader: `
        uniform float uTime; uniform vec3 uCam; attribute vec4 aSeed; varying float vA;
        void main() {
          float flock = aSeed.x;
          // flock centres live on a coarse world grid so they do not follow the camera
          vec2 g = floor(uCam.xz / 700.0) * 700.0 + vec2(120.0 + flock * 230.0, 60.0 + mod(flock * 3.0, 4.0) * 170.0);
          float ang = uTime * (0.16 + aSeed.y * 0.05) * (mod(flock, 2.0) < 1.0 ? 1.0 : -1.0) + aSeed.z * 6.28;
          float rad = 45.0 + aSeed.y * 70.0;
          vec3 c = vec3(g.x + cos(ang) * rad, uCam.y + 45.0 + aSeed.w * 60.0 + sin(uTime * 0.3 + aSeed.z * 9.0) * 6.0, g.y + sin(ang) * rad);
          vec2 fwd = normalize(vec2(-sin(ang), cos(ang)) * (mod(flock, 2.0) < 1.0 ? 1.0 : -1.0));
          float flap = sin(uTime * (9.0 + aSeed.y * 3.0) + aSeed.w * 20.0);
          vec3 lp = position * (1.0 + aSeed.w * 0.5);
          lp.y += flap * abs(position.x) * 0.55 * 1.2;
          vec3 wp = c + vec3(lp.x * fwd.y + lp.z * fwd.x, lp.y, -lp.x * fwd.x + lp.z * fwd.y);
          vec4 mv = viewMatrix * vec4(wp, 1.0);
          gl_Position = projectionMatrix * mv;
          float dist = length(mv.xyz);
          vA = 1.0 - smoothstep(600.0, 900.0, dist);
        }`,
      fragmentShader: `uniform float uDay; uniform vec3 uFog; varying float vA; void main() { gl_FragColor = vec4(mix(vec3(0.05, 0.05, 0.06), uFog, 0.25), vA * uDay); }`,
      transparent: true, side: THREE.DoubleSide, depthWrite: false,
    });
    const mesh = new THREE.InstancedMesh(g, mat, N);
    mesh.frustumCulled = false; mesh.renderOrder = 6;
    return { mesh, mat };
  }
  _updateBirds(cam, time) {
    const u = this._birds.mat.uniforms;
    u.uTime.value = time; u.uCam.value.copy(cam);
  }
  setDay(day, fog) { const u = this._birds.mat.uniforms; u.uDay.value = day; if (fog) u.uFog.value.copy(fog); }
}
