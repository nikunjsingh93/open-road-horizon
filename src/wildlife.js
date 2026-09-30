import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { mulberry32, hash2, smoothstep, clamp } from './noise.js';
import { patchMaterial } from './gfx.js';

const V3 = THREE.Vector3;
const CELL = 56;

// ---------------------------------------------------------------------------
// Animal models built from primitives (facing +Z, hooves at y = 0). Per-vertex data:
//   color  - coat (with noise / patches)
//   aHead  - 1 for head + neck (nods / grazes / bobs)
//   aLeg   - (hipY, hipZ, gait phase, 1) for leg vertices: the vertex shader swings the leg about the hip and folds the
//            lower leg at the knee, so animals really walk (diagonal walk for cattle & sheep, faster trot when fleeing)
// ---------------------------------------------------------------------------
function part(geo, m, color, head = 0, noise = 0.0, seed = 1, leg = null) {
  const g = geo.index ? geo.toNonIndexed() : geo.clone();
  g.applyMatrix4(m);
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 3), hd = new Float32Array(n).fill(head), lg = new Float32Array(n * 4);
  const p = g.attributes.position;
  for (let i = 0; i < n; i++) {
    const h = Math.sin(p.getX(i) * 91.7 + p.getY(i) * 47.3 + p.getZ(i) * 61.1 + seed) * 43758.5453;
    const k = 1 + (h - Math.floor(h) - 0.5) * noise;
    col[i * 3] = color[0] * k; col[i * 3 + 1] = color[1] * k; col[i * 3 + 2] = color[2] * k;
    if (leg) { lg[i * 4] = leg[0]; lg[i * 4 + 1] = leg[1]; lg[i * 4 + 2] = leg[2]; lg[i * 4 + 3] = 1; }
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('aHead', new THREE.BufferAttribute(hd, 1));
  g.setAttribute('aLeg', new THREE.BufferAttribute(lg, 4));
  g.deleteAttribute('uv');
  return g;
}
const M = (px, py, pz, sx = 1, sy = 1, sz = 1, rx = 0, ry = 0, rz = 0) =>
  new THREE.Matrix4().compose(new V3(px, py, pz), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new V3(sx, sy, sz));
const sph = (w = 12, h = 8) => new THREE.SphereGeometry(1, w, h);
const cyl = (rTop, rBot, h, s = 7) => new THREE.CylinderGeometry(rTop, rBot, h, s);

// A leg: thigh (thick, tapering) + shank (thin) + hoof, hanging from the hip at (x, hipY, z). phase 0 or PI for the diagonal gait.
function leg(x, z, hipY, rThigh, rShank, coat, hoof, phase, bulge = 1) {
  const kneeY = hipY * 0.5;
  return [
    part(cyl(rThigh, rShank * 1.15, hipY - kneeY + 0.02, 7), M(x, (hipY + kneeY) / 2, z), coat, 0, 0.12, 7, [hipY, z, phase]),
    part(sph(8, 6), M(x, kneeY, z, rShank * 1.35, rShank * 1.4, rShank * 1.35), coat, 0, 0, 1, [hipY, z, phase]),
    part(cyl(rShank * 1.05, rShank * 0.8, kneeY - 0.05, 6), M(x, (kneeY - 0.05) / 2 + 0.05, z), coat, 0, 0.1, 3, [hipY, z, phase]),
    part(cyl(rShank * 1.1, rShank * 1.35, 0.075, 6), M(x, 0.04, z + rShank * 0.15), hoof, 0, 0, 1, [hipY, z, phase]),
  ];
}
const quad = (g, hipY, coat, hoof, halfW, zFront, zRear, rF, rH, sK) => {
  for (const sx of [-1, 1]) {
    g.push(...leg(sx * halfW, zFront, hipY, rF, sK, coat, hoof, sx > 0 ? 0 : Math.PI));
    g.push(...leg(sx * halfW, zRear, hipY, rH, sK, coat, hoof, sx > 0 ? Math.PI : 0));
  }
};

