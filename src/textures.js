import * as THREE from 'three';
import { mulberry32 } from './noise.js';

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

// Replace RGB of transparent pixels by the average opaque colour so mip-mapping doesn't create dark halos
function dilate(ctx, w, h) {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 200) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
  r = (r / n) | 0; g = (g / n) | 0; b = (b / n) | 0;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3] / 255;
    if (a < 0.98) { const k = a; d[i] = d[i] * k + r * (1 - k); d[i + 1] = d[i + 1] * k + g * (1 - k); d[i + 2] = d[i + 2] * k + b * (1 - k); }
  }
  ctx.putImageData(img, 0, 0);
}

function finish(c, { srgb = true, repeat = false, aniso = 8 } = {}) {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = aniso;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.needsUpdate = true;
  return t;
}

function hsl(h, s, l, a = 1) { return `hsla(${h},${s}%,${l}%,${a})`; }

function drawLeaf(ctx, x, y, len, wid, ang, hue, sat, light, rnd) {
  ctx.save();
  ctx.translate(x, y); ctx.rotate(ang);
  const g = ctx.createLinearGradient(0, -wid, 0, wid);
  g.addColorStop(0, hsl(hue, sat, light * 1.18));
  g.addColorStop(1, hsl(hue + 4, sat, light * 0.78));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.bezierCurveTo(len * 0.25, -wid, len * 0.75, -wid * 0.9, len, 0);
  ctx.bezierCurveTo(len * 0.75, wid * 0.9, len * 0.25, wid, 0, 0);
  ctx.fill();
  ctx.strokeStyle = hsl(hue - 6, sat * 0.8, light * 1.5, 0.55);
  ctx.lineWidth = Math.max(1, wid * 0.09);
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(len * 0.95, 0); ctx.stroke();
  ctx.restore();
}

// Cluster of broad leaves on twigs (used as camera-facing-ish cards for deciduous trees)
export function makeLeafTexture(seed = 1, hue = 92, size = 512, opt = {}) {
  const rnd = mulberry32(seed);
  const c = canvas(size, size), ctx = c.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  const cx = size / 2, cy = size / 2;
  const N = opt.count ?? 300;
  const leaves = [];
  for (let i = 0; i < N; i++) {
    const a = rnd() * Math.PI * 2;
    const r = Math.pow(rnd(), 0.62) * size * 0.40;
    leaves.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r * 0.92, ang: a + (rnd() - 0.5) * 1.6, depth: rnd() });
  }
  // twigs
  ctx.strokeStyle = '#3a2e1f'; ctx.lineWidth = size * 0.008;
  for (let i = 0; i < (opt.twigs ?? 7); i++) {
    const a = rnd() * Math.PI * 2;
    const L = size * (0.18 + rnd() * 0.24);
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(a) * L, cy + Math.sin(a) * L); ctx.stroke();
    if (opt.twigs > 10) for (let k = 0; k < 3; k++) { const b = a + (rnd() - 0.5) * 1.6, m = L * (0.3 + rnd() * 0.6); const bx = cx + Math.cos(a) * m, by = cy + Math.sin(a) * m; ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(bx + Math.cos(b) * L * 0.4, by + Math.sin(b) * L * 0.4); ctx.stroke(); }
  }
  leaves.sort((p, q) => p.depth - q.depth);
  for (const l of leaves) {
    const len = size * (0.068 + rnd() * 0.03), wid = len * (0.38 + rnd() * 0.12);
    const light = 15 + l.depth * 24 + rnd() * 6;
    drawLeaf(ctx, l.x, l.y, len, wid, l.ang, hue + (rnd() - 0.5) * (opt.spread ?? 16), (opt.sat ?? 52) + rnd() * 16, light + (opt.light ?? 0), rnd);
  }
  dilate(ctx, size, size);
  return finish(c);
}

