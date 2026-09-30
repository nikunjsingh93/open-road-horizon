// Generates the PWA icons (public/icons/*.png) with no dependencies: a dusk sky, hills and a winding road.
import fs from 'node:fs';
import zlib from 'node:zlib';

function png(size, maskable) {
  const px = Buffer.alloc(size * size * 4);
  const pad = maskable ? 0.0 : 0.0;
  const put = (x, y, r, g, b, a = 255) => { const i = (y * size + x) * 4; px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a; };
  const mix = (a, b, t) => a + (b - a) * t;
  const s = size;
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const u = x / s, v = y / s;
      // sky gradient
      let r = mix(255, 70, Math.min(1, v * 1.6)), g = mix(190, 120, Math.min(1, v * 1.6)), b = mix(120, 200, Math.min(1, v * 1.6));
      // sun
      const dx = u - 0.68, dy = v - 0.42, d = Math.hypot(dx, dy);
      const sun = Math.max(0, 1 - d / 0.2);
      r = mix(r, 255, sun * sun); g = mix(g, 235, sun * sun); b = mix(b, 180, sun * sun);
      // far hills
      const h1 = 0.55 + 0.05 * Math.sin(u * 7) + 0.03 * Math.sin(u * 17);
      if (v > h1) { r = 74; g = 110; b = 84; }
      // near hills
      const h2 = 0.68 + 0.04 * Math.sin(u * 5 + 1.4);
      if (v > h2) { r = 44; g = 84; b = 52; }
      // winding road: perspective strip whose centre sways
      if (v > 0.6) {
        const t = (v - 0.6) / 0.4;
        const cx = 0.5 + 0.12 * Math.sin(t * 3.2 + 0.6) * (1 - t) - (t * t) * 0.02;
        const w = 0.02 + 0.32 * t * t;
        const dd = Math.abs(u - cx);
        if (dd < w) {
          r = 58; g = 60; b = 66;
          if (dd < w * 0.05 + 0.002) { r = 240; g = 190; b = 40; }
          if (dd > w * 0.86) { r = 225; g = 225; b = 220; }
        }
      }
      put(x, y, r | 0, g | 0, b | 0);
    }
  }
  // PNG encode
  const raw = Buffer.alloc((s * 4 + 1) * s);
  for (let y = 0; y < s; y++) { raw[y * (s * 4 + 1)] = 0; px.copy(raw, y * (s * 4 + 1) + 1, y * s * 4, (y + 1) * s * 4); }
  const crcTable = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc = (buf) => { let c = 0xffffffff; for (const byte of buf) c = crcTable[(c ^ byte) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(s, 0); ihdr.writeUInt32BE(s, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

fs.mkdirSync('public/icons', { recursive: true });
for (const s of [192, 512]) { fs.writeFileSync(`public/icons/icon-${s}.png`, png(s, false)); }
fs.writeFileSync('public/icons/apple-touch-icon.png', png(180, false));
console.log('icons written');
