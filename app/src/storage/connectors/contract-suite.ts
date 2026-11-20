import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { StorageConnector } from '../connector';
import { quickXorHash } from '../quickxor';
import { StorageError, type DestinationRef, type PermissionInfo } from '../types';

export interface ContractHarness {
  connector: StorageConnector;
  dest: DestinationRef;
  seedPermission(itemId: string, p: Omit<PermissionInfo, 'id'>): Promise<string>;
  close(): Promise<void>;
  /** A second destination for the copyTo case; when absent the copy stays inside `dest`. */
  otherDest?: DestinationRef;
  /** Replaces the content of an existing file, creating a provider version. Without it the version case is skipped. */
  seedVersion?(itemId: string, bytes: Buffer): Promise<void>;
  /** An address lookupPerson resolves to an account, and one it reports not_found. */
  people?: { known: string; unknown: string };
}

async function rejectsWith(p: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(p, (e: unknown) => e instanceof StorageError && e.code === code);
}

/** Registers node:test cases; every connector (local, graph) runs the same suite. */
export function runContractSuite(name: string, make: () => Promise<ContractHarness>): void {
  const run = (title: string, fn: (h: ContractHarness) => Promise<void>) =>
    test(title, async () => {
      const h = await make();
      try { await fn(h); } finally { await h.close(); }
    });
  const people = (h: ContractHarness) => h.people ?? { known: 'known.person@example.org', unknown: 'unknown.person@example.org' };

  describe(`storage connector contract: ${name}`, () => {
    run('ensureFolder creates once and returns the same item for the same name', async (h) => {
      const a = await h.connector.ensureFolder(h.dest, null, 'Reports');
      const b = await h.connector.ensureFolder(h.dest, null, 'Reports');
      assert.equal(a.itemId, b.itemId);
      assert.equal(a.name, 'Reports');
      const child = await h.connector.ensureFolder(h.dest, a.itemId, 'Q1');
      assert.notEqual(child.itemId, a.itemId);
    });

    run('upload returns size and provider hash equal to quickXorHash', async (h) => {
      const f = await h.connector.ensureFolder(h.dest, null, 'Up');
      const bytes = Buffer.from('hello contract');
      const ref = await h.connector.upload(h.dest, f.itemId, 'a.txt', bytes, { conflict: 'fail' });
      assert.equal(ref.size, bytes.length);
      assert.equal(ref.providerHash, quickXorHash(bytes));
      assert.equal(ref.name, 'a.txt');
      assert.equal(ref.parentId, f.itemId);
    });

    run('upload with conflict fail rejects an existing name with code conflict', async (h) => {
      const f = await h.connector.ensureFolder(h.dest, null, 'Dup');
      await h.connector.upload(h.dest, f.itemId, 'a.txt', Buffer.from('one'), { conflict: 'fail' });
      await rejectsWith(h.connector.upload(h.dest, f.itemId, 'a.txt', Buffer.from('two'), { conflict: 'fail' }), 'conflict');
    });

    run('findChild returns null for a missing name', async (h) => {
      const f = await h.connector.ensureFolder(h.dest, null, 'Find');
      assert.equal(await h.connector.findChild(h.dest, f.itemId, 'nope.txt'), null);
      const ref = await h.connector.upload(h.dest, f.itemId, 'yes.txt', Buffer.from('x'), { conflict: 'fail' });
      assert.equal((await h.connector.findChild(h.dest, f.itemId, 'yes.txt'))?.itemId, ref.itemId);
    });

    run('getItem reflects move and rename with the same itemId', async (h) => {
      const f1 = await h.connector.ensureFolder(h.dest, null, 'From');
      const f2 = await h.connector.ensureFolder(h.dest, null, 'To');
      const ref = await h.connector.upload(h.dest, f1.itemId, 'old.txt', Buffer.from('m'), { conflict: 'fail' });
      const moved = await h.connector.move(h.dest, ref.itemId, f2.itemId, 'new.txt');
      assert.equal(moved.itemId, ref.itemId);
      const st = await h.connector.getItem(h.dest, ref.itemId);
      assert.equal(st.itemId, ref.itemId);
      assert.equal(st.name, 'new.txt');
      assert.equal(st.parentId, f2.itemId);
      assert.ok(st.path.endsWith('/To/new.txt'), st.path);
      assert.equal(await h.connector.findChild(h.dest, f1.itemId, 'old.txt'), null);
      await rejectsWith(h.connector.getItem(h.dest, 'no-such-item'), 'not_found');
    });

    run('download returns the exact bytes', async (h) => {
      const f = await h.connector.ensureFolder(h.dest, null, 'Dl');
      const bytes = Buffer.alloc(5000);
      for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 13) & 0xff;
      const ref = await h.connector.upload(h.dest, f.itemId, 'b.bin', bytes, { conflict: 'fail' });
      assert.ok((await h.connector.download(h.dest, ref.itemId)).equals(bytes));
    });

    run('copyTo across destinations preserves bytes', async (h) => {
      const f = await h.connector.ensureFolder(h.dest, null, 'CopySrc');
      const bytes = Buffer.from('copy me, exactly');
      const ref = await h.connector.upload(h.dest, f.itemId, 'c.txt', bytes, { conflict: 'fail' });
      const dst = h.otherDest ?? h.dest;
      const target = await h.connector.ensureFolder(dst, null, 'CopyDst');
      const copy = await h.connector.copyTo(h.dest, ref.itemId, dst, target.itemId, 'c-copy.txt');
      assert.notEqual(copy.itemId, ref.itemId);
      assert.equal(copy.size, bytes.length);
      assert.equal(copy.providerHash, quickXorHash(bytes));
      assert.ok((await h.connector.download(dst, copy.itemId)).equals(bytes));
      assert.ok((await h.connector.download(h.dest, ref.itemId)).equals(bytes), 'source untouched');
    });

    run('removePermanently leaves no version to restore', async (h) => {
      const f = await h.connector.ensureFolder(h.dest, null, 'Rm');
      const ref = await h.connector.upload(h.dest, f.itemId, 'r.txt', Buffer.from('v1'), { conflict: 'fail' });
      if (h.seedVersion) await h.seedVersion(ref.itemId, Buffer.from('v2'));
      const versions = await h.connector.listVersions(h.dest, ref.itemId);
      await h.connector.removePermanently(h.dest, ref.itemId);
      await rejectsWith(h.connector.getItem(h.dest, ref.itemId), 'not_found');
      await rejectsWith(h.connector.download(h.dest, ref.itemId), 'not_found');
      await rejectsWith(h.connector.listVersions(h.dest, ref.itemId), 'not_found');
      if (versions[0]) await rejectsWith(h.connector.restoreVersion(h.dest, ref.itemId, versions[0].id), 'not_found');
      assert.equal(await h.connector.findChild(h.dest, f.itemId, 'r.txt'), null);
    });

    run('listVersions and restoreVersion bring back earlier content', async (h) => {
      if (!h.seedVersion) return; // contract case needs a way to create a second version
      const f = await h.connector.ensureFolder(h.dest, null, 'Ver');
      const v1 = Buffer.from('first content');
      const v2 = Buffer.from('second, longer content');
      const ref = await h.connector.upload(h.dest, f.itemId, 'v.txt', v1, { conflict: 'fail' });
      await h.seedVersion(ref.itemId, v2);
      assert.ok((await h.connector.download(h.dest, ref.itemId)).equals(v2));
      const versions = await h.connector.listVersions(h.dest, ref.itemId);
      assert.ok(versions.length >= 2, 'at least current and earlier version');
      const earlier = versions.find((v) => v.size === v1.length && v.providerHash === quickXorHash(v1));
      assert.ok(earlier, 'earlier version listed with size and hash');
      await h.connector.restoreVersion(h.dest, ref.itemId, earlier.id);
      assert.ok((await h.connector.download(h.dest, ref.itemId)).equals(v1));
    });

    run('grant on a folder returns a permission id and listPermissions shows it', async (h) => {
      const f = await h.connector.ensureFolder(h.dest, null, 'Share');
      const p = people(h);
      const r = await h.connector.grant(h.dest, f.itemId, p.known, 'read');
      assert.ok('permissionId' in r, 'granted');
      if (!('permissionId' in r)) return;
      const perms = await h.connector.listPermissions(h.dest, f.itemId);
      const mine = perms.find((x) => x.id === r.permissionId);
      assert.ok(mine);
      assert.deepEqual(mine.roles, ['read']);
      assert.equal(mine.principal.toLowerCase(), p.known.toLowerCase());
      const none = await h.connector.grant(h.dest, f.itemId, p.unknown, 'read');
      assert.deepEqual(none, { notFound: true });
    });

    run('revoke removes only that permission', async (h) => {
      const f = await h.connector.ensureFolder(h.dest, null, 'Revoke');
      const owner = await h.seedPermission(f.itemId, { kind: 'owner_group', principal: 'Owners', roles: ['owner'] });
      const group = await h.seedPermission(f.itemId, { kind: 'group', principal: 'Team', roles: ['write'] });
      const r = await h.connector.grant(h.dest, f.itemId, people(h).known, 'write');
      assert.ok('permissionId' in r);
      if (!('permissionId' in r)) return;
      await h.connector.revoke(h.dest, f.itemId, r.permissionId);
      const ids = (await h.connector.listPermissions(h.dest, f.itemId)).map((x) => x.id);
      assert.ok(!ids.includes(r.permissionId));
      assert.ok(ids.includes(owner));
      assert.ok(ids.includes(group));
    });

    run('lookupPerson returns not_found for an unknown address', async (h) => {
      assert.equal(await h.connector.lookupPerson(people(h).unknown), 'not_found');
    });
  });
}