// Small-leaf (birch / aspen-like) cluster
export function makeSmallLeafTexture(seed = 3, hue = 78, size = 512, opt = {}) {
  const rnd = mulberry32(seed);
  const c = canvas(size, size), ctx = c.getContext('2d');
  const cx = size / 2, cy = size / 2;
  const leaves = [];
  for (let i = 0; i < (opt.count ?? 260); i++) {
    const a = rnd() * Math.PI * 2, r = Math.pow(rnd(), 0.6) * size * 0.42;
    leaves.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r, ang: rnd() * 6.28, depth: rnd() });
  }
  leaves.sort((p, q) => p.depth - q.depth);
  for (const l of leaves) {
    const len = size * (0.06 + rnd() * 0.03), wid = len * 0.5;
    drawLeaf(ctx, l.x, l.y, len, wid, l.ang, hue + (rnd() - 0.5) * (opt.spread ?? 14), (opt.sat ?? 55) + rnd() * 15, 24 + l.depth * 26 + (opt.light ?? 0), rnd);
  }
  dilate(ctx, size, size);
  return finish(c);
}

// Conifer branch: a twig with dense needles both sides
export function makeNeedleTexture(seed = 5, hue = 128, w = 256, h = 512) {
  // A spruce branch spray: a tapering frond of hundreds of fine needles on forward-swept twigs, dark inside, fresh yellow-green tips.
  const rnd = mulberry32(seed);
  const c = canvas(w, h), ctx = c.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  ctx.lineCap = 'round';
  const stemX = w / 2;
  const S = w / 256;
  const wood = (x0, y0, x1, y1, lw) => { ctx.strokeStyle = '#3a2a1a'; ctx.lineWidth = lw; ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke(); };
  // needles along a twig from (x0,y0) heading 'ang' for 'len' px; tip=1 => fresh growth colouring
  const needles = (x0, y0, ang, len, shade, fresh) => {
    const step = 2.3 * S;
    const n = Math.max(2, Math.floor(len / step));
    for (let i = 0; i < n; i++) {
      const t = i / n;
      const bx = x0 + Math.cos(ang) * len * t, by = y0 + Math.sin(ang) * len * t;
      const cnt = 3;
      for (let k = 0; k < cnt; k++) {
        for (const side of [-1, 1]) {
          const spread = (0.55 + rnd() * 0.75) * side;            // needles sweep forward of the twig
          const a = ang + spread;
          const nl = (10 + rnd() * 9) * S * (1 - t * 0.35);
          const tip = fresh * smoothT(t, 0.55, 1);
          const hh = hue - 6 + (rnd() - 0.5) * 14 - tip * 12;
          const ss = 36 + rnd() * 16 + tip * 8;
          const ll = (13 + rnd() * 10) * shade + t * 5 + tip * 8;
          ctx.strokeStyle = hsl(hh, ss, ll);
          ctx.lineWidth = (1.35 + rnd() * 0.6) * S;
          ctx.beginPath(); ctx.moveTo(bx, by);
          ctx.lineTo(bx + Math.cos(a) * nl, by + Math.sin(a) * nl); ctx.stroke();
        }
      }
    }
  };
  function smoothT(t, a, b) { const x = Math.min(1, Math.max(0, (t - a) / (b - a))); return x * x * (3 - 2 * x); }
  // dense dark under-layer so the spray reads as a full frond with a ragged needle fringe
  {
    const prof = (t) => (w * 0.5) * (0.28 + 0.72 * Math.pow(Math.sin(Math.min(1, t * 0.92 + 0.06) * Math.PI), 0.7)) * 0.62;
    ctx.fillStyle = hsl(hue - 10, 34, 9, 0.92);
    ctx.beginPath();
    for (let k = 0; k <= 24; k++) { const t = k / 24; ctx.lineTo(stemX + prof(t) * 0.95, h * (0.985 - t * 0.9)); }
    for (let k = 24; k >= 0; k--) { const t = k / 24; ctx.lineTo(stemX - prof(t) * 0.95, h * (0.985 - t * 0.9)); }
    ctx.closePath(); ctx.fill();
  }
  const twigs = 30;
  for (let i = 0; i < twigs; i++) {
    const t = i / twigs;                               // 0 = branch base (bottom) ... 1 = tip
    const y0 = h * (0.985 - t * 0.9);
    // frond outline: widest at ~30% then tapering to the tip
    const outline = Math.pow(Math.sin(Math.min(1, t * 0.92 + 0.06) * Math.PI), 0.7);
    const len = (w * 0.5) * (0.28 + 0.72 * outline);
    for (const side of [-1, 1]) {
      const phi = 1.08 - t * 0.2 + (rnd() - 0.5) * 0.16;            // angle between twig and stem (swept toward the tip)
      const a2 = -Math.PI / 2 + side * phi;
      const ex = stemX + Math.cos(a2) * len, ey = y0 + Math.sin(a2) * len;
      wood(stemX, y0, ex, ey, 1.5 * S);
      needles(stemX, y0, a2, len, 0.8 + rnd() * 0.4, 0.5 + rnd() * 0.5);
      // short sprigs off the twig
      const sprigs = Math.floor(len / (14 * S));
      for (let k = 1; k <= sprigs; k++) {
        const tt = k / (sprigs + 1);
        const px = stemX + Math.cos(a2) * len * tt, py = y0 + Math.sin(a2) * len * tt;
        const sa = a2 + (0.7 + rnd() * 0.3) * (rnd() < 0.5 ? 1 : -1);
        const sl = len * (0.18 + rnd() * 0.12) * (1 - tt * 0.5);
        wood(px, py, px + Math.cos(sa) * sl, py + Math.sin(sa) * sl, 1.1 * S);
        needles(px, py, sa, sl, 0.7 + rnd() * 0.4, 0.4 + rnd() * 0.6);
      }
    }
  }
  // leading shoot
  wood(stemX, h * 0.13, stemX, h * 0.02, 2 * S);
  needles(stemX, h * 0.13, -Math.PI / 2, h * 0.11, 1.05, 1);
  dilate(ctx, w, h);
  return finish(c);
}

