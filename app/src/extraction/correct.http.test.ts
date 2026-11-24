import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { uuidv7 } from '../common/uuid7';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedProject, seedUser } from '../testing/projects';

const TEXT = 'Ann will export the records by 20 November 2026.\nShould we keep the old barcode?\nWe will move to the new system.';
const RECORD_OF: Record<string, string> = { action: 'task', decision: 'decision', question: 'question', risk: 'risk' };

describe('correcting a proposal (D130)', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let pm: Client;
  let owner: Client;
  let sponsor: Client;
  const ids: Record<string, string> = {};
  const item: Record<string, string> = {};
  let projectId: string;
  let runId: string;
  let versionId: string;

  beforeEach(async () => {
    t = await startTestApp();
    for (const p of ['pm', 'owner', 'sponsor', 'ann']) ids[p] = await seedUser(t.pool, `${p}@example.org`);
    projectId = await seedProject(t.pool, {
      status: 'active',
      members: [
        { userId: ids.pm, role: 'pm' },
        { userId: ids.pm, role: 'member' },
        { userId: ids.owner, role: 'owner' },
        { userId: ids.sponsor, role: 'sponsor' },
        { userId: ids.ann, role: 'member' },
      ],
    });
    pm = await t.signIn('pm@example.org');
    owner = await t.signIn('owner@example.org');
    sponsor = await t.signIn('sponsor@example.org');
    versionId = (await pm.request('POST', `/projects/${projectId}/notes`, { title: 'Kick-off', text: TEXT })).body.version.id;
    runId = uuidv7();
    await t.pool.query(
      `INSERT INTO extraction_runs (id, source_version_id, requested_by, status, item_count, unlocated_count, model_id, created_at, finished_at)
       VALUES ($1, $2, $3, 'succeeded', 6, 0, 'example-model-1', now(), now())`,
      [runId, versionId, ids.pm],
    );
    const quote = 'Ann will export the records by 20 November 2026.';
    const rows: Array<[string, string, string]> = [
      ['task', 'action', 'Export the records.'],
      ['race1', 'action', 'Export the records (1).'],
      ['race2', 'action', 'Export the records (2).'],
      ['race3', 'action', 'Export the records (3).'],
      ['race4', 'action', 'Export the records (4).'],
      ['decision', 'decision', 'Move to the new system.'],
    ];
    for (const [i, [key, kind, text]] of rows.entries()) {
      item[key] = uuidv7();
      const q = key === 'decision' ? 'We will move to the new system.' : quote;
      const start = TEXT.indexOf(q);
      await t.pool.query(
        `INSERT INTO extraction_items (id, run_id, source_version_id, position, kind, text, owner, due, quote, quote_start, quote_end, quote_matches, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'Ann', 'by 20 November 2026', $7, $8, $9, 1, now())`,
        [item[key], runId, versionId, i, kind, text, q, start, start + q.length],
      );
    }
  });
  afterEach(async () => {
    await t?.close();
  });

  const edit = (c: Client, key: string, body: object) =>
    c.request('POST', `/extractions/${runId}/items/${item[key]}/edit`, { sourceVersionId: versionId, ...body });
  const authorise = (c: Client, key: string, body: object = {}) =>
    c.request('POST', `/extractions/${runId}/items/${item[key]}/authorise`, { sourceVersionId: versionId, ...body });
  const view = async (key: string) => (await pm.request('GET', `/extractions/${runId}`)).body.items.find((i: { id: string }) => i.id === item[key]);

  test('a type change with a reason is saved, shown in force and named in the history', async () => {
    const r = await edit(pm, 'task', { text: 'Export the records.', owner: 'Ann', due: 'by 20 November 2026', kind: 'decision', reason: '  It was agreed, not assigned.  ' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const it = await view('task');
    assert.equal(it.kind, 'decision');
    assert.equal(it.corrections.length, 1);
    const [c] = it.corrections;
    assert.deepEqual(c.changed, ['type']);
    assert.equal(c.by, 'pm');
    assert.equal(c.role, 'Project Manager');
    assert.deepEqual(c.from, { kind: 'action' });
    assert.deepEqual(c.to, { kind: 'decision' });
    assert.equal(c.reason, 'It was agreed, not assigned.');
    assert.equal(typeof c.at, 'string');
    // The edit row keeps the kind in force and the trimmed reason.
    const row = (await t.pool.query(`SELECT kind, reason FROM extraction_item_edits WHERE item_id = $1`, [item.task])).rows[0];
    assert.deepEqual(row, { kind: 'decision', reason: 'It was agreed, not assigned.' });
  });

  test('the history is newest first, and every new edit row stores the kind in force', async () => {
    await edit(pm, 'task', { text: 'Export the records.', owner: 'Ann', due: 'by 20 November 2026', kind: 'decision', reason: 'Agreed.' });
    t.clock.advanceSeconds(1);
    await edit(owner, 'task', { text: 'Move the records.', owner: 'Ann', due: 'by 20 November 2026' });
    const it = await view('task');
    assert.equal(it.kind, 'decision');
    assert.deepEqual(it.corrections.map((c: { changed: string[] }) => c.changed), [['text'], ['type']]);
    assert.equal(it.corrections[0].by, 'owner');
    assert.equal(it.corrections[0].role, 'Owner');
    assert.deepEqual([it.corrections[0].from, it.corrections[0].to], [{ kind: 'decision' }, { kind: 'decision' }]);
    const kinds = (await t.pool.query(`SELECT kind FROM extraction_item_edits WHERE item_id = $1 ORDER BY edited_at`, [item.task])).rows.map((x) => x.kind);
    assert.deepEqual(kinds, ['decision', 'decision']);
  });

  test('a type change needs a reason', async () => {
    for (const reason of [undefined, '', '    ']) {
      const r = await edit(pm, 'task', { text: 'Export the records.', owner: 'Ann', due: 'by 20 November 2026', kind: 'decision', ...(reason === undefined ? {} : { reason }) });
      assert.equal(r.status, 400);
      assert.equal(r.body.message, 'Give a reason for changing the type.');
    }
    assert.equal((await t.pool.query('SELECT count(*)::int AS n FROM extraction_item_edits')).rows[0].n, 0);
  });

  test('a reason is at most 500 characters, and the type must be one of the four', async () => {
    const base = { text: 'Export the records.', owner: 'Ann', due: 'by 20 November 2026' };
    assert.equal((await edit(pm, 'task', { ...base, kind: 'decision', reason: 'x'.repeat(501) })).status, 400);
    assert.equal((await edit(pm, 'task', { ...base, kind: 'task', reason: 'Because.' })).status, 400);
    assert.equal((await edit(pm, 'task', { ...base, kind: 5, reason: 'Because.' })).status, 400);
    assert.equal((await edit(pm, 'task', { ...base, kind: 'decision', reason: 7 })).status, 400);
    assert.equal((await t.pool.query('SELECT count(*)::int AS n FROM extraction_item_edits')).rows[0].n, 0);
    assert.equal((await edit(pm, 'task', { ...base, kind: 'decision', reason: 'x'.repeat(500) })).status, 200);
  });

  test('a wording-only edit needs no reason', async () => {
    const r = await edit(pm, 'task', { text: 'Export all the records.', owner: 'Ann', due: 'by 20 November 2026' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const it = await view('task');
    assert.equal(it.kind, 'action');
    assert.equal(it.corrections[0].reason, null);
    assert.deepEqual(it.corrections[0].changed, ['text']);
    assert.deepEqual([it.corrections[0].from, it.corrections[0].to], [{ kind: 'action' }, { kind: 'action' }]);
    // Naming the same type again is not a change and needs no reason.
    assert.equal((await edit(pm, 'task', { text: 'Export all the records.', owner: 'Bo', due: 'by 20 November 2026', kind: 'action' })).status, 200);
    assert.deepEqual((await view('task')).corrections[0].changed, ['owner']);
  });

  test('a type change alone counts as a change; naming the same type alone does not', async () => {
    const base = { text: 'Export the records.', owner: 'Ann', due: 'by 20 November 2026' };
    const same = await edit(pm, 'task', { ...base, kind: 'action', reason: 'No change.' });
    assert.equal(same.status, 409);
    assert.equal(same.body.message, 'Nothing was changed');
    assert.equal((await edit(pm, 'task', { ...base, kind: 'risk', reason: 'It is a risk.' })).status, 200);
  });

  test('the original block keeps the model\'s type and wording, and names the model', async () => {
    const untouched = await view('decision');
    assert.deepEqual(untouched.original, { kind: 'decision', text: 'Move to the new system.', owner: 'Ann', due: 'by 20 November 2026', model: 'example-model-1' });
    assert.deepEqual(untouched.corrections, []);
    await edit(pm, 'task', { text: 'Ship the records.', owner: null, due: null, kind: 'question', reason: 'It is open.' });
    const it = await view('task');
    assert.deepEqual(it.original, { kind: 'action', text: 'Export the records.', owner: 'Ann', due: 'by 20 November 2026', model: 'example-model-1' });
    assert.deepEqual(it.corrections[0].changed, ['type', 'text', 'owner', 'due']);
    assert.equal((await t.pool.query('SELECT kind, text FROM extraction_items WHERE id = $1', [item.task])).rows[0].kind, 'action');
  });

  test('authorising a corrected proposal creates a record of the corrected type', async () => {
    await edit(pm, 'task', { text: 'Move the records to the new system.', owner: null, due: null, kind: 'decision', reason: 'Agreed at the meeting.' });
    const r = await authorise(owner, 'task');
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.record.kind, 'decision');
    assert.equal((await t.pool.query('SELECT count(*)::int AS n FROM tasks WHERE origin_item_id = $1', [item.task])).rows[0].n, 0);
    const d = (await t.pool.query('SELECT statement FROM decisions WHERE origin_item_id = $1', [item.task])).rows[0];
    assert.equal(d.statement, 'Move the records to the new system.');
    // And the other way: a decision corrected to a task needs a task's assignee and due date.
    await edit(pm, 'decision', { text: 'Move to the new system.', owner: 'Ann', due: '2026-11-20', kind: 'action', reason: 'Someone has to do it.' });
    assert.equal((await authorise(owner, 'decision')).status, 400);
    const task = await authorise(owner, 'decision', { assigneeId: ids.ann, dueOn: '2026-11-20' });
    assert.equal(task.status, 201, JSON.stringify(task.body));
    assert.equal(task.body.record.kind, 'task');
  });

  test('a correction after authorising is refused', async () => {
    assert.equal((await authorise(owner, 'task', { assigneeId: ids.ann, dueOn: '2026-11-20' })).status, 201);
    const r = await edit(pm, 'task', { text: 'Export the records.', owner: 'Ann', due: 'by 20 November 2026', kind: 'decision', reason: 'Too late.' });
    assert.equal(r.status, 409);
    assert.equal((await t.pool.query('SELECT count(*)::int AS n FROM extraction_item_edits')).rows[0].n, 0);
    assert.equal((await view('task')).kind, 'action');
  });

  test('a correction racing an authorisation never leaves a record of the other type', async () => {
    for (const key of ['race1', 'race2', 'race3', 'race4']) {
      const [a, b] = await Promise.allSettled([
        authorise(owner, key, { assigneeId: ids.ann, dueOn: '2026-11-20' }),
        edit(pm, key, { text: 'Export the records.', owner: 'Ann', due: 'by 20 November 2026', kind: 'decision', reason: 'Agreed, not assigned.' }),
      ]);
      assert.equal(a.status, 'fulfilled');
      assert.equal(b.status, 'fulfilled');
      const it = await view(key);
      const records = (
        await t.pool.query(
          `SELECT 'task' AS kind FROM tasks WHERE origin_item_id = $1 UNION ALL SELECT 'decision' FROM decisions WHERE origin_item_id = $1
           UNION ALL SELECT 'question' FROM questions WHERE origin_item_id = $1 UNION ALL SELECT 'risk' FROM risks WHERE origin_item_id = $1`,
          [item[key]],
        )
      ).rows.map((x) => x.kind);
      assert.ok(records.length <= 1, key);
      for (const kind of records) assert.equal(kind, RECORD_OF[it.kind], `${key}: a ${kind} record for a proposal now in force as ${it.kind}`);
      // Exactly one side wins: either the correction is in force, or the record was made and the correction refused.
      if (records.length === 1 && records[0] === 'task') assert.equal(b.status === 'fulfilled' && b.value.status, 409, key);
    }
  });

  test('a change request about a corrected proposal is judged and listed as the corrected type', async () => {
    await t.pool.query(`UPDATE approval_policy SET required = 2`);
    await edit(pm, 'task', { text: 'Move the records to the new system.', owner: null, due: null, kind: 'decision', reason: 'Agreed at the meeting.' });
    // A decision needs no assignee or due date: the request is accepted as one and waits for a second approver.
    const first = await authorise(owner, 'task');
    assert.equal(first.status, 202, JSON.stringify(first.body));
    const listed = (await pm.request('GET', `/projects/${projectId}/changes?status=pending`)).body;
    const request = (Array.isArray(listed) ? listed : listed.requests).find((r: { target: { id: string } }) => r.target.id === item.task);
    assert.ok(request, 'the request is listed');
    assert.equal(request.kind, 'authorise_proposal');
    assert.equal(request.proposal?.kind, 'decision');
    const done = await sponsor.request('POST', `/changes/${request.id}/approve`, { version: request.version });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal((await t.pool.query('SELECT count(*)::int AS n FROM decisions WHERE origin_item_id = $1', [item.task])).rows[0].n, 1);
  });

  test('each correction is audited with the fields changed, never the wording or the reason', async () => {
    await edit(pm, 'task', { text: 'Secret wording', owner: 'Ann', due: 'by 20 November 2026', kind: 'risk', reason: 'Private reason' });
    const { rows } = await t.pool.query(`SELECT actor_user_id, subject_id, detail FROM audit_events WHERE action = 'proposal.corrected'`);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].actor_user_id, ids.pm);
    assert.equal(rows[0].subject_id, item.task);
    assert.deepEqual(rows[0].detail.fields, ['type', 'text']);
    assert.equal(rows[0].detail.projectId, projectId);
    assert.ok(!JSON.stringify(rows[0].detail).includes('Secret') && !JSON.stringify(rows[0].detail).includes('Private'));
  });
});
