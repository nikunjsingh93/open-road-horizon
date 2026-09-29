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
  const rnd = mulberry32(seed);
  const c = canvas(w, h), ctx = c.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  // central stem runs bottom->top (x = w/2)
  const stemX = w / 2;
  ctx.strokeStyle = '#3b2c1c'; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(stemX, h); ctx.lineTo(stemX, h * 0.02); ctx.stroke();
  // side twigs, each with needles
  const needles = (x0, y0, ang, len, depthShade) => {
    const n = Math.floor(len / 4.2);
    for (let i = 0; i < n; i++) {
      const t = i / n;
      const bx = x0 + Math.cos(ang) * len * t, by = y0 + Math.sin(ang) * len * t;
      for (const side of [-1, 1]) {
        const a = ang + side * (0.9 + rnd() * 0.35);
        const nl = 15 + rnd() * 9 - t * 6;
        const hh = hue + (rnd() - 0.5) * 12;
        const l = (14 + rnd() * 12) * depthShade;
        ctx.strokeStyle = hsl(hh, 48 + rnd() * 12, l + t * 4);
        ctx.lineWidth = 1.8 + rnd() * 0.8;
        ctx.beginPath(); ctx.moveTo(bx, by);
        ctx.lineTo(bx + Math.cos(a) * nl, by + Math.sin(a) * nl); ctx.stroke();
      }
    }
  };
  const twigs = 22;
  for (let i = 0; i < twigs; i++) {
    const t = i / twigs;
    const y0 = h * (0.97 - t * 0.9);
    const len = (w * 0.47) * (0.35 + 0.65 * Math.sin(Math.min(1, t * 1.05 + 0.08) * Math.PI * 0.8));
    for (const side of [-1, 1]) {
      const ang = (side < 0 ? Math.PI : 0) + side * -0.2 - 0.5 * side * (0.2 + t * 0.5) * (side < 0 ? -1 : 1) * 0;
      const a2 = side < 0 ? Math.PI + 0.55 : -0.55; // upwards & outwards
      ctx.strokeStyle = '#3b2c1c'; ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.moveTo(stemX, y0);
      const ex = stemX + Math.cos(a2) * len, ey = y0 + Math.sin(a2) * len;
      ctx.lineTo(ex, ey); ctx.stroke();
      needles(stemX, y0, a2, len, 0.85 + rnd() * 0.3);
    }
  }
  needles(stemX, h * 0.10, -Math.PI / 2, h * 0.09, 1.1);
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
  const rnd = mulberry32(seed);
  const c = canvas(w, h), ctx = c.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  const blades = Math.round(110 * (w / 256));
  for (let i = 0; i < blades; i++) {
    const x0 = w * (0.12 + rnd() * 0.76);
    const tipX = x0 + (rnd() - 0.5) * w * 0.5;
    const hgt = h * (0.35 + rnd() * 0.6);
    const bw = (1.6 + rnd() * 2.4) * (w / 256);
    const ctrl = x0 + (tipX - x0) * 0.3 + (rnd() - 0.5) * 20;
    const g = ctx.createLinearGradient(0, h, 0, h - hgt);
    const hue = 84 + rnd() * 26;
    g.addColorStop(0, hsl(hue, 45, 22));
    g.addColorStop(0.55, hsl(hue, 58, 38));
    g.addColorStop(1, hsl(hue - 6, 62, 56));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(x0 - bw, h);
    ctx.quadraticCurveTo(ctrl - bw * 0.6, h - hgt * 0.55, tipX, h - hgt);
    ctx.quadraticCurveTo(ctrl + bw * 0.6, h - hgt * 0.55, x0 + bw, h);
    ctx.closePath(); ctx.fill();
  }
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
