// Draws Kainow's default logos (flat placeholder marks) and writes them to assets/branding.
// Run from app/: node scripts/make-default-logos.mjs. The PNGs are committed; rerun only to change them.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';

const TEAL = [15, 110, 86, 255];
const INK = [28, 42, 46, 255];
const WHITE = [255, 255, 255, 255];
const CLEAR = [0, 0, 0, 0];

function canvas(width, height, fill) {
  const px = Array.from({ length: width * height }, () => fill);
  return {
    width,
    height,
    set(x, y, c) {
      if (x >= 0 && y >= 0 && x < width && y < height) px[y * width + x] = c;
    },
    rect(x0, y0, w, h, c) {
      for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) this.set(x, y, c);
    },
    roundRect(x0, y0, w, h, r, c) {
      for (let y = y0; y < y0 + h; y++)
        for (let x = x0; x < x0 + w; x++) {
          const dx = Math.max(x0 + r - x - 0.5, 0, x + 0.5 - (x0 + w - r));
          const dy = Math.max(y0 + r - y - 0.5, 0, y + 0.5 - (y0 + h - r));
          if (dx * dx + dy * dy <= r * r) this.set(x, y, c);
        }
    },
    // A thick straight stroke from (x1,y1) to (x2,y2).
    line(x1, y1, x2, y2, t, c) {
      const minX = Math.floor(Math.min(x1, x2) - t), maxX = Math.ceil(Math.max(x1, x2) + t);
      const minY = Math.floor(Math.min(y1, y2) - t), maxY = Math.ceil(Math.max(y1, y2) + t);
      const len2 = (x2 - x1) ** 2 + (y2 - y1) ** 2;
      for (let y = minY; y <= maxY; y++)
        for (let x = minX; x <= maxX; x++) {
          const u = Math.max(0, Math.min(1, ((x - x1) * (x2 - x1) + (y - y1) * (y2 - y1)) / len2));
          const d = Math.hypot(x - (x1 + u * (x2 - x1)), y - (y1 + u * (y2 - y1)));
          if (d <= t / 2) this.set(x, y, c);
        }
    },
    png() {
      const raw = Buffer.alloc((width * 4 + 1) * height);
      for (let y = 0; y < height; y++) {
        raw[y * (width * 4 + 1)] = 0;
        for (let x = 0; x < width; x++) Buffer.from(px[y * width + x]).copy(raw, y * (width * 4 + 1) + 1 + x * 4);
      }
      const chunk = (type, data) => {
        const len = Buffer.alloc(4);
        len.writeUInt32BE(data.length);
        const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
        const crc = Buffer.alloc(4);
        crc.writeUInt32BE(crc32(body));
        return Buffer.concat([len, body, crc]);
      };
      const ihdr = Buffer.alloc(13);
      ihdr.writeUInt32BE(width, 0);
      ihdr.writeUInt32BE(height, 4);
      ihdr[8] = 8;
      ihdr[9] = 6;
      return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
    },
  };
}

// The mark: a white "K" on a rounded teal square, size s at (x, y).
function mark(c, x, y, s) {
  c.roundRect(x, y, s, s, Math.round(s * 0.2), TEAL);
  const t = Math.round(s * 0.13);
  const l = x + Math.round(s * 0.3), top = y + Math.round(s * 0.22), bottom = y + Math.round(s * 0.78), mid = y + Math.round(s * 0.52);
  c.line(l, top, l, bottom, t, WHITE);
  c.line(l + t / 2, mid, x + Math.round(s * 0.72), top, t, WHITE);
  c.line(l + Math.round(s * 0.1), mid - Math.round(s * 0.06), x + Math.round(s * 0.74), bottom, t, WHITE);
}

// A 5×7 pixel font for the wordmark's letters.
const GLYPHS = {
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  W: ['10001', '10001', '10001', '10101', '10101', '11011', '10001'],
};
function word(c, text, x, y, scale, colour) {
  for (const ch of text) {
    GLYPHS[ch].forEach((row, gy) => [...row].forEach((bit, gx) => bit === '1' && c.rect(x + gx * scale, y + gy * scale, scale, scale, colour)));
    x += 6 * scale;
  }
}

const out = join(import.meta.dirname, '..', 'assets', 'branding');
mkdirSync(out, { recursive: true });

const square = canvas(128, 128, CLEAR);
mark(square, 0, 0, 128);
writeFileSync(join(out, 'kainow-square.png'), square.png());

const wide = canvas(240, 80, CLEAR);
mark(wide, 4, 8, 64);
word(wide, 'KAINOW', 80, 26, 4, INK);
writeFileSync(join(out, 'kainow-wide.png'), wide.png());
console.log('wrote', out);