function cowGeo() {
  const white = [0.50, 0.49, 0.46], black = [0.05, 0.045, 0.045], pink = [0.6, 0.4, 0.37], horn = [0.62, 0.58, 0.46];
  const patchy = (geo, m, seed, head = 0) => {
    const g = part(geo, m, white, head, 0.08, seed);
    const p = g.attributes.position, c = g.attributes.color;
    for (let i = 0; i < p.count; i++) {
      const v = Math.sin(p.getX(i) * 4.6 + 1.7) * Math.cos(p.getZ(i) * 3.4 + seed) + Math.sin(p.getY(i) * 5.1 + p.getX(i) * 1.6 + seed);
      if (v > 0.35) c.setXYZ(i, black[0], black[1], black[2]);
    }
    return g;
  };
  const g = [
    patchy(sph(16, 10), M(0, 1.05, -0.05, 0.47, 0.46, 0.74), 3),                 // barrel
    patchy(sph(12, 8), M(0, 1.1, 0.55, 0.42, 0.44, 0.44), 8),                    // chest / shoulders
    patchy(sph(12, 8), M(0, 1.08, -0.68, 0.43, 0.43, 0.4), 5),                   // rump
    patchy(sph(10, 7), M(0, 1.39, 0.42, 0.2, 0.15, 0.3), 11),                    // withers hump
    patchy(cyl(0.2, 0.27, 0.62, 9), M(0, 1.2, 1.0, 1, 1, 1, 1.05, 0, 0), 13, 1), // neck
    patchy(sph(12, 9), M(0, 1.06, 1.42, 0.2, 0.235, 0.34, 0.5), 5, 1),           // skull
    part(sph(10, 8), M(0, 0.9, 1.72, 0.16, 0.13, 0.15), pink, 1),                // muzzle
    part(sph(6, 5), M(-0.055, 0.9, 1.84, 0.03, 0.025, 0.03), black, 1),
    part(sph(6, 5), M(0.055, 0.9, 1.84, 0.03, 0.025, 0.03), black, 1),
    part(sph(6, 5), M(-0.13, 1.16, 1.63, 0.05, 0.05, 0.05), black, 1),           // eyes
    part(sph(6, 5), M(0.13, 1.16, 1.63, 0.05, 0.05, 0.05), black, 1),
    part(sph(8, 5), M(-0.3, 1.2, 1.36, 0.16, 0.06, 0.09, 0, 0, 0.35), white, 1), // ears
    part(sph(8, 5), M(0.3, 1.2, 1.36, 0.16, 0.06, 0.09, 0, 0, -0.35), white, 1),
    part(cyl(0.012, 0.04, 0.17, 6), M(-0.14, 1.33, 1.36, 1, 1, 1, 0, 0, 0.7), horn, 1),
    part(cyl(0.012, 0.04, 0.17, 6), M(0.14, 1.33, 1.36, 1, 1, 1, 0, 0, -0.7), horn, 1),
    part(sph(10, 7), M(0, 0.72, -0.62, 0.17, 0.14, 0.22), pink),                 // udder
    part(cyl(0.02, 0.035, 0.85, 5), M(0, 0.95, -1.06, 1, 1, 1, 0.12, 0, 0), black),// tail
    part(sph(6, 5), M(0, 0.5, -1.13, 0.06, 0.13, 0.06), black),                  // tail tuft
  ];
  quad(g, 0.82, white, black, 0.27, 0.6, -0.62, 0.115, 0.14, 0.055);
  return mergeGeometries(g);
}

