import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runBackupKeyCli } from './backup-key-cli';
import { loadBackupKey } from './crypto';

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
}

test('--create writes a 32-byte key and prints only the path and the id', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kn-bk-'));
  const path = join(dir, 'backup.key');
  const c = io();
  assert.equal(runBackupKeyCli(['--create', path], c.io), 0);
  const bytes = readFileSync(path);
  assert.equal(bytes.length, 32);
  if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);
  const loaded = loadBackupKey(path);
  assert.ok(!('error' in loaded));
  const all = c.out.join('\n');
  assert.ok(all.includes(path));
  if (!('error' in loaded)) assert.ok(all.includes(loaded.id));
  assert.ok(!all.includes(bytes.toString('hex')) && !all.includes(bytes.toString('base64')));
});

test('--create refuses an existing file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kn-bk-'));
  const path = join(dir, 'backup.key');
  assert.equal(runBackupKeyCli(['--create', path], io().io), 0);
  const before = readFileSync(path);
  const c = io();
  assert.equal(runBackupKeyCli(['--create', path], c.io), 1);
  assert.ok(readFileSync(path).equals(before));
  assert.equal(c.out.length, 0);
});

test('no arguments exits 2 and writes nothing', () => {
  const c = io();
  assert.equal(runBackupKeyCli([], c.io), 2);
  assert.equal(runBackupKeyCli(['--create'], c.io), 2);
  assert.equal(runBackupKeyCli(['--create', '--x'], c.io), 2);
  assert.ok(!existsSync('--x'));
});
