import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { FakeRunner } from '../testing/fake-runner';
import { PREVIOUS_SIGNERS } from './install';
import {
  RECOVER_TEXT,
  SET_ASIDE_PATTERN,
  decideSituation,
  runRecover,
  setAsideName,
  type Found,
  type RecoverDeps,
  type RecoverStore,
  type RecoverUpdate,
  type Situation,
} from './recover';

const NOW = new Date('2026-12-01T04:00:00Z');
const ID = '0190a1b2-c3d4-7000-8000-000000000001';
const RUN_ID = '0190a000-0000-7000-8000-00000000beef';
const SET = '20261201T034500Z-pre_update';
const ASIDE = 'kainow_failed_20261201_0190a1b2';

const update = (over: Partial<RecoverUpdate> = {}): RecoverUpdate => ({
  id: ID,
  state: 'failed_after_migration',
  tag: 'v1.1.0',
  fromVersion: '1.0.0',
  toVersion: '1.1.0',
  failureCode: 'migration_failed',
  preUpdateRunId: RUN_ID,
  preUpdateSet: SET,
  ...over,
});

class MemoryStore implements RecoverStore {
  situationIs: Situation = { kind: 'fresh', update: update() };
  tickHoldsLock = false;
  locked = false;
  fixed: Array<{ id: string; failedDb: string }> = [];
  finished: string[] = [];
  closed = false;
  constructor(private readonly events: string[]) {}
  async situation() {
    return this.situationIs;
  }
  async lockUpdater(wait: boolean) {
    if (this.tickHoldsLock && !wait) return false;
    this.locked = true;
    this.events.push(`lock ${wait ? 'wait' : 'try'}`);
    return true;
  }
  async releaseKainow() {
    this.locked = false;
    this.events.push('release');
  }
  async fixRecord(u: RecoverUpdate, failedDb: string) {
    assert.ok(this.locked, 'the record is put right with the updater lock held');
    this.fixed.push({ id: u.id, failedDb });
    this.events.push(`fix ${failedDb}`);
  }
  async finishInPlace(u: RecoverUpdate) {
    this.finished.push(u.id);
    this.events.push('finish in place');
    return true;
  }
  async close() {
    this.closed = true;
  }
}

