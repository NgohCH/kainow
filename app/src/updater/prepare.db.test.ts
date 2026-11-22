import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Pool } from 'pg';
import { uuidv7 } from '../common/uuid7';
import { loadDatabaseConfig } from '../config';
import { runMigrations } from '../db/migrate';
import { SKIP_NO_DB, resetPublicSchema, testDatabaseUrl } from '../testing/db';
import { FakeRunner } from '../testing/fake-runner';
import { gitToolsMissing, makeReleaseRepos, type ReleaseRepos } from '../testing/git-releases';
import { seedUser } from '../testing/projects';
import { git } from './git';
import { prepareUpdate, stagingDir, type PrepareDeps } from './prepare';
import { RealRunner, type RunOptions, type Runner } from './runner';
import { runTick, type TickUpdate } from './tick';

const migrationsDir = loadDatabaseConfig({ DATABASE_URL: 'x' }).migrationsDir;
const NOW = new Date('2026-12-01T04:00:00Z');
const GB = 1024 ** 3;

const DB_JSON = JSON.stringify({
  name: 'kainow',
  services: {
    db: { image: 'postgres:16', volumes: [{ type: 'volume', source: 'kainow-db', target: '/var/lib/postgresql/data' }], environment: { POSTGRES_DB: 'kainow' } },
    api: { image: 'kainow-app:1.1.0' },
  },
});

/** Real git (fetch, verify, worktree) in throwaway repositories; docker scripted. */
class HybridRunner implements Runner {
  readonly docker = new FakeRunner();
  constructor(private readonly real: RealRunner) {}
  run(cmd: 'git' | 'docker', args: string[], opts?: RunOptions) {
    return cmd === 'git' ? this.real.run(cmd, args, opts) : this.docker.run(cmd, args, opts);
  }
}

