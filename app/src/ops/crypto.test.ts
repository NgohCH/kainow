import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, type Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { test } from 'node:test';
import { BackupCryptoError, decryptStream, encryptStream, loadBackupKey, sha256Stream } from './crypto';

const MIB = 1024 * 1024;
function keyOf(bytes: Buffer = randomBytes(32)) {
  return { id: createHash('sha256').update(bytes).digest('hex').slice(0, 16), bytes };
}
async function collect(input: Buffer | Buffer[], t: Transform): Promise<Buffer> {
  const parts: Buffer[] = [];
  const src = Readable.from(Array.isArray(input) ? input : [input], { objectMode: false });
  await pipeline(src, t, async (it: AsyncIterable<unknown>) => {
    for await (const c of it) parts.push(c as Buffer);
  });
  return Buffer.concat(parts);
}
const enc = (key: ReturnType<typeof keyOf>, data: Buffer) => collect(data, encryptStream(key));
const dec = (key: ReturnType<typeof keyOf>, data: Buffer) => collect(data, decryptStream(key));
async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof BackupCryptoError, `unexpected error ${String(e)}`);
    return e.code;
  }
  return 'no_error';
}
const HEADER = 5 + 16 + 12;
const FRAME = 4 + MIB + 16;

for (const size of [0, 1, MIB, 3.5 * MIB]) {
  test(`round trip of ${size} bytes`, async () => {
    const key = keyOf();
    const plain = randomBytes(size);
    const sealed = await enc(key, plain);
    assert.equal(sealed.subarray(0, 5).toString('latin1'), 'KNBK1');
    assert.equal(sealed.subarray(5, 21).toString('ascii'), key.id);
    assert.ok((await dec(key, sealed)).equals(plain));
  });
}

test('round trip survives odd input slicing', async () => {
  const key = keyOf();
  const plain = randomBytes(2 * MIB + 77);
  const pieces = [plain.subarray(0, 5), plain.subarray(5, MIB + 3), plain.subarray(MIB + 3)];
  const sealed = await collect(pieces, encryptStream(key));
  const odd = [sealed.subarray(0, 7), sealed.subarray(7, 40), sealed.subarray(40, 5000), sealed.subarray(5000)];
  assert.ok((await collect(odd, decryptStream(key))).equals(plain));
});

test('a different key gives wrong_key', async () => {
  const sealed = await enc(keyOf(), randomBytes(100));
  assert.equal(await codeOf(dec(keyOf(), sealed)), 'wrong_key');
});

test('a flipped bit in the header key id gives wrong_key', async () => {
  const key = keyOf();
  const sealed = Buffer.from(await enc(key, randomBytes(10)));
  sealed[10] ^= 1;
  assert.equal(await codeOf(dec(key, sealed)), 'wrong_key');
});

test('wrong magic gives bad_magic', async () => {
  const key = keyOf();
  const sealed = Buffer.from(await enc(key, randomBytes(10)));
  sealed[0] ^= 1;
  assert.equal(await codeOf(dec(key, sealed)), 'bad_magic');
  assert.equal(await codeOf(dec(key, Buffer.from('not a backup at all, no way, none'))), 'bad_magic');
});

test('a flipped bit in the header salt gives tampered', async () => {
  const key = keyOf();
  const sealed = Buffer.from(await enc(key, randomBytes(100)));
  sealed[25] ^= 1;
  assert.equal(await codeOf(dec(key, sealed)), 'tampered');
});

test('a flipped bit in a chunk, a tag or a length gives tampered', async () => {
  const key = keyOf();
  const sealed = await enc(key, randomBytes(100));
  const a = Buffer.from(sealed);
  a[HEADER + 4 + 10] ^= 0x10;
  assert.equal(await codeOf(dec(key, a)), 'tampered');
  const b = Buffer.from(sealed);
  b[b.length - 3] ^= 0x01;
  assert.equal(await codeOf(dec(key, b)), 'tampered');
  const c = Buffer.from(sealed);
  c[HEADER + 3] ^= 0x04; // 100 -> 96: a shorter claimed length (a longer one cannot be told from a cut-off file)
  assert.equal(await codeOf(dec(key, c)), 'tampered');
});

test('dropping the last chunk gives truncated', async () => {
  const key = keyOf();
  const sealed = await enc(key, randomBytes(3.5 * MIB));
  assert.equal(sealed.length, HEADER + 3 * FRAME + (4 + 0.5 * MIB + 16));
  assert.equal(await codeOf(dec(key, sealed.subarray(0, HEADER + 3 * FRAME))), 'truncated');
  assert.equal(await codeOf(dec(key, sealed.subarray(0, sealed.length - 5))), 'truncated');
  assert.equal(await codeOf(dec(key, sealed.subarray(0, 10))), 'truncated');
  assert.equal(await codeOf(dec(key, Buffer.alloc(0))), 'truncated');
});

test('data after the final chunk gives tampered', async () => {
  const key = keyOf();
  const sealed = await enc(key, randomBytes(10));
  assert.equal(await codeOf(dec(key, Buffer.concat([sealed, Buffer.from([1, 2, 3])]))), 'tampered');
});

test('swapped chunks give tampered', async () => {
  const key = keyOf();
  const sealed = await enc(key, randomBytes(3.5 * MIB));
  const f0 = sealed.subarray(HEADER, HEADER + FRAME);
  const f1 = sealed.subarray(HEADER + FRAME, HEADER + 2 * FRAME);
  const swapped = Buffer.concat([sealed.subarray(0, HEADER), f1, f0, sealed.subarray(HEADER + 2 * FRAME)]);
  assert.equal(await codeOf(dec(key, swapped)), 'tampered');
});

test('a chunk spliced in from another file with the same key gives tampered', async () => {
  const key = keyOf();
  const a = await enc(key, randomBytes(2.5 * MIB));
  const b = await enc(key, randomBytes(2.5 * MIB));
  const spliced = Buffer.concat([a.subarray(0, HEADER), b.subarray(HEADER, HEADER + FRAME), a.subarray(HEADER + FRAME)]);
  assert.equal(await codeOf(dec(key, spliced)), 'tampered');
});

test('the same input encrypted twice gives different ciphertext', async () => {
  const key = keyOf();
  const plain = randomBytes(1000);
  const x = await enc(key, plain);
  const y = await enc(key, plain);
  assert.ok(!x.equals(y));
});

test('sha256Stream passes data through and reports the digest', async () => {
  const plain = randomBytes(3 * MIB + 5);
  const h = sha256Stream();
  const out = await collect(plain, h);
  assert.ok(out.equals(plain));
  assert.equal(h.digest(), createHash('sha256').update(plain).digest('hex'));
});

test('loadBackupKey reads a 32-byte key and reports missing or invalid', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kn-key-'));
  const bytes = randomBytes(32);
  writeFileSync(join(dir, 'ok.key'), bytes);
  writeFileSync(join(dir, 'short.key'), randomBytes(31));
  const ok = loadBackupKey(join(dir, 'ok.key'));
  assert.ok(!('error' in ok));
  if (!('error' in ok)) {
    assert.equal(ok.id, createHash('sha256').update(bytes).digest('hex').slice(0, 16));
    assert.ok(ok.bytes.equals(bytes));
  }
  assert.deepEqual(loadBackupKey(join(dir, 'nope.key')), { error: 'key_missing' });
  assert.deepEqual(loadBackupKey(join(dir, 'short.key')), { error: 'key_invalid' });
});
