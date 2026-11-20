import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalConnector } from './local';
import { runContractSuite } from './contract-suite';
import { StorageError, type DestinationRef } from '../types';

const dest: DestinationRef = { id: 'dest-a', connector: 'local', driveId: 'drive-a', rootItemId: 'root-a' };
const other: DestinationRef = { id: 'dest-b', connector: 'local', driveId: 'drive-b', rootItemId: 'root-b' };
const people = { known: 'known.person@example.org', unknown: 'unknown.person@example.org' };

runContractSuite('local', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kainow-local-'));
  const connector = new LocalConnector(dir, { lookup: { [people.known]: 'account', [people.unknown]: 'not_found' } });
  return {
    connector, dest, otherDest: other, people,
    seedPermission: async (itemId, p) => connector.seedPermission(dest, itemId, p),
    seedVersion: async (itemId, bytes) => connector.overwrite(dest, itemId, bytes),
    close: async () => { await rm(dir, { recursive: true, force: true }); },
  };
});

test('local connector keeps item ids and grants across a restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kainow-local-'));
  try {
    const a = new LocalConnector(dir, { lookup: { [people.known]: 'account' } });
    const f = await a.ensureFolder(dest, null, 'Persist');
    const ref = await a.upload(dest, f.itemId, 'p.txt', Buffer.from('keep'), { conflict: 'fail' });
    const g = await a.grant(dest, f.itemId, people.known, 'read');
    const b = new LocalConnector(dir, { lookup: { [people.known]: 'account' } });
    assert.equal((await b.ensureFolder(dest, null, 'Persist')).itemId, f.itemId);
    assert.equal((await b.getItem(dest, ref.itemId)).itemId, ref.itemId);
    assert.ok('permissionId' in g);
    assert.equal((await b.listPermissions(dest, f.itemId)).length, 1);
    const side = JSON.parse(await readFile(join(dir, 'permissions.json'), 'utf8')) as Record<string, Array<{ id: string }>>;
    assert.ok('permissionId' in g && side[f.itemId].some((p) => p.id === g.permissionId));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('local connector removePermanently deletes the file and its versions from disk', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kainow-local-'));
  try {
    const c = new LocalConnector(dir);
    const f = await c.ensureFolder(dest, null, 'Disk');
    const ref = await c.upload(dest, f.itemId, 'd.txt', Buffer.from('one'), { conflict: 'fail' });
    await c.overwrite(dest, ref.itemId, Buffer.from('two'));
    assert.ok(existsSync(join(dir, dest.driveId, 'versions', ref.itemId)));
    await c.removePermanently(dest, ref.itemId);
    assert.ok(!existsSync(join(dir, dest.driveId, 'files', ref.itemId)));
    assert.ok(!existsSync(join(dir, dest.driveId, 'versions', ref.itemId)));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('local connector refuses grants on files and unsafe names', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kainow-local-'));
  try {
    const c = new LocalConnector(dir, { lookup: { [people.known]: 'account' } });
    const f = await c.ensureFolder(dest, null, 'Safe');
    const ref = await c.upload(dest, f.itemId, 'x.txt', Buffer.from('x'), { conflict: 'fail' });
    await assert.rejects(c.grant(dest, ref.itemId, people.known, 'read'), (e: unknown) => e instanceof StorageError && e.code === 'invalid');
    await assert.rejects(c.ensureFolder(dest, null, '../escape'), (e: unknown) => e instanceof StorageError && e.code === 'invalid');
    await assert.rejects(c.getItem(other, ref.itemId), (e: unknown) => e instanceof StorageError && e.code === 'not_found');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('local connector resolveLink round-trips a web URL', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kainow-local-'));
  try {
    const c = new LocalConnector(dir);
    const f = await c.ensureFolder(dest, null, 'Links');
    const ref = await c.upload(dest, f.itemId, 'l.txt', Buffer.from('x'), { conflict: 'fail' });
    assert.ok(ref.webUrl);
    const r = await c.resolveLink(ref.webUrl);
    assert.equal(r.item.itemId, ref.itemId);
    await assert.rejects(c.resolveLink('https://example.org/nope'), (e: unknown) => e instanceof StorageError && e.code === 'invalid');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('local connector checkDestination creates and removes a permission only with a test person', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kainow-local-'));
  try {
    const c = new LocalConnector(dir, { lookup: { [people.known]: 'account' } });
    const chk = await c.checkDestination(dest, { testPerson: people.known });
    assert.equal(chk.ok, true, JSON.stringify(chk.lines));
    assert.equal(chk.lines.find((l) => l.key === 'permissions')?.ok, true);
    const folder = await c.ensureFolder(dest, null, '.kainow-check');
    assert.deepEqual(await c.listPermissions(dest, folder.itemId), [], 'test grant revoked');
    const none = await c.checkDestination(dest);
    assert.equal(none.ok, false);
    assert.deepEqual(none.lines.find((l) => l.key === 'permissions'),
      { key: 'permissions', ok: false, detail: 'Creating permissions was not checked: no test person given' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
