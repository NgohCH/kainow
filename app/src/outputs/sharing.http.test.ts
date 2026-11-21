import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { uuidv7 } from '../common/uuid7';
import { M365TokenSource } from '../email/m365-token';
import type { StorageConnectorFactory } from '../storage/connector-factory';
import { GraphConnector } from '../storage/connectors/graph';
import { type StorageDeps, type StorageJob, onFinalFailure, storageHandler } from '../storage/jobs';
import { makeStorageNotify } from '../storage/notices';
import { type DestinationRef, StorageError } from '../storage/types';
import { SKIP_NO_DB } from '../testing/db';
import { type FakeGraph, startFakeGraph } from '../testing/fake-graph';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedDepartment, seedProject, seedUser } from '../testing/projects';
import { fileOutputVersion } from './filing';
import { placeOutput, queueOutputPlacement, reconcileSharing, sharingToRepair, syncFolderGrants } from './sharing';

const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';
const APP_ID = '11111111-2222-4333-8444-555555555555';
const PROJECT = 'Pump station renewal';

function multipart(fields: Record<string, string>, file: { name: string; bytes: Buffer }): { body: Buffer; type: string } {
  const b = 'sharingboundary42';
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`), file.bytes, Buffer.from(`\r\n--${b}--\r\n`));
  return { body: Buffer.concat(parts), type: `multipart/form-data; boundary=${b}` };
}

describe('folder sharing kept in step with readers', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let fake: FakeGraph;
  let connector: GraphConnector;
  let drive: { driveId: string; rootItemId: string };
  let destId: string;
  let dept: string;
  let project: string;
  const ids: Record<string, string> = {};
  const c: Record<string, Client> = {};
  /** When set, every connector request fails as the destination would when unavailable (no key, unreadable secret, withdrawn). */
  let destinationDown: StorageError | null = null;
  const factory: StorageConnectorFactory = {
    forDestination: async (id) => {
      if (destinationDown) throw destinationDown;
      return { connector, dest: { id, connector: 'graph', driveId: drive.driveId, rootItemId: drive.rootItemId } };
    },
    forNew: async () => connector,
  };
  const dest = (): DestinationRef => ({ id: destId, connector: 'graph', driveId: drive.driveId, rootItemId: drive.rootItemId });
  const deps = (): StorageDeps => ({ pool: t.pool, connectors: factory, key: null, clock: t.clock.now, notify: makeStorageNotify(t.pool, t.clock.now) });
  const rows = async (sql: string, params: unknown[] = []) => (await t.pool.query(sql, params)).rows;
  const typeId = async (name: string) => (await rows(`SELECT id FROM report_types WHERE name = $1`, [name]))[0].id as string;
  const url = (p = '') => `/projects/${project}/outputs${p}`;
  const graphConnector = (lookup: boolean) => {
    const tokens = new M365TokenSource({ tenantId: 'test-tenant', clientId: 'client-1', clientSecret: 'test-secret-value' }, fake.fetch, undefined, undefined, GRAPH_SCOPE);
    return new GraphConnector(tokens, { fetchFn: fake.fetch, graphBase: fake.graphBase, lookup, allowedDomains: async () => ['example.org'], appClientId: APP_ID });
  };

  async function registered(title: string, restrictTo?: string[]): Promise<string> {
    const m = multipart({ title }, { name: 'report.md', bytes: Buffer.from(`# ${title}\n\nThe valve audit is on Friday.\n`) });
    const sub = await c.pm.upload('POST', url(), m.body, m.type);
    assert.equal(sub.status, 201, JSON.stringify(sub.body));
    const body: Record<string, unknown> = { reportTypeId: await typeId('Status reports'), issueDate: '2026-11-09' };
    if (restrictTo) body.audience = { mode: 'restricted', namedUserIds: restrictTo };
    const reg = await c.pm.request('POST', url(`/${sub.body.id}/register`), body);
    assert.equal(reg.status, 200, JSON.stringify(reg.body));
    return sub.body.id;
  }
  const fileRow = async (outputId: string) =>
    (await rows(`SELECT f.* FROM output_versions v JOIN stored_files f ON f.id = v.stored_file_id WHERE v.output_id = $1 AND v.version_no = 1`, [outputId]))[0];
  /** Files version 1 and runs the queued storage work. */
  async function filed(outputId: string): Promise<Record<string, any>> {
    const r = await c.pm.request('POST', url(`/${outputId}/versions/1/file`));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await drain();
    const f = await fileRow(outputId);
    assert.equal(f.state, 'stored');
    return f;
  }

  /**
   * Runs the queued storage work as the worker would: unsent outbox rows, urgent first, until none are left. Returns
   * what ran, with the error code of each that failed.
   */
  async function drain(): Promise<Array<{ job: StorageJob; subjectId: string; urgent: boolean; failed?: string }>> {
    const ran: Array<{ job: StorageJob; subjectId: string; urgent: boolean; failed?: string }> = [];
    for (let i = 0; i < 100; i++) {
      const next = (
        await rows(`UPDATE storage_outbox SET sent_at = now() WHERE id = (SELECT id FROM storage_outbox WHERE sent_at IS NULL ORDER BY urgent DESC, created_at, id LIMIT 1) RETURNING job, subject_id, urgent`)
      )[0];
      if (!next) return ran;
      const entry: { job: StorageJob; subjectId: string; urgent: boolean; failed?: string } = { job: next.job, subjectId: next.subject_id, urgent: next.urgent };
      try {
        await storageHandler(next.job)!(deps(), next.subject_id, 1);
      } catch (err) {
        entry.failed = (err as { code?: string }).code ?? 'internal';
      }
      ran.push(entry);
    }
    throw new Error('the outbox did not drain');
  }

  const folder = async (level: string, key: string) => (await rows(`SELECT id, item_id FROM storage_folders WHERE level = $1 AND key = $2`, [level, key]))[0] as { id: string; item_id: string };
  const projectFolder = () => folder('project', `${dept}/${project}`);
  const outputFolder = (outputId: string) => folder('output', `${dept}/${project}/output/${outputId}`);
  /** The Kainow grants on a folder, by state, as sorted emails. */
  async function granted(folderId: string, state = 'granted'): Promise<string[]> {
    return (await rows(`SELECT u.email FROM storage_grants g JOIN users u ON u.id = g.user_id WHERE g.folder_id = $1 AND g.state = $2 ORDER BY u.email`, [folderId, state])).map((r) => r.email);
  }
  /** The people the provider shows as granted on an item. */
  async function sharedWith(itemId: string): Promise<string[]> {
    return (await connector.listPermissions(dest(), itemId)).filter((p) => p.kind === 'user').map((p) => p.principal).sort();
  }
  const parentOf = async (itemId: string) => (await connector.getItem(dest(), itemId)).parentId;
  /** Puts the output's audience to these people (or Project-wide), as the audience change of a later task records it. */
  async function setAudience(outputId: string, people: string[] | null, direction: 'narrow' | 'widen'): Promise<void> {
    const cl = await t.pool.connect();
    try {
      await cl.query('BEGIN');
      if (people) {
        const a = uuidv7();
        await cl.query(`INSERT INTO audiences (id, project_id, mode, created_at) VALUES ($1, $2, 'restricted', now())`, [a, project]);
        for (const p of people) await cl.query(`INSERT INTO audience_members (audience_id, user_id, added_by, added_at) VALUES ($1, $2, $3, now())`, [a, p, ids.pm]);
        await cl.query(`UPDATE outputs SET audience_id = $2 WHERE id = $1`, [outputId, a]);
      } else {
        await cl.query(`UPDATE outputs SET audience_id = NULL WHERE id = $1`, [outputId]);
      }
      await queueOutputPlacement(cl, outputId, direction);
      await cl.query('COMMIT');
    } finally {
      cl.release();
    }
  }
  const PROJECT_READERS = ['ada@example.org', 'aud@example.org', 'deputy@example.org', 'owner@example.org', 'pm@example.org', 'sponsor@example.org'];

  beforeEach(async () => {
    destinationDown = null;
    fake = await startFakeGraph();
    connector = graphConnector(true);
    drive = fake.addDrive();
    t = await startTestApp(undefined, { storageConnectors: factory });
    ids.admin = await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    for (const k of ['pm', 'deputy', 'owner', 'sponsor', 'ada', 'sam', 'hal', 'eve', 'rex', 'aud', 'old', 'lea', 'kim']) {
      ids[k] = await seedUser(t.pool, `${k}@example.org`);
      fake.addUser(`${k}@example.org`);
    }
    dept = await seedDepartment(t.pool, 'Water Services');
    project = await seedProject(t.pool, {
      status: 'active',
      name: PROJECT,
      departmentId: dept,
      members: [
        { userId: ids.pm, role: 'pm' },
        { userId: ids.deputy, role: 'deputy_pm' },
        { userId: ids.owner, role: 'owner' },
        { userId: ids.sponsor, role: 'sponsor' },
        { userId: ids.ada, role: 'member' },
        { userId: ids.sam, role: 'member', startsOn: '2026-12-01' }, // Scheduled
        { userId: ids.hal, role: 'member' }, // put On Hold below
        { userId: ids.eve, role: 'member', expiresOn: '2026-11-05' }, // Expired
        { userId: ids.rex, role: 'member', revoked: true }, // Revoked
      ],
    });
    await t.pool.query(`UPDATE memberships SET held_at = '2026-11-05T02:00:00Z', held_by = $2, hold_reason = 'Investigation' WHERE user_id = $1`, [ids.hal, ids.pm]);
    const grant = async (userId: string, startsOn: string, expiresOn: string) =>
      t.pool.query(
        `INSERT INTO access_grants (id, project_id, user_id, kind, purpose, scope, starts_on, expires_on, requested_by, requested_at, decision, decided_by, decided_at)
         VALUES ($1, $2, $3, 'audit', 'Annual audit', 'All records', $4, $5, $6, now(), 'approved', $7, now())`,
        [uuidv7(), project, userId, startsOn, expiresOn, ids.owner, ids.sponsor],
      );
    await grant(ids.aud, '2026-11-01', '2026-12-31'); // Active Audit grant
    await grant(ids.old, '2026-10-01', '2026-11-05'); // ended
    await t.pool.query(
      `INSERT INTO leadership_grants (id, user_id, scope_kind, starts_on, reason, granted_by, granted_at) VALUES ($1, $2, 'organisation', '2026-11-01', 'Board', $3, now())`,
      [uuidv7(), ids.lea, ids.admin],
    );
    destId = uuidv7();
    await t.pool.query(
      `INSERT INTO storage_destinations (id, connector, kind, purpose, label, drive_id, root_item_id, status, created_by, created_at)
       VALUES ($1, 'graph', 'sharepoint_library', 'outputs', 'Outputs library', $2, $3, 'approved', $4, now())`,
      [destId, drive.driveId, drive.rootItemId, ids.admin],
    );
    await t.pool.query(`INSERT INTO project_output_settings (project_id, destination_id) VALUES ($1, $2)`, [project, destId]);
    await t.pool.query(`INSERT INTO eligible_domains (id, domain, added_by, added_at) VALUES ($1, 'example.org', $2, now())`, [uuidv7(), ids.admin]);
    for (const k of ['admin', 'pm', 'deputy', 'owner', 'sponsor', 'ada']) c[k] = await t.signIn(`${k}@example.org`);
  });
  afterEach(async () => {
    await t?.close();
    await fake?.close();
  });

  test("the project folder is granted read to exactly the project's content readers", async () => {
    const out = await registered('Weekly status');
    await filed(out);
    const pf = await projectFolder();
    assert.deepEqual(await granted(pf.id), PROJECT_READERS);
    assert.deepEqual(await sharedWith(pf.item_id), PROJECT_READERS);
    for (const inv of fake.invites) {
      assert.deepEqual((inv.body as { roles: string[] }).roles, ['read']);
      assert.equal((inv.body as { requireSignIn: boolean }).requireSignIn, true);
    }
    // Nothing else in the tree is shared, and a second sync changes nothing.
    assert.equal(new Set(fake.invites.map((i) => i.itemId)).size, 1);
    const before = fake.calls.length;
    await syncFolderGrants(deps(), pf.id);
    assert.equal(fake.calls.filter((x, i) => i >= before && (x.path.endsWith('/invite') || x.method === 'DELETE')).length, 0);
  });

  test("restricted output folders are granted to the output's readers only and the restricted root to nobody", async () => {
    const out = await registered('Board briefing', [ids.pm, ids.ada]);
    const f = await filed(out);
    const of = await outputFolder(out);
    assert.equal(await parentOf(f.item_id), of.item_id);
    assert.deepEqual(await granted(of.id), ['ada@example.org', 'pm@example.org']);
    assert.deepEqual(await sharedWith(of.item_id), ['ada@example.org', 'pm@example.org']);
    const root = await folder('restricted_root', `${dept}/${project}/restricted`);
    assert.equal((await rows(`SELECT count(*)::int AS n FROM storage_grants WHERE folder_id = $1`, [root.id]))[0].n, 0);
    assert.deepEqual(await sharedWith(root.item_id), []);
    assert.equal(fake.invites.filter((i) => i.itemId !== of.item_id).length, 0);
    assert.equal(await projectFolder(), undefined, 'no project folder for a restricted output');
  });

  test('no file ever carries a Kainow grant', async () => {
    const wide = await registered('Weekly status');
    const narrow = await registered('Board briefing', [ids.pm]);
    await filed(wide);
    await filed(narrow);
    await setAudience(wide, [ids.pm, ids.deputy], 'narrow');
    await drain();
    await setAudience(wide, null, 'widen');
    await drain();
    assert.ok(fake.invites.length > 0);
    const shareable = new Set((await rows(`SELECT item_id FROM storage_folders WHERE level IN ('project', 'output')`)).map((r) => r.item_id));
    const files = (await rows(`SELECT item_id FROM stored_files WHERE item_id IS NOT NULL`)).map((r) => r.item_id as string);
    for (const inv of fake.invites) {
      assert.ok(shareable.has(inv.itemId), 'every invitation is on a project or output folder');
      assert.ok(!files.includes(inv.itemId), 'never on a file');
      assert.notEqual(inv.itemId, drive.rootItemId, 'never on the library root');
    }
    for (const id of files) assert.deepEqual(await connector.listPermissions(dest(), id), []);
  });

  test('membership ending, On Hold, account disabled and Audit grant end revoke at once; expiry by date revokes at the daily reconciliation', async () => {
    // kim is a Member until 10 November; deputy is also disabled to show the hold path.
    await t.pool.query(`INSERT INTO memberships (id, project_id, user_id, role, starts_on, expires_on) VALUES ($1, $2, $3, 'member', '2026-11-01', '2026-11-10')`, [uuidv7(), project, ids.kim]);
    const out = await registered('Weekly status');
    await filed(out);
    const pf = await projectFolder();
    assert.deepEqual(await granted(pf.id), [...PROJECT_READERS, 'kim@example.org'].sort());

    // Membership revoked.
    const ada = (await rows(`SELECT id FROM memberships WHERE user_id = $1`, [ids.ada]))[0].id;
    assert.equal((await c.pm.request('POST', `/memberships/${ada}/revoke`, { reason: 'Left the team' })).status, 200);
    assert.deepEqual((await rows(`SELECT job, urgent FROM storage_outbox WHERE sent_at IS NULL`)).map((r) => [r.job, r.urgent]), [['share-sync', true]]);
    await drain();
    assert.ok(!(await granted(pf.id)).includes('ada@example.org'));
    assert.ok(!(await sharedWith(pf.item_id)).includes('ada@example.org'));
    assert.deepEqual(await granted(pf.id, 'revoked'), ['ada@example.org']);

    // Account disabled: memberships go On Hold, and the SharePoint grant goes at once.
    assert.equal((await c.admin.request('POST', `/users/${ids.deputy}/disable`)).status, 204);
    assert.ok((await rows(`SELECT urgent FROM storage_outbox WHERE sent_at IS NULL`)).every((r) => r.urgent));
    await drain();
    assert.ok(!(await sharedWith(pf.item_id)).includes('deputy@example.org'));

    // An account with only an Audit grant, disabled.
    assert.equal((await c.admin.request('POST', `/users/${ids.aud}/disable`)).status, 204);
    await drain();
    assert.ok(!(await sharedWith(pf.item_id)).includes('aud@example.org'));

    // Audit grant revoked by the Owner.
    await t.pool.query(`UPDATE users SET status = 'active' WHERE id = $1`, [ids.aud]);
    await syncFolderGrants(deps(), pf.id);
    assert.ok((await sharedWith(pf.item_id)).includes('aud@example.org'));
    const g = (await rows(`SELECT id FROM access_grants WHERE user_id = $1`, [ids.aud]))[0].id;
    assert.equal((await c.owner.request('POST', `/grants/${g}/revoke`, { reason: 'Audit finished' })).status, 200);
    assert.deepEqual((await rows(`SELECT job, urgent FROM storage_outbox WHERE sent_at IS NULL`)).map((r) => [r.job, r.urgent]), [['share-sync', true]]);
    await drain();
    assert.ok(!(await sharedWith(pf.item_id)).includes('aud@example.org'));

    // kim's membership expires by date: nothing happens until the daily reconciliation.
    t.clock.advanceSeconds(2 * 86_400);
    assert.ok((await sharedWith(pf.item_id)).includes('kim@example.org'));
    await reconcileSharing(deps());
    assert.ok(!(await sharedWith(pf.item_id)).includes('kim@example.org'));
    assert.deepEqual(await sharedWith(pf.item_id), ['owner@example.org', 'pm@example.org', 'sponsor@example.org']);
  });

  test('joining grants', async () => {
    const out = await registered('Weekly status');
    await filed(out);
    const pf = await projectFolder();
    assert.ok(!(await sharedWith(pf.item_id)).includes('kim@example.org'));
    const r = await c.pm.request('POST', `/projects/${project}/members`, { userId: ids.kim, role: 'member', startsOn: '2026-11-09' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual((await rows(`SELECT job, urgent FROM storage_outbox WHERE sent_at IS NULL`)).map((x) => [x.job, x.urgent]), [['share-sync', false]]);
    await drain();
    assert.ok((await sharedWith(pf.item_id)).includes('kim@example.org'));
    // A re-enabled account whose hold is lifted is shared with again.
    const hal = (await rows(`SELECT id FROM memberships WHERE user_id = $1`, [ids.hal]))[0].id;
    assert.equal((await c.pm.request('POST', `/memberships/${hal}/restore`, { reason: 'Cleared' })).status, 200);
    await drain();
    assert.ok((await sharedWith(pf.item_id)).includes('hal@example.org'));
  });

  test('narrowing an audience moves the files out of the project folder before revoking or granting anything', async () => {
    const out = await registered('Weekly status');
    const f = await filed(out);
    const typeFolder = await parentOf(f.item_id);
    const mark = fake.calls.length;
    await setAudience(out, [ids.pm, ids.deputy], 'narrow');
    assert.deepEqual((await rows(`SELECT job, urgent FROM storage_outbox WHERE sent_at IS NULL`)).map((x) => [x.job, x.urgent]), [['place-output', true]]);
    // Kainow hides it from Ada at once.
    assert.equal((await c.ada.request('GET', url(`/${out}`))).status, 404);
    await drain();
    const after = fake.calls.slice(mark);
    const moves = after.map((x, i) => (x.method === 'PATCH' ? i : -1)).filter((i) => i >= 0);
    const sharing = after.map((x, i) => (x.path.endsWith('/invite') || x.method === 'DELETE' ? i : -1)).filter((i) => i >= 0);
    assert.ok(moves.length > 0 && sharing.length > 0);
    assert.ok(Math.max(...moves) < Math.min(...sharing), 'every move comes before any grant or revocation');
    const of = await outputFolder(out);
    assert.notEqual(await parentOf(f.item_id), typeFolder);
    assert.equal(await parentOf(f.item_id), of.item_id);
    assert.equal((await fileRow(out)).path, `Water Services/${PROJECT} (restricted)/Weekly status/Weekly status v1.md`);
    assert.equal((await rows(`SELECT count(*)::int AS n FROM stored_file_moves WHERE stored_file_id = $1`, [f.id]))[0].n, 1);
    assert.equal((await rows(`SELECT placement_folder_id FROM outputs WHERE id = $1`, [out]))[0].placement_folder_id, of.id);
    assert.deepEqual(await sharedWith(of.item_id), ['deputy@example.org', 'pm@example.org']);
  });

  test('narrowing with a failing move keeps output hidden and listed to repair', async () => {
    const out = await registered('Weekly status');
    const f = await filed(out);
    const typeFolder = await parentOf(f.item_id);
    fake.fault({ method: 'PATCH', pathIncludes: f.item_id }, '503', 1);
    const mark = fake.calls.length;
    await setAudience(out, [ids.pm], 'narrow');
    const ran = await drain();
    assert.deepEqual(ran.map((r) => [r.job, r.failed]), [['place-output', 'server']]);
    // The file is still in the project tree, but Kainow no longer shows the output to Ada.
    assert.equal(await parentOf(f.item_id), typeFolder);
    assert.equal((await c.ada.request('GET', url(`/${out}`))).status, 404);
    assert.ok(!(await c.ada.request('GET', url())).body.outputs.some((o: { id: string }) => o.id === out));
    assert.equal(fake.calls.slice(mark).filter((x) => x.path.endsWith('/invite') || x.method === 'DELETE').length, 0, 'nothing shared or revoked');
    const repair = await sharingToRepair(t.pool);
    assert.deepEqual(repair.outputs.map((o) => [o.outputId, o.projectName]), [[out, PROJECT]]);
    // The retry completes once the fault has cleared.
    await placeOutput(deps(), out);
    const of = await outputFolder(out);
    assert.equal(await parentOf(f.item_id), of.item_id);
    assert.deepEqual(await sharedWith(of.item_id), ['pm@example.org']);
    assert.deepEqual((await sharingToRepair(t.pool)).outputs, []);
  });

  test('widening moves files back and never revokes first', async () => {
    const out = await registered('Board briefing', [ids.pm, ids.ada]);
    const f = await filed(out);
    const of = await outputFolder(out);
    assert.deepEqual(await sharedWith(of.item_id), ['ada@example.org', 'pm@example.org']);
    const mark = fake.calls.length;
    await setAudience(out, null, 'widen');
    assert.deepEqual((await rows(`SELECT job, urgent FROM storage_outbox WHERE sent_at IS NULL`)).map((x) => [x.job, x.urgent]), [['place-output', false]]);
    await drain();
    const after = fake.calls.slice(mark);
    const firstDelete = after.findIndex((x) => x.method === 'DELETE');
    const lastMove = after.map((x) => x.method).lastIndexOf('PATCH');
    assert.ok(lastMove >= 0 && firstDelete > lastMove, 'the files move back before any grant is removed');
    assert.equal((await fileRow(out)).path, `Water Services/${PROJECT}/2026/Status reports/Board briefing v1.md`);
    assert.equal((await rows(`SELECT f.level FROM outputs o JOIN storage_folders f ON f.id = o.placement_folder_id WHERE o.id = $1`, [out]))[0].level, 'report_type');
    // Its own folder now holds nothing and is shared with nobody; the project folder is shared with the project.
    assert.deepEqual(await sharedWith(of.item_id), []);
    assert.deepEqual(await sharedWith((await projectFolder()).item_id), PROJECT_READERS);
  });

  test('not_found with lookup on (guest, disabled, unknown) and off (domain not approved) is shown to PM, Deputy, Owner, Sponsor', async () => {
    const people: Record<string, string> = {};
    for (const [k, email] of [['guest', 'guest@example.org'], ['gone', 'gone@example.org'], ['nobody', 'nobody@example.org'], ['outside', 'outside@example.net']]) {
      people[k] = await seedUser(t.pool, email);
      await t.pool.query(`INSERT INTO memberships (id, project_id, user_id, role, starts_on) VALUES ($1, $2, $3, 'member', '2026-11-01')`, [uuidv7(), project, people[k]]);
    }
    fake.addUser('guest@example.org', { userType: 'Guest' });
    fake.addUser('gone@example.org', { enabled: false });
    fake.addUser('outside@example.net');
    const out = await registered('Weekly status');
    await filed(out);
    const pf = await projectFolder();
    assert.deepEqual(await granted(pf.id, 'not_found'), ['gone@example.org', 'guest@example.org', 'nobody@example.org']);
    assert.ok((await granted(pf.id)).includes('outside@example.net'), 'lookup on: an account in the tenant is shared with');
    for (const k of ['pm', 'deputy', 'owner', 'sponsor']) {
      const r = await c[k].request('GET', url(`/${out}`));
      assert.deepEqual(r.body.notShared.map((x: { message: string }) => x.message), [
        'Not shared in SharePoint — no Microsoft account found for gone@example.org',
        'Not shared in SharePoint — no Microsoft account found for guest@example.org',
        'Not shared in SharePoint — no Microsoft account found for nobody@example.org',
      ]);
    }
    assert.equal((await c.ada.request('GET', url(`/${out}`))).body.notShared, undefined, 'a Member does not see it');

    // Lookup off: only approved domains are shared with.
    connector = graphConnector(false);
    const ext = (await rows(`SELECT id FROM memberships WHERE user_id = $1`, [people.outside]))[0].id;
    assert.equal((await c.pm.request('POST', `/memberships/${ext}/revoke`, { reason: 'Moved' })).status, 200);
    await drain();
    assert.ok(!(await sharedWith(pf.item_id)).includes('outside@example.net'));
    await t.pool.query(`INSERT INTO memberships (id, project_id, user_id, role, starts_on) VALUES ($1, $2, $3, 'member', '2026-11-09')`, [uuidv7(), project, people.outside]);
    await reconcileSharing(deps());
    assert.ok((await granted(pf.id, 'not_found')).includes('outside@example.net'));
    assert.ok(!(await sharedWith(pf.item_id)).includes('outside@example.net'));
    const r = await c.pm.request('GET', url(`/${out}`));
    assert.ok(r.body.notShared.some((x: { message: string }) => x.message === 'Not shared in SharePoint — no Microsoft account found for outside@example.net'));
    // The person still reads the output in Kainow.
    const outside = await t.signIn('outside@example.net');
    assert.equal((await outside.request('GET', url(`/${out}`))).status, 200);
  });

  test('permissions Kainow did not create are never revoked', async () => {
    const wide = await registered('Weekly status');
    const narrow = await registered('Board briefing', [ids.pm, ids.ada]);
    await filed(wide);
    await filed(narrow);
    const pf = await projectFolder();
    const of = await outputFolder(narrow);
    const seeded: Array<[string, string]> = [];
    for (const item of [drive.rootItemId, pf.item_id, of.item_id]) {
      seeded.push([item, fake.seedPermission(drive.driveId, item, { kind: 'owner_group', principal: 'Site Owners', roles: ['owner'] })]);
      // A named person shared by someone else, who is also a project reader Kainow shares with and then revokes.
      seeded.push([item, fake.seedPermission(drive.driveId, item, { kind: 'user', principal: 'ada@example.org', roles: ['write'] })]);
    }
    const ada = (await rows(`SELECT id FROM memberships WHERE user_id = $1`, [ids.ada]))[0].id;
    assert.equal((await c.pm.request('POST', `/memberships/${ada}/revoke`, { reason: 'Left' })).status, 200);
    await drain();
    await setAudience(wide, [ids.pm], 'narrow');
    await drain();
    await setAudience(wide, null, 'widen');
    await drain();
    t.clock.advanceSeconds(86_400);
    await reconcileSharing(deps());
    const ours = new Set((await rows(`SELECT permission_id FROM storage_grants WHERE permission_id IS NOT NULL`)).map((r) => r.permission_id));
    for (const call of fake.calls.filter((x) => x.method === 'DELETE')) {
      const pid = /\/permissions\/([^/]+)$/.exec(call.path)?.[1];
      assert.ok(pid && ours.has(pid), 'only permissions recorded in storage_grants are deleted');
    }
    for (const [item, pid] of seeded) {
      assert.ok((await connector.listPermissions(dest(), item)).some((p) => p.id === pid), 'the seeded permission survives');
    }
  });

  test('revocation that keeps failing raises the Administrator notice once and stays listed', async () => {
    const out = await registered('Weekly status');
    await filed(out);
    const pf = await projectFolder();
    const ada = (await rows(`SELECT id FROM memberships WHERE user_id = $1`, [ids.ada]))[0].id;
    fake.fault({ method: 'DELETE', pathIncludes: '/permissions/' }, '503', 3);
    assert.equal((await c.pm.request('POST', `/memberships/${ada}/revoke`, { reason: 'Left' })).status, 200);
    assert.deepEqual((await drain()).map((r) => [r.job, r.urgent, r.failed]), [['share-sync', true, 'server']]);
    assert.deepEqual(await granted(pf.id, 'revoking'), ['ada@example.org']);
    const listed = async () => (await sharingToRepair(t.pool)).grants.map((g) => [g.displayName, g.projectName, g.state]);
    assert.deepEqual(await listed(), [['ada', PROJECT, 'revoking']]);
    const notices = async () => rows(`SELECT u.email, n.summary, n.link FROM notifications n JOIN users u ON u.id = n.user_id WHERE n.kind = 'sharing_revoke_failed' ORDER BY u.email`);
    assert.deepEqual(await notices(), []);
    // The job's attempts run out: one notice to the Administrator.
    await onFinalFailure(deps(), 'share-sync', pf.id, 'server');
    const expected = [{ email: 'admin@example.org', summary: `Kainow could not remove SharePoint access for a person who has left ${PROJECT}`, link: '#/storage' }];
    assert.deepEqual(await notices(), expected);
    // A fresh job fails again and runs out again: still one notice; the daily reconciliation fails too.
    await assert.rejects(syncFolderGrants(deps(), pf.id));
    await onFinalFailure(deps(), 'share-sync', pf.id, 'server');
    t.clock.advanceSeconds(86_400);
    assert.deepEqual(await reconcileSharing(deps()), { synced: 0, queued: 1, placed: 0 });
    assert.deepEqual(await notices(), expected);
    assert.deepEqual(await listed(), [['ada', PROJECT, 'revoking']]);
    assert.ok((await sharedWith(pf.item_id)).includes('ada@example.org'));
    // Once the provider accepts it, the revocation completes and leaves the list.
    await drain();
    assert.ok(!(await sharedWith(pf.item_id)).includes('ada@example.org'));
    assert.deepEqual(await listed(), []);
  });

  const membershipOf = async (userId: string) => (await rows(`SELECT id FROM memberships WHERE user_id = $1 AND revoked_at IS NULL`, [userId]))[0].id as string;
  const grantRow = async (folderId: string, userId: string) =>
    (await rows(`SELECT state, permission_id, none_created FROM storage_grants WHERE folder_id = $1 AND user_id = $2 ORDER BY updated_at DESC, id DESC LIMIT 1`, [folderId, userId]))[0];
  const providerCallsSince = (mark: number) => fake.calls.slice(mark).filter((x) => !x.path.includes('/token'));
  const invitedTo = (email: string) => fake.invites.filter((i) => JSON.stringify(i.body).includes(email)).length;
  const appoint = async (userId: string) => {
    const r = await c.pm.request('POST', `/projects/${project}/members`, { userId, role: 'member', startsOn: '2026-11-09' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  };
  const leave = async (userId: string) => {
    assert.equal((await c.pm.request('POST', `/memberships/${await membershipOf(userId)}/revoke`, { reason: 'Left' })).status, 200);
  };

  test('a grant the provider definitely refused is revoked without any provider call', async () => {
    await filed(await registered('Weekly status'));
    const pf = await projectFolder();
    fake.fault({ method: 'POST', pathIncludes: '/invite' }, '403', 1);
    await appoint(ids.kim);
    assert.equal((await drain())[0].failed, 'forbidden');
    assert.deepEqual(await grantRow(pf.id, ids.kim), { state: 'failed', permission_id: null, none_created: true });
    const mark = fake.calls.length;
    await leave(ids.kim);
    await drain();
    assert.deepEqual(providerCallsSince(mark), [], 'no listing, no invitation, no removal');
    assert.equal((await grantRow(pf.id, ids.kim)).state, 'revoked');
  });

  test('an unknown-outcome grant that landed is found by listing and deleted; one that did not land is marked revoked with no invite', async () => {
    await filed(await registered('Weekly status'));
    const pf = await projectFolder();
    // The invitation takes effect but its answer is lost.
    fake.fault({ method: 'POST', pathIncludes: '/invite' }, 'drop_after_body', 1);
    await appoint(ids.kim);
    await drain();
    assert.deepEqual(await grantRow(pf.id, ids.kim), { state: 'failed', permission_id: null, none_created: false });
    assert.ok((await sharedWith(pf.item_id)).includes('kim@example.org'));
    let mark = fake.calls.length;
    const invites = fake.invites.length;
    await leave(ids.kim);
    await drain();
    assert.equal(fake.invites.length, invites, 'revoking never invites');
    assert.ok(providerCallsSince(mark).some((x) => x.method === 'GET' && x.path.endsWith('/permissions')));
    assert.ok(!(await sharedWith(pf.item_id)).includes('kim@example.org'));
    const kim = await grantRow(pf.id, ids.kim);
    assert.equal(kim.state, 'revoked');
    assert.ok(kim.permission_id, 'the permission found by listing is recorded');
    // A server error: the outcome is unknown, and here nothing landed.
    const joe = await seedUser(t.pool, 'joe@example.org');
    fake.addUser('joe@example.org');
    fake.fault({ method: 'POST', pathIncludes: '/invite' }, '503', 1);
    await appoint(joe);
    await drain();
    assert.deepEqual(await grantRow(pf.id, joe), { state: 'failed', permission_id: null, none_created: false });
    mark = fake.calls.length;
    await leave(joe);
    await drain();
    assert.equal(providerCallsSince(mark).filter((x) => x.path.endsWith('/invite') || x.method === 'DELETE').length, 0);
    assert.equal((await grantRow(pf.id, joe)).state, 'revoked');
  });

  test('a person who already has a permission is recorded external, never touched, and keeps it after leaving and returning', async () => {
    await t.pool.query(`INSERT INTO memberships (id, project_id, user_id, role, starts_on) VALUES ($1, $2, $3, 'member', '2026-11-01')`, [uuidv7(), project, ids.kim]);
    const out = await registered('Weekly status');
    assert.equal((await c.pm.request('POST', url(`/${out}/versions/1/file`))).status, 200);
    const vid = (await rows(`SELECT id FROM output_versions WHERE output_id = $1`, [out]))[0].id;
    await fileOutputVersion(deps(), vid);
    const pf = await projectFolder();
    // Someone else shares the folder with Kim directly, before Kainow first shares it.
    const theirs = fake.seedPermission(drive.driveId, pf.item_id, { kind: 'user', principal: 'kim@example.org', roles: ['write'] });
    await drain();
    assert.deepEqual(await grantRow(pf.id, ids.kim), { state: 'external', permission_id: theirs, none_created: false });
    assert.equal(invitedTo('kim@example.org'), 0, 'Kainow never invites over it');
    assert.deepEqual(await granted(pf.id), PROJECT_READERS);
    const mark = fake.calls.length;
    await leave(ids.kim);
    await drain();
    assert.deepEqual(await grantRow(pf.id, ids.kim), { state: 'revoked', permission_id: null, none_created: false });
    // Back again, and gone again: still never invited over, never deleted.
    await appoint(ids.kim);
    await drain();
    assert.deepEqual(await grantRow(pf.id, ids.kim), { state: 'external', permission_id: theirs, none_created: false });
    await leave(ids.kim);
    await drain();
    assert.equal((await grantRow(pf.id, ids.kim)).state, 'revoked');
    assert.equal(invitedTo('kim@example.org'), 0, 'never invited');
    assert.equal(providerCallsSince(mark).filter((x) => x.method === 'DELETE').length, 0, 'never deleted');
    const still = (await connector.listPermissions(dest(), pf.item_id)).find((p) => p.id === theirs);
    assert.deepEqual(still?.roles, ['write'], 'their permission survives with its original roles');
  });

  test('a returning person is re-granted only while their permission still stands', async () => {
    await filed(await registered('Weekly status'));
    const pf = await projectFolder();
    const first = (await grantRow(pf.id, ids.ada)).permission_id;
    fake.fault({ method: 'DELETE', pathIncludes: '/permissions/' }, '503', 1);
    await leave(ids.ada);
    await drain();
    assert.equal((await grantRow(pf.id, ids.ada)).state, 'revoking');
    // The permission goes some other way; Ada then comes back.
    await connector.revoke(dest(), pf.item_id, first);
    await appoint(ids.ada);
    await drain();
    const ada = await grantRow(pf.id, ids.ada);
    assert.equal(ada.state, 'granted');
    assert.notEqual(ada.permission_id, first, 'invited afresh');
    assert.ok((await sharedWith(pf.item_id)).includes('ada@example.org'));
  });

  test('a failed narrowing of a restricted output still revokes the removed person', async () => {
    const out = await registered('Board briefing', [ids.pm, ids.ada]);
    const f = await filed(out);
    const of = await outputFolder(out);
    assert.deepEqual(await sharedWith(of.item_id), ['ada@example.org', 'pm@example.org']);
    fake.fault({ method: 'GET', pathIncludes: f.item_id }, '503', 1);
    await setAudience(out, [ids.pm], 'narrow');
    assert.deepEqual((await drain()).map((r) => [r.job, r.failed]), [['place-output', 'server']]);
    assert.deepEqual(await sharedWith(of.item_id), ['pm@example.org']);
    assert.equal((await grantRow(of.id, ids.ada)).state, 'revoked');
    assert.deepEqual((await sharingToRepair(t.pool)).outputs.map((o) => o.outputId), [out]);
    // Its attempts run out: one Administrator notice.
    await onFinalFailure(deps(), 'place-output', out, 'server');
    await onFinalFailure(deps(), 'place-output', out, 'server');
    assert.deepEqual(
      (await rows(`SELECT n.summary FROM notifications n WHERE n.kind = 'sharing_place_failed'`)).map((r) => r.summary),
      [`Kainow could not move the files of an output in ${PROJECT} to where only its readers can open them`],
    );
  });

  test('with the destination unavailable, a removed person is listed to repair and the notice is raised once', async () => {
    await filed(await registered('Weekly status'));
    const pf = await projectFolder();
    destinationDown = new StorageError('invalid');
    await leave(ids.ada);
    assert.deepEqual((await drain()).map((r) => r.failed), ['invalid']);
    assert.equal((await grantRow(pf.id, ids.ada)).state, 'revoking');
    assert.deepEqual((await sharingToRepair(t.pool)).grants.map((g) => [g.displayName, g.state]), [['ada', 'revoking']]);
    await onFinalFailure(deps(), 'share-sync', pf.id, 'invalid');
    await onFinalFailure(deps(), 'share-sync', pf.id, 'invalid');
    t.clock.advanceSeconds(86_400);
    await reconcileSharing(deps());
    assert.equal((await rows(`SELECT count(*)::int AS n FROM notifications WHERE kind = 'sharing_revoke_failed'`))[0].n, 1);
    destinationDown = null;
    await drain();
    assert.ok(!(await sharedWith(pf.item_id)).includes('ada@example.org'));
    assert.deepEqual((await sharingToRepair(t.pool)).grants, []);
  });

  test('a stored file left in the project tree for a restricted output is found and moved by the reconciliation', async () => {
    const out = await registered('Weekly status');
    const f = await filed(out);
    const typeFolder = (await rows(`SELECT id, item_id FROM storage_folders WHERE level = 'report_type'`))[0];
    await setAudience(out, [ids.pm], 'narrow');
    await drain();
    const of = await outputFolder(out);
    assert.equal(await parentOf(f.item_id), of.item_id);
    // As if a filing had recorded it in the project tree while the readers narrowed.
    fake.moveItem(drive.driveId, f.item_id, typeFolder.item_id);
    await t.pool.query(`UPDATE stored_files SET folder_id = $2 WHERE id = $1`, [f.id, typeFolder.id]);
    const r = await reconcileSharing(deps());
    assert.equal(r.placed, 1);
    assert.deepEqual((await rows(`SELECT job, urgent FROM storage_outbox WHERE sent_at IS NULL`)).map((x) => [x.job, x.urgent]), [['place-output', true]]);
    await drain();
    assert.equal(await parentOf(f.item_id), of.item_id);
    assert.equal((await rows(`SELECT folder_id FROM stored_files WHERE id = $1`, [f.id]))[0].folder_id, of.id);
    assert.equal((await reconcileSharing(deps())).placed, 0, 'nothing left to place');
  });
});
