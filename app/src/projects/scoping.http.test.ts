import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { uuidv7 } from '../common/uuid7';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedProject, seedUser } from '../testing/projects';

const TEXT = 'We agreed to ship on Friday.\nRisk: vendor late.';

describe('notes, extraction and review inside projects', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let admin: Client;
  let pm: Client;
  let owner: Client;
  let member: Client;
  let outsider: Client;
  let projectId: string;
  let sourceId: string;
  let versionId: string;
  let runId: string;
  let itemId: string;

  beforeEach(async () => {
    t = await startTestApp();
    await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    for (const p of ['pm', 'owner', 'member', 'outsider']) await seedUser(t.pool, `${p}@example.org`);
    admin = await t.signIn('admin@example.org');
    pm = await t.signIn('pm@example.org');
    owner = await t.signIn('owner@example.org');
    member = await t.signIn('member@example.org');
    outsider = await t.signIn('outsider@example.org');
    projectId = await seedProject(t.pool, {
      status: 'active',
      members: [{ userId: pm.userId, role: 'pm' }, { userId: owner.userId, role: 'owner' }, { userId: member.userId, role: 'member' }],
    });
    const made = await pm.request('POST', `/projects/${projectId}/notes`, { title: 'Weekly', text: TEXT });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    sourceId = made.body.source.id;
    versionId = made.body.version.id;
    runId = uuidv7();
    await t.pool.query(
      `INSERT INTO extraction_runs (id, source_version_id, requested_by, status, item_count, unlocated_count, created_at, finished_at)
       VALUES ($1, $2, $3, 'succeeded', 1, 0, now(), now())`,
      [runId, versionId, pm.userId],
    );
    itemId = uuidv7();
    await t.pool.query(
      `INSERT INTO extraction_items (id, run_id, source_version_id, position, kind, text, quote, quote_start, quote_end, quote_matches, created_at)
       VALUES ($1, $2, $3, 0, 'decision', 'Ship Friday', 'We agreed to ship on Friday.', 0, 28, 1, now())`,
      [itemId, runId, versionId],
    );
  });
  afterEach(async () => {
    await t?.close();
  });

  const approve = (c: Client) => c.request('POST', `/extractions/${runId}/items/${itemId}/review`, { sourceVersionId: versionId, decision: 'approved' });

  test('a Member reads notes and proposals but cannot add notes, run extraction or approve', async () => {
    assert.equal((await member.request('GET', `/projects/${projectId}/notes`)).body.sources.length, 1);
    assert.equal((await member.request('GET', `/notes/${sourceId}/versions/1`)).status, 200);
    assert.equal((await member.request('GET', `/extractions/${runId}`)).status, 200);
    const add = await member.request('POST', `/projects/${projectId}/notes`, { title: 'x', text: 'y' });
    assert.equal(add.status, 403);
    assert.equal(add.body.message, 'Only the Project Manager, a Deputy, the Owner or a Sponsor can add notes or run extraction, and not while the project is Deferred or Closed.');
    assert.equal((await member.request('POST', `/notes/${sourceId}/versions/1/extractions`)).status, 403);
    const a = await approve(member);
    assert.equal(a.status, 403);
    assert.equal(a.body.message, 'Only the Owner or a Sponsor can approve or reject proposals, and only while the project is Planned or Active.');
    assert.equal((await approve(pm)).status, 403, 'the PM is not an Owner or Sponsor');
    assert.equal((await approve(owner)).status, 200);
  });

  test('an administrator without a role and an outsider see nothing of the project content', async () => {
    for (const c of [admin, outsider]) {
      assert.equal((await c.request('GET', `/projects/${projectId}/notes`)).status, 404);
      assert.equal((await c.request('GET', `/notes/${sourceId}`)).status, 404);
      assert.equal((await c.request('GET', `/notes/${sourceId}/versions/1/original`)).status, 404);
      assert.equal((await c.request('GET', `/extractions/${runId}`)).status, 404);
      assert.equal((await approve(c)).status, 404);
    }
  });

  test('a revoked member loses access', async () => {
    await t.pool.query(`UPDATE memberships SET revoked_at = now() WHERE user_id = $1`, [member.userId]);
    assert.equal((await member.request('GET', `/notes/${sourceId}`)).status, 404);
    assert.equal((await member.request('GET', `/projects/${projectId}/notes`)).status, 404);
  });

  test('notes from before projects are not readable or listed by anyone', async () => {
    const old = uuidv7();
    await t.pool.query(`INSERT INTO sources (id, title, created_by, created_at) VALUES ($1, 'Old', $2, now())`, [old, pm.userId]);
    for (const c of [admin, pm, owner]) assert.equal((await c.request('GET', `/notes/${old}`)).status, 404);
    assert.deepEqual((await pm.request('GET', `/projects/${projectId}/notes`)).body.sources.map((s: { id: string }) => s.id), [sourceId]);
    assert.equal((await pm.request('GET', '/notes')).status, 404, 'the organisation-wide list is gone');
  });

  test('a Deferred project is read-only for notes and extraction', async () => {
    await t.pool.query(`UPDATE projects SET status = 'deferred' WHERE id = $1`, [projectId]);
    assert.equal((await pm.request('POST', `/projects/${projectId}/notes`, { title: 'x', text: 'y' })).status, 403);
    assert.equal((await pm.request('POST', `/notes/${sourceId}/versions`, { text: 'z' })).status, 403);
    assert.equal((await pm.request('GET', `/notes/${sourceId}`)).status, 200, 'still readable');
  });

  test('a Draft project cannot authorise proposals', async () => {
    await t.pool.query(`UPDATE projects SET status = 'draft' WHERE id = $1`, [projectId]);
    assert.equal((await approve(owner)).status, 403);
  });

  test('approval is refused while accountability is missing, for example after the Owner expires', async () => {
    await t.pool.query(`INSERT INTO memberships (id, project_id, user_id, role, starts_on) VALUES ($1, $2, $3, 'sponsor', '2026-11-01')`, [uuidv7(), projectId, outsider.userId]);
    await t.pool.query(`DELETE FROM memberships WHERE user_id = $1 AND role = 'member'`, [member.userId]);
    const r = await approve(owner);
    assert.equal(r.status, 409);
    assert.equal(r.body.message, 'The project is missing a required role, so proposals cannot be approved until it is repaired.');
    await t.pool.query(`INSERT INTO memberships (id, project_id, user_id, role, starts_on) VALUES ($1, $2, $3, 'member', '2026-11-01')`, [uuidv7(), projectId, member.userId]);
    await t.pool.query(`UPDATE memberships SET expires_on = '2026-11-08' WHERE user_id = $1`, [owner.userId]);
    assert.equal((await approve(owner)).status, 404, 'the expired Owner is no longer a participant');
  });

  test('editing wording and setting the meeting date need PM, Owner or Sponsor', async () => {
    const edit = (c: Client) => c.request('POST', `/extractions/${runId}/items/${itemId}/edit`, { sourceVersionId: versionId, text: 'Ship on Friday' });
    assert.equal((await edit(member)).status, 403);
    assert.equal((await edit(pm)).status, 200);
    const meeting = (c: Client) => c.request('POST', `/notes/${sourceId}/versions/1/meeting-date`, { meetingDate: '2026-11-04' });
    assert.equal((await meeting(member)).status, 403);
    assert.equal((await meeting(owner)).status, 200);
  });
});
