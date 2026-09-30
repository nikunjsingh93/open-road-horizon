import * as THREE from 'three';
import { ROAD_HALF, DS } from './terrain.js';
import { clamp, smoothstep } from './noise.js';

const G = 9.81;
const V3 = THREE.Vector3, Q = THREE.Quaternion;

// engine torque curve (normalised)
const CURVE = [[700, 0.25], [1000, 0.55], [1500, 0.75], [2000, 0.92], [2500, 1.0], [4500, 1.0], [5500, 0.93], [6500, 0.78], [7200, 0.55]];
function torqueCurve(rpm) {
  if (rpm <= CURVE[0][0]) return CURVE[0][1];
  for (let i = 1; i < CURVE.length; i++) {
    if (rpm <= CURVE[i][0]) {
      const a = CURVE[i - 1], b = CURVE[i];
      return a[1] + (b[1] - a[1]) * (rpm - a[0]) / (b[0] - a[0]);
    }
  }
  return 0.4;
}

export const SPEC = {
  mass: 1380,
  inertia: new V3(2100, 2350, 560),   // pitch(x), yaw(y), roll(z)
  wheelbase: 2.74, track: 1.58, comH: 0.52,
  radius: 0.335, wheelInertia: 1.5,
  kF: 34000, kR: 31000, cBump: 2600, cReb: 4200, arbF: 14000, arbR: 9000,
  rayLen: 0.60, maxComp: 0.26,
  gears: [3.62, 2.19, 1.52, 1.14, 0.90, 0.74], reverse: 3.5, finalDrive: 3.55, eff: 0.9,
  maxTorque: 360, idle: 850, redline: 6800,
  brakeTorque: 3000, brakeBias: 0.66,
  cdA: 0.62, rollRes: 0.011,
};

function tireCurve(s) {
  const B = 10.5, C = 1.55, E = 0.25;
  const bs = B * s;
  return Math.sin(C * Math.atan(bs - E * (bs - Math.atan(bs))));
}

export class Vehicle {
  constructor(world) {
    this.world = world;
    this.spec = SPEC;
    this.pos = new V3(); this.quat = new Q(); this.vel = new V3(); this.omega = new V3();
    this.right = new V3(1, 0, 0); this.up = new V3(0, 1, 0); this.fwd = new V3(0, 0, -1);
    const hw = SPEC.track / 2, hl = SPEC.wheelbase / 2;
    const ay = -0.06;
    // order: FL, FR, RL, RR  (forward is -Z in body space)
    this.wheels = [
      this._wheel(-hw, ay, -hl, true, false, SPEC.kF, SPEC.arbF),
      this._wheel(+hw, ay, -hl, true, false, SPEC.kF, SPEC.arbF),
      this._wheel(-hw, ay, +hl, false, true, SPEC.kR, SPEC.arbR),
      this._wheel(+hw, ay, +hl, false, true, SPEC.kR, SPEC.arbR),
    ];
    this.hint = 4;
    this.ri = { s: 0, t: 0, y: 0, d: 0, i: 0, u: 0, th: 0, px: 0, pz: 0 };
    this.gh = { h: 0, surf: 0 };
    // controls
    this.steerInput = 0; this.steerAngle = 0;
    this.throttle = 0; this.brake = 0; this.handbrake = 0;
    // drivetrain
    this.snow = 0; this.wet = 0; this.assist = 0.6; this.tcOn = true; this.tune = { power: 1, grip: 1 }; this.manual = false; this.gear = 1; this.rpm = SPEC.idle; this.shiftTimer = 0;
    this.speed = 0; this.speedKmh = 0; this.fwdSpeed = 0;
    this.s = 0; this.t = 0;
    this.onGround = 0; this.slip = 0;
    this.accel = new V3(); this._lastVel = new V3();
    this.distance = 0;
    // scratch
    this._org = new V3(); this._cp = new V3(); this._r = new V3(); this._vc = new V3();
    this._wf = new V3(); this._wl = new V3(); this._tv = new V3(); this._tot = new V3(); this._trq = new V3();
    this._tv2 = new V3(); this._q = new Q(); this._dq = new Q(); this._wb = new V3(); this._tb = new V3();
  }

