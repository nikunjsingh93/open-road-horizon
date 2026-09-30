import * as THREE from 'three';
import { SPEC } from './vehicle.js';

// Traffic: cars drive towards you in the opposite lane AND along with you in your own direction (slower than you, so you come up behind
// them and have to overtake). Purely decorative - no collision.
const COLORS = [0xd9dadd, 0x1a1c20, 0x8a8e94, 0x1c3f7a, 0x2c5a3a, 0xb0441b, 0xd6b21a, 0x6b1218, 0xe8e4da, 0x2b2f38, 0x2a6f8f, 0x8f2a55];
const MAX_ONCOMING = 3, MAX_SAME = 3;

export class Traffic {
  constructor(scene, world, car, wheelLocals) {
    this.scene = scene; this.world = world; this.car = car;
    this.wheelLocals = wheelLocals;       // [{x, z}] x4 (FL FR RL RR) in body space
    this.cars = [];
    this.enabled = true;
    this.timer = 14 + Math.random() * 14;
    this.timerSame = 6 + Math.random() * 8;
    this._a = {}; this._b = {};
    this.group = new THREE.Group(); scene.add(this.group);
  }

  setEnabled(on) {
    this.enabled = on; this.group.visible = on;
    if (!on) { for (const c of this.cars) this._remove(c); this.cars.length = 0; }
  }

  // dir = -1: oncoming (opposite lane), +1: same direction as the player (right-hand lane)
  _spawn(carS, dir, gap = 0) {
    const w = this.world;
    const color = COLORS[(Math.random() * COLORS.length) | 0];
    const laneMin = this.laneMin ?? 1.55;
    const t = this.car.spawnTraffic(color);
    for (let i = 0; i < 4; i++) t.wheels[i].pivot.position.set(this.wheelLocals[i].x, SPEC.radius, this.wheelLocals[i].z);
    this.group.add(t.root);
    let s, speed, lane;
    if (dir < 0) { s = carS + 620 + Math.random() * 220 + gap; speed = 15 + Math.random() * 13; lane = laneMin + Math.random() * 0.35; }
    else { s = carS + 220 + Math.random() * 200 + gap; speed = 11 + Math.random() * 12; lane = 1.55 + Math.random() * 0.25; }   // 40 - 83 km/h, in the lane the player starts in
    this.cars.push({ t, s, speed, dist: 0, lane, dir, vx: 0, vz: 0, px: 0, pz: 0, fx: 0, fz: 0 });
    w.ensure(s + 60);
  }

  _remove(c) { this.group.remove(c.t.root); }

  update(dt, carS, playerSpeed) {
    if (!this.enabled || dt <= 0) return;
    const w = this.world, a = this._a, b = this._b;
    this.timer -= dt; this.timerSame -= dt;
    const count = (d) => this.cars.reduce((n, c) => n + (c.dir === d ? 1 : 0), 0);
    if (this.timer <= 0) {
      this.timer = 25 + Math.random() * 45;
      if (playerSpeed > 5 && count(-1) < MAX_ONCOMING) {
        this._spawn(carS, -1);
        if (Math.random() < 0.3 && count(-1) < MAX_ONCOMING) this._spawn(carS, -1, 45 + Math.random() * 40);   // a convoy
      }
    }
    if (this.timerSame <= 0) {
      this.timerSame = 18 + Math.random() * 35;
      if (playerSpeed > 8 && count(1) < MAX_SAME) this._spawn(carS, 1);
    }
    for (let i = this.cars.length - 1; i >= 0; i--) {
      const c = this.cars[i];
      c.s += c.dir * c.speed * dt; c.dist += c.speed * dt;
      if (c.s < carS - 200 || c.s > carS + 1300) { this._remove(c); this.cars.splice(i, 1); continue; }
      w.at(c.s, a); w.at(Math.max(c.s + c.dir * 4, 0), b);
      const cx = Math.cos(a.th), cz = Math.sin(a.th);
      const root = c.t.root;
      const x = a.x + cx * c.lane * c.dir, z = a.z + cz * c.lane * c.dir;    // oncoming: left of the centre line (from the player's view), same direction: right
      root.position.set(x, a.y + 0.03, z);
      // heading follows the road (reversed for oncoming); pitch follows the road grade
      const pitch = Math.atan2(b.y - a.y, 4);
      const ry = c.dir < 0 ? Math.PI - a.th : -a.th;
      root.rotation.set(pitch, ry, 0, 'YXZ');
      // world velocity / forward vector for collisions
      c.px = x; c.pz = z; c.fx = -Math.sin(ry); c.fz = -Math.cos(ry);
      c.vx = c.fx * c.speed; c.vz = c.fz * c.speed;
      const spin = -c.dist / SPEC.radius;
      for (const wh of c.t.wheels) wh.spinner.rotation.x = spin;
    }
  }

  // push the player out of any traffic car it overlaps (circles along both bodies) and exchange velocity. returns the impact speed (0 = none)
  bump(v, offs, R, hit) {
    if (!this.enabled) return 0;
    let worst = 0;
    for (const c of this.cars) {
      const dx0 = v.pos.x - c.px, dz0 = v.pos.z - c.pz;
      if (dx0 * dx0 + dz0 * dz0 > 64) continue;                          // further than 8 m
      for (const off of offs) {
        const cx = v.pos.x + v.fwd.x * off, cz = v.pos.z + v.fwd.z * off;
        for (const to of [-1.25, 0.15, 1.25]) {
          const tx = c.px + c.fx * to, tz = c.pz + c.fz * to;
          const dx = cx - tx, dz = cz - tz, d = Math.hypot(dx, dz), rr = R + 0.95;
          if (d >= rr || d < 1e-4) continue;
          const nx = dx / d, nz = dz / d, pen = rr - d;
          v.pos.x += nx * pen * 0.9; v.pos.z += nz * pen * 0.9;
          const vn = (v.vel.x - c.vx) * nx + (v.vel.z - c.vz) * nz;
          if (vn < 0) {
            v.vel.x -= nx * vn * 1.25; v.vel.z -= nz * vn * 1.25;
            v.vel.multiplyScalar(0.99);
            worst = Math.max(worst, -vn);
          }
        }
      }
    }
    return worst;
  }
}