function sheepGeo() {
  const wool = [0.62, 0.59, 0.52], dark = [0.08, 0.07, 0.065], wool2 = [0.55, 0.52, 0.46];
  const g = [
    part(sph(14, 9), M(0, 0.7, 0, 0.33, 0.31, 0.5), wool, 0, 0.25, 1),
    part(sph(10, 7), M(0, 0.71, 0.3, 0.3, 0.29, 0.28), wool2, 0, 0.25, 2),
    part(sph(10, 7), M(0, 0.7, -0.3, 0.3, 0.29, 0.28), wool, 0, 0.25, 3),
  ];
  // curly fleece tufts
  for (let i = 0; i < 16; i++) {
    const a = i * 2.399, u = ((i * 0.6180339) % 1) * 2 - 1, r = Math.sqrt(1 - u * u);
    g.push(part(sph(7, 5), M(Math.cos(a) * r * 0.29, 0.73 + u * 0.24, Math.sin(a) * r * 0.42, 0.11, 0.1, 0.11), i % 2 ? wool : wool2, 0, 0.3, i));
  }
  g.push(
    part(cyl(0.09, 0.15, 0.36, 8), M(0, 0.88, 0.55, 1, 1, 1, 0.85, 0, 0), dark, 1),                // neck
    part(sph(10, 8), M(0, 0.86, 0.79, 0.11, 0.135, 0.19, 0.4), dark, 1),                            // head
    part(sph(6, 5), M(-0.055, 0.9, 0.86, 0.025, 0.025, 0.025), [0.7, 0.62, 0.3], 1),
    part(sph(6, 5), M(0.055, 0.9, 0.86, 0.025, 0.025, 0.025), [0.7, 0.62, 0.3], 1),
    part(sph(8, 5), M(-0.16, 0.92, 0.74, 0.11, 0.035, 0.06, 0, 0, 0.3), dark, 1),                   // ears
    part(sph(8, 5), M(0.16, 0.92, 0.74, 0.11, 0.035, 0.06, 0, 0, -0.3), dark, 1),
    part(sph(6, 5), M(0, 0.85, -0.5, 0.09, 0.08, 0.1), wool),                                       // tail
  );
  quad(g, 0.5, dark, dark, 0.13, 0.28, -0.3, 0.05, 0.06, 0.028);
  return mergeGeometries(g);
}

function deerGeo() {
  const coat = [0.20, 0.118, 0.062], belly = [0.36, 0.28, 0.20], dk = [0.06, 0.045, 0.032], rump = [0.55, 0.5, 0.42], horn = [0.42, 0.38, 0.3];
  const g = [
    part(sph(14, 9), M(0, 0.98, -0.02, 0.27, 0.3, 0.62), coat, 0, 0.14, 4),
    part(sph(10, 7), M(0, 0.88, 0.0, 0.24, 0.2, 0.5), belly, 0, 0.08),
    part(sph(10, 7), M(0, 1.02, -0.5, 0.26, 0.3, 0.28), coat, 0, 0.14, 6),
    part(sph(7, 5), M(0, 1.0, -0.76, 0.12, 0.17, 0.05), rump),                                     // white rump patch
    part(cyl(0.065, 0.13, 0.62, 8), M(0, 1.33, 0.6, 1, 1, 1, 0.65, 0, 0), coat, 1),                // neck
    part(sph(10, 8), M(0, 1.66, 0.88, 0.1, 0.115, 0.2, 0.35), coat, 1),                            // head
    part(sph(8, 6), M(0, 1.58, 1.05, 0.055, 0.055, 0.09, 0.35), belly, 1),                            // muzzle
    part(sph(5, 4), M(0, 1.56, 1.13, 0.03, 0.027, 0.03), dk, 1),                                 // nose
    part(sph(5, 4), M(-0.085, 1.71, 0.92, 0.022, 0.022, 0.022), dk, 1),
    part(sph(5, 4), M(0.085, 1.71, 0.92, 0.022, 0.022, 0.022), dk, 1),
    part(sph(8, 5), M(-0.15, 1.78, 0.79, 0.11, 0.04, 0.055, 0, 0, 0.55), coat, 1),                    // big ears
    part(sph(8, 5), M(0.15, 1.78, 0.79, 0.11, 0.04, 0.055, 0, 0, -0.55), coat, 1),
    part(sph(6, 5), M(0, 0.98, -0.8, 0.05, 0.07, 0.04, 0.5), rump),                              // tail
  ];
  // antlers: main beam + two tines each side
  for (const sx of [-1, 1]) {
    g.push(part(cyl(0.01, 0.017, 0.4, 5), M(sx * 0.08, 1.92, 0.75, 1, 1, 1, -0.25, 0, -sx * 0.32), horn, 1));
    g.push(part(cyl(0.008, 0.012, 0.2, 5), M(sx * 0.14, 1.92, 0.73, 1, 1, 1, -0.9, 0, -sx * 0.6), horn, 1));
    g.push(part(cyl(0.008, 0.012, 0.22, 5), M(sx * 0.16, 2.06, 0.69, 1, 1, 1, -0.6, 0, -sx * 0.5), horn, 1));
  }
  quad(g, 0.82, coat, dk, 0.13, 0.42, -0.44, 0.075, 0.092, 0.036);
  return mergeGeometries(g);
}

