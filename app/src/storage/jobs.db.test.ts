import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { Pool } from 'pg';
import type { JobWithMetadata, PgBoss } from 'pg-boss';
import { uuidv7 } from '../common/uuid7';
import { loadDatabaseConfig } from '../config';
import { runMigrations } from '../db/migrate';
import { SKIP_NO_DB, resetPublicSchema, testDatabaseUrl } from '../testing/db';
import { QUEUES, startQueues } from '../worker/queues';
import { StorageWaitingForKey, type StorageConnectorFactory } from './connector-factory';
import {
  type StorageDeps, type StorageJob, type StorageJobData,
  registerStorageDailyTask, registerStorageFinalFailure, registerStorageHandler, runStorageDaily,
} from './jobs';
import { URGENT_PRIORITY, queueStorageJob, sendStorageOutbox } from './outbox';
import { registerStorageWorker } from './storage-worker';
import { StorageError, type StorageErrorCode } from './types';

const migrationsDir = loadDatabaseConfig({ DATABASE_URL: 'x' }).migrationsDir;
const SCHEMA = 'pgboss_storage_jobs';
const MINUTE = 60_000;

async function until(cond: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('storage jobs', { skip: SKIP_NO_DB }, () => {
  let pool: Pool;
  let boss: PgBoss;
  // A frozen clock six hours in the past: every re-sent job is due at once, and its start time is exact against it.
  const T0 = new Date(Math.floor((Date.now() - 6 * 60 * MINUTE) / 1000) * 1000);
  const failures: Array<{ job: StorageJob; subjectId: string; code: string }> = [];

  const factory: StorageConnectorFactory = {
    forDestination: async () => { throw new StorageError('invalid'); },
    forNew: async () => { throw new StorageError('invalid'); },
  };
  const deps = (connectors: StorageConnectorFactory = factory): StorageDeps => ({
    pool, connectors, key: null, clock: () => T0, notify: async () => undefined,
  });

  async function queue(job: StorageJob, subjectId: string, priority?: 'urgent' | 'normal'): Promise<void> {
    const c = await pool.connect();
    try {
      await queueStorageJob(c, job, subjectId, priority ? { priority } : undefined);
    } finally {
      c.release();
    }
  }
  const jobsFor = async (job: StorageJob, subjectId: string): Promise<JobWithMetadata<StorageJobData>[]> =>
    (await boss.findJobs<StorageJobData>(QUEUES.storage, { key: `${job}:${subjectId}` })).sort((a, b) => a.createdOn.getTime() - b.createdOn.getTime());
  const attempts = async (subjectId: string) =>
    (await pool.query(`SELECT job, subject_id, outcome, provider_status, duration_ms, at FROM storage_attempts WHERE subject_id = $1 ORDER BY at, id`, [subjectId])).rows;

  beforeEach(async () => {
    pool = new Pool({ connectionString: testDatabaseUrl() });
    await resetPublicSchema(pool);
    await runMigrations(pool, migrationsDir);
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    boss = await startQueues(testDatabaseUrl() as string, SCHEMA);
    failures.length = 0;
    for (const job of ['file-output', 'store-source', 'share-sync', 'check'] as const) {
      registerStorageFinalFailure(job, async (_d, subjectId, code) => {
        failures.push({ job, subjectId, code });
      });
    }
  });
  afterEach(async () => {
    await boss.stop({ graceful: true, timeout: 5000 });
    await pool.end();
  });

  test('outbox row written in the caller\'s transaction is not sent if it rolls back', async () => {
    const lost = uuidv7();
    const kept = uuidv7();
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await queueStorageJob(c, 'check', lost);
      await c.query('ROLLBACK');
      await c.query('BEGIN');
      await queueStorageJob(c, 'check', kept);
      await c.query('COMMIT');
    } finally {
      c.release();
    }
    assert.equal(await sendStorageOutbox(pool, boss), 1);
    assert.equal((await jobsFor('check', lost)).length, 0);
    assert.equal((await jobsFor('check', kept)).length, 1);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM storage_outbox WHERE subject_id = $1`, [lost])).rows[0].n, 0);
  });

  test('outbox tick sends each row once', async () => {
    const a = uuidv7();
    const b = uuidv7();
    await queue('file-output', a);
    await queue('share-sync', b);
    // Two ticks at once (two worker processes) still send each row once.
    const sent = await Promise.all([sendStorageOutbox(pool, boss), sendStorageOutbox(pool, boss)]);
    assert.equal(sent[0] + sent[1], 2);
    assert.equal(await sendStorageOutbox(pool, boss), 0);
    const [ja] = await jobsFor('file-output', a);
    const [jb] = await jobsFor('share-sync', b);
    assert.deepEqual(ja.data, { job: 'file-output', subjectId: a });
    assert.deepEqual(jb.data, { job: 'share-sync', subjectId: b });
    assert.equal(ja.retryLimit, 4);
    assert.equal((await boss.findJobs(QUEUES.storage)).length, 2);
    const unsent = (await pool.query(`SELECT count(*)::int AS n FROM storage_outbox WHERE sent_at IS NULL`)).rows[0].n;
    assert.equal(unsent, 0);
  });

  test('temporary failure retries then succeeds', async () => {
    const subject = uuidv7();
    const seen: number[] = [];
    registerStorageHandler('check', async (_d, _s, attempt) => {
      seen.push(attempt);
      if (attempt < 3) throw new StorageError('server', { status: 503 });
    });
    await registerStorageWorker(boss, deps());
    await queue('check', subject);
    await sendStorageOutbox(pool, boss);
    await until(async () => (await attempts(subject)).some((r) => r.outcome === 'ok'));
    assert.deepEqual(seen, [1, 2, 3]);
    assert.deepEqual((await attempts(subject)).map((r) => [r.outcome, r.provider_status]), [['server', 503], ['server', 503], ['ok', null]]);
    const jobs = await jobsFor('check', subject);
    assert.equal(jobs.length, 3);
    // Retries are timed from the first failure: 1 minute, then 5 minutes after it.
    assert.deepEqual(jobs.map((j) => j.data), [
      { job: 'check', subjectId: subject },
      { job: 'check', subjectId: subject, attempt: 2, firstFailureAt: T0.toISOString() },
      { job: 'check', subjectId: subject, attempt: 3, firstFailureAt: T0.toISOString() },
    ]);
    assert.equal(jobs[1].startAfter.getTime(), T0.getTime() + MINUTE);
    assert.equal(jobs[2].startAfter.getTime(), T0.getTime() + 5 * MINUTE);
    assert.deepEqual(failures, []);
  });

  test('a job that fails every attempt stops after four retries and calls onFinalFailure', async () => {
    const subject = uuidv7();
    const seen: number[] = [];
    registerStorageHandler('check', async (_d, _s, attempt) => {
      seen.push(attempt);
      throw new StorageError('timeout');
    });
    await registerStorageWorker(boss, deps());
    await queue('check', subject);
    await sendStorageOutbox(pool, boss);
    await until(() => failures.length > 0);
    await new Promise((r) => setTimeout(r, 1000));
    assert.deepEqual(seen, [1, 2, 3, 4, 5]);
    assert.deepEqual(failures, [{ job: 'check', subjectId: subject, code: 'timeout' }]);
    const jobs = await jobsFor('check', subject);
    assert.deepEqual(jobs.slice(1).map((j) => j.startAfter.getTime() - T0.getTime()), [1, 5, 30, 120].map((m) => m * MINUTE));
  });

  test('final failure codes are not retried and call onFinalFailure', async () => {
    const codes: StorageErrorCode[] = ['unauthorised', 'forbidden', 'invalid', 'too_large'];
    const subjects = new Map(codes.map((code) => [uuidv7(), code]));
    let runs = 0;
    registerStorageHandler('file-output', async (_d, subjectId) => {
      runs++;
      throw new StorageError(subjects.get(subjectId) as StorageErrorCode, { status: 403 });
    });
    await registerStorageWorker(boss, deps());
    for (const s of subjects.keys()) await queue('file-output', s);
    await sendStorageOutbox(pool, boss);
    await until(() => failures.length >= codes.length);
    await new Promise((r) => setTimeout(r, 1000));
    assert.equal(runs, codes.length);
    assert.deepEqual(
      [...failures].sort((x, y) => x.code.localeCompare(y.code)),
      [...subjects].map(([subjectId, code]) => ({ job: 'file-output', subjectId, code })).sort((x, y) => x.code.localeCompare(y.code)),
    );
    for (const [s, code] of subjects) {
      assert.equal((await jobsFor('file-output', s)).length, 1);
      assert.deepEqual((await attempts(s)).map((r) => r.outcome), [code]);
    }
  });

  test('attempts are recorded without names or content', async () => {
    const cols = (await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'storage_attempts' ORDER BY column_name`)).rows.map((r) => r.column_name);
    assert.deepEqual(cols, ['at', 'duration_ms', 'id', 'job', 'outcome', 'provider_status', 'subject_id']);
    const subject = uuidv7();
    let n = 0;
    registerStorageHandler('share-sync', async () => {
      n++;
      if (n === 1) throw new StorageError('throttled', { status: 429, retryAfterMs: 90_000 });
      if (n === 2) throw new Error('Ada Lovelace minutes.docx Bearer eyJ0eXAi.secret-token');
    });
    const logs: string[] = [];
    await registerStorageWorker(boss, deps(), (m) => logs.push(m));
    await queue('share-sync', subject);
    await sendStorageOutbox(pool, boss);
    await until(async () => (await attempts(subject)).length === 3);
    const rows = await attempts(subject);
    assert.deepEqual(rows.map((r) => [r.job, r.subject_id, r.outcome, r.provider_status]), [
      ['share-sync', subject, 'throttled', 429],
      ['share-sync', subject, 'internal', null],
      ['share-sync', subject, 'ok', null],
    ]);
    for (const r of rows) {
      assert.ok(Number.isInteger(r.duration_ms) && r.duration_ms >= 0);
      assert.equal((r.at as Date).getTime(), T0.getTime());
    }
    const jobs = await jobsFor('share-sync', subject);
    // Retry-After (90 seconds from now) is later than the 1-minute schedule.
    assert.equal(jobs[1].startAfter.getTime(), T0.getTime() + 90_000);
    assert.deepEqual(logs, ['A storage share-sync job failed on an unexpected error.']);
    const text = JSON.stringify([rows, jobs.map((j) => j.data), logs]);
    for (const leak of ['Ada', 'minutes.docx', 'Bearer', 'secret-token']) assert.ok(!text.includes(leak), leak);
    for (const j of jobs) for (const k of Object.keys(j.data)) assert.ok(['job', 'subjectId', 'attempt', 'firstFailureAt'].includes(k), k);
  });

  test('jobs wait without protected key and resume when it returns', async () => {
    const subject = uuidv7();
    let keyInstalled = false;
    let opened = 0;
    const seen: number[] = [];
    const waiting: StorageConnectorFactory = {
      forDestination: async () => {
        opened++;
        if (!keyInstalled) throw new StorageWaitingForKey();
        return {} as Awaited<ReturnType<StorageConnectorFactory['forDestination']>>;
      },
      forNew: async () => { throw new StorageWaitingForKey(); },
    };
    registerStorageHandler('store-source', async (d, _s, attempt) => {
      seen.push(attempt);
      await d.connectors.forDestination(uuidv7());
    });
    await registerStorageWorker(boss, deps(waiting));
    await queue('store-source', subject);
    await sendStorageOutbox(pool, boss);
    await until(() => opened >= 3);
    // Waiting is not an attempt: no attempt row, the attempt count is unchanged, the subject is not failed.
    assert.deepEqual(await attempts(subject), []);
    assert.deepEqual(failures, []);
    const jobs = await jobsFor('store-source', subject);
    assert.ok(jobs.length >= 3);
    for (const j of jobs) assert.equal(j.data.attempt ?? 1, 1);
    assert.equal(jobs[1].startAfter.getTime(), T0.getTime() + 5 * MINUTE);

    keyInstalled = true;
    await until(async () => (await attempts(subject)).length === 1);
    assert.deepEqual((await attempts(subject)).map((r) => r.outcome), ['ok']);
    assert.ok(seen.every((a) => a === 1));
    assert.deepEqual(failures, []);
  });

  test('urgent jobs are sent with higher priority', async () => {
    const normal = uuidv7();
    const urgent = uuidv7();
    await queue('share-sync', normal);
    await queue('share-sync', urgent, 'urgent');
    assert.equal(await sendStorageOutbox(pool, boss), 2);
    const [n] = await jobsFor('share-sync', normal);
    const [u] = await jobsFor('share-sync', urgent);
    assert.equal(u.priority, URGENT_PRIORITY);
    assert.ok(u.priority > n.priority);
    // A retry keeps the job's priority.
    registerStorageHandler('share-sync', async (_d, subjectId, attempt) => {
      if (subjectId === urgent && attempt === 1) throw new StorageError('server');
    });
    await registerStorageWorker(boss, deps());
    await until(async () => (await attempts(urgent)).length === 2);
    const retried = (await jobsFor('share-sync', urgent))[1];
    assert.equal(retried.priority, URGENT_PRIORITY);
  });

  test('the daily storage tasks each run, and one failing does not stop the others', async () => {
    const ran: string[] = [];
    const logs: string[] = [];
    registerStorageDailyTask('test-a', async () => {
      ran.push('a');
      throw new Error('postgres://user:hunter2@db.example.org');
    });
    registerStorageDailyTask('test-b', async () => {
      ran.push('b');
    });
    await runStorageDaily(deps(), (m) => logs.push(m));
    assert.deepEqual(ran, ['a', 'b']);
    assert.deepEqual(logs, ['The daily storage task test-a failed; it will run again tomorrow.']);
  });
});
