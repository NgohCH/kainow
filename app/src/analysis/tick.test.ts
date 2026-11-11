import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { uuidv7 } from '../common/uuid7';
import { SpendService } from '../spend/spend.service';
import { SpendSettingsService } from '../spend/spend.settings';
import { MVP_SPEND_SETTINGS } from '../spend/mvp-settings';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedProject, seedUser } from '../testing/projects';
import type { AnalysisQueue } from './queue';
import { AnalysisTick } from './tick';

describe('analysis tick', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let ada: Client;
  let pm: Client;
  let ids: Record<string, string>;
  let project: string;
  let jobs: string[];
  let queue: AnalysisQueue;
  let tick: AnalysisTick;

  const post = async (c: Client, thread: string, body = 'We should ship on Friday.') => {
    const r = await c.request('POST', `/threads/${thread}/messages`, { body });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.id as string;
  };
  const start = async (c: Client, kind: 'discussion' | 'meeting', title = 'Release plan') => {
    const r = await c.request('POST', `/projects/${project}/threads`, { kind, title });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.id as string;
  };
  const runs = async (thread?: string) =>
    (await t.pool.query(`SELECT * FROM analysis_runs WHERE $1::uuid IS NULL OR thread_id = $1 ORDER BY created_at, id`, [thread ?? null])).rows;
  /** Pretends the worker finished the thread's active run, covering messages up to `through`. */
  const finish = (through: number) =>
    t.pool.query(`UPDATE analysis_runs SET status = 'succeeded', covers_through_no = $1, finished_at = $2 WHERE status IN ('queued', 'running')`, [through, t.clock.now()]);

  beforeEach(async () => {
    t = await startTestApp();
    jobs = [];
    queue = { enqueue: async (id) => void jobs.push(id) };
    ids = {};
    for (const k of ['admin', 'pm', 'ada']) ids[k] = await seedUser(t.pool, `${k}@example.org`);
    project = await seedProject(t.pool, {
      name: 'Alpha Project',
      status: 'active',
      members: [
        { userId: ids.pm, role: 'pm' },
        { userId: ids.pm, role: 'owner' },
        { userId: ids.ada, role: 'member' },
      ],
    });
    await new SpendSettingsService(t.pool, t.clock.now).apply(MVP_SPEND_SETTINGS, ids.admin);
    ada = await t.signIn('ada@example.org');
    pm = await t.signIn('pm@example.org');
    tick = new AnalysisTick({ pool: t.pool, clock: t.clock.now, queue, spend: new SpendService(t.pool, t.clock.now) });
  });
  afterEach(async () => {
    await t.close();
  });

  test('thread due after 5 quiet minutes gets one run and one job', async () => {
    const thread = await start(ada, 'discussion');
    await post(ada, thread);
    await post(ada, thread, 'And the vendor must confirm.');
    t.clock.advanceMinutes(4);
    assert.deepEqual(await tick.run(), { started: 0 }, 'the quiet period has not passed');
    t.clock.advanceMinutes(1);
    assert.deepEqual(await tick.run(), { started: 1 });
    const [run, ...rest] = await runs();
    assert.equal(rest.length, 0);
    assert.deepEqual([run.thread_id, run.kind, run.trigger, run.requested_by, run.status], [thread, 'proposals', 'quiet_period', null, 'queued']);
    assert.deepEqual([run.covers_from_no, run.covers_through_no], [1, 2]);
    assert.deepEqual(jobs, [run.id]);
  });

  test('a meeting gets a minutes run', async () => {
    const meeting = await start(ada, 'meeting', 'Weekly check-in');
    await post(ada, meeting);
    t.clock.advanceMinutes(5);
    assert.deepEqual(await tick.run(), { started: 1 });
    const [run] = await runs();
    assert.deepEqual([run.thread_id, run.kind, run.trigger], [meeting, 'minutes', 'quiet_period']);
  });

  test('second tick does not double-start', async () => {
    const thread = await start(ada, 'discussion');
    await post(ada, thread);
    t.clock.advanceMinutes(5);
    assert.deepEqual(await tick.run(), { started: 1 });
    assert.deepEqual(await tick.run(), { started: 0 });
    // Two ticks at once (two workers) still start the thread once.
    const second = start(ada, 'discussion', 'Another');
    await post(ada, await second);
    t.clock.advanceMinutes(5);
    const both = await Promise.all([tick.run(), new AnalysisTick({ pool: t.pool, clock: t.clock.now, queue, spend: new SpendService(t.pool, t.clock.now) }).run()]);
    assert.equal(both[0].started + both[1].started, 1);
    assert.equal((await runs()).length, 2);
    assert.equal(jobs.length, 2);
  });

  test('third automatic run within 20 minutes waits', async () => {
    const thread = await start(ada, 'discussion');
    await post(ada, thread); // 10:00
    t.clock.advanceMinutes(5);
    assert.equal((await tick.run()).started, 1); // 10:05
    await finish(1);
    await post(ada, thread);
    t.clock.advanceMinutes(5);
    assert.equal((await tick.run()).started, 1); // 10:10
    await finish(2);
    await post(ada, thread);
    t.clock.advanceMinutes(5);
    assert.equal((await tick.run()).started, 0, '10:15: two automatic runs in the last 20 minutes');
    t.clock.advanceMinutes(9);
    assert.equal((await tick.run()).started, 0, '10:24: the first run (10:05) is still inside the window');
    t.clock.advanceMinutes(1);
    assert.equal((await tick.run()).started, 1, '10:25: the window has moved on');
    assert.equal((await runs()).length, 3);
  });

  test('Deferred project starts nothing', async () => {
    const thread = await start(ada, 'discussion');
    await post(ada, thread);
    await t.pool.query(`UPDATE projects SET status = 'deferred' WHERE id = $1`, [project]);
    t.clock.advanceMinutes(10);
    assert.deepEqual(await tick.run(), { started: 0 });
    assert.equal((await runs()).length, 0);
    assert.equal(jobs.length, 0);
  });

  test('meeting with a human draft starts nothing', async () => {
    const meeting = await start(ada, 'meeting', 'Weekly check-in');
    await post(ada, meeting);
    await t.pool.query(
      `INSERT INTO minutes_drafts (id, thread_id, version_no, origin, body, covers_through_no, created_by, created_at) VALUES ($1, $2, 1, 'human', 'Edited minutes', 0, $3, $4)`,
      [uuidv7(), meeting, ids.ada, t.clock.now()],
    );
    t.clock.advanceMinutes(10);
    assert.deepEqual(await tick.run(), { started: 0 });
    assert.equal((await runs()).length, 0);
  });

  test('deleted messages are not unanalysed', async () => {
    const thread = await start(ada, 'discussion');
    const m = await post(ada, thread);
    const gone = await pm.request('POST', `/messages/${m}/delete`, { reason: 'Posted by mistake' });
    assert.equal(gone.status, 200, JSON.stringify(gone.body));
    t.clock.advanceMinutes(10);
    assert.deepEqual(await tick.run(), { started: 0 });
    // A hidden message is not counted either; a new visible one is.
    await post(ada, thread, 'A real message.');
    t.clock.advanceMinutes(5);
    assert.deepEqual(await tick.run(), { started: 1 });
    const [run] = await runs();
    assert.deepEqual([run.covers_from_no, run.covers_through_no], [1, 2]);
  });

  test('a thread with a queued run is skipped, and a selection run does not move the cursor', async () => {
    const thread = await start(ada, 'discussion');
    const m = await post(ada, thread);
    t.clock.advanceMinutes(5);
    await t.pool.query(
      `INSERT INTO analysis_runs (id, thread_id, kind, trigger, requested_by, status, covers_from_no, covers_through_no, selected_message_ids, created_at)
       VALUES ($1, $2, 'proposals', 'selection', $3, 'succeeded', 1, 1, $4, $5)`,
      [uuidv7(), thread, ids.ada, [m], t.clock.now()],
    );
    assert.deepEqual(await tick.run(), { started: 1 }, 'a selection run leaves the message unanalysed');
    assert.deepEqual(await tick.run(), { started: 0 });
  });

  test('spend settings not approved, or no allowance, start nothing', async () => {
    const thread = await start(ada, 'discussion');
    await post(ada, thread);
    t.clock.advanceMinutes(5);
    await t.pool.query(`UPDATE ai_spend_settings SET monthly_limit_micro_myr = 0`);
    assert.equal((await tick.run()).started, 0, 'no allowance');
    await t.pool.query(`DELETE FROM ai_spend_settings`);
    assert.equal((await tick.run()).started, 0, 'not approved');
    assert.equal((await runs()).length, 0);
  });

  test('automatic analysis off for the project starts nothing; a longer quiet period waits', async () => {
    const thread = await start(ada, 'discussion');
    await post(ada, thread);
    await t.pool.query(`INSERT INTO project_analysis_settings (project_id, quiet_minutes, updated_at) VALUES ($1, 10, $2)`, [project, t.clock.now()]);
    t.clock.advanceMinutes(9);
    assert.equal((await tick.run()).started, 0);
    t.clock.advanceMinutes(1);
    await t.pool.query(`UPDATE project_analysis_settings SET automatic = false WHERE project_id = $1`, [project]);
    assert.equal((await tick.run()).started, 0);
    await t.pool.query(`UPDATE project_analysis_settings SET automatic = true WHERE project_id = $1`, [project]);
    assert.equal((await tick.run()).started, 1);
  });

  test('a queue that refuses the job leaves a failed run, not a stuck one', async () => {
    const thread = await start(ada, 'discussion');
    await post(ada, thread);
    t.clock.advanceMinutes(5);
    const broken = new AnalysisTick({ pool: t.pool, clock: t.clock.now, queue: { enqueue: async () => Promise.reject(new Error('down')) }, spend: new SpendService(t.pool, t.clock.now) });
    assert.deepEqual(await broken.run(), { started: 0 });
    const [run] = await runs();
    assert.deepEqual([run.status, run.failure_code], ['failed', 'queue_unavailable']);
    t.clock.advanceMinutes(1);
    assert.deepEqual(await tick.run(), { started: 1 }, 'the next tick starts it again');
  });
});
