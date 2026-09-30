// Dev-only helpers (stripped from production builds): window.__trailTest(i) drives the real car physics along side track i.
export function installDevTools(game) {
  const g = game;
  window.__trailTest = async (ti, maxSec = 100, want = 38) => {
    const v = g.vehicle, w = g.world, tr = w.trails[ti];
    const j0 = 2, x = tr.pts[j0 * 2], z = tr.pts[j0 * 2 + 1], a = Math.atan2(tr.pts[j0 * 2 + 3] - z, tr.pts[j0 * 2 + 2] - x);
    g.teleport(Math.max(tr.s - 30, 10), 0);
    v.pos.set(x, tr.ys[j0] + 0.9, z); v.quat.setFromAxisAngle(new v.pos.constructor(0, 1, 0), -a - Math.PI / 2);
    v.vel.set(0, 0, 0); v.omega.set(0, 0, 0); v.hint = Math.round(tr.s / 2);
    const q = {}; let st = 0, maxD = 0, minUp = 1, stuck = 0, lastU = 0, maxU = 0, offAt = null, at = null;
    for (let step = 0; step < maxSec * 30; step++) {
      w.trailQuery(v.pos.x, v.pos.z, q); const u = q.u; maxU = Math.max(maxU, u);
      const ju = Math.min(Math.floor(u + 2.2), tr.n - 2);
      const dx = tr.pts[ju * 2] - v.pos.x, dz = tr.pts[ju * 2 + 1] - v.pos.z, rgt = v.right;
      const cross = (dx * rgt.x + dz * rgt.z) / Math.hypot(dx, dz);
      st += (Math.max(-1, Math.min(1, cross * 2.2)) - st) * 0.25;
      v.drive(v.speedKmh < want ? 1 : 0, v.speedKmh > want + 8 ? 1 : 0, st, 0, 1 / 30); v.step(1 / 30, 3);
      maxD = Math.max(maxD, q.d); minUp = Math.min(minUp, v.up.y);
      if (q.d > 5 && offAt === null) offAt = +u.toFixed(0);
      if (step % 30 === 0) { if (maxU - lastU < 0.3) stuck++; else stuck = 0; lastU = maxU; if (stuck >= 6) { at = [Math.round(v.pos.x), Math.round(v.pos.z)]; break; } }
      if (maxU >= tr.n - 3) break;
    }
    return JSON.stringify({ ti, n: tr.n, why: maxU >= tr.n - 3 ? 'done' : stuck >= 6 ? 'STUCK' : 'time', u: +maxU.toFixed(0), maxD: +maxD.toFixed(1), minUp: +minUp.toFixed(2), offAt, gain: Math.round(tr.ys[tr.n - 1] - tr.ys[0]), stuckAt: at });
  };
  window.__trailAll = async (max = 100) => { const out = []; for (let i = 0; i < g.world.trails.length; i++) out.push(await window.__trailTest(i, max)); return out; };
}

// Compares the rendered terrain (near strip + far tiles) with the surface the physics uses, on a grid around the car.
import * as THREE from 'three';
export function installSurfaceTest(game) {
  const g = game;
  window.__surfaceTest = (radius = 90, step = 6, layer = 'all') => {
    const v = g.vehicle, meshes = [];
    if (layer !== 'far') g.ground.group.traverse(o => { if (o.isMesh && o.material === g.ground.terrainMat) meshes.push(o); });
    if (layer !== 'near') g.far.group.traverse(o => { if (o.isMesh && o.material !== g.far.waterMat) meshes.push(o); });
    const rc = new THREE.Raycaster(), dir = new THREE.Vector3(0, -1, 0), o = new THREE.Vector3();
    const gh = { h: 0, surf: 0 };
    let n = 0, bad = 0, worst = 0, wx = 0, wz = 0, sum = 0;
    for (let dx = -radius; dx <= radius; dx += step) for (let dz = -radius; dz <= radius; dz += step) {
      const x = v.pos.x + dx, z = v.pos.z + dz;
      o.set(x, v.pos.y + 400, z); rc.set(o, dir);
      let top = -1e9;
      for (const m of meshes) { const h = rc.intersectObject(m, false); if (h.length && h[0].point.y > top) top = h[0].point.y; }
      if (top < -1e8) continue;
      const p = v.ground(x, z, gh);
      const d = top - p;          // > 0: the visible surface is above what the car drives on (car looks buried)
      n++; sum += Math.abs(d);
      if (Math.abs(d) > 0.35) bad++;
      if (Math.abs(d) > Math.abs(worst)) { worst = d; wx = dx; wz = dz; }
    }
    return { samples: n, mismatched: bad, meanAbs: +(sum / n).toFixed(3), worst: +worst.toFixed(2), at: [wx, wz] };
  };
}

// Drives off-road and reports how deep the wheels sit below the *rendered* terrain surface (positive = buried).
export function installBuriedTest(game) {
  const g = game;
  window.__buriedTest = (s0, key, secs = 12) => {
    const v = g.vehicle, meshes = [];
    const collect = () => { meshes.length = 0; g.ground.group.traverse(o => { if (o.isMesh && o.material === g.ground.terrainMat) meshes.push(o); }); g.far.group.traverse(o => { if (o.isMesh && o.material !== g.far.waterMat) meshes.push(o); }); };
    const rc = new THREE.Raycaster(), dir = new THREE.Vector3(0, -1, 0), o = new THREE.Vector3();
    const top = (x, z, y) => { o.set(x, y + 30, z); rc.set(o, dir); let t = -1e9; for (const m of meshes) { const h = rc.intersectObject(m, false); if (h.length && h[0].point.y > t) t = h[0].point.y; } return t; };
    g.teleport(s0, 50); g.keys = {}; g.steerSmooth = 0; v.omega.set(0, 0, 0); g.advance(0.5);
    g.keys = { KeyW: true, [key]: true };
    let worst = 0, sum = 0, n = 0, maxAir = 0;
    for (let i = 0; i < secs * 4; i++) {
      g.advance(0.25);
      if (i % 4 === 0) collect();
      for (const wh of v.wheels) {
        const t = top(wh.hub.x, wh.hub.z, wh.hub.y); if (t < -1e8) continue;
        const bottom = wh.hub.y - 0.335;
        const buried = t - bottom;
        worst = Math.max(worst, buried); maxAir = Math.max(maxAir, -buried); sum += Math.max(0, buried); n++;
      }
    }
    g.keys = {};
    return { worstBuried: +worst.toFixed(2), meanBuried: +(sum / n).toFixed(3), maxHover: +maxAir.toFixed(2), kmh: Math.round(v.speedKmh) };
  };
}