  _wheel(x, y, z, steer, drive, k, arb) {
    return {
      local: new V3(x, y, z), steer, drive, k, arb,
      comp: 0, prevComp: 0, contact: false, omega: 0, spin: 0, steerA: 0,
      hub: new V3(), normal: new V3(0, 1, 0), fz: 0, fx: 0, fy: 0, slipRatio: 0, slipAngle: 0, surf: 0,
    };
  }

  maxSteer(v) { return Math.min(0.60, 0.62 / (1 + (v / 14) * (v / 14)) + 0.07); }

  place(s, lane = 1.7, speed = 0) {
    const w = this.world;
    const c = w.at(s, {});
    const cx = Math.cos(c.th), cz = Math.sin(c.th);
    this.pos.set(c.x + cx * lane, c.y + SPEC.comH + 0.12, c.z + cz * lane);
    this.quat.setFromAxisAngle(new V3(0, 1, 0), -c.th);
    this.vel.set(Math.sin(c.th) * speed, 0, -Math.cos(c.th) * speed);
    this.omega.set(0, 0, 0);
    this.hint = Math.round(s / DS);
    for (const wh of this.wheels) { wh.omega = speed / SPEC.radius; wh.comp = 0.08; wh.prevComp = 0.08; }
    this.gear = speed > 3 ? Math.min(6, 1 + Math.floor(speed / 7)) : 1;
    this.steerAngle = 0;
    this.updateBasis();
    this.s = s;
  }

  updateBasis() {
    this.right.set(1, 0, 0).applyQuaternion(this.quat);
    this.up.set(0, 1, 0).applyQuaternion(this.quat);
    this.fwd.set(0, 0, -1).applyQuaternion(this.quat);
  }

  // terrain / road height + surface at (x,z)
  ground(x, z, out) {
    const w = this.world;
    const r = w.nearestHint(x, z, this.hint, this.ri);
    const nat = w.natural(x, z);
    const t = r.t, at = Math.abs(t);
    let h = w._carve(nat, r.y, r.d);
    let surf = 2;
    const HW = ROAD_HALF + 0.12;
    if (at < HW) {
      const u = t / HW;
      h = r.y + 0.05 * (1 - u * u) + 0.005;
      surf = 0;
    } else if (at < HW + 0.3) {
      const k = (at - HW) / 0.3;
      const hr = r.y + 0.005;
      h = hr + (h - hr) * k;          // small chamfer off the tarmac edge
      surf = 1;
    } else if (at < 6.4) surf = 1;
    out.h = h; out.surf = surf;
    return h;
  }

  groundNormal(x, z, out, e = 0.4) {
    const g = this.gh;
    const hl = this.ground(x - e, z, g), hr = this.ground(x + e, z, g);
    const hd = this.ground(x, z - e, g), hu = this.ground(x, z + e, g);
    out.set(hl - hr, 2 * e, hd - hu).normalize();
  }

  step(dt, sub = 3) {
    const h = dt / sub;
    this._lastVel.copy(this.vel);
    for (let i = 0; i < sub; i++) this._sub(h);
    this.accel.copy(this.vel).sub(this._lastVel).divideScalar(dt);
    this.speed = this.vel.length();
    this.fwdSpeed = this.vel.dot(this.fwd);
    this.speedKmh = this.speed * 3.6;
    this.hint = clamp(Math.round(this.ri.s / DS), 4, 1e9);
    this.s = this.ri.s; this.t = this.ri.t;
    this.distance += Math.abs(this.fwdSpeed) * dt;
  }

