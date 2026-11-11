import assert from 'node:assert/strict';
import { test } from 'node:test';
import { jpegHeader, pngHeader } from '../testing/images';
import { checkLogo, readImage } from './image';

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
