// Generates the PNG icons the manifest and iOS need.
//
// PNG rather than only SVG because `apple-touch-icon` will not take an SVG, and
// an installed icon that silently falls back to a screenshot is a poor first
// impression. Written by hand with zlib rather than pulled from a toolchain —
// there is no build step in this project and this is not a reason to add one.
//
// Run after changing icon.svg:  npm run icons

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { crc32 } from '../public/js/crc32.js';

const OUT = join(fileURLToPath(new URL('..', import.meta.url)), 'public');

const COLOURS = {
  background: [0x10, 0x13, 0x1a, 0xff],
  maskable: [0x1d, 0x4e, 0xd8, 0xff],
  accent: [0x6c, 0x94, 0xff, 0xff],
  light: [0xf4, 0xf6, 0xfb, 0xff],
};

// ── shapes, as coverage functions over the unit square ───────────────────────
// Coverage rather than "is this pixel inside" so that supersampling gives clean
// edges without a rasteriser.

const roundedRect = (x0, y0, x1, y1, radius) => (x, y) => {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const dx = Math.max(x0 + radius - x, 0, x - (x1 - radius));
  const dy = Math.max(y0 + radius - y, 0, y - (y1 - radius));
  return dx * dx + dy * dy <= radius * radius || dx === 0 || dy === 0;
};

const circle = (cx, cy, r) => (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;

/** A triangle, via the sign of the cross product against each edge. */
const triangle = (a, b, c) => (x, y) => {
  const side = (p, q) => (q[0] - p[0]) * (y - p[1]) - (q[1] - p[1]) * (x - p[0]);
  const s1 = side(a, b);
  const s2 = side(b, c);
  const s3 = side(c, a);
  return (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0);
};

// The mark: a source, a beam, and a direction. Coordinates match icon.svg so the
// two cannot drift apart visually.
const MARK = [
  { shape: circle(92 / 512, 256 / 512, 30 / 512), colour: 'accent' },
  { shape: roundedRect(146 / 512, 234 / 512, 322 / 512, 278 / 512, 22 / 512), colour: 'accent' },
  { shape: triangle([330 / 512, 168 / 512], [330 / 512, 344 / 512], [444 / 512, 256 / 512]), colour: 'light' },
];

function render(size, { maskable = false } = {}) {
  const pixels = new Uint8Array(size * size * 4);
  const samples = 3; // 3×3 per pixel is enough for shapes this simple
  const background = maskable ? COLOURS.maskable : COLOURS.background;

  // A maskable icon is cropped to a circle by the platform, so the mark has to
  // sit inside the safe area — 80% of the width, centred.
  const inset = maskable ? 0.1 : 0;
  const scale = maskable ? 0.8 : 1;

  // Rounded corners only matter for the plain icon; a maskable one is clipped.
  const frame = maskable ? () => true : roundedRect(0, 0, 1, 1, 116 / 512);

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const accumulated = [0, 0, 0, 0];

      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const x = (px + (sx + 0.5) / samples) / size;
          const y = (py + (sy + 0.5) / samples) / size;

          let colour = [0, 0, 0, 0];
          if (frame(x, y)) {
            colour = background;
            const mx = (x - inset) / scale;
            const my = (y - inset) / scale;
            for (const { shape, colour: name } of MARK) {
              if (mx >= 0 && mx <= 1 && my >= 0 && my <= 1 && shape(mx, my)) colour = COLOURS[name];
            }
          }
          for (let i = 0; i < 4; i++) accumulated[i] += colour[i];
        }
      }

      const at = (py * size + px) * 4;
      const total = samples * samples;
      for (let i = 0; i < 4; i++) pixels[at + i] = Math.round(accumulated[i] / total);
    }
  }

  return pixels;
}

// ── PNG container ────────────────────────────────────────────────────────────

function chunk(type, body) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  const typed = Buffer.concat([Buffer.from(type, 'latin1'), body]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, checksum]);
}

function toPng(pixels, size) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;  // bit depth
  header[9] = 6;  // truecolour with alpha
  header[10] = 0; // deflate
  header[11] = 0; // adaptive filtering
  header[12] = 0; // no interlace

  // Every scanline gets filter byte 0. Real filters would compress better; at
  // these sizes the difference is a few kilobytes and not worth the code.
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let row = 0; row < size; row++) {
    raw[row * (stride + 1)] = 0;
    Buffer.from(pixels.buffer, row * stride, stride).copy(raw, row * (stride + 1) + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const [name, size, options] of [
  ['icon-192.png', 192, {}],
  ['icon-512.png', 512, {}],
  ['icon-maskable-512.png', 512, { maskable: true }],
]) {
  const png = toPng(render(size, options), size);
  writeFileSync(join(OUT, name), png);
  console.log(`  ${name}  ${size}×${size}  ${(png.length / 1024).toFixed(1)} KB`);
}
