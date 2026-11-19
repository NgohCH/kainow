import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { loadProtectedKey } from './protected-key';
import { runProtectedKeyCli } from './protected-key-cli';

const dir = mkdtempSync(join(tmpdir(), 'kainow-key-'));
after(() => rmSync(dir, { recursive: true, force: true }));

function keyFile(name: string, bytes: Buffer = randomBytes(32)): { path: string; bytes: Buffer } {
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return { path, bytes };
}

describe('protected key', () => {
  test('round trip', () => {
    const key = loadProtectedKey(keyFile('rt.key').path, () => {});
    assert.ok(key);
    const plain = Buffer.from('a marked text, with unicode — ok', 'utf8');
    const sealed = key.encrypt(plain);
    assert.equal(sealed.nonce.length, 12);
    assert.equal(sealed.tag.length, 16);
    assert.notDeepEqual(sealed.ciphertext, plain);
    assert.deepEqual(key.decrypt(sealed), plain);
  });

  test('a fresh nonce each call', () => {
    const key = loadProtectedKey(keyFile('nonce.key').path, () => {});
    assert.ok(key);
    const a = key.encrypt(Buffer.from('same'));
    const b = key.encrypt(Buffer.from('same'));
    assert.notDeepEqual(a.nonce, b.nonce);
    assert.notDeepEqual(a.ciphertext, b.ciphertext);
  });

  test('tampered tag fails', () => {
    const key = loadProtectedKey(keyFile('tag.key').path, () => {});
    assert.ok(key);
    const sealed = key.encrypt(Buffer.from('secret'));
    const tag = Buffer.from(sealed.tag);
    tag[0] ^= 1;
    assert.throws(() => key.decrypt({ ...sealed, tag }));
    assert.throws(() => key.decrypt({ ...sealed, tag: sealed.tag.subarray(0, 8) }), /tag must be 16/);
    assert.throws(() => key.decrypt({ ...sealed, nonce: sealed.nonce.subarray(0, 8) }), /nonce must be 12/);
    const ciphertext = Buffer.from(sealed.ciphertext);
    ciphertext[0] ^= 1;
    assert.throws(() => key.decrypt({ ...sealed, ciphertext }));
  });

  test('another key cannot decrypt', () => {
    const a = loadProtectedKey(keyFile('a.key').path, () => {});
    const b = loadProtectedKey(keyFile('b.key').path, () => {});
    assert.ok(a && b);
    assert.throws(() => b.decrypt(a.encrypt(Buffer.from('x'))));
  });

  test('wrong length file gives null, and the log names the problem but not the bytes', () => {
    const logs: string[] = [];
    const f = keyFile('short.key', randomBytes(31));
    assert.equal(loadProtectedKey(f.path, (m) => logs.push(m)), null);
    assert.equal(loadProtectedKey(keyFile('long.key', randomBytes(33)).path, (m) => logs.push(m)), null);
    assert.equal(logs.length, 2);
    assert.match(logs[0], /wrong length/);
    assert.ok(logs[0].includes(f.path));
    assert.ok(!logs[0].includes(f.bytes.toString('hex')) && !logs[0].includes(f.bytes.toString('base64')));
  });

  test('missing, unset and unreadable give null', () => {
    const logs: string[] = [];
    assert.equal(loadProtectedKey(null, (m) => logs.push(m)), null);
    assert.equal(loadProtectedKey(join(dir, 'nope.key'), (m) => logs.push(m)), null);
    assert.equal(loadProtectedKey(dir, (m) => logs.push(m)), null);
    assert.equal(logs.length, 2, 'unset is normal and logs nothing');
    assert.match(logs[0], /not found/);
    assert.match(logs[1], /unreadable/);
  });

  test('key id is stable and 16 hex', () => {
    const f = keyFile('id.key');
    const one = loadProtectedKey(f.path, () => {});
    const two = loadProtectedKey(f.path, () => {});
    assert.ok(one && two);
    assert.match(one.id, /^[0-9a-f]{16}$/);
    assert.equal(one.id, two.id);
    assert.equal(one.id, createHash('sha256').update(f.bytes).digest('hex').slice(0, 16));
  });
});

describe('protected-key CLI', () => {
  const run = (args: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = runProtectedKeyCli(args, { out: (l) => out.push(l), err: (l) => err.push(l) });
    return { code, out, err };
  };

  test('creates a 32-byte key file and prints only the path and the key id', () => {
    const path = join(dir, 'made.key');
    const r = run(['--create', path]);
    assert.equal(r.code, 0);
    const bytes = readFileSync(path);
    assert.equal(bytes.length, 32);
    const printed = [...r.out, ...r.err].join('\n');
    assert.ok(printed.includes(path));
    assert.ok(printed.includes(createHash('sha256').update(bytes).digest('hex').slice(0, 16)));
    assert.ok(!printed.includes(bytes.toString('hex')) && !printed.includes(bytes.toString('base64')));
    assert.ok(loadProtectedKey(path, () => {}));
  });

  test('CLI refuses to overwrite', () => {
    const f = keyFile('keep.key');
    const r = run(['--create', f.path]);
    assert.notEqual(r.code, 0);
    assert.match(r.err.join('\n'), /already exists/);
    assert.deepEqual(readFileSync(f.path), f.bytes);
  });

  test('asks for a path', () => {
    const r = run([]);
    assert.notEqual(r.code, 0);
    assert.match(r.err.join('\n'), /Usage/);
  });
});
