import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Pool } from 'pg';
import { uuidv7 } from '../common/uuid7';
import { loadDatabaseConfig } from '../config';
import { runMigrations } from '../db/migrate';
import { OperationsState } from '../ops/state';
import { SKIP_NO_DB, resetPublicSchema, testDatabaseUrl } from '../testing/db';
import { FakeRunner } from '../testing/fake-runner';
import { seedUser } from '../testing/projects';
import { MAINTENANCE_WAIT_MS, installUpdate, type InstallDeps, type InstallGit } from './install';
import { prepareUpdate, type PrepareDeps } from './prepare';
import type { UpdateState } from './states';
import { runTick, type TickUpdate } from './tick';
import { endMissedWindows } from './window-sweep';
import { runOpsSweep } from '../ops/sweep-ops';

const migrationsDir = loadDatabaseConfig({ DATABASE_URL: 'x' }).migrationsDir;
const NOW = new Date('2026-12-01T04:00:00Z');
const TAG_OBJECT = 'ab'.repeat(20);
const COMMIT = 'cd'.repeat(20);

describe('installing an update (database)', { skip: SKIP_NO_DB }, () => {
  let pool: Pool;
  let admin: string;
  let dir: string;
  let t: number;
  let runner: FakeRunner;
  let lines: string[];
  let git: InstallGit;
  let migrateCode: number;
  let head: string;
  let onBackup: () => Promise<void>;
  let crashOnMigrate: boolean;

  before(async () => {
    pool = new Pool({ connectionString: testDatabaseUrl() });
    await resetPublicSchema(pool);
    await runMigrations(pool, migrationsDir);
    admin = await seedUser(pool, 'install9-admin@example.org', 'enterprise_administrator');
  });
  after(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SET LOCAL session_replication_role = replica`);
      for (const tbl of ['update_steps', 'update_changes', 'updates', 'updater_ticks', 'email_outbox', 'notifications', 'audit_events', 'operations_state_changes', 'backup_runs', 'storage_readings']) {
        await c.query(`DELETE FROM ${tbl}`);
      }
      await c.query(`UPDATE operations_state SET protective = false, reason = NULL, since = NULL, detail = NULL, changed_by = NULL WHERE id`);
      await c.query('COMMIT');
    } finally {
      c.release();
    }
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = await mkdtemp(join(tmpdir(), 'kainow-install-db-'));
    await mkdir(join(dir, 'release'));
    await writeFile(join(dir, 'release-signers'), 'OLD\n');
    await writeFile(join(dir, 'release', 'release-signers'), 'NEW\n');
    t = NOW.getTime();
    lines = [];
    migrateCode = 0;
    head = 'v1.0.0';
    onBackup = async () => undefined;
    crashOnMigrate = false;
    git = {
      workingTreeState: async () => ({ clean: true, changed: [], headTag: 'v1.0.0' }),
      fetchCandidate: async () => ({ ok: true, tagObject: TAG_OBJECT }),
    };
    runner = new FakeRunner();
    runner.on('git', ['rev-parse'], { code: 0, stdout: `${COMMIT}\n`, stderr: '' });
    runner.on('git', [], (args) => {
      if (args.includes('checkout')) head = args.at(-1)!;
      return { code: 0, stdout: '', stderr: '' };
    });
    runner.on('docker', ['inspect'], { code: 0, stdout: '0 2026-12-01T04:00:00Z\n', stderr: '' });
    runner.on('docker', ['compose'], async (args) => {
      const cmd = args.slice(args.lastIndexOf('--profile') + 2).join(' ');
      if (cmd.includes('backup-cli.js')) {
        await onBackup();
        const id = uuidv7(t);
        await pool.query(
          `INSERT INTO backup_runs (id, kind, started_at, finished_at, outcome) VALUES ($1, 'pre_update', $2, $2, 'succeeded')`,
          [id, new Date(t)],
        );
        return { code: 0, stdout: `run ${id} succeeded\n`, stderr: '' };
      }
      if (cmd === 'run --rm --no-deps migrate') {
        if (crashOnMigrate) throw new Error('the updater container was killed');
        return { code: migrateCode, stdout: '', stderr: migrateCode ? 'migration failed' : '' };
      }
      if (cmd.startsWith('ps')) {
        return {
          code: 0,
          stdout: [
            JSON.stringify({ ID: 'a1', Service: 'api', State: 'running', Health: 'healthy' }),
            JSON.stringify({ ID: 'w1', Service: 'worker', State: 'running' }),
          ].join('\n'),
          stderr: '',
        };
      }
      return { code: 0, stdout: '', stderr: '' };
    });
  });

  async function seedUpdate(state: UpdateState = 'ready', startsAt = NOW): Promise<TickUpdate> {
    const id = uuidv7();
    await pool.query(
      `INSERT INTO updates (id, from_version, to_version, tag, commit, tag_object, state, starts_at, expected_minutes, approved_by, approved_at, reason)
       VALUES ($1, '1.0.0', '1.1.0', 'v1.1.0', $2, $3, $4, $5, 30, $6, $7, 'Monthly release')`,
      [id, COMMIT, TAG_OBJECT, state, startsAt, admin, new Date(NOW.getTime() - 86_400_000)],
    );
    return {
      id,
      state,
      fromVersion: '1.0.0',
      toVersion: '1.1.0',
      tag: 'v1.1.0',
      commit: COMMIT,
      tagObject: TAG_OBJECT,
      startsAt,
      expectedMinutes: 30,
      preUpdateBackupRunId: null,
    };
  }

  const deps = (): InstallDeps => ({
    pool,
    runner,
    installDir: dir,
    projectName: 'kainow',
    now: () => new Date(t),
    log: (l) => lines.push(l),
    sleep: async (ms) => {
      t += ms;
    },
    git,
  });
  const row = async (id: string) => (await pool.query(`SELECT * FROM updates WHERE id = $1`, [id])).rows[0];
  const steps = async (id: string) =>
    (await pool.query(`SELECT step, outcome, failure_code FROM update_steps WHERE update_id = $1 ORDER BY started_at, id`, [id])).rows.map(
      (r) => `${r.step}:${r.outcome}${r.failure_code ? `:${r.failure_code}` : ''}`,
    );
  const count = async (sql: string) => (await pool.query(sql)).rows[0].n as number;
  const ops = async () => (await pool.query(`SELECT protective, reason, detail FROM operations_state WHERE id`)).rows[0];

  test('the happy path runs the steps in order and ends succeeded with maintenance off and audit ops.update_succeeded', async () => {
    const u = await seedUpdate();
    assert.equal(await installUpdate(deps(), u), 'succeeded');
    const r = await row(u.id);
    assert.equal(r.state, 'succeeded');
    assert.ok(r.finished_at);
    assert.ok(r.pre_update_backup_run_id);
    assert.deepEqual(await steps(u.id), [
      'recheck:passed', 'maintenance_on:passed', 'backup:passed', 'stop:passed', 'switch_code:passed', 'migrate:passed',
      'start:passed', 'health:passed', 'maintenance_off:passed', 'tidy:passed',
    ]);
    assert.equal((await ops()).protective, false);
    const changes = (await pool.query(`SELECT action, reason FROM operations_state_changes ORDER BY at, id`)).rows;
    assert.deepEqual(changes, [
      { action: 'entered', reason: 'update' },
      { action: 'resumed', reason: null },
    ]);
    assert.deepEqual((await pool.query(`SELECT action, subject_id, detail FROM audit_events WHERE action LIKE 'ops.update_%'`)).rows, [
      { action: 'ops.update_succeeded', subject_id: u.id, detail: { tag: 'v1.1.0' } },
    ]);
    assert.equal(await count(`SELECT count(*)::int AS n FROM notifications WHERE kind = 'update_succeeded' AND urgent`), 1);
    const states = (await pool.query(`SELECT detail FROM update_changes WHERE update_id = $1 ORDER BY at, id`, [u.id])).rows.map((x) => x.detail.to);
    assert.deepEqual(states, ['installing', 'succeeded']);
    assert.equal(head, COMMIT);
  });

  test('a low database-disk reading taken during the update puts Kainow in protective mode when maintenance ends (M4)', async () => {
    const u = await seedUpdate();
    onBackup = async () => {
      // The storage check runs while update maintenance is on: it records the reading but cannot enter protective mode.
      await pool.query(
        `INSERT INTO storage_readings (id, at, location, total_bytes, free_bytes, used_bytes) VALUES ($1, $2, 'database_disk', $3, $4, $5)`,
        [uuidv7(t), new Date(t), 100 * 1024 ** 3, 1024 ** 3, 99 * 1024 ** 3],
      );
    };
    assert.equal(await installUpdate(deps(), u), 'succeeded');
    const s = await ops();
    assert.deepEqual([s.protective, s.reason], [true, 'low_space']);
    const changes = (await pool.query(`SELECT action, reason FROM operations_state_changes ORDER BY at, id`)).rows;
    assert.deepEqual(changes, [
      { action: 'entered', reason: 'update' },
      { action: 'resumed', reason: null },
      { action: 'entered', reason: 'low_space' },
    ]);
    assert.equal(await count(`SELECT count(*)::int AS n FROM notifications WHERE kind = 'protective_mode_entered'`), 1);
  });

  test('a database-disk reading above the floor leaves maintenance simply ended (M4)', async () => {
    const u = await seedUpdate();
    await pool.query(`INSERT INTO storage_readings (id, at, location, total_bytes, free_bytes, used_bytes) VALUES ($1, $2, 'database_disk', $3, $3, 0)`, [
      uuidv7(t),
      new Date(t),
      100 * 1024 ** 3,
    ]);
    assert.equal(await installUpdate(deps(), u), 'succeeded');
    assert.equal((await ops()).protective, false);
  });

  test('maintenance is on before the backup command starts (Review Focus 3)', async () => {
    const u = await seedUpdate();
    let seen = false;
    onBackup = async () => {
      const s = await ops();
      assert.equal(s.protective, true);
      assert.equal(s.reason, 'update');
      assert.deepEqual(s.detail, { updateId: u.id, version: '1.1.0' });
      // Any process reading the state from now on refuses saves with the update text.
      const fresh = new OperationsState(pool);
      assert.deepEqual(await fresh.current().then((x) => [x.protective, x.reason]), [true, 'update']);
      assert.ok(t - NOW.getTime() >= MAINTENANCE_WAIT_MS);
      assert.deepEqual((await steps(u.id)).slice(0, 3), ['recheck:passed', 'maintenance_on:passed', 'backup:running']);
      seen = true;
    };
    assert.equal(await installUpdate(deps(), u), 'succeeded');
    assert.ok(seen);
  });

  test('migration failure: notice page started, previous tag checked out, failed_after_migration with the pre-update run id, no outbox rows written', async () => {
    const u = await seedUpdate();
    migrateCode = 1;
    assert.equal(await installUpdate(deps(), u), 'failed_after_migration');
    const r = await row(u.id);
    assert.equal(r.state, 'failed_after_migration');
    assert.equal(r.failure_code, 'migration_failed');
    const run = (await pool.query(`SELECT id FROM backup_runs WHERE kind = 'pre_update'`)).rows[0].id;
    assert.equal(r.pre_update_backup_run_id, run);
    assert.equal(head, 'v1.0.0');
    assert.ok(runner.lines('docker').some((l) => l.endsWith('up -d --no-deps notice')));
    assert.equal(await count(`SELECT count(*)::int AS n FROM email_outbox`), 0);
    assert.equal(await count(`SELECT count(*)::int AS n FROM notifications`), 0);
    assert.equal(await count(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'ops.update_failed'`), 1);
    // Maintenance stays on in the database that `recover` sets aside.
    assert.equal((await ops()).reason, 'update');
    assert.deepEqual((await steps(u.id)).slice(-2), ['migrate:failed:migration_failed', 'notice_page:passed']);
  });

  test('a failure before the stop: failed_before_install, maintenance off, audit and notice', async () => {
    const u = await seedUpdate();
    runner = (() => {
      const base = runner;
      const r = new FakeRunner();
      r.on('docker', ['compose'], (args) =>
        args.includes('dist/ops/backup-cli.js') ? { code: 1, stdout: '', stderr: '' } : base.run('docker', args),
      );
      r.on('git', [], (args) => base.run('git', args));
      r.on('docker', [], (args) => base.run('docker', args));
      return r;
    })();
    assert.equal(await installUpdate(deps(), u), 'failed_before_install');
    const r = await row(u.id);
    assert.equal(r.failure_code, 'backup_failed');
    assert.equal((await ops()).protective, false);
    assert.equal(await count(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'ops.update_failed'`), 1);
    assert.equal(await count(`SELECT count(*)::int AS n FROM notifications WHERE kind = 'update_failed'`), 1);
    assert.ok(!runner.lines('docker').some((l) => l.endsWith('stop api worker')));
    // Kainow was never stopped: everyone warned of the outage gets the "update cancelled" email (PO, 23 November 2026).
    const mail = (await pool.query(`SELECT to_address, subject FROM email_outbox WHERE kind = 'update_cancelled'`)).rows;
    assert.equal(mail.length, await count(`SELECT count(*)::int AS n FROM users WHERE status = 'active'`));
    assert.ok(mail.length > 0);
  });

  test('a cancel during the re-check wins: nothing is installed', async () => {
    const u = await seedUpdate();
    git.fetchCandidate = async () => {
      await pool.query(`UPDATE updates SET state = 'cancelled', cancelled_by = $2, cancelled_at = $3, cancel_reason = 'Not now' WHERE id = $1`, [u.id, admin, NOW]);
      return { ok: true, tagObject: TAG_OBJECT };
    };
    assert.equal(await installUpdate(deps(), u), 'cancelled');
    assert.equal((await row(u.id)).state, 'cancelled');
    assert.equal((await ops()).protective, false);
    assert.ok(!runner.calls.some((c) => c.cmd === 'docker'));
    assert.deepEqual(await steps(u.id), ['recheck:skipped']);
  });

  test('a new start time set during the re-check wins: the row stays ready', async () => {
    const u = await seedUpdate();
    git.fetchCandidate = async () => {
      await pool.query(`UPDATE updates SET starts_at = $2 WHERE id = $1`, [u.id, new Date(NOW.getTime() + 86_400_000)]);
      return { ok: true, tagObject: TAG_OBJECT };
    };
    assert.equal(await installUpdate(deps(), u), 'ready');
    assert.equal((await row(u.id)).state, 'ready');
    assert.ok(!runner.calls.some((c) => c.cmd === 'docker'));
  });

  test('a tag object that changed since preparation is refused tag_changed before maintenance', async () => {
    const u = await seedUpdate();
    git.fetchCandidate = async () => ({ ok: true, tagObject: 'ef'.repeat(20) });
    assert.equal(await installUpdate(deps(), u), 'refused');
    const r = await row(u.id);
    assert.equal(r.state, 'refused');
    assert.equal(r.failure_code, 'tag_changed');
    assert.equal(await count(`SELECT count(*)::int AS n FROM operations_state_changes`), 0);
    assert.equal(await count(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'ops.update_refused'`), 1);
    assert.equal(await count(`SELECT count(*)::int AS n FROM notifications WHERE kind = 'update_refused'`), 1);
    // M1: ended at the re-check; everyone told of the outage gets the "cancelled" email.
    assert.equal(await count(`SELECT count(*)::int AS n FROM email_outbox WHERE kind = 'update_cancelled'`), 1);
  });

  test('window_missed: a ready row 61 minutes past its start ends failed_before_install; audit, notice, email; maintenance untouched (D125)', async () => {
    const u = await seedUpdate('ready', new Date(NOW.getTime() - 61 * 60_000));
    assert.equal(await installUpdate(deps(), u), 'failed_before_install');
    const r = await row(u.id);
    assert.equal(r.state, 'failed_before_install');
    assert.equal(r.failure_code, 'window_missed');
    assert.ok(r.finished_at);
    assert.deepEqual(await steps(u.id), ['recheck:failed:window_missed']);
    assert.deepEqual((await pool.query(`SELECT detail FROM audit_events WHERE action = 'ops.update_failed'`)).rows, [
      { detail: { tag: 'v1.1.0', failureCode: 'window_missed' } },
    ]);
    const n = (await pool.query(`SELECT summary FROM notifications WHERE kind = 'update_failed' AND urgent`)).rows;
    assert.equal(n.length, 1);
    assert.match(n[0].summary, /within an hour of its start time.*Approve it again with a new start time\./);
    assert.equal(await count(`SELECT count(*)::int AS n FROM email_outbox WHERE kind = 'update_cancelled'`), 1);
    assert.equal(await count(`SELECT count(*)::int AS n FROM operations_state_changes`), 0, 'maintenance never went on');
    assert.ok(!runner.calls.some((c) => c.cmd === 'docker'));
    assert.deepEqual(
      (await pool.query(`SELECT detail FROM update_changes WHERE update_id = $1 ORDER BY at, id`, [u.id])).rows.map((x) => x.detail),
      [{ from: 'ready', to: 'failed_before_install', failureCode: 'window_missed' }],
    );
  });

  test('begin refuses a ready row whose hour ran out during the re-check; the next run ends it window_missed', async () => {
    const u = await seedUpdate('ready', new Date(NOW.getTime() - 59 * 60_000));
    git.fetchCandidate = async () => {
      t += 2 * 60_000; // the re-check took two minutes
      return { ok: true, tagObject: TAG_OBJECT };
    };
    assert.equal(await installUpdate(deps(), u), 'ready');
    assert.equal((await row(u.id)).state, 'ready');
    assert.deepEqual(await steps(u.id), ['recheck:skipped']);
    assert.ok(!runner.calls.some((c) => c.cmd === 'docker'));
    assert.equal(await installUpdate(deps(), u), 'failed_before_install');
    assert.equal((await row(u.id)).failure_code, 'window_missed');
  });

  test('the ops sweep ends approved and ready rows more than 60 minutes past their start; preparing, installing and on-time rows stay', async () => {
    const late = new Date(NOW.getTime() - 61 * 60_000);
    const cases: Array<[UpdateState, Date, string]> = [
      ['approved', late, 'failed_before_install'],
      ['ready', late, 'failed_before_install'],
      ['preparing', late, 'preparing'],
      ['installing', late, 'installing'],
      ['ready', new Date(NOW.getTime() - 60 * 60_000), 'ready'],
      ['approved', new Date(NOW.getTime() + 60 * 60_000), 'approved'],
    ];
    const clear = async () => {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query(`SET LOCAL session_replication_role = replica`);
        for (const tbl of ['update_steps', 'update_changes', 'updates', 'notifications', 'email_outbox', 'audit_events']) await c.query(`DELETE FROM ${tbl}`);
        await c.query('COMMIT');
      } finally {
        c.release();
      }
    };
    for (const [state, startsAt, want] of cases) {
      await clear();
      const u = await seedUpdate(state, startsAt);
      assert.equal(await endMissedWindows(pool, NOW), want === state ? 0 : 1, `${state} ${startsAt.toISOString()}`);
      const r = await row(u.id);
      assert.equal(r.state, want, `${state} ${startsAt.toISOString()}`);
      if (want !== state) {
        assert.equal(r.failure_code, 'window_missed');
        assert.equal(await count(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'ops.update_failed'`), 1);
        assert.equal(await count(`SELECT count(*)::int AS n FROM notifications WHERE kind = 'update_failed' AND urgent`), 1);
        assert.equal(await count(`SELECT count(*)::int AS n FROM email_outbox WHERE kind = 'update_cancelled'`), 1);
        const ch = (await pool.query(`SELECT detail FROM update_changes WHERE update_id = $1`, [u.id])).rows.map((x) => x.detail);
        assert.deepEqual(ch, [{ from: state, to: 'failed_before_install', failureCode: 'window_missed' }]);
        assert.equal(await endMissedWindows(pool, NOW), 0, 'idempotent');
      }
    }
    // Wired into the ops sweep.
    await clear();
    const u = await seedUpdate('approved', late);
    await runOpsSweep(pool, NOW).catch(() => undefined);
    assert.equal((await row(u.id)).failure_code, 'window_missed');
  });

  test('re-entry: the updater killed during the migration; the next tick finds the row installing and follows 5.7', async () => {
    const u = await seedUpdate();
    crashOnMigrate = true;
    const d = deps();
    const tick = (now: Date) =>
      runTick({ pool, runner, installDir: dir, now: () => now, log: (l) => lines.push(l), prepare: async () => undefined, install: (x) => installUpdate(d, x) });
    assert.equal((await tick(NOW)).did, 'failed');
    assert.equal((await row(u.id)).state, 'installing');
    assert.deepEqual((await steps(u.id)).slice(-1), ['migrate:running']);
    crashOnMigrate = false;
    // M6: the install ended failed_after_migration, so the tick records 'failed', not 'installed'.
    assert.equal((await tick(new Date(NOW.getTime() + 300_000))).did, 'failed');
    const r = await row(u.id);
    assert.equal(r.state, 'failed_after_migration');
    assert.equal(r.failure_code, 'migration_failed');
    assert.equal(await count(`SELECT count(*)::int AS n FROM update_steps WHERE outcome = 'running'`), 0);
    assert.equal(head, 'v1.0.0');
    assert.ok(runner.lines('docker').some((l) => l.endsWith('up -d --no-deps notice')));
    assert.ok(!runner.lines('docker').filter((l) => l.endsWith('run --rm --no-deps migrate')).slice(1).length, 'the migration is never run again');
    assert.equal(await count(`SELECT count(*)::int AS n FROM email_outbox`), 0);
  });

  test('re-entry before the migration goes back: failed_before_install, maintenance off', async () => {
    const u = await seedUpdate();
    await pool.query(`UPDATE updates SET state = 'installing' WHERE id = $1`, [u.id]);
    await pool.query(`UPDATE operations_state SET protective = true, reason = 'update', since = $1, detail = $2 WHERE id`, [
      NOW,
      JSON.stringify({ updateId: u.id, version: '1.1.0' }),
    ]);
    for (const [step, outcome] of [['recheck', 'passed'], ['maintenance_on', 'passed'], ['backup', 'passed'], ['stop', 'passed'], ['switch_code', 'running']]) {
      await pool.query(`INSERT INTO update_steps (id, update_id, step, started_at, finished_at, outcome) VALUES ($1, $2, $3, $4, $5, $6)`, [
        uuidv7(t),
        u.id,
        step,
        new Date(t),
        outcome === 'running' ? null : new Date(t),
        outcome,
      ]);
      t++; // the next step, and the re-entry's own steps, start a millisecond later
    }
    assert.equal(await installUpdate(deps(), { ...u, state: 'installing' }), 'failed_before_install');
    const r = await row(u.id);
    assert.equal(r.failure_code, 'checkout_failed');
    assert.equal((await ops()).protective, false);
    assert.equal(head, 'v1.0.0');
    assert.ok(runner.lines('docker').some((l) => l.endsWith('up -d --no-deps api worker')));
    assert.deepEqual((await steps(u.id)).slice(-2), ['switch_code:failed', 'go_back:passed']);
    // Kainow was stopped, so the outage happened: no "update cancelled" email.
    assert.equal(await count(`SELECT count(*)::int AS n FROM email_outbox WHERE kind = 'update_cancelled'`), 0);
  });

  test('a row still preparing more than 60 minutes after its start ends failed_before_install build_timeout and notifies', async () => {
    const u = await seedUpdate('preparing', new Date(NOW.getTime() - 61 * 60_000));
    const pd: PrepareDeps = { pool, runner, installDir: dir, projectName: 'kainow', now: () => NOW, log: (l) => lines.push(l), statfs: () => ({ total: 1e12, free: 1e12 }) };
    const out = await runTick({ ...pd, prepare: (x) => prepareUpdate(pd, x), install: async () => undefined });
    assert.equal(out.did, 'failed', 'M6: a preparation that ended failed is not recorded as prepared');
    const r = await row(u.id);
    assert.equal(r.state, 'failed_before_install');
    assert.equal(r.failure_code, 'build_timeout');
    assert.equal(await count(`SELECT count(*)::int AS n FROM notifications WHERE kind = 'update_failed'`), 1);
    assert.ok(!runner.lines('docker').some((l) => l.endsWith(' build')));
  });
});
