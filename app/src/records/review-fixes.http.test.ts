import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { uuidv7 } from '../common/uuid7';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedProject, seedUser } from '../testing/projects';

const TEXT = 'Ann will export the records by 20 November 2026.';

/** Fixes from sub-project 2a's final review. */
describe('records: review fixes', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let pm: Client;
  let owner: Client;
  let admin: Client;
  const ids: Record<string, string> = {};
  let projectId: string;

  beforeEach(async () => {
    t = await startTestApp();
    await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    for (const p of ['pm', 'owner', 'ann', 'ben', 'old']) ids[p] = await seedUser(t.pool, `${p}@example.org`);
    admin = await t.signIn('admin@example.org');
    await admin.request('POST', '/domains', { domain: 'example.org' });
    projectId = await seedProject(t.pool, {
      status: 'active',
      members: [
        { userId: ids.pm, role: 'pm' },
        { userId: ids.owner, role: 'owner' },
        { userId: ids.ann, role: 'member' },
        { userId: ids.ben, role: 'member' },
        { userId: ids.old, role: 'member', expiresOn: '2026-11-05' },
      ],
    });
    pm = await t.signIn('pm@example.org');
    owner = await t.signIn('owner@example.org');
  });
  afterEach(async () => {
    await t?.close();
  });

  const seedRun = async () => {
    const versionId = (await pm.request('POST', `/projects/${projectId}/notes`, { title: 'N', text: TEXT })).body.version.id;
    const runId = uuidv7();
    await t.pool.query(
      `INSERT INTO extraction_runs (id, source_version_id, requested_by, status, item_count, unlocated_count, created_at, finished_at) VALUES ($1, $2, $3, 'succeeded', 1, 0, now(), now())`,
      [runId, versionId, ids.pm],
    );
    const itemId = uuidv7();
    await t.pool.query(
      `INSERT INTO extraction_items (id, run_id, source_version_id, position, kind, text, owner, due, quote, quote_start, quote_end, quote_matches, created_at)
       VALUES ($1, $2, $3, 0, 'action', 'Export the records.', 'Ann', 'by 20 November 2026', $4, 0, $5, 1, now())`,
      [itemId, runId, versionId, TEXT, TEXT.length],
    );
    return { runId, versionId, itemId };
  };

  test('an edit that started before an authorise commits is refused, never orphaning the record', async () => {
    const { runId, versionId, itemId } = await seedRun();
    // An authorise is in progress: it holds the item row.
    const other = await t.pool.connect();
    try {
      await other.query('BEGIN');
      await other.query('SELECT id FROM extraction_items WHERE id = $1 FOR UPDATE', [itemId]);
      const editing = pm.request('POST', `/extractions/${runId}/items/${itemId}/edit`, { sourceVersionId: versionId, text: 'Changed wording' });
      await new Promise((r) => setTimeout(r, 500));
      // The authorise creates its task and commits.
      await other.query(
        `INSERT INTO tasks (id, project_id, depth, title, assignee_id, due_on, origin_item_id, authorised_by, authorised_at) VALUES ($1, $2, 0, 'Export the records.', $3, '2026-11-20', $4, $5, now())`,
        [uuidv7(), projectId, ids.ann, itemId, ids.owner],
      );
      await other.query(`UPDATE extraction_items SET review_status = 'approved', reviewed_by = $2, reviewed_at = now() WHERE id = $1`, [itemId, ids.owner]);
      await other.query('COMMIT');
      const r = await editing;
      assert.equal(r.status, 409);
      assert.equal(r.body.message, 'This proposal has been authorised; its record changes only through an amendment.');
    } finally {
      other.release();
    }
    const item = (await t.pool.query(`SELECT review_status FROM extraction_items WHERE id = $1`, [itemId])).rows[0];
    assert.equal(item.review_status, 'approved');
  });

  test('a grant holder changes nothing, even on their own old task, question or risk', async () => {
    // Ann's membership ends; she now reads the project through an Audit grant.
    const taskId = uuidv7();
    await t.pool.query(
      `INSERT INTO tasks (id, project_id, depth, title, assignee_id, due_on, status, authorised_by, authorised_at) VALUES ($1, $2, 0, 'T', $3, '2026-11-20', 'in_progress', $4, now())`,
      [taskId, projectId, ids.ann, ids.owner],
    );
    const hp = async (kind: string) => {
      const id = uuidv7();
      await t.pool.query(
        `INSERT INTO human_proposals (id, project_id, kind, text, proposed_by, proposed_at, review_status, reviewed_by, reviewed_at) VALUES ($1, $2, $3, 'x', $4, now(), 'approved', $4, now())`,
        [id, projectId, kind, ids.owner],
      );
      return id;
    };
    const questionId = uuidv7();
    await t.pool.query(
      `INSERT INTO questions (id, project_id, text, requester_id, status, origin_proposal_id, authorised_by, authorised_at) VALUES ($1, $2, 'Q?', $3, 'answered', $4, $5, now())`,
      [questionId, projectId, ids.ann, await hp('question'), ids.owner],
    );
    const riskId = uuidv7();
    await t.pool.query(
      `INSERT INTO risks (id, project_id, description, severity, responsible_id, origin_proposal_id, authorised_by, authorised_at) VALUES ($1, $2, 'R', 'low', $3, $4, $5, now())`,
      [riskId, projectId, ids.ann, await hp('risk'), ids.owner],
    );
    const gid = (await owner.request('POST', `/projects/${projectId}/grants`, { userId: ids.ann, kind: 'audit', purpose: 'p', scope: 's', startsOn: '2026-11-09' })).body.grant.id;
    await admin.request('POST', `/grants/${gid}/approve`, {});
    await t.pool.query(`UPDATE memberships SET expires_on = '2026-11-08' WHERE project_id = $1 AND user_id = $2`, [projectId, ids.ann]);
    const ann = await t.signIn('ann@example.org');
    const readOnly = 'Audit and Oversight access is read-only.';
    const block = await ann.request('POST', `/records/tasks/${taskId}/block`, { note: 'x' });
    assert.deepEqual([block.status, block.body.message], [403, readOnly]);
    assert.equal((await ann.request('POST', `/records/questions/${questionId}/resolve`, {})).status, 403);
    assert.equal((await ann.request('POST', `/records/risks/${riskId}/mitigate`, { note: 'x' })).status, 403);
    const list = (await ann.request('GET', `/projects/${projectId}/records`)).body;
    assert.deepEqual([list.tasks[0].mayAct, list.questions[0].mayAct, list.risks[0].mayAct], [[], [], []]);
  });

  test('inviting by email someone whose Member role lapsed is refused with a way forward', async () => {
    const { runId, versionId, itemId } = await seedRun();
    const r = await owner.request('POST', `/extractions/${runId}/items/${itemId}/authorise`, { sourceVersionId: versionId, inviteEmail: 'old@example.org', dueOn: '2026-11-20' });
    assert.equal(r.status, 409);
    assert.equal(r.body.message, 'This person already has a Member appointment here; extend or restore it on the People tab, then choose them.');
    assert.equal((await t.pool.query(`SELECT count(*)::int AS n FROM invitations WHERE email = 'old@example.org'`)).rows[0].n, 0);
  });

  test('task history includes the authorisation and why a task was split', async () => {
    const { runId, versionId, itemId } = await seedRun();
    const a = await owner.request('POST', `/extractions/${runId}/items/${itemId}/authorise`, {
      sourceVersionId: versionId, assigneeId: ids.ann, dueOn: '2026-11-20',
      subtasks: [{ title: 'Export the finance part', assigneeId: ids.ben, dueOn: '2026-11-19' }],
    });
    assert.equal(a.status, 201, JSON.stringify(a.body));
    const sub = (await pm.request('GET', `/records/tasks/${a.body.record.subtaskIds[0]}`)).body;
    assert.deepEqual(sub.history.map((h: { kind: string; note: string | null; actor: string }) => [h.kind, h.note, h.actor]), [['authorised', 'Split at authorisation', 'owner']]);
  });

  test('changes to a risk\'s responsible person, review date and mitigation are kept in its history', async () => {
    const hp = uuidv7();
    await t.pool.query(
      `INSERT INTO human_proposals (id, project_id, kind, text, proposed_by, proposed_at, review_status, reviewed_by, reviewed_at) VALUES ($1, $2, 'risk', 'x', $3, now(), 'approved', $3, now())`,
      [hp, projectId, ids.owner],
    );
    const riskId = uuidv7();
    await t.pool.query(
      `INSERT INTO risks (id, project_id, description, severity, responsible_id, origin_proposal_id, authorised_by, authorised_at) VALUES ($1, $2, 'R', 'low', $3, $4, $5, now())`,
      [riskId, projectId, ids.ann, hp, ids.owner],
    );
    assert.equal((await pm.request('POST', `/records/risks/${riskId}/update`, { note: 'Ben takes it over', responsibleId: ids.ben, reviewOn: '2026-12-01' })).status, 200);
    const ev = (await t.pool.query(`SELECT detail FROM record_events WHERE record_id = $1`, [riskId])).rows[0].detail;
    assert.deepEqual(ev, { responsible: { from: ids.ann, to: ids.ben }, reviewOn: { from: null, to: '2026-12-01' } });
    t.clock.advanceSeconds(60);
    assert.equal((await owner.request('POST', `/records/risks/${riskId}/resolve`, { note: 'Done', responsibleId: ids.pm })).status, 200);
    const now = (await t.pool.query(`SELECT responsible_id FROM risks WHERE id = $1`, [riskId])).rows[0].responsible_id;
    assert.equal(now, ids.ben, 'resolving does not change the responsible person');
  });
});
