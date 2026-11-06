// Generates the PWA / home-screen icons (DESIGN 17.5) into public/icons. No dependencies: rasterises the
// neon ship on a dark tunnel background and writes PNGs with node:zlib.   Usage: node scripts/gen-icons.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
mkdirSync(out, { recursive: true });

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const t = Buffer.from(type);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, c]);
};
function png(size, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2; // RGB
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    rgb.copy(raw, y * (size * 3 + 1) + 1, y * size * 3, (y + 1) * size * 3);
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// ship polygon in the 32x32 favicon space (same dart as index.html), scaled around the centre
const SHIP = [[16, 4], [28, 28], [16, 22], [4, 28]];
const inside = (x, y, poly) => {
  let r = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) r = !r;
  }
  return r;
};
const distSeg = (px, py, [ax, ay], [bx, by]) => {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
};

/** `scale` < 1 leaves a larger safe margin (maskable icons keep the ship inside the central 80 %). */
function render(size, scale) {
  const buf = Buffer.alloc(size * size * 3);
  const poly = SHIP.map(([x, y]) => [(x - 16) * scale + 16, (y - 16) * scale + 16]);
  const SS = 3;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = ((px + (sx + 0.5) / SS) / size) * 32;
          const y = ((py + (sy + 0.5) / SS) / size) * 32;
          // background: dark navy with a magenta/cyan radial glow behind the ship
          const cx = (x - 16) / 16, cy = (y - 17) / 16;
          const d0 = Math.hypot(cx, cy);
          let cr = 2 + 30 * Math.max(0, 1 - d0) ** 2, cg = 2 + 4 * Math.max(0, 1 - d0), cb = 10 + 60 * Math.max(0, 1 - d0) ** 1.5;
          let dmin = Infinity;
          for (let i = 0; i < poly.length; i++) dmin = Math.min(dmin, distSeg(x, y, poly[i], poly[(i + 1) % poly.length]));
          const glow = Math.exp(-((dmin * 1.6) ** 2) / 2.2);
          cr += 0 * glow; cg += 240 * glow * 0.55; cb += 255 * glow * 0.55;
          if (inside(x, y, poly)) {
            const k = Math.max(0, Math.min(1, (y - poly[0][1]) / (poly[1][1] - poly[0][1])));
            cr = 40 + 215 * (1 - k); cg = 240; cb = 255; // cyan, whiter toward the nose
          } else if (dmin < 0.5 * scale) {
            cr = 255; cg = 43; cb = 214; // magenta rim
          }
          r += cr; g += cg; b += cb;
        }
      }
      const o = (py * size + px) * 3;
      buf[o] = Math.min(255, Math.round(r / (SS * SS)));
      buf[o + 1] = Math.min(255, Math.round(g / (SS * SS)));
      buf[o + 2] = Math.min(255, Math.round(b / (SS * SS)));
    }
  }
  return png(size, buf);
}

const files = [
  ['icon-192.png', 192, 1],
  ['icon-512.png', 512, 1],
  ['icon-maskable-512.png', 512, 0.72],
  ['apple-touch-icon.png', 180, 0.9],
];
for (const [name, size, scale] of files) {
  writeFileSync(join(out, name), render(size, scale));
  console.log('wrote public/icons/' + name);
}
