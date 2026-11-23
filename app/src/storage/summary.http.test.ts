import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { uuidv7 } from '../common/uuid7';
import { CLOSING_KEYS } from '../golive/checklist';
import { SKIP_NO_DB } from '../testing/db';
import { type FakeGraph, startFakeGraph } from '../testing/fake-graph';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedProject, seedUser } from '../testing/projects';
import { keyFile } from '../testing/ai-connections';
import { StorageSettingsService } from './settings.service';

const reason = 'Setting up storage';
const step = (body: any, key: string) => body.steps.find((s: any) => s.key === key);

describe('go-live storage step and storage summary', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let dir: string;
  let admin: Client;
  let adminId: string;
  let otherId: string;
  let fake: FakeGraph | undefined;
  const q = async (sql: string, params: unknown[] = []) => (await t.pool.query(sql, params)).rows;
  const goLive = async () => (await admin.request('GET', '/go-live')).body;
  const connect = async () => {
    fake = await startFakeGraph();
    t.app.get(StorageSettingsService).fetchFn = fake.fetch;
    assert.equal((await admin.request('PUT', '/admin/storage', { reason, tenantId: 'tenant-1', clientId: 'client-1' })).status, 200);
    assert.equal((await admin.request('POST', '/admin/storage/secret', { reason, clientSecret: 'client-secret-test-value-AAAA-0123456789' })).status, 200);
  };
  const sourceArea = async (lastCheck: unknown = null) => {
    const id = uuidv7();
    await t.pool.query(
      `INSERT INTO storage_destinations (id, connector, kind, purpose, label, status, last_check, created_by, created_at)
       VALUES ($1, 'local', 'local', 'source_area', 'Source area library', 'approved', $2, $3, now())`,
      [id, lastCheck === null ? null : JSON.stringify(lastCheck), adminId],
    );
    return id;
  };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'kainow-summary-'));
    t = await startTestApp(undefined, { protectedKeyFile: keyFile(dir) });
    adminId = await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    otherId = await seedUser(t.pool, 'member@example.org');
    admin = await t.signIn('admin@example.org');
  });
  afterEach(async () => {
    await fake?.close();
    fake = undefined;
    await t?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('go-live storage step auto-ticks when the connection checks and a source area is approved', async () => {
    assert.equal(step(await goLive(), 'storage').done, false);
    await connect();
    await sourceArea();
    // saved but not yet checked: not ticked
    assert.equal(step(await goLive(), 'storage').done, false);
    assert.deepEqual((await admin.request('POST', '/admin/storage/check')).body, { state: 'connected' });
    const done = step(await goLive(), 'storage');
    assert.deepEqual([done.done, done.tickedBy, done.canUntick], [true, 'kainow', false]);
    assert.equal(done.text, 'Connect storage and approve the source area');
    // a changed connection must be checked again
    await admin.request('PUT', '/admin/storage', { reason, clientId: 'client-2' });
    assert.equal((await q(`SELECT last_check_state FROM storage_settings`))[0].last_check_state, null);
  });

  test('a failing check or a missing source area does not tick the step', async () => {
    await connect();
    assert.equal((await admin.request('POST', '/admin/storage/check')).body.state, 'connected');
    assert.equal(step(await goLive(), 'storage').done, false, 'no source area');
    await sourceArea();
    fake!.fault({ method: 'POST', pathIncludes: 'oauth2' }, '401');
    assert.equal((await admin.request('POST', '/admin/storage/check')).body.state, 'refused');
    assert.equal(step(await goLive(), 'storage').done, false, 'last check refused');
  });

  test('the step can be skipped with a note and is not a closing key', async () => {
    const skipped = await admin.request('POST', '/go-live/steps/storage/skip', { note: 'Later' });
    assert.equal(skipped.status, 200, JSON.stringify(skipped.body));
    const s = step(skipped.body, 'storage');
    assert.deepEqual([s.done, s.skipped, s.note], [true, true, 'Later']);
    assert.equal(skipped.body.steps.length, 13); // 10b added the updater step
    // Optional (auto_or_skip) steps never hold the checklist open; every other step does (review G01), the updater too.
    assert.ok(!CLOSING_KEYS.includes('storage'));
    assert.deepEqual([...CLOSING_KEYS], ['organisation', 'second_admin', 'recovery', 'mailbox', 'test_email', 'calendar', 'backups', 'department', 'users', 'project', 'updates']);
  });

  test('skip route refuses steps that cannot be skipped and an automatic tick', async () => {
    assert.equal((await admin.request('POST', '/go-live/steps/department/skip', {})).status, 404);
    assert.equal((await admin.request('POST', '/go-live/steps/mailbox/skip', {})).status, 404);
    await connect();
    await sourceArea();
    await admin.request('POST', '/admin/storage/check');
    assert.equal(step(await goLive(), 'storage').done, true);
    assert.equal((await admin.request('POST', '/go-live/steps/storage/skip', {})).status, 409);
  });

  test('the recorded check is cleared by a new secret and by a tenant change', async () => {
    await connect();
    const state = async () => (await admin.request('GET', '/admin/storage/summary')).body.connection;
    await admin.request('POST', '/admin/storage/check');
    assert.equal(await state(), 'connected');
    await admin.request('POST', '/admin/storage/secret', { reason, clientSecret: 'client-secret-test-value-BBBB-0123456789' });
    assert.equal(await state(), 'not_checked');
    await admin.request('POST', '/admin/storage/check');
    assert.equal(await state(), 'connected');
    await admin.request('PUT', '/admin/storage', { reason, tenantId: 'tenant-2' });
    assert.equal(await state(), 'not_checked');
  });

  test('a credentials change during a check is not overwritten by the stale result', async () => {
    await connect();
    const svc = t.app.get(StorageSettingsService);
    const real = fake!.fetch;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    let reached: () => void = () => undefined;
    const atToken = new Promise<void>((r) => { reached = r; });
    svc.fetchFn = (async (input: any, init?: any) => {
      if (String(input).includes('oauth2')) {
        reached();
        await gate;
      }
      return real(input, init);
    }) as typeof fetch;
    const checking = svc.check();
    await atToken;
    await admin.request('POST', '/admin/storage/secret', { reason, clientSecret: 'client-secret-test-value-BBBB-0123456789' });
    release();
    await checking;
    assert.equal((await q(`SELECT last_check_state FROM storage_settings`))[0].last_check_state, null);
  });

  test('summary is for Enterprise Administrators only', async () => {
    const member = await t.signIn('member@example.org');
    assert.equal((await member.request('GET', '/admin/storage/summary')).status, 403);
    assert.equal((await t.anonymous('GET', '/admin/storage/summary')).status, 401);
  });

  test('summary counts and quota Unavailable', async () => {
    const empty = (await admin.request('GET', '/admin/storage/summary')).body;
    assert.deepEqual([empty.connection, empty.waiting, empty.failed, empty.withheld, empty.sourceArea.quotaBytes, empty.scheduledChecks], ['not_configured', 0, 0, 0, null, false]);

    await connect();
    assert.equal((await admin.request('GET', '/admin/storage/summary')).body.connection, 'not_checked');
    await admin.request('POST', '/admin/storage/check');
    const dest = await sourceArea({ ok: true, lines: [], quotaBytes: null, usedBytes: null, others: [], sourceAreaWarning: 'Others can open the source area' });
    const project = await seedProject(t.pool, { members: [{ userId: adminId, role: 'pm' }] as any, name: 'Zeta project' });
    const file = (purpose: string, state: string, size: number, inDest = true) =>
      t.pool.query(
        `INSERT INTO stored_files (id, purpose, project_id, destination_id, name, size_bytes, state, created_at) VALUES ($1, $2, $3, $4, 'f.pdf', $5, $6, now())`,
        [uuidv7(), purpose, project, inDest ? dest : null, size, state],
      );
    await file('source_original', 'stored', 100);
    await file('source_text', 'stored', 50);
    await file('source_original', 'pending', 7, false);
    await file('source_original', 'storing', 7, false);
    await file('output', 'failed', 9, false);
    await file('output', 'withheld', 9);
    await t.pool.query(`UPDATE storage_settings SET scheduled_checks = true`);
    await q(`INSERT INTO storage_admins (id, user_id, designated_by, designated_at, reason) VALUES ($1, $2, $3, now(), 'Needed')`, [uuidv7(), otherId, adminId]);

    const s = (await admin.request('GET', '/admin/storage/summary')).body;
    assert.equal(s.connection, 'connected');
    assert.equal(s.protectedKeyMissing, false);
    assert.deepEqual([s.waiting, s.failed, s.withheld], [2, 1, 1]);
    assert.deepEqual(s.sourceArea, { files: 2, bytes: 150, quotaBytes: null, warning: 'Others can open the source area' });
    assert.equal(s.destinations.length, 1);
    const expectedName = (await q(`SELECT display_name FROM users WHERE id = $1`, [otherId]))[0].display_name;
    assert.deepEqual(s.storageAdmins.map((a: any) => a.name), [expectedName]);
    assert.equal(s.scheduledChecks, true);
    assert.equal(s.sourceAreaMove, null);
    assert.deepEqual(s.byPurpose.map((p: any) => p.purpose), ['source_original', 'source_text', 'output']);

    await t.pool.query(`UPDATE storage_destinations SET last_check = jsonb_set(last_check, '{quotaBytes}', '5000')`);
    assert.equal((await admin.request('GET', '/admin/storage/summary')).body.sourceArea.quotaBytes, 5000);
  });

  test('sharing to repair labels source rows Source area and orders projects first', async () => {
    const dest = await sourceArea();
    const project = await seedProject(t.pool, { members: [{ userId: adminId, role: 'pm' }] as any, name: 'Alpha project' });
    const folder = async (level: string, key: string) => {
      const id = uuidv7();
      await t.pool.query(`INSERT INTO storage_folders (id, destination_id, level, key, item_id, name, created_at) VALUES ($1, $2, $3, $4, $5, 'F', now())`, [id, dest, level, key, `item-${id}`]);
      return id;
    };
    const grant = async (folderId: string, userId: string, state: string) =>
      t.pool.query(`INSERT INTO storage_grants (id, folder_id, user_id, role, state, updated_at) VALUES ($1, $2, $3, 'read', $4, now())`, [uuidv7(), folderId, userId, state]);
    await grant(await folder('source_root', 'projects'), adminId, 'failed');
    await grant(await folder('project', `dept/${project}`), otherId, 'revoking');
    const s = (await admin.request('GET', '/admin/storage/summary')).body;
    assert.deepEqual(s.sharingToRepair.map((r: any) => [r.project, r.kind, r.state]), [
      ['Alpha project', 'access', 'revoking'],
      ['Source area', 'access', 'failed'],
    ]);
  });
});

describe('storage summary without the protected key', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  afterEach(async () => {
    await t?.close();
  });

  test('the summary says the protected key is missing and counts unsent jobs', async () => {
    t = await startTestApp();
    await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    const admin = await t.signIn('admin@example.org');
    await t.pool.query(`INSERT INTO storage_outbox (id, job, subject_id, created_at) VALUES ($1, 'store-file', $2, now())`, [uuidv7(), uuidv7()]);
    const s = (await admin.request('GET', '/admin/storage/summary')).body;
    assert.equal(s.protectedKeyMissing, true);
    assert.equal(s.queuedJobs, 1);
  });
});
