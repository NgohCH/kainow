import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, beforeEach, describe, test, type TestContext } from 'node:test';
import { Pool, type PoolClient } from 'pg';
import { unavailableReason } from '../assist/questions.service';
import { AnalysisTick } from '../analysis/tick';
import { uuidv7 } from '../common/uuid7';
import { loadDatabaseConfig } from '../config';
import { runMigrations } from '../db/migrate';
import { SpendService } from '../spend/spend.service';
import { SKIP_NO_DB, resetPublicSchema, testDatabaseUrl } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedProject, seedUser } from '../testing/projects';
import { BOSS_SCHEMA, QUEUES, startQueues } from '../worker/queues';
import { afterRestore } from './after-restore';
import { runBackup } from './backup';
import type { OpsConfig } from './config';
import { PgTools } from './pg-tools';
import { RESTORE_TEXT, type RestoreDeps, runRestore } from './restore';

const migrationsDir = loadDatabaseConfig({ DATABASE_URL: 'x' }).migrationsDir;
const TB = 1024 ** 4;
const PREFIX = 'kainow_restore_test_';

const urlFor = (name: string): string => {
  const u = new URL(testDatabaseUrl() as string);
  u.pathname = `/${name}`;
  return u.toString();
};

describe('restore', { skip: SKIP_NO_DB }, () => {
  let pool: Pool;
  let tools: PgTools;
  let toolsReady = false;
  let root: string;
  let folder: string;
  let keyFile: string;
  let clock = Date.parse('2026-11-21T02:00:00Z');
  let made = 0;
  const targets: Pool[] = [];

  const needTools = (t: TestContext): boolean => {
    if (toolsReady) return true;
    if (process.env.CI) assert.fail('pg client tools not found (required in CI)');
    t.skip('pg client tools not found');
    return false;
  };
  const config = (over: Partial<OpsConfig> = {}): OpsConfig => ({
    databaseUrl: testDatabaseUrl() as string,
    backupDir: folder,
    backupKeyFile: keyFile,
    dbDataDir: '/pgdata',
    protectedKeyFile: null,
    folderLabel: '/srv/backups',
    ...over,
  });
  const setsDir = () => join(folder, 'kainow', 'sets');

  async function backup(): Promise<{ name: string; startedAt: string }> {
    const out: string[] = [];
    const at = new Date((clock += 60_000));
    const code = await runBackup([], { pool, config: config(), tools, now: () => at, out: (l) => out.push(l), err: () => undefined });
    assert.equal(code, 0, out.join('\n'));
    const id = /^run (\S+) succeeded$/.exec(out[out.length - 1])?.[1] as string;
    const name = readdirSync(setsDir()).find((n) => n.endsWith(id)) as string;
    const summary = JSON.parse(readFileSync(join(setsDir(), name, 'backup.json'), 'utf8'));
    return { name, startedAt: summary.startedAt };
  }

  /** A new, empty database on the test server, and a pool on it. */
  async function target(): Promise<{ name: string; url: string; db: Pool }> {
    const name = `${PREFIX}${process.pid}_${++made}`;
    await pool.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await pool.query(`CREATE DATABASE "${name}"`);
    const db = new Pool({ connectionString: urlFor(name), max: 3 });
    db.on('error', () => undefined);
    targets.push(db);
    return { name, url: urlFor(name), db };
  }

  async function restore(into: { url: string; db: Pool }, argv: string[], over: Partial<RestoreDeps> = {}) {
    const out: string[] = [];
    const err: string[] = [];
    const at = new Date((clock += 60_000));
    const d: RestoreDeps = {
      pool: into.db,
      config: config({ databaseUrl: into.url }),
      tools: new PgTools(into.url),
      statfs: () => ({ total: 10 * TB, free: 5 * TB }),
      now: () => at,
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      protectedKeyPresent: true,
      ...over,
    };
    const code = await runRestore(argv, d);
    return { code, out, err, at };
  }

  const assertEmpty = async (db: Pool): Promise<void> => {
    assert.deepEqual(await publicTables(db), [], 'no table in public');
    assert.equal((await db.query(`SELECT count(*) AS n FROM pg_namespace WHERE nspname = 'pgboss'`)).rows[0].n, '0', 'no pgboss schema');
  };
  const publicTables = async (db: Pool): Promise<string[]> =>
    (await db.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`)).rows.map((r) => r.tablename);

  before(async () => {
    pool = new Pool({ connectionString: testDatabaseUrl() });
    await resetPublicSchema(pool);
    await pool.query(`DROP SCHEMA IF EXISTS ${BOSS_SCHEMA} CASCADE`);
    await runMigrations(pool, migrationsDir);
    const admin = await seedUser(pool, 'rs-admin1@example.org', 'enterprise_administrator');
    await seedUser(pool, 'rs-admin2@example.org', 'enterprise_administrator');
    await seedUser(pool, 'rs-member@example.org');
    await pool.query(`INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES ($1, $2, 'hash-rs-1', now() + interval '1 day')`, [uuidv7(), admin]);
    await pool.query(
      `INSERT INTO email_outbox (id, to_address, subject, text_body, kind, initiated_by, status, created_at)
       VALUES ($1, 'someone@example.org', 'Queued before the backup', 'b', 'test', 'system', 'queued', now())`,
      [uuidv7()],
    );
    tools = new PgTools(testDatabaseUrl() as string);
    toolsReady = await tools.version().then(
      (v) => v === 16,
      () => false,
    );
    root = mkdtempSync(join(tmpdir(), 'kainow-rs-'));
  });
  after(async () => {
    for (const db of targets) await db.end().catch(() => undefined);
    const left = (await pool.query(`SELECT datname FROM pg_database WHERE datname LIKE 'kainow\\_restore\\_test\\_%' ORDER BY datname`)).rows;
    for (const r of left) await pool.query(`DROP DATABASE IF EXISTS "${r.datname}" WITH (FORCE)`).catch(() => undefined);
    await pool.end();
    rmSync(root, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await pool.query('DELETE FROM backup_runs');
    folder = mkdtempSync(join(root, 'f-'));
    keyFile = join(root, `k-${Date.now()}-${Math.random()}`);
    writeFileSync(keyFile, randomBytes(32));
  });

  test('flags: --reason is required, a credential in it is refused, an unknown flag is usage', async () => {
    const into = await target();
    assert.equal((await restore(into, ['--set', 'latest'])).code, 2);
    assert.equal((await restore(into, ['--set', 'latest', '--reason', '   '])).code, 2);
    assert.equal((await restore(into, ['--set', 'latest', '--reason', 'r', '--keep'])).code, 2);
    const secret = await restore(into, ['--reason', `the key is sk-test-${'x'.repeat(40)}`]);
    assert.equal(secret.code, 1);
    assert.ok(!secret.err.join('\n').includes('xxxxxxxx'), 'the credential is not repeated');
    assert.deepEqual(await publicTables(into.db), []);
  });

  test('a target with any table in public, or a pgboss schema, is refused and nothing changes', async () => {
    const withTable = await target();
    await withTable.db.query('CREATE TABLE public.something_else (n integer)');
    await withTable.db.query('INSERT INTO public.something_else VALUES (1)');
    const a = await restore(withTable, ['--set', 'latest', '--reason', 'Disaster recovery']);
    assert.equal(a.code, 1);
    assert.deepEqual(a.err, [RESTORE_TEXT.notEmpty]);
    assert.deepEqual(await publicTables(withTable.db), ['something_else']);
    assert.equal(Number((await withTable.db.query('SELECT count(*) AS n FROM public.something_else')).rows[0].n), 1);

    const withBoss = await target();
    await withBoss.db.query('CREATE SCHEMA pgboss');
    const b = await restore(withBoss, ['--set', 'latest', '--reason', 'Disaster recovery']);
    assert.equal(b.code, 1);
    assert.deepEqual(b.err, [RESTORE_TEXT.notEmpty]);
    assert.deepEqual(await publicTables(withBoss.db), []);
  });

  test('no set, or a set made with another key, is refused and the target stays empty', async (t) => {
    const into = await target();
    const none = await restore(into, ['--set', 'latest', '--reason', 'Disaster recovery']);
    assert.equal(none.code, 1);
    assert.deepEqual(none.err, [RESTORE_TEXT.noSet]);
    if (!needTools(t)) return;
    const { name } = await backup();
    const keyId = JSON.parse(readFileSync(join(setsDir(), name, 'backup.json'), 'utf8')).keyId as string;
    keyFile = join(root, `k-other-${Date.now()}`);
    writeFileSync(keyFile, randomBytes(32));
    const wrong = await restore(into, ['--set', name, '--reason', 'Disaster recovery']);
    assert.equal(wrong.code, 1);
    assert.deepEqual(wrong.err, [RESTORE_TEXT.wrongKey(keyId)]);
    assert.deepEqual(await publicTables(into.db), []);
  });

  test('too little free space is refused before anything is restored', async (t) => {
    if (!needTools(t)) return;
    await backup();
    const into = await target();
    const r = await restore(into, ['--set', 'latest', '--reason', 'Disaster recovery'], { statfs: () => ({ total: 10 * 1024 ** 3, free: 1024 ** 3 }) });
    assert.equal(r.code, 1);
    assert.deepEqual(r.err, [RESTORE_TEXT.noSpace]);
    assert.deepEqual(await publicTables(into.db), []);
  });

  test('a successful restore into an empty database: row counts match, the post-steps ran and the operator text names the set time', async (t) => {
    if (!needTools(t)) return;
    const { name, startedAt } = await backup();
    const manifestTables = (await pool.query(`SELECT count(*) AS n FROM pg_tables WHERE schemaname = 'public'`)).rows[0].n;
    const into = await target();
    const r = await restore(into, ['--set', 'latest', '--reason', 'Server lost in the flood']);
    assert.equal(r.code, 0, r.err.join('\n'));
    assert.equal((await publicTables(into.db)).length, Number(manifestTables));
    for (const table of ['users', 'audit_events', 'notifications', 'email_outbox', 'backup_runs']) {
      if (table === 'audit_events' || table === 'notifications' || table === 'email_outbox') continue; // the post-steps add rows
      const live = Number((await pool.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);
      const restored = Number((await into.db.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);
      assert.equal(restored, live, `${table} rows`);
    }
    // The post-steps: sessions gone, the queued email not sent, protective mode on with the set time.
    assert.equal(Number((await into.db.query('SELECT count(*) AS n FROM sessions')).rows[0].n), 0);
    const mail = (await into.db.query(`SELECT status FROM email_outbox WHERE subject = 'Queued before the backup'`)).rows[0];
    assert.equal(mail.status, 'not_sent_restored');
    const state = (await into.db.query('SELECT protective, reason, detail FROM operations_state')).rows[0];
    assert.deepEqual([state.protective, state.reason, state.detail.setTime], [true, 'restored_from_backup', startedAt]);
    // The run that made the set was 'running' when it was dumped; in the restored database it is the succeeded set.
    const run = (await into.db.query(`SELECT outcome, set_name FROM backup_runs WHERE set_name = $1`, [name])).rows[0];
    assert.equal(run.outcome, 'succeeded');
    assert.equal(Number((await into.db.query(`SELECT count(*) AS n FROM backup_runs WHERE outcome = 'running'`)).rows[0].n), 0);
    // The operator text, with the set time; nothing names the database, the folder or a password.
    assert.ok(r.out.includes(RESTORE_TEXT.done(new Date(startedAt))), r.out.join('\n'));
    assert.ok(RESTORE_TEXT.done(new Date(startedAt)).includes('2026-11-21 02:'), 'the time is shown as UTC minutes');
    const all = [...r.out, ...r.err].join('\n');
    for (const bad of [into.url, folder, ':test@', 'postgres://', '15432']) assert.ok(!all.includes(bad), `output must not contain ${bad}`);
    // A second restore into the same (now full) database is refused.
    const again = await restore(into, ['--set', 'latest', '--reason', 'Again']);
    assert.deepEqual([again.code, again.err], [1, [RESTORE_TEXT.notEmpty]]);
  });

  test('without the protected key the output says so', async (t) => {
    if (!needTools(t)) return;
    await backup();
    const into = await target();
    const r = await restore(into, ['--set', 'latest', '--reason', 'Disaster recovery'], { protectedKeyPresent: false });
    assert.equal(r.code, 0, r.err.join('\n'));
    assert.ok(r.out.includes(RESTORE_TEXT.noProtectedKey));
  });

  test('a decryption failure during the restore is fatal: no post-steps, and the target must be recreated empty', async (t) => {
    if (!needTools(t)) return;
    const { name } = await backup();
    // Damage the end of the dump and record the damaged file's checksum, so the set check passes and the restore itself
    // meets the damage after pg_restore has already written part of the database.
    const dir = join(setsDir(), name);
    const file = join(dir, 'database.dump.enc');
    const bytes = readFileSync(file);
    bytes[bytes.length - 40] ^= 0xff;
    writeFileSync(file, bytes);
    const summary = JSON.parse(readFileSync(join(dir, 'backup.json'), 'utf8'));
    summary.files['database.dump.enc'].sha256 = createHash('sha256').update(bytes).digest('hex');
    writeFileSync(join(dir, 'backup.json'), JSON.stringify(summary));
    const into = await target();
    const r = await restore(into, ['--set', name, '--reason', 'Disaster recovery']);
    assert.equal(r.code, 1);
    assert.deepEqual(r.err, [RESTORE_TEXT.decryptFailed]);
    assert.match(RESTORE_TEXT.decryptFailed, /Recreate the target database empty/, 'the operator is told to recreate the target empty');
    // pg_restore ran as one transaction: the failure rolled it back, so nothing of the dump (and no afterRestore) is there.
    await assertEmpty(into.db);
  });

  test('free space falling during the restore rolls the whole restore back: the target stays empty', async (t) => {
    if (!needTools(t)) return;
    await backup();
    const into = await target();
    let calls = 0;
    const r = await restore(into, ['--set', 'latest', '--reason', 'Disaster recovery'], {
      pollMs: 1,
      statfs: () => {
        calls++;
        return { total: 10 * TB, free: calls >= 2 ? 6 * 1024 ** 3 : 5 * TB };
      },
    });
    assert.equal(r.code, 1);
    assert.deepEqual(r.err, [RESTORE_TEXT.spaceLow]);
    assert.ok(calls >= 2);
    await assertEmpty(into.db);
  });

  test('pg_restore failing after the tables and their rows are written rolls the whole restore back: the target stays empty', async (t) => {
    if (!needTools(t)) return;
    await backup();
    const into = await target();
    // Not a table, so the target still counts as empty; it makes the post-data step CREATE UNIQUE INDEX users_email_key fail
    // after every table has been created and filled.
    await into.db.query('CREATE SEQUENCE public.users_email_key');
    const r = await restore(into, ['--set', 'latest', '--reason', 'Disaster recovery']);
    assert.equal(r.code, 1);
    assert.deepEqual(r.err, [RESTORE_TEXT.restoreFailed]);
    await assertEmpty(into.db);
  });

  test('the refusal and stop texts tell the operator to drop and recreate the target empty, never to start Kainow on it', () => {
    for (const text of [RESTORE_TEXT.notEmpty, RESTORE_TEXT.unexpected]) {
      assert.match(text, /drop and recreate (it|the target database) empty/);
      assert.match(text, /[Dd]o not start Kainow/);
    }
    assert.match(RESTORE_TEXT.notEmpty, /interrupted/);
    for (const text of [RESTORE_TEXT.decryptFailed, RESTORE_TEXT.spaceLow, RESTORE_TEXT.restoreFailed, RESTORE_TEXT.afterFailed, RESTORE_TEXT.rowCounts(['public.users'])]) {
      assert.match(text, /Recreate the target database empty before trying again\./);
    }
  });
});

describe('afterRestore', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let ids: Record<string, string>;
  let project: string;
  let pm: Client;

  beforeEach(async () => {
    t = await startTestApp();
    await t.pool.query(`DROP SCHEMA IF EXISTS ${BOSS_SCHEMA} CASCADE`);
    ids = {};
    ids.admin1 = await seedUser(t.pool, 'ar-admin1@example.org', 'enterprise_administrator');
    ids.admin2 = await seedUser(t.pool, 'ar-admin2@example.org', 'enterprise_administrator');
    ids.gone = await seedUser(t.pool, 'ar-gone@example.org', 'enterprise_administrator');
    await t.pool.query(`UPDATE users SET status = 'disabled' WHERE id = $1`, [ids.gone]);
    ids.pm = await seedUser(t.pool, 'ar-pm@example.org');
    project = await seedProject(t.pool, { name: 'Alpha Project', status: 'active', members: [{ userId: ids.pm, role: 'pm' }] });
    pm = await t.signIn('ar-pm@example.org');
  });
  afterEach(async () => {
    await t.pool.query(`DROP SCHEMA IF EXISTS ${BOSS_SCHEMA} CASCADE`);
    await t.close();
  });

  async function seedWork(): Promise<Record<string, string>> {
    const now = t.clock.now();
    const w: Record<string, string> = {};
    // An unused sign-in code, a used one, and a recovery link.
    w.code = uuidv7();
    await t.pool.query(`INSERT INTO login_codes (id, user_id, code_hash, expires_at) VALUES ($1, $2, 'h', $3)`, [w.code, ids.admin1, new Date(now.getTime() + 600_000)]);
    w.usedCode = uuidv7();
    await t.pool.query(`INSERT INTO login_codes (id, user_id, code_hash, expires_at, consumed_at) VALUES ($1, $2, 'h2', $3, $3)`, [w.usedCode, ids.admin1, now]);
    w.link = uuidv7();
    await t.pool.query(
      `INSERT INTO setup_invitations (id, user_id, email, token_hash, created_at, expires_at, kind, prior_role, prior_status)
       VALUES ($1, $2, 'ar-admin2@example.org', 'link-hash', $3, $4, 'recovery', 'enterprise_administrator', 'active')`,
      [w.link, ids.admin2, now, new Date(now.getTime() + 86_400_000)],
    );
    // Emails: queued, retry_wait, sent.
    const email = async (status: string) => {
      const id = uuidv7();
      await t.pool.query(
        `INSERT INTO email_outbox (id, to_address, subject, text_body, kind, initiated_by, status, next_attempt_at, created_at)
         VALUES ($1, 'someone@example.org', 's', 'b', 'test', 'system', $2, $3, $4)`,
        [id, status, status === 'sent' ? null : now, now],
      );
      return id;
    };
    w.queued = await email('queued');
    w.retry = await email('retry_wait');
    w.sent = await email('sent');
    // A running AI assist request with an open reservation.
    w.ai = uuidv7();
    await t.pool.query(
      `INSERT INTO ai_requests (id, project_id, kind, requested_by, status, scope, created_at, attempts) VALUES ($1, $2, 'question', $3, 'running', 'personal', $4, 1)`,
      [w.ai, project, ids.pm, now],
    );
    w.reservation = uuidv7();
    await t.pool.query(
      `INSERT INTO ai_spend_entries (id, request_id, attempt_no, created_at, updated_at, status, purpose, model_id, input_usd_per_million_micro,
                                     cached_input_usd_per_million_micro, output_usd_per_million_micro, myr_per_usd_micro, estimate_micro_myr,
                                     amount_micro_myr, project_id)
       VALUES ($1, $2, 1, $3, $3, 'reserved', 'question_answer', 'test-model', 2000000, 100000, 10000000, 4100000, 1000, 1000, $4)`,
      [w.reservation, w.ai, now, project],
    );
    // A queued analysis run on a thread, and a queued extraction run on a note.
    const thread = await pm.request('POST', `/projects/${project}/threads`, { kind: 'discussion', title: 'Release plan' });
    assert.equal(thread.status, 201, JSON.stringify(thread.body));
    w.analysis = uuidv7();
    await t.pool.query(
      `INSERT INTO analysis_runs (id, thread_id, kind, trigger, requested_by, status, created_at) VALUES ($1, $2, 'proposals', 'button', $3, 'queued', $4)`,
      [w.analysis, thread.body.id, ids.pm, now],
    );
    const note = await pm.request('POST', `/projects/${project}/notes`, { title: 'Plant room', text: 'We agreed to ship on Friday.' });
    assert.equal(note.status, 201, JSON.stringify(note.body));
    const version = (await t.pool.query(`SELECT id FROM source_versions ORDER BY created_at DESC, id DESC LIMIT 1`)).rows[0].id;
    w.extraction = uuidv7();
    await t.pool.query(
      `INSERT INTO extraction_runs (id, source_version_id, requested_by, status, created_at) VALUES ($1, $2, $3, 'queued', $4)`,
      [w.extraction, version, ids.pm, now],
    );
    return w;
  }

  async function inTx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await t.pool.connect();
    try {
      await c.query('BEGIN');
      const r = await fn(c);
      await c.query('COMMIT');
      return r;
    } catch (err) {
      await c.query('ROLLBACK');
      throw err;
    } finally {
      c.release();
    }
  }

  test('ends sessions, codes, links, emails, work and jobs; turns on protective mode; tells every Active administrator', async () => {
    const w = await seedWork();
    // Queued pg-boss jobs, written by pg-boss itself.
    const boss = await startQueues(testDatabaseUrl() as string, BOSS_SCHEMA, { supervise: false, schedule: false });
    await boss.send(QUEUES.ai, { id: w.ai });
    await boss.send(QUEUES.email, { nudge: true });
    await boss.send(QUEUES.analysis, { id: w.analysis });
    await boss.stop({ graceful: false });
    const liveJobs = Number((await t.pool.query(`SELECT count(*) AS n FROM ${BOSS_SCHEMA}.job WHERE state IN ('created', 'retry', 'active')`)).rows[0].n);
    assert.ok(liveJobs >= 3);

    const setTime = new Date('2026-11-08T02:00:00Z');
    const now = t.clock.now();
    const result = await inTx((c) => afterRestore(c, { setTime, setName: '2026-11-08T0200Z-x', reason: 'Server lost in the flood', now }));

    assert.equal(result.emails, 2);
    assert.equal(result.jobs, liveJobs);
    assert.deepEqual(result.work, { ai_requests: 1, analysis_runs: 1, extraction_runs: 1 });

    // Sessions and unused codes gone; the used code kept; the link expired.
    assert.equal(Number((await t.pool.query('SELECT count(*) AS n FROM sessions')).rows[0].n), 0);
    const codes = (await t.pool.query('SELECT id FROM login_codes ORDER BY id')).rows.map((r) => r.id);
    assert.ok(!codes.includes(w.code));
    assert.ok(codes.includes(w.usedCode));
    const link = (await t.pool.query('SELECT expires_at FROM setup_invitations WHERE id = $1', [w.link])).rows[0];
    assert.ok(new Date(link.expires_at).getTime() <= now.getTime(), 'the link is expired');
    assert.equal((await pm.request('GET', '/auth/me')).status, 401, 'the old session no longer works');

    // Emails.
    const status = async (id: string) => (await t.pool.query('SELECT status, next_attempt_at, last_reason FROM email_outbox WHERE id = $1', [id])).rows[0];
    for (const id of [w.queued, w.retry]) {
      const s = await status(id);
      assert.equal(s.status, 'not_sent_restored');
      assert.equal(s.next_attempt_at, null);
      assert.equal(s.last_reason, 'Not sent — restored from backup');
    }
    assert.equal((await status(w.sent)).status, 'sent');

    // Work rows.
    for (const table of ['ai_requests', 'analysis_runs', 'extraction_runs']) {
      const id = table === 'ai_requests' ? w.ai : table === 'analysis_runs' ? w.analysis : w.extraction;
      const r = (await t.pool.query(`SELECT status, failure_code, failure_detail, finished_at FROM ${table} WHERE id = $1`, [id])).rows[0];
      assert.deepEqual([r.status, r.failure_code, r.failure_detail], ['failed', 'restored_from_backup', 'Not run — restored from backup'], table);
      assert.equal(new Date(r.finished_at).getTime(), now.getTime());
    }
    assert.equal(unavailableReason('restored_from_backup', null), 'not run — restored from backup');
    const entry = (await t.pool.query('SELECT status, amount_micro_myr FROM ai_spend_entries WHERE id = $1', [w.reservation])).rows[0];
    assert.equal(entry.status, 'uncertain', 'the reservation stays counted, never released');
    assert.equal(Number(entry.amount_micro_myr), 1000);

    // Jobs.
    assert.equal(Number((await t.pool.query(`SELECT count(*) AS n FROM ${BOSS_SCHEMA}.job WHERE state IN ('created', 'retry', 'active')`)).rows[0].n), 0);
    assert.ok(Number((await t.pool.query(`SELECT count(*) AS n FROM ${BOSS_SCHEMA}.job WHERE state = 'cancelled'`)).rows[0].n) >= liveJobs);

    // Protective mode.
    const state = (await t.pool.query('SELECT protective, reason, since, detail FROM operations_state')).rows[0];
    assert.deepEqual([state.protective, state.reason, state.detail.setTime], [true, 'restored_from_backup', setTime.toISOString()]);
    assert.equal(new Date(state.since).getTime(), now.getTime());
    const change = (await t.pool.query(`SELECT action, reason FROM operations_state_changes ORDER BY at DESC, id DESC LIMIT 1`)).rows[0];
    assert.deepEqual([change.action, change.reason], ['entered', 'restored_from_backup']);

    // Notices: one urgent notice per Active Enterprise Administrator, none for the disabled one; their emails stay queued.
    const notices = (await t.pool.query(`SELECT user_id, urgent, summary, outbox_id FROM notifications WHERE kind = 'restored_from_backup' ORDER BY user_id`)).rows;
    assert.deepEqual(notices.map((n) => n.user_id).sort(), [ids.admin1, ids.admin2].sort());
    for (const n of notices) {
      assert.equal(n.urgent, true);
      assert.ok(n.summary.includes('2026-11-08 02:00 UTC'), n.summary);
      assert.equal((await status(n.outbox_id)).status, 'queued', 'the notice email still goes out');
    }

    // Audit.
    const audit = (await t.pool.query(`SELECT detail FROM audit_events WHERE action = 'ops.restored_from_backup'`)).rows;
    assert.equal(audit.length, 1);
    assert.equal(audit[0].detail.setName, '2026-11-08T0200Z-x');
    assert.equal(audit[0].detail.setTime, setTime.toISOString());
    assert.equal(audit[0].detail.reason, 'Server lost in the flood');
  });

  test('a later analysis tick does not rewrite the ended rows', async () => {
    const w = await seedWork();
    const now = t.clock.now();
    await inTx((c) => afterRestore(c, { setTime: new Date('2026-11-08T02:00:00Z'), setName: 's', reason: 'r', now }));
    const before = async () =>
      (
        await t.pool.query(
          `SELECT 'a' AS t, status, failure_code, failure_detail, finished_at FROM analysis_runs WHERE id = $1
           UNION ALL SELECT 'e', status, failure_code, failure_detail, finished_at FROM extraction_runs WHERE id = $2
           UNION ALL SELECT 'r', status, failure_code, failure_detail, finished_at FROM ai_requests WHERE id = $3 ORDER BY 1`,
          [w.analysis, w.extraction, w.ai],
        )
      ).rows;
    const was = await before();
    t.clock.advanceMinutes(120);
    const tick = new AnalysisTick({ pool: t.pool, clock: t.clock.now, queue: { enqueue: async () => undefined }, spend: new SpendService(t.pool, t.clock.now), key: null });
    await tick.run();
    assert.deepEqual(await before(), was);
  });

  test('a backup taken while protective mode was on is still marked restored_from_backup with the set time', async () => {
    await t.pool.query(`UPDATE operations_state SET protective = true, reason = 'low_space', since = $1, detail = '{}'`, [t.clock.now()]);
    const setTime = new Date('2026-11-08T02:00:00Z');
    await inTx((c) => afterRestore(c, { setTime, setName: 's', reason: 'r', now: t.clock.now() }));
    const state = (await t.pool.query('SELECT protective, reason, detail FROM operations_state')).rows[0];
    assert.deepEqual([state.protective, state.reason, state.detail.setTime], [true, 'restored_from_backup', setTime.toISOString()]);
  });
});
