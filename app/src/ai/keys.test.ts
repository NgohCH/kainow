import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { BadRequestException } from '@nestjs/common';
import { loadProtectedKey } from '../quarantine/protected-key';
import { KeyUnreadableError, normaliseApiKey, openApiKey, sealApiKey, type KeyBinding } from './keys';

const dir = mkdtempSync(join(tmpdir(), 'kainow-aikey-'));
after(() => rmSync(dir, { recursive: true, force: true }));

function load(name: string) {
  const path = join(dir, name);
  writeFileSync(path, randomBytes(32));
  const k = loadProtectedKey(path, () => {});
  assert.ok(k);
  return k;
}

const key = load('a.key');
const binding: KeyBinding = { connectionId: 'c1', projectId: 'p1', provider: 'openai' };
const apiKey = 'sk-test-' + 'x'.repeat(40);

describe('ai keys', () => {
  test('round trip with the same binding', () => {
    const sealed = sealApiKey(key, apiKey, binding);
    assert.equal(sealed.keyId, key.id);
    assert.equal(openApiKey(key, sealed, binding), apiKey);
  });
  test('another connection id fails with KeyUnreadableError', () => {
    const sealed = sealApiKey(key, apiKey, binding);
    assert.throws(() => openApiKey(key, sealed, { ...binding, connectionId: 'c2' }), KeyUnreadableError);
  });
  test('another project id fails', () => {
    const sealed = sealApiKey(key, apiKey, binding);
    assert.throws(() => openApiKey(key, sealed, { ...binding, projectId: 'p2' }), KeyUnreadableError);
  });
  test('another provider fails', () => {
    const sealed = sealApiKey(key, apiKey, binding);
    assert.throws(() => openApiKey(key, sealed, { ...binding, provider: 'anthropic' }), KeyUnreadableError);
  });
  test('another protected key id fails', () => {
    const sealed = sealApiKey(key, apiKey, binding);
    assert.throws(() => openApiKey(load('b.key'), sealed, binding), KeyUnreadableError);
  });
  test('error text never holds the key', () => {
    const sealed = sealApiKey(key, apiKey, binding);
    try {
      openApiKey(key, sealed, { ...binding, projectId: 'p2' });
      assert.fail('should throw');
    } catch (e) {
      assert.ok(!String((e as Error).message).includes(apiKey));
    }
  });
  test('existing quarantine callers without aad still round-trip', () => {
    const sealed = key.encrypt(Buffer.from('plain'));
    assert.equal(key.decrypt(sealed).toString(), 'plain');
  });
  test('aad given at encrypt is required at decrypt', () => {
    const sealed = key.encrypt(Buffer.from('plain'), Buffer.from('a'));
    assert.throws(() => key.decrypt(sealed));
    assert.throws(() => key.decrypt(sealed, Buffer.from('b')));
    assert.equal(key.decrypt(sealed, Buffer.from('a')).toString(), 'plain');
  });
  test('normaliseApiKey refuses 19 characters, a space, a non-ASCII character and 501 characters, and accepts and trims a 40-character key', () => {
    const msg = 'This does not look like an API key.';
    for (const bad of ['x'.repeat(19), 'x'.repeat(10) + ' ' + 'x'.repeat(20), 'x'.repeat(25) + 'é', 'x'.repeat(501), 42, null, undefined]) {
      assert.throws(() => normaliseApiKey(bad), (e: unknown) => e instanceof BadRequestException && e.message === msg);
    }
    assert.equal(normaliseApiKey('  ' + 'k'.repeat(40) + '\n'), 'k'.repeat(40));
    assert.equal(normaliseApiKey('x'.repeat(20)).length, 20);
    assert.equal(normaliseApiKey('x'.repeat(500)).length, 500);
  });
});