  // W/S style input with automatic reverse
  drive(accelKey, brakeKey, steer, handbrake, dt) {
    if (this.manual) {
      this.throttle = accelKey; this.brake = brakeKey;     // pedals do what they say; the gear lever decides the direction
    } else if (this.gear >= 1) {
      this.throttle = accelKey; this.brake = brakeKey;
      if (brakeKey > 0.1 && accelKey < 0.1 && this.fwdSpeed < 0.6) { this.gear = -1; this._revHold = 0; }
    } else {
      this.throttle = brakeKey; this.brake = accelKey;
      if (accelKey > 0.1 && brakeKey < 0.1 && this.fwdSpeed > -0.6) this.gear = 1;
    }
    this.steerInput = steer; this.handbrake = handbrake;
  }

  _sub(dt) {
    const S = SPEC;
    this.updateBasis();
    const { right, up, fwd } = this;
    const v = this.speed;
    let target = this.steerInput * this.maxSteer(v);
    // slip-angle limiter (steering assist): never turn the front wheels far past the tyre grip peak, so full lock = maximum grip, not plough-on
    if (this.assist > 0 && v > 3) {
      const fa = Math.max(Math.abs(this.wheels[0].slipAngle), Math.abs(this.wheels[1].slipAngle));
      if (fa > 0.17) target *= clamp(0.17 / fa, 0.45, 1);
    }
    this.steerAngle += clamp(target - this.steerAngle, -7.0 * dt, 7.0 * dt);

    const totalF = this._tot.set(0, -S.mass * G, 0);
    const torque = this._trq.set(0, 0, 0);
    const org = this._org, cp = this._cp, r = this._r, vc = this._vc, wf = this._wf, wl = this._wl, tv = this._tv;

    // ---- engine / gearbox ----
    const rearOmega = (this.wheels[2].omega + this.wheels[3].omega) * 0.5;
    const ratioAbs = (this.gear > 0 ? S.gears[this.gear - 1] : this.gear < 0 ? S.reverse : 0) * S.finalDrive;
    const ratio = this.gear > 0 ? ratioAbs : this.gear < 0 ? -ratioAbs : 0;
    const wheelRpm = Math.abs(rearOmega) * 60 / (2 * Math.PI) * ratioAbs;
    const clutchRpm = S.idle + (this.gear === 0 ? 4800 : 1300) * this.throttle;
    const engaged = smoothstep(clutchRpm * 0.9, clutchRpm * 1.35, wheelRpm);
    let rpm = Math.max(S.idle, wheelRpm * engaged + clutchRpm * (1 - engaged));
    if (this.shiftTimer > 0) { this.shiftTimer -= dt; rpm = Math.max(S.idle, rpm * 0.96); }
    this.rpm += (rpm - this.rpm) * clamp(dt * 25, 0, 1);
    let engT = 0;
    if (this.shiftTimer <= 0) {
      const rs = Math.max(this.wheels[2].slipRatio, this.wheels[3].slipRatio, 0);
      const loose = this.wheels[2].surf !== 0 || this.wheels[3].surf !== 0;
      const tcLow = smoothstep(2, 6, this.speed);   // let it launch: at a crawl a little wheel speed is normal
      const tc = this.tcOn && loose ? clamp(1 - (rs - 0.5) * 2, 0.5, 1) : 1;   // tarmac traction is limited per wheel below
      const thr = this.throttle * tc;
      const full = S.maxTorque * torqueCurve(this.rpm) * this.tune.power;
      const drag = -S.maxTorque * 0.15 * (this.rpm / 6000) * (1 - thr);
      engT = thr * full + drag;
      if (this.rpm > S.redline) engT = Math.min(engT, 0) - 30;
    }
    const drivenTorque = engT * ratio * S.eff;
    this.dbg = { engT, drivenTorque, ratio, thr: this.throttle };

    const holdK = this.throttle < 0.05 && this.brake < 0.05 ? 1 - smoothstep(0.5, 1.6, this.speed) : 0;
    let contacts = 0, slipMax = 0;
    for (let wi = 0; wi < 4; wi++) {
      const wh = this.wheels[wi];
      let sa = 0;
      if (wh.steer) { const inner = (wi === 0) === (this.steerAngle > 0); sa = this.steerAngle * (inner ? 1.12 : 0.9); }
      wh.steerA += (sa - wh.steerA) * clamp(dt * 40, 0, 1);

      org.copy(wh.local).applyQuaternion(this.quat).add(this.pos);
      const t0 = this._raycast(org, up, S.rayLen);
      wh.prevComp = wh.comp;
      const contact = t0 >= 0;
      wh.contact = contact;
      if (!contact) {
        wh.comp = 0; wh.fz = 0;
        wh.hub.copy(org).addScaledVector(up, -(S.rayLen - S.radius));
        wh.omega += dt * (wh.drive ? drivenTorque / 2 : 0) / S.wheelInertia;
        wh.omega *= (1 - dt * 0.25);
        continue;
      }
      contacts++;
      const comp = clamp(S.rayLen - t0, 0, S.maxComp * 1.7);
      wh.comp = comp;
      wh.hub.copy(org).addScaledVector(up, -(t0 - S.radius));
      const vComp = (wh.comp - wh.prevComp) / dt;
      const other = this.wheels[wi ^ 1];
      let f = wh.k * comp + (vComp > 0 ? S.cBump : S.cReb) * vComp + wh.arb * (comp - other.comp);
      if (comp > S.maxComp) f += 200000 * (comp - S.maxComp);
      if (f < 0) f = 0;
      wh.fz = f;
      cp.copy(org).addScaledVector(up, -t0);
      this.groundNormal(cp.x, cp.z, wh.normal);
      this.ground(cp.x, cp.z, this.gh); wh.surf = this.gh.surf;
      const gn = wh.normal;
      // suspension force at the contact point, along the body up axis
      tv.copy(up).multiplyScalar(f);
      totalF.add(tv);
      r.copy(cp).sub(this.pos);
      torque.add(this._tv2.copy(r).cross(tv));

      // tyre frame
      const cs = Math.cos(wh.steerA), sn = Math.sin(wh.steerA);
      wf.copy(fwd).multiplyScalar(cs).addScaledVector(right, sn);
      wf.addScaledVector(gn, -wf.dot(gn)).normalize();
      wl.copy(gn).cross(wf).normalize().negate();      // right-pointing lateral axis
      vc.copy(this.omega).cross(r).add(this.vel);
      const vx = vc.dot(wf), vy = vc.dot(wl);
      const mu0 = (wh.surf === 0 ? 1.42 : wh.surf === 1 ? 0.95 : 0.88) * (1 - 0.5 * this.snow) * (1 - 0.22 * this.wet);
      const mu = mu0 * (1 - 0.07 * (f / 3400 - 1)) * this.tune.grip * (wh.drive ? 1.06 : 1.0);   // a touch more rear grip = less power-on oversteer
      const Fz = f;
      const vref = Math.max(Math.abs(vx), 1.6);
      const R = S.radius, I = S.wheelInertia;

      let brakeT = this.brake * S.brakeTorque * (wh.steer ? S.brakeBias : 1 - S.brakeBias) * 0.5;
      if (this.handbrake > 0 && wh.drive) brakeT = Math.max(brakeT, this.handbrake * 2400);
      // auto-hold: with no pedal input the car stays put instead of rolling away on slopes (or creeping in reverse)
      const holdT = holdK * 900;
      brakeT = Math.max(brakeT, holdT);
      let Td = wh.drive ? drivenTorque / 2 : 0;
      if (this.tcOn && Td > 0) {
        // traction control: never ask a tyre for more drive force than its friction circle can give after cornering load
        const cap = Math.max(0.22 * mu * Fz, Math.sqrt(Math.max(0, Math.pow(0.97 * mu * Fz, 2) - wh.fy * wh.fy))) * R;
        if (Td > cap) Td = cap;
      }
      const evalF = (om, out) => {
        const kap = (om * R - vx) / vref;
        const ta = vy / vref;
        const sm = Math.hypot(kap, ta);
        const fm = sm < 1e-6 ? 0 : tireCurve(sm) * mu * Fz;
        out[0] = fm * kap / (sm || 1); out[1] = -fm * ta / (sm || 1); out[2] = kap; out[3] = ta; out[4] = sm;
      };
      const o0 = wh._o0 || (wh._o0 = [0, 0, 0, 0, 0]), o1 = wh._o1 || (wh._o1 = [0, 0, 0, 0, 0]);
      evalF(wh.omega, o0);
      evalF(wh.omega + 0.5, o1);
      const dFx = Math.max((o1[0] - o0[0]) / 0.5, 0);
      let wNew = wh.omega + dt * (Td - R * o0[0]) / I / (1 + dt * R * dFx / I);
      if (brakeT > 0) {
        // simple ABS: release when the wheel is about to lock
        const bt = o0[2] < -0.22 && this.handbrake < 0.5 && holdT < 1 ? brakeT * 0.25 : brakeT;
        const dwB = dt * bt / I;
        if (Math.abs(wNew) <= dwB) wNew = 0; else wNew -= Math.sign(wNew) * dwB;
      }
      evalF(wNew, o1);
      const fx = o1[0], fy = o1[1];
      wh.omega = wNew;
      wh.fx = fx; wh.fy = fy; wh.slipRatio = o1[2]; wh.slipAngle = o1[3];
      if (o1[4] > slipMax) slipMax = o1[4];
      const rr = (wh.surf === 0 ? S.rollRes : wh.surf === 1 ? 0.022 : 0.04) * Fz;
      const frr = -Math.tanh(vx * 2) * rr;
      tv.copy(wf).multiplyScalar(fx + frr).addScaledVector(wl, fy);
      totalF.add(tv);
      // steering scrub relief: a locked-over front tyre's cornering force points partly backwards and would strangle a launch out of a slow turn
      if (wh.steer && this.throttle > 0.05) {
        const back = -fy * wl.dot(fwd);
        if (back < 0) totalF.addScaledVector(fwd, -back * 0.75 * this.throttle * (1 - smoothstep(7, 18, this.speed)));
      }
      torque.add(this._tv2.copy(r).cross(tv));
    }
    // aerodynamics
    const sp = this.speed;
    if (sp > 0.01) {
      totalF.addScaledVector(this.vel, -0.5 * 1.2 * S.cdA * sp);
      totalF.addScaledVector(up, -0.5 * 1.2 * 0.28 * sp * sp);
    }
    torque.addScaledVector(this.omega, -80);
    if (this.assist > 0 && this.speed > 4 && this.onGround > 2) {
      const yaw = this.omega.dot(up);
      const want = this.fwdSpeed * Math.tan(this.steerAngle) / S.wheelbase * 0.92;
      const err = yaw - want;
      const tq = clamp(-err * 2600 * this.assist, -1800, 1800);
      torque.addScaledVector(up, tq);
    }
    // integrate linear
    this.vel.addScaledVector(totalF, dt / S.mass);
    // integrate angular (body-frame Euler equations)
    const qi = this._q.copy(this.quat).invert();
    const wb = this._wb.copy(this.omega).applyQuaternion(qi);
    const tb = this._tb.copy(torque).applyQuaternion(qi);
    const I = S.inertia;
    wb.x += dt * (tb.x - (I.z - I.y) * wb.y * wb.z) / I.x;
    wb.y += dt * (tb.y - (I.x - I.z) * wb.z * wb.x) / I.y;
    wb.z += dt * (tb.z - (I.y - I.x) * wb.x * wb.y) / I.z;
    this.omega.copy(wb).applyQuaternion(this.quat);
    // integrate pose
    this.pos.addScaledVector(this.vel, dt);
    const om = this.omega, hq = 0.5 * dt;
    const dq = this._dq.set(om.x * hq, om.y * hq, om.z * hq, 0).multiply(this.quat);
    this.quat.set(this.quat.x + dq.x, this.quat.y + dq.y, this.quat.z + dq.z, this.quat.w + dq.w).normalize();
    this.onGround = contacts;
    this.slip = slipMax;
    for (const wh of this.wheels) wh.spin += wh.omega * dt;
    this._gearbox();
  }

