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
