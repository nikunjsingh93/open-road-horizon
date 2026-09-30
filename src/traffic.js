import * as THREE from 'three';
import { SPEC } from './vehicle.js';

// Oncoming traffic: a car now and then drives towards you in the opposite lane. Purely decorative - no collision.
const COLORS = [0xd9dadd, 0x1a1c20, 0x8a8e94, 0x1c3f7a, 0x2c5a3a, 0xb0441b, 0xd6b21a, 0x6b1218, 0xe8e4da, 0x2b2f38, 0x2a6f8f, 0x8f2a55];
const MAX = 3;

export class Traffic {
  constructor(scene, world, car, wheelLocals) {
    this.scene = scene; this.world = world; this.car = car;
    this.wheelLocals = wheelLocals;       // [{x, z}] x4 (FL FR RL RR) in body space
    this.cars = [];
    this.enabled = true;
    this.timer = 14 + Math.random() * 14;
    this._a = {}; this._b = {};
    this.group = new THREE.Group(); scene.add(this.group);
  }

  setEnabled(on) {
    this.enabled = on; this.group.visible = on;
    if (!on) { for (const c of this.cars) this._remove(c); this.cars.length = 0; }
  }

  _spawn(carS, playerSpeed, gap = 0) {
    const w = this.world;
    const s = carS + 620 + Math.random() * 220 + gap;
    const color = COLORS[(Math.random() * COLORS.length) | 0];
    const t = this.car.spawnTraffic(color);
    for (let i = 0; i < 4; i++) t.wheels[i].pivot.position.set(this.wheelLocals[i].x, SPEC.radius, this.wheelLocals[i].z);
    this.group.add(t.root);
    const speed = 15 + Math.random() * 13;                 // m/s (54 - 100 km/h)
    this.cars.push({ t, s, speed, dist: 0, lane: 1.55 + Math.random() * 0.35 });
    w.ensure(s + 60);
  }

  _remove(c) { this.group.remove(c.t.root); }

  update(dt, carS, playerSpeed) {
    if (!this.enabled || dt <= 0) return;
    const w = this.world, a = this._a, b = this._b;
    this.timer -= dt;
    if (this.timer <= 0) {
      this.timer = 25 + Math.random() * 45;
      if (playerSpeed > 5 && this.cars.length < MAX) {
        this._spawn(carS, playerSpeed);
        if (Math.random() < 0.3 && this.cars.length < MAX) this._spawn(carS, playerSpeed, 45 + Math.random() * 40);   // a convoy
      }
    }
    for (let i = this.cars.length - 1; i >= 0; i--) {
      const c = this.cars[i];
      c.s -= c.speed * dt; c.dist += c.speed * dt;
      if (c.s < carS - 160) { this._remove(c); this.cars.splice(i, 1); continue; }
      w.at(c.s, a); w.at(Math.max(c.s - 4, 0), b);
      const cx = Math.cos(a.th), cz = Math.sin(a.th);
      const x = a.x - cx * c.lane, z = a.z - cz * c.lane;           // opposite lane (the player drives on t > 0)
      const root = c.t.root;
      root.position.set(x, a.y + 0.03, z);
      // heading is the road heading reversed; pitch follows the road grade
      const pitch = Math.atan2(b.y - a.y, 4);
      root.rotation.set(pitch, Math.PI - a.th, 0, 'YXZ');
      const spin = -c.dist / SPEC.radius;
      for (const wh of c.t.wheels) wh.spinner.rotation.x = spin;
    }
  }
}