  // manual gearbox: -1 = R, 0 = N, 1..6 - any gear can be picked at any time (the rev limiter protects the engine)
  setGear(g) {
    if (!this.manual) return false;
    g = Math.max(-1, Math.min(6, g | 0));
    if (g === this.gear) return false;
    this.gear = g; this.shiftTimer = 0.15; return true;
  }
  shiftUp() { return this.setGear(this.gear + 1); }
  shiftDown() { return this.setGear(this.gear - 1); }

  _raycast(org, up, maxLen) {
    const dy = up.y;
    if (dy < 0.25) return -1;
    let t = Math.max(org.y - this.ground(org.x, org.z, this.gh), 0) / dy;
    for (let i = 0; i < 3; i++) {
      const px = org.x - up.x * t, pz = org.z - up.z * t, py = org.y - up.y * t;
      const h = this.ground(px, pz, this.gh);
      t += (py - h) / dy;
      if (t < -0.6) return -1;
    }
    if (t > maxLen) return -1;
    return Math.max(t, 0);
  }

  _gearbox() {
    const S = SPEC;
    if (this.manual || this.gear < 1 || this.shiftTimer > 0) return;
    const rearOmega = Math.abs(this.fwdSpeed) / S.radius;
    const upRpm = 3300 + 3000 * this.throttle * this.throttle;
    const downRpm = 1350 + 900 * this.throttle;
    const rpmIn = g => rearOmega * 60 / (2 * Math.PI) * S.gears[g - 1] * S.finalDrive;
    if (this.gear < 6 && rpmIn(this.gear) > upRpm) { this.gear++; this.shiftTimer = 0.25; }
    else if (this.gear > 1 && rpmIn(this.gear) < downRpm && rpmIn(this.gear - 1) < upRpm - 700) { this.gear--; this.shiftTimer = 0.2; }
  }
}