export function makeBarkTexture(seed = 2, kind = 'oak', size = 256) {
  const rnd = mulberry32(seed);
  const c = canvas(size, size), ctx = c.getContext('2d');
  const base = kind === 'birch' ? [214, 210, 200] : kind === 'pine' ? [96, 58, 38] : [66, 52, 40];
  ctx.fillStyle = `rgb(${base[0]},${base[1]},${base[2]})`; ctx.fillRect(0, 0, size, size);
  // vertical fissures (wrap horizontally)
  const fissures = kind === 'birch' ? 18 : 60;
  for (let i = 0; i < fissures; i++) {
    const x = rnd() * size;
    const w = kind === 'birch' ? 2 + rnd() * 10 : 1 + rnd() * 4;
    const dark = kind === 'birch' ? 30 + rnd() * 40 : 20 + rnd() * 30;
    ctx.strokeStyle = `rgba(${Math.max(0, base[0] - dark)},${Math.max(0, base[1] - dark)},${Math.max(0, base[2] - dark)},${kind === 'birch' ? 0.75 : 0.85})`;
    ctx.lineWidth = w;
    for (const ox of [-size, 0, size]) {
      ctx.beginPath();
      let y = -10, xx = x + ox;
      ctx.moveTo(xx, y);
      while (y < size + 10) { y += 12 + rnd() * 24; xx += (rnd() - 0.5) * 8; ctx.lineTo(xx, y); }
      ctx.stroke();
    }
  }
  // plates / lighter ridges
  for (let i = 0; i < 700; i++) {
    const x = rnd() * size, y = rnd() * size;
    const l = kind === 'birch' ? -30 + rnd() * 50 : -14 + rnd() * 40;
    ctx.fillStyle = `rgba(${Math.min(255, base[0] + l)},${Math.min(255, base[1] + l)},${Math.min(255, base[2] + l)},0.18)`;
    ctx.fillRect(x, y, 1 + rnd() * 5, 4 + rnd() * 18);
  }
  if (kind === 'birch') { // horizontal lenticels
    ctx.fillStyle = 'rgba(30,25,20,0.7)';
    for (let i = 0; i < 26; i++) { const x = rnd() * size, y = rnd() * size; ctx.fillRect(x, y, 12 + rnd() * 30, 2 + rnd() * 2); }
  }
  return finish(c, { repeat: true });
}

