import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { loadProtectedKey } from '../quarantine/protected-key';
import { clientForAttempt, type ModelClientFactory } from './client-factory';
import { KeyUnreadableError, sealApiKey, type KeyBinding } from './keys';

const dir = mkdtempSync(join(tmpdir(), 'kainow-cf-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const path = join(dir, 'a.key');
writeFileSync(path, randomBytes(32));
const key = loadProtectedKey(path, () => {});
assert.ok(key);
const binding: KeyBinding = { connectionId: 'c1', projectId: 'p1', provider: 'anthropic' };
const apiKey = `sk-ant-test-${'x'.repeat(40)}`;

test('the helper opens the key and hands it to the factory with the provider and timeout', () => {
  const seen: unknown[] = [];
  const factory: ModelClientFactory = { forAttempt: (c) => (seen.push(c), {} as never) };
  clientForAttempt(key, sealApiKey(key, apiKey, binding), binding, factory, 90000);
  assert.deepEqual(seen, [{ provider: 'anthropic', apiKey, timeoutMs: 90000 }]);
});

test('a key sealed for another binding is unreadable', () => {
  const factory: ModelClientFactory = { forAttempt: () => assert.fail('must not build a client') };
  assert.throws(
    () => clientForAttempt(key, sealApiKey(key, apiKey, binding), { ...binding, projectId: 'p2' }, factory, 1000),
    KeyUnreadableError,
  );
});