// ---------------------------------------------------------------------------
// Autopilot: pure pursuit on the road with curvature-limited speed
// ---------------------------------------------------------------------------
export class Autopilot {
  constructor(world, vehicle) {
    this.w = world; this.v = vehicle; this.lane = 1.7; this.cruise = 24; this.steer = 0; this._c = {}; this._c2 = {}; this._c3 = {};
  }
  update(dt) {
    const v = this.v, w = this.w;
    const speed = Math.max(v.fwdSpeed, 0);
    const look = clamp(speed * 1.0 + 7, 9, 55);
    const s0 = v.s;
    const c = w.at(s0 + look, this._c);
    const cx = Math.cos(c.th), cz = Math.sin(c.th);
    const tx = c.x + cx * this.lane, tz = c.z + cz * this.lane;
    const dx = tx - v.pos.x, dz = tz - v.pos.z;
    const fl = Math.hypot(v.fwd.x, v.fwd.z), rl = Math.hypot(v.right.x, v.right.z);
    const lon = (dx * v.fwd.x + dz * v.fwd.z) / fl;
    const lat = (dx * v.right.x + dz * v.right.z) / rl;
    const ang = Math.atan2(lat, Math.max(lon, 0.5));
    const delta = Math.atan2(2 * 2.74 * Math.sin(ang), Math.hypot(lat, lon));
    const steer = clamp(delta / v.maxSteer(speed), -1, 1);
    this.steer += (steer - this.steer) * clamp(dt * 8, 0, 1);
    const fric = (1 - 0.5 * (v.snow || 0)) * (1 - 0.22 * (v.wet || 0));
    let vmax = this.cruise * (0.55 + 0.45 * fric);
    for (let d = 10; d <= 150; d += 15) {
      const a = w.at(s0 + d, this._c2), b = w.at(s0 + d + 20, this._c3);
      const k = Math.abs(b.th - a.th) / 20 + 1e-6;
      const vv = Math.sqrt(3.8 * fric / k);
      vmax = Math.min(vmax, Math.sqrt(vv * vv + 2 * 2.2 * fric * d));
    }
    const err = vmax - speed;
    return { throttle: clamp(err * 0.4, 0, 1), brake: clamp(-err * 0.25, 0, 0.55), steer: this.steer };
  }
}
