import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { uuidv7 } from '../common/uuid7';
import { POSSIBLE_COPY_TEXT } from '../quarantine/labels';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedProject, seedUser } from '../testing/projects';

type Run = { runId: string; sourceId: string; sourceTitle: string; versionNo: number; finishedAt: string; waiting: number; total: number };

/** `GET /projects/:projectId/proposal-runs`: the Proposals tab's list of extraction runs (spec 6.3). */
describe('project proposal runs', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let projectId: string;
  const ids: Record<string, string> = {};
  const people: Record<string, Client> = {};

  beforeEach(async () => {
    t = await startTestApp();
    await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    for (const p of ['pm', 'mem', 'outsider', 'stranger']) ids[p] = await seedUser(t.pool, `${p}@example.org`);
    projectId = await seedProject(t.pool, {
      status: 'active',
      members: [
        { userId: ids.pm, role: 'pm' },
        { userId: ids.pm, role: 'owner' },
        { userId: ids.mem, role: 'member' },
        { userId: ids.outsider, role: 'member' },
      ],
    });
    for (const p of ['pm', 'mem', 'outsider', 'stranger']) people[p] = await t.signIn(`${p}@example.org`);
    people.admin = await t.signIn('admin@example.org');
  });
  afterEach(async () => {
    await t?.close();
  });

  async function note(title: string): Promise<{ sourceId: string; versionId: string; audienceId: string }> {
    const r = await people.pm.request('POST', `/projects/${projectId}/notes`, { title, text: `Notes for ${title}.` });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const sourceId = r.body.source.id as string;
    const audienceId = (await t.pool.query(`SELECT audience_id FROM sources WHERE id = $1`, [sourceId])).rows[0].audience_id as string;
    return { sourceId, versionId: r.body.version.id as string, audienceId };
  }
  async function run(versionId: string, o: { finishedAt: string; items: Array<'pending' | 'approved' | 'rejected'>; status?: string }): Promise<string> {
    const id = uuidv7();
    await t.pool.query(
      `INSERT INTO extraction_runs (id, source_version_id, requested_by, status, failure_code, item_count, unlocated_count, created_at, finished_at)
       VALUES ($1, $2, $3, $4, CASE WHEN $4 = 'failed' THEN 'provider_error' END, $5, 0, $6, $6)`,
      [id, versionId, ids.pm, o.status ?? 'succeeded', o.items.length, o.finishedAt],
    );
    for (const [i, s] of o.items.entries()) {
      await t.pool.query(
        `INSERT INTO extraction_items (id, run_id, source_version_id, position, kind, text, quote, quote_start, quote_end, quote_matches, review_status, reviewed_by, reviewed_at, created_at)
         VALUES ($1, $2, $3, $4, 'decision', 'Proposed', 'Notes', 0, 5, 1, $5, $6, $7, now())`,
        [uuidv7(), id, versionId, i, s, s === 'pending' ? null : ids.pm, s === 'pending' ? null : new Date()],
      );
    }
    return id;
  }
  const list = async (who: string): Promise<Run[]> => {
    const r = await people[who].request('GET', `/projects/${projectId}/proposal-runs`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.runs as Run[];
  };

  test('succeeded runs with items, newest first, with waiting and total', async () => {
    const a = await note('Kick-off');
    const b = await note('Site visit');
    const older = await run(a.versionId, { finishedAt: '2026-11-03T02:00:00Z', items: ['pending', 'approved', 'rejected'] });
    const newer = await run(b.versionId, { finishedAt: '2026-11-05T02:00:00Z', items: ['approved'] });
    await run(b.versionId, { finishedAt: '2026-11-06T02:00:00Z', items: [] });
    await run(a.versionId, { finishedAt: '2026-11-07T02:00:00Z', items: [], status: 'failed' });
    assert.deepEqual(await list('mem'), [
      { runId: newer, sourceId: b.sourceId, sourceTitle: 'Site visit', versionNo: 1, finishedAt: '2026-11-05T02:00:00.000Z', waiting: 0, total: 1 },
      { runId: older, sourceId: a.sourceId, sourceTitle: 'Kick-off', versionNo: 1, finishedAt: '2026-11-03T02:00:00.000Z', waiting: 1, total: 3 },
    ]);
  });

  test("a Restricted note's runs are listed for its audience only", async () => {
    const open = await note('Weekly');
    const closed = await note('Personnel');
    await run(open.versionId, { finishedAt: '2026-11-03T02:00:00Z', items: ['pending'] });
    const hidden = await run(closed.versionId, { finishedAt: '2026-11-04T02:00:00Z', items: ['pending'] });
    const narrowed = await people.pm.request('PUT', `/audiences/${closed.audienceId}`, { mode: 'restricted', namedUserIds: [ids.mem], reason: 'Personnel matters' });
    assert.equal(narrowed.status, 200, JSON.stringify(narrowed.body));
    assert.deepEqual((await list('pm')).map((r) => r.sourceTitle), ['Personnel', 'Weekly'], 'the PM is always in the audience');
    assert.deepEqual((await list('mem')).map((r) => r.sourceTitle), ['Personnel', 'Weekly'], 'a named member');
    const outside = await list('outsider');
    assert.deepEqual(outside.map((r) => r.sourceTitle), ['Weekly']);
    assert.ok(!JSON.stringify(outside).includes(hidden) && !JSON.stringify(outside).includes(closed.sourceId));
  });

  test('a possible-copy note shows its label as title; a Deleted note is left out', async () => {
    const masked = await note('Login details');
    const gone = await note('Old notes');
    await run(masked.versionId, { finishedAt: '2026-11-03T02:00:00Z', items: ['pending'] });
    await run(gone.versionId, { finishedAt: '2026-11-04T02:00:00Z', items: ['pending'] });
    const caseId = uuidv7();
    const other = await note('Reported');
    await t.pool.query(
      `INSERT INTO quarantine_cases (id, project_id, item_kind, item_id, reason, marked_length, state, waiting_for_key, reported_at) VALUES ($1, $2, 'source', $3, 'test', 8, 'held', true, now())`,
      [caseId, projectId, other.sourceId],
    );
    await t.pool.query(`INSERT INTO quarantine_possible_copies (case_id, item_kind, item_id, found_at, masked) VALUES ($1, 'source', $2, now(), true)`, [caseId, masked.sourceId]);
    await t.pool.query(`UPDATE sources SET status = 'deleted' WHERE id = $1`, [gone.sourceId]);
    const runs = await list('mem');
    assert.deepEqual(runs.map((r) => [r.sourceId, r.sourceTitle]), [[masked.sourceId, POSSIBLE_COPY_TEXT]]);
  });

  test('404 for anyone who may not read the notes list', async () => {
    for (const who of ['stranger', 'admin']) {
      const r = await people[who].request('GET', `/projects/${projectId}/proposal-runs`);
      assert.equal(r.status, 404, who);
      assert.equal((await people[who].request('GET', `/projects/${projectId}/notes`)).status, 404, `${who}: the same answer as the notes list`);
    }
    await t.pool.query(`UPDATE memberships SET held_at = now(), held_by = $2, hold_reason = 'Checking' WHERE project_id = $1 AND user_id = $3`, [projectId, ids.pm, ids.mem]);
    assert.equal((await people.mem.request('GET', `/projects/${projectId}/proposal-runs`)).status, 404, 'an On Hold member');
  });
});
