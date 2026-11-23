import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { Pool } from 'pg';
import { uuidv7 } from '../common/uuid7';
import { loadDatabaseConfig } from '../config';
import { runMigrations } from '../db/migrate';
import { SKIP_NO_DB, resetPublicSchema, testDatabaseUrl } from '../testing/db';
import { FakeRunner } from '../testing/fake-runner';
import { gitToolsMissing } from '../testing/git-releases';
import { seedUser } from '../testing/projects';
import { git } from './git';
import type { UpdateState } from './states';
import { recoveryLine, runTick, runUpdaterCli, signersFingerprint, type TickDeps, type TickUpdate } from './tick';

const migrationsDir = loadDatabaseConfig({ DATABASE_URL: 'x' }).migrationsDir;
const NOW = new Date('2026-12-01T04:00:00Z');
const MIN = 60_000;
const HOUR = 60 * MIN;
const at = (ms: number): Date => new Date(NOW.getTime() + ms);

function sshKeygen(args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile('ssh-keygen', args, { windowsHide: true }, (err, stdout) => {
      const e = err as (NodeJS.ErrnoException & { code?: number | string }) | null;
      resolve({ code: e ? (typeof e.code === 'number' ? e.code : 1) : 0, stdout: String(stdout) });
    });
  });
}

