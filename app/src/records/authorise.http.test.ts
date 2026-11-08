import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { uuidv7 } from '../common/uuid7';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedProject, seedUser } from '../testing/projects';

const TEXT = 'Ann and Ben will export the records by 20 November 2026.\nShould we keep the old barcode?\nRisk: the vendor may be late.\nWe will move to the new system.';

describe('authorising proposals into records', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let owner: Client;
  let sponsor: Client;
  let pm: Client;
  const ids: Record<string, string> = {};
  const item: Record<string, string> = {};
  let projectId: string;
  let runId: string;
  let versionId: string;

  beforeEach(async () => {
    t = await startTestApp();
    await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    for (const p of ['pm', 'owner', 'sponsor', 'ann', 'ben']) ids[p] = await seedUser(t.pool, `${p}@example.org`);
    const admin = await t.signIn('admin@example.org');
    await admin.request('POST', '/domains', { domain: 'example.org' });
    projectId = await seedProject(t.pool, {
      status: 'active',
      members: [
        { userId: ids.pm, role: 'pm' },
        { userId: ids.owner, role: 'owner' },
        { userId: ids.sponsor, role: 'sponsor' },
        { userId: ids.ann, role: 'member' },
        { userId: ids.ben, role: 'member' },
      ],
    });
    pm = await t.signIn('pm@example.org');
    owner = await t.signIn('owner@example.org');
    sponsor = await t.signIn('sponsor@example.org');
    const note = (await pm.request('POST', `/projects/${projectId}/notes`, { title: 'Kick-off', text: TEXT })).body;
    versionId = note.version.id;
    runId = uuidv7();
    await t.pool.query(
      `INSERT INTO extraction_runs (id, source_version_id, requested_by, status, item_count, unlocated_count, created_at, finished_at)
       VALUES ($1, $2, $3, 'succeeded', 4, 0, now(), now())`,
      [runId, versionId, ids.pm],
    );
    const rows: Array<[string, string, string, string | null, string | null, string]> = [
      ['action', 'action', 'Export the records.', 'Ann and Ben', 'by 20 November 2026', 'Ann and Ben will export the records by 20 November 2026.'],
      ['question', 'question', 'Should we keep the old barcode?', null, null, 'Should we keep the old barcode?'],
      ['risk', 'risk', 'The vendor may be late.', null, null, 'Risk: the vendor may be late.'],
      ['decision', 'decision', 'Move to the new system.', null, null, 'We will move to the new system.'],
    ];
    for (const [i, [key, kind, text, owner_, due, quote]] of rows.entries()) {
      item[key] = uuidv7();
      const start = TEXT.indexOf(quote);
      await t.pool.query(
        `INSERT INTO extraction_items (id, run_id, source_version_id, position, kind, text, owner, due, quote, quote_start, quote_end, quote_matches, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 1, now())`,
        [item[key], runId, versionId, i, kind, text, owner_, due, quote, start, start + quote.length],
      );
    }
  });
  afterEach(async () => {
    await t?.close();
  });

  const authorise = (c: Client, key: string, body: object = {}) =>
    c.request('POST', `/extractions/${runId}/items/${item[key]}/authorise`, { sourceVersionId: versionId, ...body });
  const count = async (table: string) => (await t.pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE project_id = $1`, [projectId])).rows[0].n;

  test('an action becomes a task with its assignee and due date', async () => {
    const r = await authorise(owner, 'action', { assigneeId: ids.ann, dueOn: '2026-11-20' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.record.kind, 'task');
    const row = (await t.pool.query(`SELECT assignee_id, to_char(due_on, 'YYYY-MM-DD') AS due, owner_as_written, status, depth FROM tasks WHERE id = $1`, [r.body.record.id])).rows[0];
    assert.deepEqual(row, { assignee_id: ids.ann, due: '2026-11-20', owner_as_written: 'Ann and Ben', status: 'not_started', depth: 0 });
    assert.equal((await t.pool.query(`SELECT review_status FROM extraction_items WHERE id = $1`, [item.action])).rows[0].review_status, 'approved');
    const events = (await t.pool.query(`SELECT kind FROM task_events WHERE task_id = $1`, [r.body.record.id])).rows;
    assert.deepEqual(events.map((e) => e.kind), ['authorised']);
  });

  test('a task needs one assignee and a due date', async () => {
    const text = 'A task needs one assignee and a due date before it can be authorised.';
    const noDue = await authorise(owner, 'action', { assigneeId: ids.ann });
    assert.equal(noDue.status, 400);
    assert.equal(noDue.body.message, text);
    const stranger = await seedUser(t.pool, 'stranger@example.org');
    const outsider = await authorise(owner, 'action', { assigneeId: stranger, dueOn: '2026-11-20' });
    assert.equal(outsider.status, 400);
    assert.equal(outsider.body.message, text);
    assert.equal(await count('tasks'), 0);
  });

  test('one record however many clicks', async () => {
    const [a, b] = await Promise.all([
      authorise(owner, 'action', { assigneeId: ids.ann, dueOn: '2026-11-20' }),
      authorise(sponsor, 'action', { assigneeId: ids.ben, dueOn: '2026-11-21' }),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [200, 201]);
    assert.equal(a.body.record.id, b.body.record.id);
    assert.equal(await count('tasks'), 1);
  });

  test('several named people split into subtasks', async () => {
    const r = await authorise(owner, 'action', {
      assigneeId: ids.ann,
      dueOn: '2026-11-20',
      subtasks: [{ title: 'Export the finance records', assigneeId: ids.ben, dueOn: '2026-11-19' }],
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.record.subtaskIds.length, 1);
    const rows = (await t.pool.query(`SELECT depth, parent_id, assignee_id FROM tasks WHERE project_id = $1 ORDER BY depth`, [projectId])).rows;
    assert.deepEqual(rows.map((x) => [x.depth, x.parent_id, x.assignee_id]), [[0, null, ids.ann], [1, r.body.record.id, ids.ben]]);
  });

  test('invite gives Awaiting Membership until acceptance', async () => {
    const r = await authorise(owner, 'action', { inviteEmail: 'new@example.org', dueOn: '2026-11-20' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.delivered, true);
    const task = async (c: Client) => (await c.request('GET', `/projects/${projectId}/records`)).body.tasks[0];
    const before = await task(pm);
    assert.deepEqual([before.awaitingMembership, before.invitation], [true, 'invited']);
    const invitee = await t.signIn('new@example.org');
    const token = t.sender.lastInvitation('new@example.org').split('#/invitations/')[1];
    assert.equal((await invitee.request('POST', `/invitations/by-token/${token}/accept`)).status, 200);
    const after = await task(pm);
    assert.deepEqual([after.awaitingMembership, after.invitation], [false, null]);
  });

  test('question, risk and decision', async () => {
    const q = await authorise(owner, 'question');
    assert.equal(q.status, 201);
    assert.equal((await t.pool.query(`SELECT requester_id, status FROM questions WHERE id = $1`, [q.body.record.id])).rows[0].requester_id, ids.owner);
    const noSeverity = await authorise(owner, 'risk');
    assert.equal(noSeverity.status, 400);
    assert.equal(noSeverity.body.message, 'Choose a severity.');
    const risk = await authorise(owner, 'risk', { severity: 'high', responsibleId: ids.pm });
    assert.equal(risk.status, 201);
    assert.deepEqual((await t.pool.query(`SELECT severity, status FROM risks WHERE id = $1`, [risk.body.record.id])).rows[0], { severity: 'high', status: 'open' });
    const d = await authorise(owner, 'decision', { rationale: 'Agreed at kick-off' });
    assert.equal(d.status, 201);
    assert.equal((await t.pool.query(`SELECT status FROM decisions WHERE id = $1`, [d.body.record.id])).rows[0].status, 'active');
  });

  test('old approvals need authorising, and an authorised proposal is settled', async () => {
    assert.equal((await owner.request('POST', `/extractions/${runId}/items/${item.decision}/review`, { decision: 'approved', sourceVersionId: versionId })).status, 200);
    const view = async () => (await owner.request('GET', `/extractions/${runId}`)).body.items.find((i: { id: string }) => i.id === item.decision);
    assert.deepEqual([(await view()).approvedWithoutRecord, (await view()).record], [true, null]);
    const d = await authorise(owner, 'decision');
    assert.equal(d.status, 201);
    const v = await view();
    assert.deepEqual([v.approvedWithoutRecord, v.record.kind], [false, 'decision']);
    const settled = 'This proposal has been authorised; its record changes only through an amendment.';
    const reject = await owner.request('POST', `/extractions/${runId}/items/${item.decision}/review`, { decision: 'rejected', sourceVersionId: versionId });
    assert.deepEqual([reject.status, reject.body.message], [409, settled]);
    const edit = await pm.request('POST', `/extractions/${runId}/items/${item.decision}/edit`, { sourceVersionId: versionId, text: 'Changed' });
    assert.deepEqual([edit.status, edit.body.message], [409, settled]);
  });

  test('only the Owner or a Sponsor, and not while a required role is missing', async () => {
    assert.equal((await authorise(pm, 'decision')).status, 403);
    await t.pool.query(`UPDATE memberships SET revoked_at = now() WHERE project_id = $1 AND role = 'member'`, [projectId]);
    const r = await authorise(owner, 'decision');
    assert.equal(r.status, 409);
    assert.equal(r.body.message, 'The project is missing a required role, so proposals cannot be approved until it is repaired.');
  });
});