describe('preparing an update (database and real git)', { skip: SKIP_NO_DB }, () => {
  let pool: Pool;
  let admin: string;
  let repos: ReleaseRepos;
  let commit: string;
  let skipGit: string | null;

  before(async () => {
    pool = new Pool({ connectionString: testDatabaseUrl() });
    await resetPublicSchema(pool);
    await runMigrations(pool, migrationsDir);
    admin = await seedUser(pool, 'prepare8-admin@example.org', 'enterprise_administrator');
    skipGit = await gitToolsMissing();
    if (skipGit) return;
    repos = await makeReleaseRepos();
    const key = await repos.newKey('release');
    await repos.release('1.0.0');
    await repos.tag('v1.0.0', { key });
    await repos.pushTag('v1.0.0');
    commit = await repos.release('1.1.0', { 'compose.yaml': 'services: {}\n' });
    await repos.tag('v1.1.0', { key, message: 'Kainow v1.1.0\n\n- faster search' });
    await repos.pushTag('v1.1.0');
    await repos.pushMain();
    for (const args of [['fetch', '-q', 'origin', 'refs/tags/v1.0.0:refs/tags/v1.0.0'], ['checkout', '-q', '--detach', 'v1.0.0']]) {
      const r = await git(repos.install, args);
      assert.equal(r.code, 0, r.stderr);
    }
    // The installation's trusted signers file (untracked, as in a real installation).
    await writeFile(join(repos.install, 'release-signers'), repos.signersText([key]));
  });
  after(async () => {
    await pool.end();
    if (repos) await repos.cleanup();
  });
  beforeEach(async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SET LOCAL session_replication_role = replica`);
      for (const t of ['update_steps', 'update_changes', 'updates', 'updater_ticks', 'email_outbox', 'notifications', 'audit_events']) {
        await c.query(`DELETE FROM ${t}`);
      }
      await c.query('COMMIT');
    } finally {
      c.release();
    }
  });

  async function seedUpdate(state: 'approved' | 'preparing' = 'approved'): Promise<TickUpdate> {
    const id = uuidv7();
    await pool.query(
      `INSERT INTO updates (id, from_version, to_version, tag, commit, state, starts_at, expected_minutes, approved_by, approved_at, reason)
       VALUES ($1, '1.0.0', '1.1.0', 'v1.1.0', $2, $3, $4, 30, $5, $6, 'Monthly release')`,
      [id, commit, state, new Date(NOW.getTime() + 3600_000), admin, new Date(NOW.getTime() - 3600_000)],
    );
    return {
      id,
      state,
      fromVersion: '1.0.0',
      toVersion: '1.1.0',
      tag: 'v1.1.0',
      commit,
      tagObject: null,
      startsAt: new Date(NOW.getTime() + 3600_000),
      expectedMinutes: 30,
      preUpdateBackupRunId: null,
    };
  }

  /** Docker scripted: the staging configuration (`next`) against the running one, and the build's exit code. */
  function deps(onBuild?: () => Promise<void> | void, buildCode = 0, next = DB_JSON) {
    const runner = new HybridRunner(new RealRunner(repos.install));
    runner.docker.on('docker', ['compose'], async (args) => {
      if (args.at(-1) === 'build') {
        await onBuild?.();
        return { code: buildCode, stdout: '', stderr: buildCode ? 'failed to solve' : '' };
      }
      const dir = args[args.indexOf('--project-directory') + 1];
      return { code: 0, stdout: args.includes('json') ? (dir === repos.install ? DB_JSON : next) : '', stderr: '' };
    });
    runner.docker.on('docker', ['run'], { code: 0, stdout: '1.1.0\n', stderr: '' });
    let t = NOW.getTime();
    const lines: string[] = [];
    const d: PrepareDeps = {
      pool,
      runner,
      installDir: repos.install,
      projectName: 'kainow',
      now: () => new Date((t += 1000)),
      log: (l) => lines.push(l),
      statfs: () => ({ total: 500 * GB, free: 100 * GB }),
    };
    return { d, lines, runner };
  }

  const row = async (id: string) => (await pool.query(`SELECT * FROM updates WHERE id = $1`, [id])).rows[0];
  const steps = async (id: string) =>
    (await pool.query(`SELECT step, outcome, failure_code FROM update_steps WHERE update_id = $1 ORDER BY started_at, id`, [id])).rows.map(
      (r) => `${r.step}:${r.outcome}${r.failure_code ? `:${r.failure_code}` : ''}`,
    );
  const changes = async (id: string) =>
    (await pool.query(`SELECT detail FROM update_changes WHERE update_id = $1 AND action = 'state_changed' ORDER BY at, id`, [id])).rows.map(
      (r) => `${r.detail.from}>${r.detail.to}`,
    );
  const staging = () => stagingDir(repos.install, 'v1.1.0');

  test('steps and states are recorded in order (ORDER BY started_at, id)', async (t) => {
    if (skipGit) return t.skip(skipGit);
    const u = await seedUpdate();
    const { d } = deps();
    assert.equal(await prepareUpdate(d, u), 'ready');
    assert.deepEqual(await steps(u.id), [
      'space:passed',
      'working_tree:passed',
      'verify:passed',
      'staging:passed',
      'compatibility:passed',
      'build:passed',
    ]);
    assert.deepEqual(await changes(u.id), ['approved>preparing', 'preparing>ready']);
    const r = await row(u.id);
    assert.equal(r.state, 'ready');
    const tagObject = (await git(repos.install, ['rev-parse', 'refs/kainow/candidate/v1.1.0'])).stdout.trim();
    assert.equal(r.tag_object, tagObject);
    assert.equal(r.release_notes, 'Kainow v1.1.0\n\n- faster search');
    assert.equal(r.failure_code, null);
    // The staging checkout holds the new code; the installation is untouched.
    assert.equal(JSON.parse(readFileSync(join(staging(), 'app', 'package.json'), 'utf8')).version, '1.1.0');
    assert.equal(JSON.parse(readFileSync(join(repos.install, 'app', 'package.json'), 'utf8')).version, '1.0.0');
  });

  test('a refusal records its code, audit and notice, and removes staging', async (t) => {
    if (skipGit) return t.skip(skipGit);
    const u = await seedUpdate();
    const { d } = deps(undefined, 0, DB_JSON.replace('postgres:16', 'postgres:17'));
    assert.equal(await prepareUpdate(d, u), 'refused');
    const r = await row(u.id);
    assert.deepEqual([r.state, r.failure_code, r.finished_at instanceof Date], ['refused', 'db_service_changed', true]);
    assert.deepEqual(await steps(u.id), [
      'space:passed',
      'working_tree:passed',
      'verify:passed',
      'staging:passed',
      'compatibility:failed:db_service_changed',
    ]);
    assert.deepEqual(await changes(u.id), ['approved>preparing', 'preparing>refused']);
    const audit = (await pool.query(`SELECT action, subject_id, detail FROM audit_events WHERE action LIKE 'ops.update_%'`)).rows;
    assert.deepEqual(audit, [{ action: 'ops.update_refused', subject_id: u.id, detail: { tag: 'v1.1.0', failureCode: 'db_service_changed' } }]);
    const notes = (await pool.query(`SELECT user_id, kind, urgent, summary FROM notifications`)).rows;
    assert.equal(notes.length, 1);
    assert.deepEqual([notes[0].user_id, notes[0].kind, notes[0].urgent], [admin, 'update_refused', true]);
    assert.match(notes[0].summary, /^The update to v1\.1\.0 was refused: /);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM email_outbox WHERE kind = 'update_refused'`)).rows[0].n, 1);
    assert.ok(!existsSync(staging()));
    assert.ok(!(await git(repos.install, ['worktree', 'list'])).stdout.includes('.kainow-staging'));
  });

  test('a failed build is failed_before_install with ops.update_failed', async (t) => {
    if (skipGit) return t.skip(skipGit);
    const u = await seedUpdate();
    const { d } = deps(undefined, 1);
    assert.equal(await prepareUpdate(d, u), 'failed_before_install');
    const r = await row(u.id);
    assert.deepEqual([r.state, r.failure_code], ['failed_before_install', 'build_failed']);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'ops.update_failed'`)).rows[0].n, 1);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM notifications WHERE kind = 'update_failed'`)).rows[0].n, 1);
    assert.ok(!existsSync(staging()));
  });

  test('a cancel during the build wins: the row stays cancelled and staging is removed', async (t) => {
    if (skipGit) return t.skip(skipGit);
    const u = await seedUpdate();
    const { d } = deps(async () => {
      await pool.query(`UPDATE updates SET state = 'cancelled', cancelled_by = $2, cancelled_at = $3, cancel_reason = 'Not now', finished_at = $3 WHERE id = $1`, [
        u.id,
        admin,
        NOW,
      ]);
    });
    assert.equal(await prepareUpdate(d, u), 'cancelled');
    const r = await row(u.id);
    assert.deepEqual([r.state, r.failure_code], ['cancelled', null]);
    assert.deepEqual(await changes(u.id), ['approved>preparing']);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM notifications`)).rows[0].n, 0);
    assert.ok(!existsSync(staging()));
  });

  test('re-entry from preparing: a dead tick\'s running step is closed and preparation finishes', async (t) => {
    if (skipGit) return t.skip(skipGit);
    const u = await seedUpdate('preparing');
    await pool.query(`INSERT INTO update_steps (id, update_id, step, started_at, outcome) VALUES ($1, $2, 'build', $3, 'running')`, [
      uuidv7(NOW.getTime() - 60_000),
      u.id,
      new Date(NOW.getTime() - 60_000),
    ]);
    // a half-made staging checkout from that tick
    assert.equal((await git(repos.install, ['worktree', 'add', '--detach', staging(), commit])).code, 0);
    const { d } = deps();
    assert.equal(await prepareUpdate(d, { ...u, state: 'preparing' }), 'ready');
    const s = await steps(u.id);
    assert.equal(s[0], 'build:failed');
    assert.deepEqual(s.slice(1), ['space:passed', 'working_tree:passed', 'verify:passed', 'staging:passed', 'compatibility:passed', 'build:passed']);
    assert.deepEqual(await changes(u.id), ['preparing>ready'], 'no second approved>preparing');
    assert.equal((await row(u.id)).state, 'ready');
  });

  test('the tick prepares through prepareUpdate', async (t) => {
    if (skipGit) return t.skip(skipGit);
    const u = await seedUpdate();
    const { d } = deps();
    const out = await runTick({ ...d, now: () => NOW, prepare: async (x) => void (await prepareUpdate(d, x)), install: async () => undefined });
    assert.deepEqual(out, { did: 'prepared' });
    assert.equal((await row(u.id)).state, 'ready');
  });
});