describe('the updater tick', { skip: SKIP_NO_DB }, () => {
  let pool: Pool;
  let admin: string;
  let emptyDir: string;

  before(async () => {
    pool = new Pool({ connectionString: testDatabaseUrl() });
    await resetPublicSchema(pool);
    await runMigrations(pool, migrationsDir);
    admin = await seedUser(pool, 'tick7-admin@example.org', 'enterprise_administrator');
    emptyDir = await mkdtemp(join(tmpdir(), 'kainow-tick-'));
  });
  after(async () => {
    await pool.end();
    await rm(emptyDir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SET LOCAL session_replication_role = replica`);
      for (const t of ['update_steps', 'update_changes', 'updates', 'updater_ticks']) await c.query(`DELETE FROM ${t}`);
      await c.query('COMMIT');
    } finally {
      c.release();
    }
  });

  async function seedUpdate(state: UpdateState, over: { startsAt?: Date; finishedAt?: Date | null; approvedAt?: Date } = {}): Promise<string> {
    const id = uuidv7();
    await pool.query(
      `INSERT INTO updates (id, from_version, to_version, tag, commit, state, starts_at, expected_minutes, approved_by, approved_at, reason, finished_at)
       VALUES ($1, '1.0.0', '1.1.0', 'v1.1.0', $2, $3, $4, 30, $5, $6, 'Monthly release', $7)`,
      [id, 'a'.repeat(40), state, over.startsAt ?? at(HOUR), admin, over.approvedAt ?? at(-HOUR), over.finishedAt ?? null],
    );
    return id;
  }

  function deps(over: Partial<TickDeps> = {}) {
    const lines: string[] = [];
    const prepared: TickUpdate[] = [];
    const installed: TickUpdate[] = [];
    const d: TickDeps = {
      pool,
      runner: new FakeRunner(),
      installDir: emptyDir,
      now: () => NOW,
      log: (l) => lines.push(l),
      prepare: async (u) => void prepared.push(u),
      install: async (u) => void installed.push(u),
      ...over,
    };
    return { d, lines, prepared, installed };
  }

  const ticks = async () =>
    (await pool.query(`SELECT did, running_tag, key_fingerprint, at FROM updater_ticks ORDER BY at, id`)).rows as {
      did: string;
      running_tag: string | null;
      key_fingerprint: string | null;
      at: Date;
    }[];

  test('a second tick while the lock is held returns busy and records nothing', async () => {
    await seedUpdate('approved');
    const holder = await pool.connect();
    try {
      await holder.query(`SELECT pg_advisory_lock(hashtext('kainow.updater'))`);
      const { d, prepared } = deps();
      assert.deepEqual(await runTick(d), { did: 'busy' });
      assert.equal(prepared.length, 0);
      assert.deepEqual(await ticks(), []);
    } finally {
      await holder.query(`SELECT pg_advisory_unlock(hashtext('kainow.updater'))`);
      holder.release();
    }
    const { d, prepared } = deps();
    assert.deepEqual(await runTick(d), { did: 'prepared' }, 'the lock is free again');
    assert.equal(prepared.length, 1);
  });

  test('a tick records running_tag and key_fingerprint', async (t) => {
    const missing = await gitToolsMissing();
    if (missing) return t.skip(missing);
    const dir = await mkdtemp(join(tmpdir(), 'kainow-tick-repo-'));
    try {
      const must = async (args: string[]) => assert.equal((await git(dir, args)).code, 0, args.join(' '));
      await must(['init', '-q', '-b', 'main']);
      await must(['-c', 'user.name=T', '-c', 'user.email=t@example.org', 'commit', '-q', '--allow-empty', '-m', 'r']);
      await must(['-c', 'user.name=T', '-c', 'user.email=t@example.org', 'tag', '-a', 'v1.2.3', '-m', 'v1.2.3']);
      await must(['checkout', '-q', '--detach', 'v1.2.3']);
      // A throwaway key, made here; never a real one.
      const key = join(dir, '..', `${dir.split(/[\\/]/).pop()}-key`);
      assert.equal((await sshKeygen(['-q', '-t', 'ed25519', '-N', '', '-C', 'tick-test', '-f', key])).code, 0);
      const pub = (await readFile(`${key}.pub`, 'utf8')).trim().split(/\s+/);
      await writeFile(join(dir, 'release-signers'), `# trusted release keys\nkainow-release namespaces="git" ${pub[0]} ${pub[1]}\n`);
      const expected = (await sshKeygen(['-lf', `${key}.pub`])).stdout.trim().split(/\s+/)[1];
      assert.match(expected, /^SHA256:/);

      const { d } = deps({ installDir: dir });
      assert.deepEqual(await runTick(d), { did: 'nothing' });
      const rows = await ticks();
      assert.equal(rows.length, 1);
      assert.deepEqual([rows[0].did, rows[0].running_tag, rows[0].key_fingerprint], ['nothing', 'v1.2.3', expected]);
      assert.equal(rows[0].at.getTime(), NOW.getTime());
      await rm(key, { force: true });
      await rm(`${key}.pub`, { force: true });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('outside a repository and without a signers file the tick still records, with neither', async () => {
    const { d } = deps();
    assert.deepEqual(await runTick(d), { did: 'nothing' });
    const rows = await ticks();
    assert.deepEqual(rows.map((r) => [r.did, r.running_tag, r.key_fingerprint]), [['nothing', null, null]]);
  });

  test('signersFingerprint lists every key line, skipping comments and blank lines', () => {
    // A well-formed blob (type string, then 32 bytes), not a real key.
    const str = (b: Buffer) => Buffer.concat([Buffer.from([0, 0, 0, b.length]), b]);
    const blob = Buffer.concat([str(Buffer.from('ssh-ed25519')), str(Buffer.alloc(32, 7))]);
    const line = `kainow-release namespaces="git" ssh-ed25519 ${blob.toString('base64')} comment`;
    const one = signersFingerprint(`# c\n\n${line}\n`);
    assert.match(one ?? '', /^SHA256:[A-Za-z0-9+/]+$/);
    assert.equal(signersFingerprint(`${line}\n${line}\n`), `${one}, ${one}`);
    assert.equal(signersFingerprint('# nothing\n'), null);
    assert.equal(signersFingerprint('kainow-release garbage'), null);
  });

  describe('dispatch table', () => {
    const cases: Array<{ name: string; state: UpdateState | null; startsAt?: Date; did: string; prepare: number; install: number }> = [
      { name: 'no update', state: null, did: 'nothing', prepare: 0, install: 0 },
      { name: 'approved → prepare', state: 'approved', did: 'prepared', prepare: 1, install: 0 },
      { name: 'preparing (the last tick died) → prepare again', state: 'preparing', did: 'prepared', prepare: 1, install: 0 },
      { name: 'ready, start ahead → nothing', state: 'ready', startsAt: at(MIN), did: 'nothing', prepare: 0, install: 0 },
      { name: 'ready, start reached → install', state: 'ready', startsAt: NOW, did: 'installed', prepare: 0, install: 1 },
      { name: 'ready, start passed → install', state: 'ready', startsAt: at(-10 * MIN), did: 'installed', prepare: 0, install: 1 },
      { name: 'installing with a free lock → install (re-entry)', state: 'installing', startsAt: at(-10 * MIN), did: 'installed', prepare: 0, install: 1 },
      { name: 'succeeded → nothing', state: 'succeeded', did: 'nothing', prepare: 0, install: 0 },
      { name: 'refused → nothing', state: 'refused', did: 'nothing', prepare: 0, install: 0 },
      { name: 'cancelled → nothing', state: 'cancelled', did: 'nothing', prepare: 0, install: 0 },
      { name: 'failed_before_install → nothing', state: 'failed_before_install', did: 'nothing', prepare: 0, install: 0 },
      { name: 'recovered → nothing', state: 'recovered', did: 'nothing', prepare: 0, install: 0 },
    ];
    for (const c of cases) {
      test(c.name, async () => {
        const id = c.state ? await seedUpdate(c.state, { startsAt: c.startsAt }) : null;
        const { d, prepared, installed } = deps();
        assert.deepEqual(await runTick(d), { did: c.did });
        assert.equal(prepared.length, c.prepare);
        assert.equal(installed.length, c.install);
        for (const u of [...prepared, ...installed]) {
          assert.equal(u.id, id);
          assert.equal(u.state, c.state);
          assert.equal(u.tag, 'v1.1.0');
          assert.equal(u.commit, 'a'.repeat(40));
        }
        assert.deepEqual((await ticks()).map((r) => r.did), [c.did]);
      });
    }

    test('M6: a step that ends the update refused or failed records did = failed; ready or cancelled stays prepared/installed', async () => {
      for (const [state, ended, did] of [
        ['approved', 'refused', 'failed'],
        ['approved', 'failed_before_install', 'failed'],
        ['approved', 'ready', 'prepared'],
        ['approved', 'cancelled', 'prepared'],
        ['ready', 'failed_after_migration', 'failed'],
        ['ready', 'failed_before_install', 'failed'],
        ['ready', 'succeeded', 'installed'],
      ] as const) {
        await pool.query(`DELETE FROM updater_ticks`);
        await pool.query(`UPDATE updates SET state = 'cancelled' WHERE state IN ('approved', 'preparing', 'ready', 'installing')`);
        await seedUpdate(state, { startsAt: state === 'ready' ? NOW : undefined });
        const { d, lines } = deps({ prepare: async () => ended, install: async () => ended });
        assert.deepEqual(await runTick(d), { did }, `${state} → ${ended}`);
        assert.deepEqual((await ticks()).map((r) => r.did), [did]);
        assert.deepEqual(lines, []);
      }
    });

    test('an older failed update behind a newer open one: the open one is acted on', async () => {
      await seedUpdate('failed_after_migration', { approvedAt: at(-48 * HOUR), finishedAt: at(-47 * HOUR) });
      const id = await seedUpdate('approved');
      const { d, prepared, lines } = deps();
      assert.deepEqual(await runTick(d), { did: 'prepared' });
      assert.deepEqual(prepared.map((u) => u.id), [id]);
      assert.deepEqual(lines.filter((l) => l.includes('recover')), []);
    });

    for (const state of ['failed_after_migration', 'failed_needs_attention'] as const) {
      test(`${state} → the recovery line, once a day`, async () => {
        await seedUpdate(state, { finishedAt: at(-30 * MIN), startsAt: at(-HOUR), approvedAt: at(-2 * HOUR) });
        // The failing tick itself printed the line half an hour ago: nothing yet.
        let r = deps();
        assert.deepEqual(await runTick(r.d), { did: 'nothing' });
        assert.deepEqual(r.lines, []);
        // A day after the failure: the line again.
        r = deps({ now: () => at(24 * HOUR) });
        assert.deepEqual(await runTick(r.d), { did: 'remind_recovery' });
        assert.deepEqual(r.lines, [recoveryLine(state, 'v1.1.0')]);
        assert.match(r.lines[0], /docker compose --profile updater run --rm updater node dist\/updater\/updater-cli\.js recover/);
        assert.match(r.lines[0], /See INSTALL\.md, 'After a failed update'\./);
        // Later the same day: quiet.
        r = deps({ now: () => at(30 * HOUR) });
        assert.deepEqual(await runTick(r.d), { did: 'nothing' });
        assert.deepEqual(r.lines, []);
        // The next day: again.
        r = deps({ now: () => at(48 * HOUR) });
        assert.deepEqual(await runTick(r.d), { did: 'remind_recovery' });
        assert.equal(r.prepared.length + r.installed.length, 0);
      });
    }

    test('the failed-after-migration line is the operator message of spec 5.7', () => {
      assert.equal(
        recoveryLine('failed_after_migration', 'v1.1.0'),
        'The update to v1.1.0 failed after the database migration started. Kainow is stopped and shows a notice page. ' +
          'Run: docker compose --profile updater run --rm updater node dist/updater/updater-cli.js recover. ' +
          "See INSTALL.md, 'After a failed update'.",
      );
    });

    test('a failing step is failed, recorded, and logged with the database URL masked', async () => {
      await seedUpdate('approved');
      const { d, lines } = deps({
        prepare: async () => {
          throw new Error('build broke at postgres://kainow:topsecret@db:5432/kainow');
        },
      });
      assert.deepEqual(await runTick(d), { did: 'failed' });
      assert.deepEqual((await ticks()).map((r) => r.did), ['failed']);
      assert.ok(lines.some((l) => l.includes('postgres://kainow:***@db')));
      assert.ok(!lines.some((l) => l.includes('topsecret')));
    });

    test('an update cancelled while the tick waits for its row is not dispatched', async () => {
      const id = await seedUpdate('approved');
      const canceller = await pool.connect();
      try {
        await canceller.query('BEGIN');
        await canceller.query(`SELECT pg_advisory_xact_lock(hashtext('kainow.updates'))`);
        await canceller.query(`UPDATE updates SET state = 'cancelled', cancelled_by = $2, cancelled_at = $3, cancel_reason = 'No' WHERE id = $1`, [id, admin, NOW]);
        const { d, prepared } = deps();
        const ticking = runTick(d);
        await sleep(300); // the tick is now waiting behind the cancel
        await canceller.query('COMMIT');
        assert.deepEqual(await ticking, { did: 'nothing' });
        assert.equal(prepared.length, 0);
      } finally {
        canceller.release();
      }
    });
  });

  describe('the updater command', () => {
    test('tick runs a tick; exit 0, or 1 when the step failed', async () => {
      const { d } = deps();
      assert.equal(await runUpdaterCli(['tick'], d), 0);
      assert.deepEqual((await ticks()).map((r) => r.did), ['nothing']);
      await seedUpdate('approved');
      const failing = deps({ prepare: async () => Promise.reject(new Error('x')) });
      assert.equal(await runUpdaterCli(['tick'], failing.d), 1);
    });

    test('recover goes to the recovery command with its own arguments; anything else is usage (exit 2)', async () => {
      const got: string[][] = [];
      const recover = async (args: string[]) => (got.push(args), 7);
      for (const argv of [['recover'], ['recover', '--yes']]) {
        const { d } = deps();
        assert.equal(await runUpdaterCli(argv, { ...d, recover }), 7, argv.join(' '));
      }
      assert.deepEqual(got, [[], ['--yes']]);
      for (const argv of [[], ['tock'], ['tick', 'extra'], ['recover']]) {
        const { d, lines } = deps();
        assert.equal(await runUpdaterCli(argv, d), 2, argv.join(' '));
        assert.equal(lines.length, 1);
      }
      assert.deepEqual(await ticks(), []);
    });
  });
});
