import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quickXorHash, QuickXorHasher } from './quickxor';

// Vector provenance: the empty-buffer value is the one given in the sub-project 9 plan.
// The "abc" and 1,000-byte values were derived from Microsoft's published algorithm description
// (160-bit register, each byte XORed in at bit offset (index * 11) mod 160 with circular wrap,
// then the byte length XORed little-endian into the last 8 bytes, base64 of the 20 bytes) using
// an independent BigInt rotation implementation; the "abc" value was also worked out by hand
// (bytes 61 10 C3 18 ... 03 at index 12). They are not copied from a Microsoft page.
const EMPTY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const ABC = 'YRDDGAAAAAAAAAAAAwAAAAAAAAA=';
const THOUSAND = 'dgD8j0n8sM0aPE5CUJ8tqmilX/E=';

test('quickXorHash of empty buffer is AAAAAAAAAAAAAAAAAAAAAAAAAAA=', () => {
  assert.equal(quickXorHash(Buffer.alloc(0)), EMPTY);
});

// TODO(real tenant): confirm against Microsoft: `npm run probe-storage -- --destination <label>` uploads "abc" and a
// 6 MiB file and its "hashes" line compares the QuickXorHash Microsoft returns with Kainow's (this "abc" vector).
test('quickXorHash matches reference vectors derived from the algorithm description', () => {
  assert.equal(quickXorHash(Buffer.from('abc')), ABC);
  const b = Buffer.alloc(1000);
  for (let i = 0; i < 1000; i++) b[i] = (i * 7 + 3) & 0xff;
  assert.equal(quickXorHash(b), THOUSAND);
});

test('hash is stable across chunk boundaries', () => {
  const b = Buffer.alloc(160 * 1024);
  for (let i = 0; i < b.length; i++) b[i] = (i * 31 + (i >> 8)) & 0xff;
  const h = new QuickXorHasher();
  for (let o = 0; o < b.length; o += 7) h.update(b.subarray(o, o + 7));
  assert.equal(h.digest(), quickXorHash(b));
  assert.equal(h.digest(), quickXorHash(b), 'digest is repeatable');
});