// Grass tuft card: several blades fanning from the bottom
export function makeGrassTexture(seed = 9, w = 256, h = 256) {
  // A clump of ~50 broad tapering blades with a lighter mid-rib, warm olive at the base, yellow-green in the sun-lit tips.
  const rnd = mulberry32(seed);
  const c = canvas(w, h), ctx = c.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  const S = w / 256;
  const blades = 52;
  const order = [];
  for (let i = 0; i < blades; i++) order.push(rnd());
  order.sort((a, b) => a - b);
  for (let i = 0; i < blades; i++) {
    const back = 1 - order[i];                                   // paint tall/back blades first
    const x0 = w * (0.16 + rnd() * 0.68);
    const hgt = h * (0.42 + Math.pow(rnd(), 0.7) * 0.55);
    const lean = (rnd() - 0.5) * w * 0.55;
    const tipX = x0 + lean;
    const bw = (3.6 + rnd() * 3.8) * S;
    const bend = (rnd() - 0.5) * w * 0.18;
    const ctrlX = x0 + lean * 0.25 + bend, ctrlY = h - hgt * 0.62;
    const hue = 76 + rnd() * 26, dry = rnd() < 0.14;
    const g = ctx.createLinearGradient(0, h, 0, h - hgt);
    g.addColorStop(0, hsl(hue - 4, 38, dry ? 24 : 15 + back * 3));
    g.addColorStop(0.45, hsl(dry ? 52 : hue, dry ? 40 : 46, dry ? 42 : 28 + rnd() * 6));
    g.addColorStop(1, hsl(dry ? 48 : hue - 10, dry ? 46 : 55, dry ? 58 : 48 + rnd() * 8));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(x0 - bw, h);
    ctx.quadraticCurveTo(ctrlX - bw * 0.85, ctrlY, tipX, h - hgt);
    ctx.quadraticCurveTo(ctrlX + bw * 0.85, ctrlY, x0 + bw, h);
    ctx.closePath(); ctx.fill();
    // mid-rib highlight
    ctx.strokeStyle = hsl(hue - 8, 40, 46, 0.35); ctx.lineWidth = 0.9 * S;
    ctx.beginPath(); ctx.moveTo(x0, h); ctx.quadraticCurveTo(ctrlX, ctrlY, tipX, h - hgt); ctx.stroke();
  }
  // dark, soft contact shadow at the very base so tufts sit in the ground
  const sh = ctx.createLinearGradient(0, h, 0, h * 0.78);
  sh.addColorStop(0, 'rgba(8,16,4,0.55)'); sh.addColorStop(1, 'rgba(8,16,4,0)');
  ctx.globalCompositeOperation = 'source-atop'; ctx.fillStyle = sh; ctx.fillRect(0, h * 0.78, w, h * 0.22); ctx.globalCompositeOperation = 'source-over';
  dilate(ctx, w, h);
  return finish(c);
}

export function makeRockTexture(seed = 4, size = 256) {
  const rnd = mulberry32(seed);
  const c = canvas(size, size), ctx = c.getContext('2d');
  ctx.fillStyle = '#7d7a72'; ctx.fillRect(0, 0, size, size);
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  // tileable value noise sum
  const grid = (n) => { const g = new Float32Array((n + 1) * (n + 1)); for (let i = 0; i < g.length; i++) g[i] = rnd(); return g; };
  const layers = [[6, 0.5, grid(6)], [16, 0.28, grid(16)], [40, 0.16, grid(40)], [96, 0.1, grid(96)]];
  const smooth = t => t * t * (3 - 2 * t);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let v = 0;
    for (const [n, a, g] of layers) {
      const fx = x / size * n, fy = y / size * n;
      const ix = Math.floor(fx), iy = Math.floor(fy);
      const tx = smooth(fx - ix), ty = smooth(fy - iy);
      const i00 = g[(iy % n) * (n + 1) + (ix % n)], i10 = g[(iy % n) * (n + 1) + ((ix + 1) % n)];
      const i01 = g[((iy + 1) % n) * (n + 1) + (ix % n)], i11 = g[((iy + 1) % n) * (n + 1) + ((ix + 1) % n)];
      v += a * ((i00 * (1 - tx) + i10 * tx) * (1 - ty) + (i01 * (1 - tx) + i11 * tx) * ty);
    }
    const i = (y * size + x) * 4;
    const k = 0.55 + v * 0.75;
    d[i] = 128 * k; d[i + 1] = 124 * k; d[i + 2] = 116 * k; d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  // lichen / moss specks
  for (let i = 0; i < 140; i++) {
    ctx.fillStyle = `hsla(${70 + rnd() * 40},35%,${28 + rnd() * 16}%,${0.2 + rnd() * 0.25})`;
    ctx.beginPath(); ctx.arc(rnd() * size, rnd() * size, 2 + rnd() * 9, 0, 6.3); ctx.fill();
  }
  return finish(c, { repeat: true });
}
