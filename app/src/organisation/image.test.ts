import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkLogo, readImage } from './image';

/** The first bytes of a PNG: signature and IHDR with the given size (enough for reading, not a full image). */
export function pngHeader(width: number, height: number, totalSize = 64): Buffer {
  const b = Buffer.alloc(Math.max(totalSize, 33));
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  b[24] = 8;
  b[25] = 6;
  return b;
}

/** A baseline JPEG's opening: SOI, a JFIF APP0 segment, then SOF0 with the given size. */
export function jpegHeader(width: number, height: number, totalSize = 64): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const sof = Buffer.alloc(19);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof[9] = 3;
  const head = Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof]);
  return Buffer.concat([head, Buffer.alloc(Math.max(0, totalSize - head.length))]);
}

test('a PNG and a JPEG are read for their type and size', () => {
  assert.deepEqual(readImage(pngHeader(64, 64)), { mime: 'image/png', width: 64, height: 64 });
  assert.deepEqual(readImage(jpegHeader(120, 40)), { mime: 'image/jpeg', width: 120, height: 40 });
});

test('anything else, or a cut-off file, is not an image', () => {
  assert.equal(readImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')), null);
  assert.equal(readImage(Buffer.from('GIF89a\x40\x00\x40\x00', 'latin1')), null);
  assert.equal(readImage(pngHeader(64, 64).subarray(0, 20)), null);
  assert.equal(readImage(jpegHeader(120, 40).subarray(0, 24)), null);
  assert.equal(readImage(Buffer.alloc(0)), null);
});

const SQUARE = 'A square logo must be square and at least 64 × 64 pixels.';
const WIDE = 'A wide logo must be 2 to 6 times as wide as it is high and at least 40 pixels high.';
const refusal = (fn: () => unknown) => {
  try {
    fn();
    return 'accepted';
  } catch (e) {
    return (e as Error).message;
  }
};

test('a square logo must be square enough and large enough', () => {
  assert.equal(checkLogo('square', pngHeader(64, 64)).width, 64);
  assert.equal(checkLogo('square', jpegHeader(100, 98)).height, 98);
  assert.equal(refusal(() => checkLogo('square', pngHeader(63, 63))), SQUARE);
  assert.equal(refusal(() => checkLogo('square', pngHeader(100, 90))), SQUARE);
  assert.equal(refusal(() => checkLogo('square', Buffer.from('<svg/>'))), 'Use a PNG or JPEG file.');
});

test('a wide logo is 2 to 6 times as wide as it is high and at least 40 high', () => {
  for (const [w, h] of [[80, 40], [120, 40], [240, 40]]) assert.equal(checkLogo('wide', pngHeader(w, h)).width, w);
  for (const [w, h] of [[79, 40], [241, 40], [120, 39]]) assert.equal(refusal(() => checkLogo('wide', pngHeader(w, h))), WIDE, `${w}x${h}`);
});

test('a logo over 512 KB is refused before anything else', () => {
  assert.equal(refusal(() => checkLogo('wide', pngHeader(120, 40, 524289))), 'A logo can be at most 512 KB.');
  assert.equal(checkLogo('wide', pngHeader(120, 40, 524288)).width, 120);
});
