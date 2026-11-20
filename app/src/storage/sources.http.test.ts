import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { uuidv7 } from '../common/uuid7';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedProject, seedUser } from '../testing/projects';
import type { StorageConnectorFactory } from './connector-factory';
import { LocalConnector } from './connectors/local';
import { type StorageDeps, onFinalFailure } from './jobs';
import { storeSourceVersion } from './sources';

describe('managed source area over HTTP', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let dir: string;
  let local: LocalConnector;
  const ids: Record<string, string> = {};
  const c: Record<string, Client> = {};
  let project: string;
  const factory: StorageConnectorFactory = {
    forDestination: async (id) => ({ connector: local, dest: { id, connector: 'local', driveId: 'drive1', rootItemId: 'root' } }),
    forNew: async () => local,
  };
  const deps = (): StorageDeps => ({ pool: t.pool, connectors: factory, key: null, clock: t.clock.now, notify: async () => undefined });
  const rows = async (sql: string, params: unknown[] = []) => (await t.pool.query(sql, params)).rows;
  /** The stored files of every version of a source: [version no, purpose, name, state]. */
  const filesOfSource = async (sourceId: string) =>
    (
      await rows(
        `SELECT v.version_no, v.origin, f.purpose, f.name, f.state FROM source_versions v
           JOIN stored_files f ON f.id IN (v.original_stored_file_id, v.text_stored_file_id)
          WHERE v.source_id = $1 ORDER BY v.version_no, f.purpose`,
        [sourceId],
      )
    ).map((r) => [r.version_no, r.origin, r.purpose, r.name, r.state]);

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'kainow-sources-http-'));
    local = new LocalConnector(dir);
    t = await startTestApp(undefined, { storageConnectors: factory });
    for (const k of ['pm', 'deputy', 'owner', 'sponsor', 'ada']) ids[k] = await seedUser(t.pool, `${k}@example.org`);
    project = await seedProject(t.pool, {
      name: 'Alpha Project',
      status: 'active',
      members: [
        { userId: ids.pm, role: 'pm' },
        { userId: ids.deputy, role: 'deputy_pm' },
        { userId: ids.owner, role: 'owner' },
        { userId: ids.sponsor, role: 'sponsor' },
        { userId: ids.ada, role: 'member' },
      ],
    });
    for (const k of Object.keys(ids)) c[k] = await t.signIn(`${k}@example.org`);
    await t.pool.query(
      `INSERT INTO storage_destinations (id, connector, kind, purpose, label, drive_id, root_item_id, status, created_by, created_at)
       VALUES ($1, 'local', 'local', 'source_area', 'Sources', 'drive1', 'root', 'approved', $2, now())`,
      [uuidv7(), ids.pm],
    );
  });
  afterEach(async () => {
    await t?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('storage state shows Stored, Waiting to store, Storage failed to PM, Deputy, Owner and Sponsor only', async () => {
    const created = await c.pm.request('POST', `/projects/${project}/notes`, { title: 'Pump notes', text: 'First text.' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const sourceId = created.body.source.id as string;
    await c.pm.request('POST', `/notes/${sourceId}/versions`, { text: 'Second text.' });
    const v3 = await c.pm.request('POST', `/notes/${sourceId}/versions`, { text: 'Third text.' });
    await storeSourceVersion(deps(), created.body.version.id);
    await onFinalFailure(deps(), 'store-source', v3.body.version.id, 'forbidden');

    for (const k of ['pm', 'deputy', 'owner', 'sponsor']) {
      const r = await c[k].request('GET', `/notes/${sourceId}`);
      assert.equal(r.status, 200, `${k}: ${JSON.stringify(r.body)}`);
      assert.deepEqual(r.body.versions.map((v: { storage: string }) => v.storage), ['stored', 'waiting', 'failed'], k);
      const one = await c[k].request('GET', `/notes/${sourceId}/versions/3`);
      assert.equal(one.body.version.storage, 'failed', k);
    }
    const member = await c.ada.request('GET', `/notes/${sourceId}`);
    assert.equal(member.status, 200);
    assert.deepEqual(member.body.versions.map((v: { storage: unknown }) => v.storage ?? null), [null, null, null], 'a member sees no storage state');
    assert.equal((await c.ada.request('GET', `/notes/${sourceId}/versions/1`)).body.version.storage ?? null, null);
  });

  test('minutes publication, meeting publication and approved summaries store text.txt', async () => {
    // Minutes published by the PM from a meeting's draft.
    const meeting = await c.pm.request('POST', `/projects/${project}/threads`, { kind: 'meeting', title: 'Weekly check-in' });
    assert.equal(meeting.status, 201, JSON.stringify(meeting.body));
    assert.equal((await c.pm.request('POST', `/threads/${meeting.body.id}/minutes`, { body: 'Agreed to ship.', basedOnVersion: 0 })).status, 201);
    const published = await c.pm.request('POST', `/threads/${meeting.body.id}/minutes/1/publish`);
    assert.equal(published.status, 200, JSON.stringify(published.body));
    assert.deepEqual(await filesOfSource(published.body.sourceId), [[1, 'meeting', 'source_text', 'text.txt', 'pending']]);

    // A member's meeting minutes, submitted from the meeting and published by a reviewer.
    const own = await c.ada.request('POST', `/projects/${project}/threads`, { kind: 'meeting', title: 'Site walk' });
    assert.equal((await c.ada.request('POST', `/threads/${own.body.id}/minutes`, { body: 'Walked the site.', basedOnVersion: 0 })).status, 201);
    const submitted = await c.ada.request('POST', `/threads/${own.body.id}/minutes/1/submit`);
    assert.equal(submitted.status, 201, JSON.stringify(submitted.body));
    assert.equal((await c.pm.request('POST', `/notes/${submitted.body.id}/publish`, { mode: 'project' })).status, 200);
    assert.deepEqual(await filesOfSource(submitted.body.id), [[1, 'meeting', 'source_text', 'text.txt', 'pending']]);

    // An approved shareable summary of a note.
    const note = await c.pm.request('POST', `/projects/${project}/notes`, { title: 'Board note', text: 'The turbine replacement goes ahead next month.' });
    const summaryId = uuidv7();
    await t.pool.query(
      `INSERT INTO summaries (id, project_id, original_source_id, intended_audience, created_by, created_at) VALUES ($1, $2, $3, '{"mode":"project","namedUserIds":[]}', $4, now())`,
      [summaryId, project, note.body.source.id, ids.pm],
    );
    await t.pool.query(
      `INSERT INTO summary_versions (id, summary_id, version_no, origin, body, created_by, created_at) VALUES ($1, $2, 1, 'human', 'The turbine is replaced next month.', $3, now())`,
      [uuidv7(), summaryId, ids.pm],
    );
    const approved = await c.pm.request('POST', `/summaries/${summaryId}/approve`, { versionNo: 1, reason: 'Fine to share' });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.deepEqual(await filesOfSource(approved.body.approved.sourceId), [[1, 'summary', 'source_text', 'text.txt', 'pending']]);

    // Each is stored as text.txt alone.
    const versions = await rows(
      `SELECT v.id FROM source_versions v JOIN sources s ON s.id = v.source_id WHERE s.kind IN ('minutes', 'summary') ORDER BY v.created_at, v.id`,
    );
    assert.equal(versions.length, 3);
    for (const v of versions) await storeSourceVersion(deps(), v.id);
    const stored = await rows(
      `SELECT f.name, f.state, f.path FROM source_versions v JOIN sources s ON s.id = v.source_id JOIN stored_files f ON f.id = v.text_stored_file_id
        WHERE s.kind IN ('minutes', 'summary') ORDER BY f.path`,
    );
    assert.equal(stored.length, 3);
    for (const f of stored) {
      assert.equal(f.state, 'stored');
      assert.match(f.path, new RegExp(`^/projects/${project}/sources/[0-9a-f-]+/v1/text\\.txt$`));
    }
  });
});
