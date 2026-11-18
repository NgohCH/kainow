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
import { unavailableReason } from '../assist/questions.service';
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

  test('an ended meeting with no final draft gets one meeting_end run, once', async () => {
    const meeting = await start(ada, 'meeting', 'Weekly check-in');
    await post(ada, meeting);
    t.clock.advanceMinutes(1);
    await t.pool.query(`UPDATE discussion_threads SET state = 'ended', ended_by = $2, ended_at = $3 WHERE id = $1`, [meeting, ids.ada, t.clock.now()]);
    t.clock.advanceMinutes(1);
    assert.deepEqual(await tick.run(), { started: 1 });
    const [run, ...rest] = await runs();
    assert.deepEqual([rest.length, run.kind, run.trigger, run.requested_by], [0, 'minutes', 'meeting_end', null]);
    await t.pool.query(`UPDATE analysis_runs SET status = 'failed', failure_code = 'x', finished_at = now()`);
    t.clock.advanceMinutes(10);
    assert.deepEqual(await tick.run(), { started: 0 }, 'not asked for again');
  });

  test('a run stuck for 45 minutes is failed as stalled, with its extraction run, and the thread is free again', async () => {
    const thread = await start(ada, 'discussion');
    await post(ada, thread);
    t.clock.advanceMinutes(5);
    assert.equal((await tick.run()).started, 1);
    const [stuck] = await runs();
    const source = uuidv7();
    const version = uuidv7();
    const extraction = uuidv7();
    await t.pool.query(`INSERT INTO sources (id, title, created_by, created_at, project_id, kind, thread_id, audience_id)
       VALUES ($1, 'T', NULL, now(), $2, 'discussion', $3, (SELECT audience_id FROM discussion_threads WHERE id = $3))`, [source, project, thread]);
    await t.pool.query(`INSERT INTO source_versions (id, source_id, version_no, origin, text_content, text_sha256, char_count, created_by, created_at) VALUES ($1, $2, 1, 'discussion', 'x', 'x', 1, NULL, now())`, [version, source]);
    await t.pool.query(`INSERT INTO extraction_runs (id, source_version_id, requested_by, trigger, status, created_at) VALUES ($1, $2, NULL, 'discussion', 'running', now())`, [extraction, version]);
    await t.pool.query(`UPDATE analysis_runs SET status = 'running', extraction_run_id = $2 WHERE id = $1`, [stuck.id, extraction]);
    t.clock.advanceMinutes(44);
    await tick.run();
    assert.equal((await runs())[0].status, 'running', 'not yet stalled at 49 minutes after creation');
    t.clock.advanceMinutes(2);
    await tick.run();
    const [after] = await runs();
    assert.deepEqual([after.status, after.failure_code, after.failure_detail], ['failed', 'stalled', 'This analysis stopped without finishing; ask again.']);
    const ex = (await t.pool.query(`SELECT status, failure_code FROM extraction_runs WHERE id = $1`, [extraction])).rows[0];
    assert.deepEqual([ex.status, ex.failure_code], ['failed', 'stalled']);
  });

  test('a run with a live pg-boss job is not stalled however old; without one it is', async () => {
    const thread = await start(ada, 'discussion');
    await post(ada, thread);
    t.clock.advanceMinutes(5);
    assert.equal((await tick.run()).started, 1);
    const [queued] = await runs();
    await t.pool.query(`CREATE SCHEMA IF NOT EXISTS pgboss`);
    await t.pool.query(`CREATE TABLE pgboss.job (name text NOT NULL, singleton_key text, state text NOT NULL)`);
    try {
      for (const state of ['created', 'retry', 'active']) {
        await t.pool.query(`INSERT INTO pgboss.job (name, singleton_key, state) VALUES ('ai', $1, $2)`, [queued.id, state]);
        t.clock.advanceMinutes(120);
        await tick.run();
        assert.equal((await runs())[0].status, 'queued', `a ${state} job keeps the run alive`);
        await t.pool.query(`DELETE FROM pgboss.job`);
      }
      // A finished job (or one on another queue) does not count.
      await t.pool.query(`INSERT INTO pgboss.job (name, singleton_key, state) VALUES ('ai', $1, 'completed'), ('email', $1, 'active')`, [queued.id]);
      await tick.run();
      const [after] = await runs();
      assert.deepEqual([after.status, after.failure_code], ['failed', 'stalled']);
    } finally {
      await t.pool.query(`DROP SCHEMA pgboss CASCADE`);
    }
  });

  test('a stuck AI assist request is failed as stalled and its reservation kept as uncertain; a live job or a fresh request is left alone', async () => {
    const insertRequest = async (status: 'queued' | 'running') => {
      const id = uuidv7(t.clock.now().getTime());
      await t.pool.query(
        `INSERT INTO ai_requests (id, project_id, kind, requested_by, status, scope, created_at, attempts) VALUES ($1, $2, 'question', $3, $4, 'personal', $5, $6)`,
        [id, project, ids.ada, status, t.clock.now(), status === 'running' ? 3 : 0],
      );
      return id;
    };
    const request = async (id: string) =>
      (await t.pool.query(`SELECT status, failure_code, failure_detail, finished_at FROM ai_requests WHERE id = $1`, [id])).rows[0];
    const queued = await insertRequest('queued');
    const running = await insertRequest('running');
    const withJob = await insertRequest('queued');
    const spend = new SpendService(t.pool, t.clock.now);
    const reserved = await spend.reserveOrganisationOnlyBridged({ requestId: running, attemptNo: 3, estimateMicroMyr: 1000n, purpose: 'question_answer', actorUserId: null });
    assert.equal(reserved.status, 'reserved');
    await t.pool.query(`CREATE SCHEMA IF NOT EXISTS pgboss`);
    await t.pool.query(`CREATE TABLE pgboss.job (name text NOT NULL, singleton_key text, state text NOT NULL)`);
    try {
      await t.pool.query(`INSERT INTO pgboss.job (name, singleton_key, state) VALUES ('ai', $1, 'active')`, [withJob]);
      t.clock.advanceMinutes(44);
      const fresh = await insertRequest('queued');
      t.clock.advanceMinutes(2);
      await tick.run();
      for (const id of [queued, running]) {
        const r = await request(id);
        assert.deepEqual([r.status, r.failure_code], ['failed', 'stalled'], `request ${id} is stalled`);
        assert.ok(r.failure_detail);
        assert.equal(new Date(r.finished_at).getTime(), t.clock.now().getTime());
      }
      assert.equal((await request(withJob)).status, 'queued', 'a live job keeps the request alive');
      assert.equal((await request(fresh)).status, 'queued', 'a fresh request is left alone');
      const entry = (await t.pool.query(`SELECT status FROM ai_spend_entries WHERE request_id = $1`, [running])).rows[0];
      assert.equal(entry.status, 'uncertain', 'the open reservation stays counted as uncertain');
      assert.equal(unavailableReason('stalled', null), 'it stopped without finishing; ask again');
    } finally {
      await t.pool.query(`DROP SCHEMA pgboss CASCADE`);
    }
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

  test('a blocked automatic run is not repeated without a new message, and is repeated after one', async () => {
    const thread = await start(ada, 'discussion');
    await post(ada, thread);
    t.clock.advanceMinutes(5);
    assert.equal((await tick.run()).started, 1);
    await t.pool.query(`UPDATE analysis_runs SET status = 'blocked', failure_code = 'cap_would_be_exceeded', finished_at = $1`, [t.clock.now()]);
    for (let i = 0; i < 3; i++) {
      t.clock.advanceMinutes(1);
      assert.equal((await tick.run()).started, 0, 'no run every minute');
    }
    assert.equal((await runs()).length, 1);
    const status = await ada.request('GET', `/threads/${thread}/analysis`);
    assert.equal(status.body.status.state, 'paused');
    assert.equal(status.body.lastFailure, 'cap_would_be_exceeded');
    await post(ada, thread, 'A new message.');
    t.clock.advanceMinutes(5);
    assert.equal((await tick.run()).started, 1);
    assert.equal((await runs()).length, 2);
  });

  test('two blocked quiet_period runs inside 20 minutes make the thread wait for the limit', async () => {
    const thread = await start(ada, 'discussion');
    const block = () => t.pool.query(`UPDATE analysis_runs SET status = 'blocked', failure_code = 'cap_would_be_exceeded', finished_at = $1 WHERE status = 'queued'`, [t.clock.now()]);
    await post(ada, thread);
    t.clock.advanceMinutes(5);
    assert.equal((await tick.run()).started, 1); // 10:05
    await block();
    t.clock.advanceMinutes(1);
    await post(ada, thread); // a message after the blocked run lets the next automatic run start
    t.clock.advanceMinutes(5);
    assert.equal((await tick.run()).started, 1); // 10:11
    await block();
    t.clock.advanceMinutes(1);
    await post(ada, thread);
    t.clock.advanceMinutes(5);
    assert.equal((await tick.run()).started, 0, '10:17: blocked runs count toward the limit');
    const line = (await ada.request('GET', `/threads/${thread}/analysis`)).body.line;
    assert.match(line, /^Limit reached — next eligible /);
    t.clock.advanceMinutes(8);
    assert.equal((await tick.run()).started, 1, '10:25: the first blocked run has left the window');
  });

  test('a thread whose start throws does not stop a later thread from starting', async () => {
    const first = await start(ada, 'discussion', 'First');
    const second = await start(ada, 'discussion', 'Second');
    await post(ada, first);
    await post(ada, second);
    await t.pool.query(`CREATE FUNCTION fail_first() RETURNS trigger AS $$ BEGIN
        IF NEW.thread_id = '${first}' THEN RAISE EXCEPTION 'boom'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql`);
    await t.pool.query(`CREATE TRIGGER fail_first BEFORE INSERT ON analysis_runs FOR EACH ROW EXECUTE FUNCTION fail_first()`);
    t.clock.advanceMinutes(5);
    const logs: string[] = [];
    const guarded = new AnalysisTick({ pool: t.pool, clock: t.clock.now, queue, spend: new SpendService(t.pool, t.clock.now), log: (m) => logs.push(m) });
    assert.deepEqual(await guarded.run(), { started: 1 });
    assert.deepEqual((await runs()).map((r) => r.thread_id), [second]);
    assert.deepEqual(logs, ['An analysis could not be started for one thread; the other threads continue.']);
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
    assert.deepEqual(await tick.run(), { started: 0 }, 'a failed automatic run is not repeated without a new message');
    await post(ada, thread, 'One more point.');
    t.clock.advanceMinutes(5);
    assert.deepEqual(await tick.run(), { started: 1 }, 'a new message lets the next tick start it again');
  });
});