describe('recover (spec 5.9)', () => {
  let dir: string;
  let t: number;
  let events: string[];
  let lines: string[];
  let store: MemoryStore;
  let runner: FakeRunner;
  let answers: Array<string | null>;
  let asked: number;
  let world: { head: string; api: boolean; notice: boolean; restoreCode: number; healthy: boolean; renameFails: number };

  const rest = (args: string[]) => args.slice(args.lastIndexOf('--profile') + 2);
  const deps = (): RecoverDeps => ({
    runner,
    installDir: dir,
    projectName: async () => 'kainow',
    store,
    now: () => new Date(t),
    log: (l) => lines.push(l),
    ask: async () => {
      asked++;
      return answers.shift() ?? null;
    },
    sleep: async (ms) => void (t += ms),
  });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kainow-recover-'));
    await writeFile(join(dir, 'release-signers'), 'OLD\n');
    t = NOW.getTime();
    events = [];
    lines = [];
    answers = [];
    asked = 0;
    store = new MemoryStore(events);
    world = { head: 'v1.0.0', api: false, notice: true, restoreCode: 0, healthy: true, renameFails: 0 };
    runner = new FakeRunner();
    runner.on('git', ['tag', '--points-at', 'HEAD'], () => {
      events.push('confirm tag');
      return { code: 0, stdout: `${world.head}\n`, stderr: '' };
    });
    runner.on('docker', ['inspect'], { code: 0, stdout: '0 2026-12-01T04:00:00Z\n', stderr: '' });
    runner.on('docker', ['compose'], (args) => {
      const r = rest(args);
      const cmd = r.join(' ');
      const ok = { code: 0, stdout: '', stderr: '' };
      if (cmd === 'stop notice') {
        world.notice = false;
        events.push('stop notice');
        return ok;
      }
      if (cmd === 'stop api worker') {
        world.api = false;
        events.push('stop api worker');
        return ok;
      }
      if (cmd.startsWith('exec -T db psql')) {
        const sql = r.filter((_, i) => r[i - 1] === '-c');
        if (sql.some((s) => s.includes('RENAME TO'))) {
          events.push(`rename: ${sql.join('; ')}`);
          if (world.renameFails > 0) {
            world.renameFails--;
            return { code: 1, stdout: '', stderr: 'database "kainow" is being accessed by other users' };
          }
          return ok;
        }
        events.push(`psql: ${sql.join('; ')}`);
        return ok;
      }
      if (cmd.startsWith('exec -T db createdb')) {
        events.push(cmd);
        return ok;
      }
      if (cmd.startsWith('run --rm ops node dist/ops/restore-cli.js')) {
        events.push(cmd);
        return {
          code: world.restoreCode,
          stdout: `Restoring backup set ${SET}.\nKainow was restored from the backup taken at 2026-12-01 03:45 UTC.\nset ${SET} restored\n`,
          stderr: world.restoreCode ? 'could not connect to postgres://kainow:hunter2@db:5432/kainow' : '',
        };
      }
      if (cmd === 'up -d --no-deps api worker') {
        assert.equal(world.notice, false, 'the notice page is off before Kainow takes its port');
        world.api = true;
        events.push('up api worker');
        return ok;
      }
      if (cmd === 'up -d --no-deps notice') {
        world.notice = true;
        events.push('up notice');
        return ok;
      }
      if (cmd === 'ps --all --format json') {
        const health = world.healthy ? 'healthy' : 'unhealthy';
        return {
          code: 0,
          stdout: [
            JSON.stringify({ ID: 'a1', Service: 'api', State: world.api ? 'running' : 'exited', Health: world.api ? health : '' }),
            JSON.stringify({ ID: 'w1', Service: 'worker', State: world.api ? 'running' : 'exited', Health: '' }),
          ].join('\n'),
          stderr: '',
        };
      }
      if (r[0] === 'run' && r.includes('dist/updater/post-check-cli.js')) {
        events.push(`post-check ${r.at(-1)}`);
        return { code: r.at(-1) === '1.0.0' ? 0 : 1, stdout: '', stderr: '' };
      }
      return ok;
    });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('the set-aside name is kainow_failed_<YYYYMMDD>_<id8> (UTC+8 date)', () => {
    assert.equal(setAsideName(ID, NOW), ASIDE);
    assert.equal(setAsideName(ID, new Date('2026-12-01T17:00:00Z')), 'kainow_failed_20261202_0190a1b2');
  });

  test('usage: anything but [--yes] is exit 2 and does nothing', async () => {
    for (const argv of [['--force'], ['--yes', '--yes'], ['yes']]) {
      assert.equal(await runRecover(argv, deps()), 2, argv.join(' '));
    }
    assert.deepEqual(runner.calls, []);
  });

  test('refuses unless the latest update needs recovery', async () => {
    store.situationIs = { kind: 'refused', message: RECOVER_TEXT.notNeeded('v1.1.0', 'succeeded') };
    assert.equal(await runRecover(['--yes'], deps()), 1);
    assert.deepEqual(runner.calls, []);
    assert.deepEqual(events, []);
    assert.match(lines.join('\n'), /nothing to recover/);
    assert.ok(store.closed);

    // Failed after the migration with no pre-update backup recorded: nothing to restore from.
    store.situationIs = { kind: 'fresh', update: update({ preUpdateSet: null }) };
    lines = [];
    assert.equal(await runRecover(['--yes'], deps()), 1);
    assert.deepEqual(runner.calls, []);
    assert.deepEqual(lines, [RECOVER_TEXT.noBackup]);
  });

  test('decides where to start from what the databases hold', () => {
    const k = (latest: RecoverUpdate | null, over: Partial<NonNullable<Found['kainow']>> = {}) => ({
      empty: false,
      hasUpdates: true,
      latest,
      reason: null,
      ...over,
    });
    for (const state of ['succeeded', 'installing', 'recovered', 'failed_before_install', 'approved'] as const) {
      assert.equal(decideSituation({ kainow: k(update({ state })), setAside: null }).kind, 'refused', state);
    }
    assert.deepEqual(decideSituation({ kainow: k(null), setAside: null }), { kind: 'refused', message: RECOVER_TEXT.nothing });
    for (const state of ['failed_after_migration', 'failed_needs_attention'] as const) {
      assert.equal(decideSituation({ kainow: k(update({ state })), setAside: null }).kind, 'fresh', state);
    }
    // A restored copy never put right (or left by a restore that stopped) is never started.
    assert.deepEqual(decideSituation({ kainow: k(update({ state: 'installing' }), { reason: 'restored_from_backup' }), setAside: null }), {
      kind: 'refused',
      message: RECOVER_TEXT.partial,
    });
    assert.deepEqual(decideSituation({ kainow: k(null, { hasUpdates: false }), setAside: { name: ASIDE, latest: update() } }), {
      kind: 'refused',
      message: RECOVER_TEXT.partial,
    });
    assert.deepEqual(decideSituation({ kainow: k(null, { hasUpdates: false, reason: 'restored_from_backup' }), setAside: null }), {
      kind: 'refused',
      message: RECOVER_TEXT.partial,
    });
    // Non-empty, no updates table, no set-aside database: may be the failed database itself, half-migrated. Never drop advice.
    for (const f of [
      { kainow: k(null, { hasUpdates: false }), setAside: null },
      { kainow: k(null, { hasUpdates: false, reason: 'update' }), setAside: null },
      { kainow: k(null, { hasUpdates: false }), setAside: { name: 'kainow_failed_20260101_ffffffff', latest: update({ id: 'ffffffff-0000-7000-8000-000000000009', state: 'recovered' }) } },
    ]) {
      const d = decideSituation(f);
      assert.deepEqual(d, { kind: 'refused', message: RECOVER_TEXT.unrecognised });
      assert.ok(!(d as { message: string }).message.includes('dropdb'));
    }
    // An installing row with update maintenance: still in progress, or its failure not yet recorded.
    assert.deepEqual(decideSituation({ kainow: k(update({ state: 'installing' }), { reason: 'update' }), setAside: null }), {
      kind: 'refused',
      message: RECOVER_TEXT.inProgress('v1.1.0'),
    });
    // An earlier recover renamed the failed database: carry on from the restore.
    const empty = k(null, { empty: true, hasUpdates: false });
    assert.deepEqual(decideSituation({ kainow: empty, setAside: { name: ASIDE, latest: update() } }), {
      kind: 'set_aside',
      update: update(),
      failedDb: ASIDE,
      createKainow: false,
    });
    assert.deepEqual(decideSituation({ kainow: null, setAside: { name: ASIDE, latest: update() } }), {
      kind: 'set_aside',
      update: update(),
      failedDb: ASIDE,
      createKainow: true,
    });
    // A set-aside database of another, older update, or one already recovered, is not this one.
    assert.equal(decideSituation({ kainow: empty, setAside: { name: 'kainow_failed_20261201_ffffffff', latest: update() } }).kind, 'refused');
    assert.equal(decideSituation({ kainow: empty, setAside: { name: ASIDE, latest: update({ state: 'recovered' }) } }).kind, 'refused');
    assert.equal(decideSituation({ kainow: empty, setAside: null }).kind, 'refused');
  });

  test('asks for confirmation without --yes and does nothing on "no"', async () => {
    for (const answer of ['no', 'Yes', ' yes', 'yes please', '', null]) {
      answers = [answer];
      lines = [];
      assert.equal(await runRecover([], deps()), 1, String(answer));
      assert.ok(lines.includes(RECOVER_TEXT.declined));
    }
    assert.equal(asked, 6);
    assert.deepEqual(runner.calls, []);
    assert.deepEqual(events, []);

    // The plan is shown before the question.
    answers = ['yes'];
    lines = [];
    assert.equal(await runRecover([], deps()), 0);
    assert.equal(asked, 7);
    assert.match(lines.join('\n'), new RegExp(`keep the failed database as ${ASIDE}`));
    assert.match(lines.join('\n'), new RegExp(`restore the pre-update backup set ${SET}`));
  });

  test('the command sequence: stop notice, rename, create, confirm previous tag, restore --set <pre_update set>, fix the record, up -d, health', async () => {
    assert.equal(await runRecover(['--yes'], deps()), 0);
    assert.equal(asked, 0);
    const postChecks = events.filter((e) => e.startsWith('post-check'));
    assert.deepEqual(
      events.filter((e) => !e.startsWith('post-check')),
      [
        'lock try',
        'stop notice',
        'stop api worker',
        'release',
        `psql: ALTER DATABASE kainow WITH ALLOW_CONNECTIONS false; SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'kainow' AND pid <> pg_backend_pid()`,
        `rename: ALTER DATABASE kainow RENAME TO ${ASIDE}`,
        `psql: ALTER DATABASE ${ASIDE} WITH ALLOW_CONNECTIONS true`,
        'exec -T db createdb -U kainow kainow',
        'lock wait',
        'confirm tag',
        `run --rm ops node dist/ops/restore-cli.js --set ${SET} --reason Recovering from failed update to v1.1.0`,
        `fix ${ASIDE}`,
        'release',
        'up api worker',
      ],
    );
    assert.deepEqual(postChecks, ['post-check 1.0.0']);
    // The exact runner calls for the rename and the restore (no shell: the reason is one argument).
    const compose = runner.calls.filter((c) => c.cmd === 'docker' && c.args[0] === 'compose').map((c) => rest(c.args));
    assert.ok(compose.some((a) => a.join('\u0000') === ['exec', '-T', 'db', 'psql', '-U', 'kainow', '-d', 'postgres', '-c', `ALTER DATABASE kainow RENAME TO ${ASIDE}`].join('\u0000')));
    assert.ok(
      compose.some(
        (a) =>
          a.join('\u0000') ===
          ['run', '--rm', 'ops', 'node', 'dist/ops/restore-cli.js', '--set', SET, '--reason', 'Recovering from failed update to v1.1.0'].join('\u0000'),
      ),
    );
    assert.deepEqual(store.fixed, [{ id: ID, failedDb: ASIDE }]);
    // The restore's own message, then recover's.
    assert.ok(lines.includes('Kainow was restored from the backup taken at 2026-12-01 03:45 UTC.'));
    assert.equal(lines.at(-1), RECOVER_TEXT.back('1.0.0'));
    assert.equal(lines.at(-1), 'Kainow is back on v1.0.0. Review and choose Resume on the Operations page.');
    assert.ok(store.closed);
  });

  test('a set-aside name not as expected never reaches the rename SQL', async () => {
    assert.match(setAsideName(ID, NOW), SET_ASIDE_PATTERN);
    store.situationIs = { kind: 'fresh', update: update({ id: "x'; DROP DATABASE kainow; --" }) };
    assert.equal(await runRecover(['--yes'], deps()), 1);
    assert.ok(!events.some((e) => e.startsWith('psql') || e.startsWith('rename')));
    assert.ok(lines.at(-1)!.startsWith('The set-aside database name'));
  });

  test('a rename refused while a connection is going away is tried again', async () => {
    world.renameFails = 2;
    assert.equal(await runRecover(['--yes'], deps()), 0);
    assert.equal(events.filter((e) => e.startsWith('rename')).length, 3);
  });

  test('a rename that keeps failing changes nothing: connections allowed again, the notice page back', async () => {
    world.renameFails = 99;
    assert.equal(await runRecover(['--yes'], deps()), 1);
    assert.ok(events.includes('psql: ALTER DATABASE kainow WITH ALLOW_CONNECTIONS true'));
    assert.ok(!events.some((e) => e.includes('createdb') || e.includes('restore-cli')));
    assert.equal(events.at(-1), 'up notice');
    assert.ok(lines.includes(RECOVER_TEXT.renameFailed(ASIDE)));
  });

  test('a tick holding the updater lock: refused before anything changes', async () => {
    store.tickHoldsLock = true;
    assert.equal(await runRecover(['--yes'], deps()), 1);
    assert.deepEqual(runner.calls.filter((c) => !c.args.includes('config')), []);
    assert.ok(lines.includes(RECOVER_TEXT.busy));
  });

  test('failed_needs_attention skips the rename and restore', async () => {
    store.situationIs = { kind: 'fresh', update: update({ state: 'failed_needs_attention', failureCode: 'rollback_failed', preUpdateSet: null, preUpdateRunId: null }) };
    assert.equal(await runRecover(['--yes'], deps()), 0);
    assert.deepEqual(
      events.filter((e) => !e.startsWith('post-check')),
      ['lock try', 'stop notice', 'confirm tag', 'up api worker', 'finish in place'],
    );
    assert.ok(!runner.lines().some((l) => /psql|createdb|restore-cli/.test(l)));
    assert.deepEqual(store.finished, [ID]);
    assert.deepEqual(store.fixed, []);
    assert.equal(lines.at(-1), RECOVER_TEXT.backWritable('1.0.0'));
  });

  test('failed_needs_attention whose previous version is not healthy: maintenance stays on, the notice page is back', async () => {
    store.situationIs = { kind: 'fresh', update: update({ state: 'failed_needs_attention', failureCode: 'rollback_failed' }) };
    world.healthy = false;
    assert.equal(await runRecover(['--yes'], deps()), 1);
    assert.deepEqual(store.finished, []);
    assert.equal(events.at(-1), 'up notice');
    assert.ok(lines.includes(RECOVER_TEXT.startFailed('1.0.0')));
  });

  test('the folder not at the previous tag: stops before the restore', async () => {
    world.head = 'v1.1.0';
    assert.equal(await runRecover(['--yes'], deps()), 1);
    assert.ok(!events.some((e) => e.includes('restore-cli')));
    assert.deepEqual(store.fixed, []);
    assert.ok(lines.includes(RECOVER_TEXT.notAtTag('v1.0.0')));
  });

  test('a signers file still kept by the failed install is put back', async () => {
    await writeFile(join(dir, PREVIOUS_SIGNERS), 'PREVIOUS\n');
    await writeFile(join(dir, 'release-signers'), 'NEW\n');
    assert.equal(await runRecover(['--yes'], deps()), 0);
    assert.equal(await readFile(join(dir, 'release-signers'), 'utf8'), 'PREVIOUS\n');
  });

  test('a failed restore keeps the failed database, does not fix the record or start Kainow; output masked', async () => {
    world.restoreCode = 1;
    assert.equal(await runRecover(['--yes'], deps()), 1);
    assert.deepEqual(store.fixed, []);
    assert.ok(!events.includes('up api worker'));
    assert.ok(lines.includes(RECOVER_TEXT.restoreFailed(ASIDE)));
    assert.ok(!lines.join('\n').includes('hunter2'));
    assert.ok(lines.some((l) => l.includes('postgres://kainow:***@db')));
  });

  test('run again after the rename: no second rename, carries on from the restore', async () => {
    store.situationIs = { kind: 'set_aside', update: update(), failedDb: ASIDE, createKainow: false };
    assert.equal(await runRecover(['--yes'], deps()), 0);
    assert.deepEqual(
      events.filter((e) => !e.startsWith('post-check')),
      [
        'stop notice',
        'lock wait',
        'confirm tag',
        `run --rm ops node dist/ops/restore-cli.js --set ${SET} --reason Recovering from failed update to v1.1.0`,
        `fix ${ASIDE}`,
        'release',
        'up api worker',
      ],
    );
    // kainow missing (created after the rename failed): created first.
    events.length = 0;
    store.situationIs = { kind: 'set_aside', update: update(), failedDb: ASIDE, createKainow: true };
    assert.equal(await runRecover(['--yes'], deps()), 0);
    assert.deepEqual(events.slice(0, 3), ['stop notice', 'exec -T db createdb -U kainow kainow', 'lock wait']);
  });

  test('Kainow not healthy after the restore: the notice page is back, exit 1', async () => {
    world.healthy = false;
    assert.equal(await runRecover(['--yes'], deps()), 1);
    assert.deepEqual(store.fixed, [{ id: ID, failedDb: ASIDE }]);
    assert.deepEqual(events.slice(-3), ['up api worker', 'stop api worker', 'up notice']);
    assert.equal(lines.at(-1), RECOVER_TEXT.startFailed('1.0.0'));
  });
});