// walk: metres/second when strolling, run: when fleeing; stride: radians of gait phase per metre travelled
const SPECIES = {
  sheep: { make: sheepGeo, r: 0.55, flee: 26, walk: 0.55, run: 3.6, stride: 5.2, pivot: [0, 0.7, 0.5], max: 260 },
  cow:   { make: cowGeo,   r: 1.0,  flee: 16, walk: 0.5,  run: 2.8, stride: 3.6, pivot: [0, 1.1, 0.95], max: 120 },
  deer:  { make: deerGeo,  r: 0.7,  flee: 48, walk: 0.9,  run: 9.0, stride: 3.3, pivot: [0, 1.25, 0.6], max: 120 },
};

function makeMaterial(name, sp) {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0 });
  m.userData.cacheKey = 'animal2_' + name;
  patchMaterial(m, (sh) => {
    sh.uniforms.uPivot = { value: new V3(...sp.pivot) };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float aHead; attribute vec4 aLeg; attribute vec2 aAnim; uniform vec3 uPivot;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        {
          float amp = aAnim.x, ph = aAnim.y;                       // amp: 0 standing .. ~0.4 strolling .. 1 running
          if (aLeg.w > 0.5) {
            float hy = aLeg.x, hz = aLeg.y, kneeY = hy * 0.5;
            float sw = sin(ph + aLeg.z);
            if (transformed.y < kneeY) {                             // fold the shank at the knee while the leg swings through
              float f = max(0.0, -cos(ph + aLeg.z)) * 1.05 * amp;
              float cf = cos(f), sf = sin(f);
              float ky = transformed.y - kneeY, kz = transformed.z - hz;
              transformed.y = kneeY + ky * cf - kz * sf;
              transformed.z = hz + ky * sf + kz * cf;
            }
            float a = sw * (0.05 + 0.6 * amp);
            float c = cos(a), s = sin(a);
            float dy = transformed.y - hy, dz = transformed.z - hz;
            transformed.y = hy + dy * c - dz * s;
            transformed.z = hz + dy * s + dz * c;
          }
          transformed.y += amp * 0.045 * abs(sin(ph)) ;              // body rise / fall
          transformed.x += amp * 0.03 * sin(ph);                      // slight side-to-side sway
          if (aHead > 0.5) {
            vec3 ip = vec3(instanceMatrix[3].x, 0.0, instanceMatrix[3].z);
            float ph0 = fract(sin(dot(ip.xz, vec2(12.9898, 78.233))) * 43758.5453) * 6.2832;
            // standing: slow grazing nods with head-up moments; moving: head carried up and bobbing with the stride
            float graze = 0.5 * max(0.0, sin(uTime * 0.33 + ph0)) + 0.05 * sin(uTime * 1.7 + ph0 * 2.0) - 0.0;
            float nod = mix(graze, -0.12 + 0.06 * sin(ph * 2.0), smoothstep(0.05, 0.3, amp));
            float c = cos(nod), s = sin(nod);
            vec3 q = transformed - uPivot;
            transformed = uPivot + vec3(q.x, q.y * c + q.z * s, -q.y * s + q.z * c);
          }
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
      const geo = sp.make();
      sp.anim = new THREE.InstancedBufferAttribute(new Float32Array(sp.max * 2), 2);
      sp.anim.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('aAnim', sp.anim);
      const mesh = new THREE.InstancedMesh(geo, makeMaterial(name, sp), sp.max);
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
      c.push({ sp: species, hx: x, hz: z, x, z, y: h, yaw: yaw0 + (rnd() - 0.5) * 1.6, s: 0.88 + rnd() * 0.26, vx: 0, vz: 0, flee: 0, id: rnd(), state: 0, timer: 2 + rnd() * 14, dir: 0, amp: 0, ph: rnd() * 6.28, vel: 0 });
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
          const away = Math.atan2(cz, cx);           // run away from the car
          a.dir = away + (Math.random() - 0.5) * 0.9;
          a.state = 2;
        }
      }
      // state machine: 0 graze (stand, head down), 1 stroll, 2 flee
      if (a.state !== 2) {
        a.timer -= dt;
        if (a.timer <= 0) {
          if (a.state === 0) { a.state = 1; a.timer = 3 + Math.random() * 7; a.dir = Math.random() * 6.283; }
          else { a.state = 0; a.timer = 5 + Math.random() * 16; }
        }
      } else { a.flee -= dt; if (a.flee <= 0) { a.state = 0; a.timer = 4 + Math.random() * 6; } }
      const targetSpeed = a.state === 2 ? sp.run * (a.flee > 1 ? 1 : Math.max(a.flee, 0.2)) : a.state === 1 ? sp.walk : 0;
      a.vel += (targetSpeed - a.vel) * Math.min(1, dt * (targetSpeed > a.vel ? 2.2 : 3.5));
      if (a.vel > 0.03 && dt > 0) {
        const nx = a.x + Math.cos(a.dir) * a.vel * dt, nz = a.z + Math.sin(a.dir) * a.vel * dt;
        // keep off the road, out of the water and off steep ground
        const nh = w.heightRI(nx, nz), nd = w._tmp.d;
        if (nh < w.waterY + 0.45 || nd < 7.5 || w.tdist < 3.2 || Math.abs(nh - a.y) > 0.5 * a.vel * dt + 0.12) {
          a.dir += Math.PI * (0.6 + Math.random() * 0.8);
          if (a.state === 1) { a.state = 0; a.timer = 3 + Math.random() * 5; }
        } else { a.x = nx; a.z = nz; a.y += (nh - a.y) * Math.min(1, dt * 8); }
        // turn smoothly towards the direction of travel (the model faces +Z)
        const want = Math.atan2(Math.cos(a.dir), Math.sin(a.dir));
        let dy = want - a.yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
        a.yaw += dy * Math.min(1, dt * (a.state === 2 ? 7 : 3.2));
      }
      const moving = a.vel > 0.06;
      const ampT = moving ? Math.min(1, 0.2 + 0.8 * (a.vel / sp.run) ** 0.7) : 0;
      a.amp += (ampT - a.amp) * Math.min(1, dt * 6);
      a.ph += a.vel * sp.stride * dt;
      p.set(a.x, a.y, a.z);
      q.setFromAxisAngle(this.up, a.yaw);
      sc.setScalar(a.s);
      m4.compose(p, q, sc);
      const ci = counts[a.sp]++;
      this.meshes[a.sp].setMatrixAt(ci, m4);
      sp.anim.setXY(ci, a.amp, a.ph);
    }
    for (const k in this.meshes) { this.meshes[k].count = counts[k]; this.meshes[k].instanceMatrix.needsUpdate = true; SPECIES[k].anim.needsUpdate = true; }
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
