import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { FakeRunner } from '../testing/fake-runner';
import {
  BACKUP_BUSY_LIMIT_MS,
  HEALTH_LIMIT_MS,
  MAINTENANCE_WAIT_MS,
  installWithStore,
  lastRunId,
  parsePs,
  resumePoint,
  runPostCheck,
  type BeforeEnd,
  type InstallDeps,
  type InstallGit,
  type InstallStep,
  type InstallStore,
  type StepRow,
} from './install';
import type { FailureCode, UpdateState } from './states';
import type { TickUpdate } from './tick';

const NOW = new Date('2026-12-01T04:00:00Z');
const TAG_OBJECT = 'ab'.repeat(20);
const COMMIT = 'cd'.repeat(20);
const RUN_ID = '0190a000-0000-7000-8000-00000000beef';
const ID = '0190a000-0000-7000-8000-000000000001';

class Crash extends Error {}

/** Where the store makes the updater die: when a step is recorded as started, or when its success is about to be recorded. */
type CrashAt = { step: InstallStep; at: 'start' | 'end' };

class MemoryStore implements InstallStore {
  state: UpdateState = 'ready';
  steps: { id: string; step: string; outcome: StepRow['outcome']; code: FailureCode | null }[] = [];
  maintenance: { reason: string; updateId: string | null } | null = null;
  maintenanceOnAt: number | null = null;
  preRun: string | null = null;
  ends: Array<BeforeEnd | { state: string; code: FailureCode }> = [];
  audits: string[] = [];
  notices: string[] = [];
  crash: CrashAt | null = null;
  onMaintenanceOff: () => void = () => undefined;
  constructor(private readonly clock: () => number) {}

  private fire(step: string, at: 'start' | 'end') {
    if (this.crash && this.crash.step === step && this.crash.at === at) {
      this.crash = null;
      throw new Crash(`crash ${at} ${step}`);
    }
  }
  private clear(updateId: string) {
    if (this.maintenance?.reason === 'update' && this.maintenance.updateId === updateId) {
      this.onMaintenanceOff();
      this.maintenance = null;
    }
  }
  async closeRunning() {
    for (const s of this.steps) if (s.outcome === 'running') s.outcome = 'failed';
  }
  async begin() {
    if (this.state !== 'ready') return false;
    this.state = 'installing';
    return true;
  }
  async reenter() {
    if (this.state !== 'installing') return null;
    const rows = this.steps.map((s) => ({ step: s.step, outcome: s.outcome, failureCode: s.code }));
    await this.closeRunning();
    return rows;
  }
  async stateOf() {
    return this.state;
  }
  async startStep(_id: string, step: InstallStep) {
    const id = String(this.steps.length);
    this.steps.push({ id, step, outcome: 'running', code: null });
    this.fire(step, 'start');
    return id;
  }
  async endStep(stepId: string, outcome: 'passed' | 'failed' | 'skipped', code: FailureCode | null) {
    const s = this.steps[Number(stepId)];
    if (outcome === 'passed') this.fire(s.step, 'end');
    if (s.outcome === 'running') Object.assign(s, { outcome, code });
  }
  async protective() {
    return { protective: this.maintenance !== null, reason: this.maintenance?.reason ?? null, updateId: this.maintenance?.updateId ?? null };
  }
  async maintenanceOn(id: string) {
    if (this.maintenance) return this.maintenance.reason === 'update' && this.maintenance.updateId === id;
    this.maintenance = { reason: 'update', updateId: id };
    this.maintenanceOnAt = this.clock();
    return true;
  }
  async savePreUpdateRun(_id: string, runId: string) {
    this.preRun = runId;
  }
  async endBefore(id: string, from: 'ready' | 'installing', end: BeforeEnd) {
    const moved = this.state === from;
    if (moved) {
      this.state = end.state;
      this.ends.push(end);
      this.audits.push(end.state === 'refused' ? 'ops.update_refused' : 'ops.update_failed');
      this.notices.push(end.state === 'refused' ? 'update_refused' : 'update_failed');
    }
    this.clear(id);
    return moved;
  }
  async succeed(id: string, stepId: string) {
    this.fire('maintenance_off', 'end');
    this.clear(id);
    this.steps[Number(stepId)].outcome = 'passed';
    if (this.state !== 'installing') return;
    this.state = 'succeeded';
    this.audits.push('ops.update_succeeded');
    this.notices.push('update_succeeded');
  }
  async failAfter(_id: string, state: 'failed_after_migration' | 'failed_needs_attention', code: FailureCode) {
    if (this.state !== 'installing') return;
    this.state = state;
    this.ends.push({ state, code });
    this.audits.push('ops.update_failed');
  }
  stepLine() {
    return this.steps.map((s) => `${s.step}:${s.outcome}${s.code ? `:${s.code}` : ''}`);
  }
}

/** The installation as the fake commands leave it. */
class World {
  head = 'v1.0.0';
  api = true;
  worker = true;
  /** The version the running api and worker containers carry. */
  version = '1.0.0';
  migrated = false;
  notice = false;
  checkoutFails = new Set<string>();
  migrateCode = 0;
  startCode = 0;
  /** Versions whose api becomes healthy. */
  healthyVersions = new Set(['1.0.0', '1.1.0']);
  backupCodes: number[] = [];
  images: string[] = [];
  removed: string[] = [];
  backupCalls: number[] = [];
}

const update = (over: Partial<TickUpdate> = {}): TickUpdate => ({
  id: ID,
  state: 'ready',
  fromVersion: '1.0.0',
  toVersion: '1.1.0',
  tag: 'v1.1.0',
  commit: COMMIT,
  tagObject: TAG_OBJECT,
  startsAt: NOW,
  expectedMinutes: 30,
  preUpdateBackupRunId: null,
  ...over,
});

describe('installing an update', () => {
  let dir: string;
  let t: number;
  let store: MemoryStore;
  let runner: FakeRunner;
  let world: World;
  let lines: string[];
  let git: InstallGit;

  const rest = (args: string[]) => args.slice(args.lastIndexOf('--profile') + 2);

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kainow-install-'));
    await mkdir(join(dir, 'release'));
    await writeFile(join(dir, 'release-signers'), 'OLD\n');
    await writeFile(join(dir, 'release', 'release-signers'), 'NEW\n');
    t = NOW.getTime();
    store = new MemoryStore(() => t);
    world = new World();
    lines = [];
    git = {
      workingTreeState: async () => ({ clean: true, changed: [], headTag: world.head === 'v1.0.0' ? 'v1.0.0' : null }),
      fetchCandidate: async () => ({ ok: true, tagObject: TAG_OBJECT }),
    };
    runner = new FakeRunner();
    runner.on('git', ['rev-parse'], { code: 0, stdout: `${COMMIT}\n`, stderr: '' });
    runner.on('git', [], (args) => {
      const i = args.indexOf('checkout');
      if (i >= 0) {
        const target = args.at(-1)!;
        if (world.checkoutFails.has(target)) return { code: 1, stdout: '', stderr: 'error: checkout failed' };
        world.head = target;
      }
      return { code: 0, stdout: '', stderr: '' };
    });
    runner.on('docker', ['inspect'], { code: 0, stdout: '0 2026-12-01T04:00:00Z\n', stderr: '' });
    runner.on('docker', ['image', 'ls'], () => ({ code: 0, stdout: world.images.join('\n'), stderr: '' }));
    runner.on('docker', ['image', 'rm'], (args) => {
      world.removed.push(args.at(-1)!);
      return { code: 0, stdout: '', stderr: '' };
    });
    runner.on('docker', ['compose'], (args) => {
      const r = rest(args);
      const cmd = r.join(' ');
      const ok = { code: 0, stdout: '', stderr: '' };
      if (cmd.startsWith('run --rm ops node dist/ops/backup-cli.js --kind pre_update')) {
        world.backupCalls.push(t);
        const code = world.backupCodes.length ? world.backupCodes.shift()! : 0;
        if (code === 0) return { code, stdout: `Backup set x written.\nrun ${RUN_ID} succeeded\n`, stderr: '' };
        return { code, stdout: code === 3 ? '' : `run ${RUN_ID} failed backup_failed\n`, stderr: '' };
      }
      if (cmd === 'stop api worker') {
        world.api = world.worker = false;
        return ok;
      }
      if (cmd === 'run --rm --no-deps migrate') {
        world.migrated = world.migrateCode === 0;
        return { code: world.migrateCode, stdout: '', stderr: world.migrateCode ? 'migration 0040 failed postgres://kainow:hunter2@db:5432/kainow' : '' };
      }
      if (cmd === 'up -d --no-deps api worker') {
        if (world.startCode !== 0) return { code: world.startCode, stdout: '', stderr: 'failed' };
        world.api = world.worker = true;
        world.version = world.head === COMMIT ? '1.1.0' : '1.0.0';
        return ok;
      }
      if (cmd === 'up -d --no-deps notice') {
        world.notice = true;
        return ok;
      }
      if (cmd === 'ps --all --format json') {
        const health = world.healthyVersions.has(world.version) ? 'healthy' : 'unhealthy';
        return {
          code: 0,
          stdout: [
            JSON.stringify({ ID: 'a1', Service: 'api', State: world.api ? 'running' : 'exited', Health: world.api ? health : '' }),
            JSON.stringify({ ID: 'w1', Service: 'worker', State: world.worker ? 'running' : 'exited', Health: '' }),
          ].join('\n'),
          stderr: '',
        };
      }
      if (r[0] === 'run' && r.includes('dist/updater/post-check-cli.js')) {
        return { code: r.at(-1) === world.version && (world.version === '1.0.0' || world.migrated) ? 0 : 1, stdout: '', stderr: '' };
      }
      return ok;
    });
    // Maintenance ends only with a whole installation running: the previous code and version, or the new ones.
    store.onMaintenanceOff = () => {
      assert.ok(world.api && world.worker, 'api and worker run when maintenance ends');
      if (world.head === 'v1.0.0') assert.equal(world.version, '1.0.0');
      else {
        assert.equal(world.head, COMMIT);
        assert.equal(world.version, '1.1.0');
        assert.ok(world.migrated);
      }
    };
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const deps = (over: Partial<InstallDeps> = {}): Omit<InstallDeps, 'pool'> => ({
    runner,
    installDir: dir,
    projectName: 'kainow',
    now: () => new Date(t),
    log: (l) => lines.push(l),
    sleep: async (ms) => {
      t += ms;
    },
    git,
    ...over,
  });
  const run = (u = update()) => installWithStore(deps(), store, u);
  const composeLines = () => runner.calls.filter((c) => c.args[0] === 'compose').map((c) => rest(c.args).join(' '));
  const signers = () => readFile(join(dir, 'release-signers'), 'utf8');

  test('the happy path runs the steps in order and ends succeeded with maintenance off and audit ops.update_succeeded', async () => {
    assert.equal(await run(), 'succeeded');
    assert.deepEqual(store.stepLine(), [
      'recheck:passed', 'maintenance_on:passed', 'backup:passed', 'stop:passed', 'switch_code:passed', 'migrate:passed',
      'start:passed', 'health:passed', 'maintenance_off:passed', 'tidy:passed',
    ]);
    assert.equal(store.state, 'succeeded');
    assert.equal(store.maintenance, null);
    assert.deepEqual(store.audits, ['ops.update_succeeded']);
    assert.deepEqual(store.notices, ['update_succeeded']);
    assert.equal(store.preRun, RUN_ID);
    assert.equal(world.head, COMMIT);
    assert.equal(await signers(), 'NEW\n', 'the release signers file is now trusted');
    const c = composeLines().filter((l) => !l.startsWith('ps') && !l.includes('post-check'));
    assert.deepEqual(c, [
      'run --rm ops node dist/ops/backup-cli.js --kind pre_update',
      'stop api worker',
      'run --rm --no-deps migrate',
      'up -d --no-deps api worker',
    ]);
    assert.ok(composeLines().includes('run --rm --no-deps api node dist/updater/post-check-cli.js --expect 1.1.0'));
    // The installation's own project name, .env and override, as for preparation.
    const first = runner.calls.find((x) => x.args[0] === 'compose')!.args;
    assert.deepEqual(first.slice(0, 9), ['compose', '--project-directory', dir, '--project-name', 'kainow', '--env-file', join(dir, '.env'), '-f', join(dir, 'compose.yaml')]);
    // Only api, worker and migrate (and the one-off backup) are touched: never the db container.
    assert.ok(!composeLines().some((l) => /\bdb\b/.test(l) || l === 'up -d' || l.startsWith('restart')));
    // The worker had to be seen running for 60 seconds; the 15 seconds' wait came first.
    assert.ok(t - NOW.getTime() >= MAINTENANCE_WAIT_MS + 60_000);
  });

  test('window_missed: a ready row more than 60 minutes past its start ends failed_before_install, nothing touched (D125)', async () => {
    let fetched = 0;
    git.fetchCandidate = async () => {
      fetched += 1;
      return { ok: true, tagObject: TAG_OBJECT };
    };
    assert.equal(await run(update({ startsAt: new Date(NOW.getTime() - 61 * 60_000) })), 'failed_before_install');
    assert.equal(store.state, 'failed_before_install');
    assert.deepEqual(store.stepLine(), ['recheck:failed:window_missed']);
    assert.equal((store.ends[0] as BeforeEnd).code, 'window_missed');
    assert.match((store.ends[0] as BeforeEnd).summary, /Approve it again with a new start time\./);
    assert.deepEqual(store.audits, ['ops.update_failed']);
    assert.deepEqual(store.notices, ['update_failed']);
    assert.equal(fetched, 0, 'nothing is fetched');
    assert.equal(store.maintenanceOnAt, null, 'maintenance never went on');
    assert.deepEqual(composeLines(), []);
    assert.equal(world.head, 'v1.0.0');
  });

  test('window_missed boundary: exactly 60 minutes past its start still installs', async () => {
    assert.equal(await run(update({ startsAt: new Date(NOW.getTime() - 60 * 60_000) })), 'succeeded');
  });

  test('a ready row whose begin is refused (the hour ran out during the re-check, or a reschedule) changes nothing', async () => {
    store.begin = async () => false;
    assert.equal(await run(), 'ready');
    assert.deepEqual(store.stepLine(), ['recheck:skipped']);
    assert.equal(store.maintenanceOnAt, null);
    assert.ok(lines.some((l) => l.includes('did not start within 60 minutes')));
  });

  test('switch_code records the release as a local tag at the verified tag object (C1)', async () => {
    assert.equal(await run(), 'succeeded');
    const g = runner.lines('git');
    assert.ok(g.includes(`git update-ref refs/tags/v1.1.0 ${TAG_OBJECT} `), g.join('\n'));
    const upd = g.findIndex((l) => l.startsWith('git update-ref refs/tags/'));
    const co = g.findIndex((l) => l.includes(`checkout --detach ${COMMIT}`));
    assert.ok(upd >= 0 && upd < co, 'the tag is recorded before the checkout');
  });

  test('a local tag that differs from the verified object refuses at the re-check (tag_changed)', async () => {
    const original = runner.run.bind(runner);
    runner.run = async (cmd, args, opts) =>
      cmd === 'git' && args[0] === 'for-each-ref' ? { code: 0, stdout: `${'ef'.repeat(20)}\n`, stderr: '' } : original(cmd, args, opts);
    assert.equal(await run(), 'refused');
    assert.deepEqual(store.stepLine(), ['recheck:failed:tag_changed']);
    assert.equal(store.maintenanceOnAt, null);
  });

  test('maintenance is on before the backup command starts (Review Focus 3)', async () => {
    let checked = false;
    const original = runner.run.bind(runner);
    runner.run = async (cmd, args, opts) => {
      if (cmd === 'docker' && args.includes('dist/ops/backup-cli.js')) {
        assert.deepEqual(store.maintenance, { reason: 'update', updateId: ID });
        assert.ok(t - store.maintenanceOnAt! >= MAINTENANCE_WAIT_MS, 'the 15 seconds have passed');
        assert.deepEqual(store.stepLine().slice(0, 2), ['recheck:passed', 'maintenance_on:passed']);
        checked = true;
      }
      return original(cmd, args, opts);
    };
    assert.equal(await run(), 'succeeded');
    assert.ok(checked);
  });

  test('backup exit 3 retries each minute and gives up after 30 minutes as backup_busy, maintenance off', async () => {
    world.backupCodes = Array(100).fill(3);
    assert.equal(await run(), 'failed_before_install');
    assert.equal(world.backupCalls.length, 31);
    for (let i = 1; i < world.backupCalls.length; i++) assert.equal(world.backupCalls[i] - world.backupCalls[i - 1], 60_000);
    assert.equal(world.backupCalls.at(-1)! - world.backupCalls[0], BACKUP_BUSY_LIMIT_MS);
    assert.deepEqual(store.ends.map((e) => e.code), ['backup_busy']);
    assert.equal(store.maintenance, null);
    assert.ok(!composeLines().includes('stop api worker'));
    assert.deepEqual(store.notices, ['update_failed']);

    // The lock freed within the 30 minutes: the backup goes ahead.
    store = new MemoryStore(() => t);
    world.backupCodes = [3, 3, 0];
    world.backupCalls = [];
    assert.equal(await run(), 'succeeded');
    assert.equal(world.backupCalls.length, 3);
  });

  test('backup failure: failed_before_install, nothing stopped', async () => {
    world.backupCodes = [1];
    assert.equal(await run(), 'failed_before_install');
    assert.deepEqual(store.ends.map((e) => [e.state, e.code]), [['failed_before_install', 'backup_failed']]);
    assert.deepEqual(composeLines(), ['run --rm ops node dist/ops/backup-cli.js --kind pre_update']);
    assert.ok(!runner.lines('git').some((l) => l.includes('checkout')));
    assert.equal(store.maintenance, null);
    assert.deepEqual(store.audits, ['ops.update_failed']);
    assert.equal(store.stepLine().at(-1), 'backup:failed:backup_failed');
    assert.ok(world.api && world.worker);
  });

  test('checkout failure goes back to the previous tag and images', async () => {
    world.checkoutFails.add(COMMIT);
    assert.equal(await run(), 'failed_before_install');
    assert.deepEqual(store.ends.map((e) => e.code), ['checkout_failed']);
    assert.ok(runner.lines('git').includes('git -c advice.detachedHead=false checkout --force --detach v1.0.0'));
    assert.equal(world.head, 'v1.0.0');
    assert.ok(composeLines().includes('up -d --no-deps api worker'));
    assert.ok(composeLines().includes('run --rm --no-deps api node dist/updater/post-check-cli.js --expect 1.0.0'));
    assert.ok(!composeLines().includes('run --rm --no-deps migrate'));
    assert.equal(world.version, '1.0.0');
    assert.equal(store.maintenance, null);
    assert.equal(await signers(), 'OLD\n');
    assert.deepEqual(store.stepLine().slice(-2), ['switch_code:failed:checkout_failed', 'go_back:passed']);
  });

  test('migration failure: notice page started, previous tag checked out, failed_after_migration with the pre-update run id', async () => {
    world.migrateCode = 1;
    assert.equal(await run(), 'failed_after_migration');
    assert.deepEqual(store.ends, [{ state: 'failed_after_migration', code: 'migration_failed' }]);
    assert.equal(store.preRun, RUN_ID);
    assert.equal(world.head, 'v1.0.0');
    assert.equal(await signers(), 'OLD\n', 'the previous signers file is trusted again');
    assert.ok(world.notice);
    assert.ok(!world.api && !world.worker);
    const c = composeLines();
    assert.ok(c.indexOf('up -d --no-deps notice') > c.lastIndexOf('stop api worker'));
    const g = runner.lines('git');
    assert.ok(g.indexOf('git -c advice.detachedHead=false checkout --force --detach v1.0.0') >= 0);
    assert.deepEqual(store.notices, [], 'no notices or emails after the migration started');
    // Maintenance stays on: the database is set aside by `recover`.
    assert.deepEqual(store.maintenance, { reason: 'update', updateId: ID });
    assert.ok(lines.some((l) => l.startsWith('The update to v1.1.0 failed after the database migration started.') && l.includes('updater-cli.js recover')));
    assert.ok(!lines.some((l) => l.includes('hunter2')), 'command output is masked');
    assert.deepEqual(store.stepLine().slice(-2), ['migrate:failed:migration_failed', 'notice_page:passed']);
  });

  test('a start failure after migrate is failed_after_migration start_failed', async () => {
    world.startCode = 1;
    assert.equal(await run(), 'failed_after_migration');
    assert.deepEqual(store.ends.map((e) => e.code), ['start_failed']);
    assert.ok(world.notice);
  });

  test('health failure after migrate is failed_after_migration', async () => {
    world.healthyVersions.delete('1.1.0');
    const started = t;
    assert.equal(await run(), 'failed_after_migration');
    assert.deepEqual(store.ends.map((e) => e.code), ['health_failed']);
    assert.ok(t - started >= HEALTH_LIMIT_MS && t - started < HEALTH_LIMIT_MS + 2 * 60_000, 'given up after 10 minutes');
    assert.equal(world.head, 'v1.0.0');
    assert.ok(world.notice);
    assert.ok(!composeLines().some((l) => l.includes('post-check')), 'the post-check waits for api and worker');
  });

  test('a worker that keeps restarting never passes', async () => {
    let n = 0;
    const r = new FakeRunner();
    r.on('docker', ['inspect'], () => ({ code: 0, stdout: `${n++} 2026-12-01T04:00:00Z\n`, stderr: '' }));
    const base = runner.run.bind(runner);
    runner.run = (cmd, args, opts) => (cmd === 'docker' && args[0] === 'inspect' ? r.run(cmd, args, opts) : base(cmd, args, opts));
    assert.equal(await run(), 'failed_after_migration');
    assert.deepEqual(store.ends.map((e) => e.code), ['health_failed']);
  });

  test('going back that itself fails health is failed_needs_attention', async () => {
    world.checkoutFails.add(COMMIT);
    world.healthyVersions.delete('1.0.0');
    assert.equal(await run(), 'failed_needs_attention');
    assert.deepEqual(store.ends, [{ state: 'failed_needs_attention', code: 'rollback_failed' }]);
    assert.ok(world.notice);
    assert.ok(!world.api && !world.worker);
    assert.equal(world.head, 'v1.0.0');
    assert.deepEqual(store.notices, []);
    assert.ok(store.maintenance, 'maintenance stays on');
    assert.ok(lines.some((l) => l.includes('going back to the previous version did not pass') && l.includes('recover')));
  });

  test('a tag object that changed since preparation is refused tag_changed before maintenance', async () => {
    git.fetchCandidate = async () => ({ ok: true, tagObject: 'ef'.repeat(20) });
    assert.equal(await run(), 'refused');
    assert.deepEqual(store.ends.map((e) => [e.state, e.code]), [['refused', 'tag_changed']]);
    assert.equal(store.maintenanceOnAt, null, 'maintenance never went on');
    assert.ok(!runner.calls.some((c) => c.cmd === 'docker'));
    assert.ok(!runner.lines('git').some((l) => l.includes('checkout')));
    assert.deepEqual(store.stepLine(), ['recheck:failed:tag_changed']);
    assert.equal(store.state, 'refused');
    assert.deepEqual(store.audits, ['ops.update_refused']);

    // The same tag object but peeling to another commit (cannot happen; checked anyway).
    store = new MemoryStore(() => t);
    git.fetchCandidate = async () => ({ ok: true, tagObject: TAG_OBJECT });
    const r2 = new FakeRunner();
    r2.on('git', ['rev-parse'], { code: 0, stdout: `${'ee'.repeat(20)}\n`, stderr: '' });
    const base = runner.run.bind(runner);
    runner.run = (cmd, args, opts) => (cmd === 'git' && args[0] === 'rev-parse' ? r2.run(cmd, args, opts) : base(cmd, args, opts));
    assert.equal(await run(), 'refused');
    assert.deepEqual(store.ends.map((e) => e.code), ['tag_changed']);
  });

  test('the re-check refuses protective mode, local changes and a fetch failure; nothing is touched', async () => {
    store.maintenance = { reason: 'low_space', updateId: null };
    assert.equal(await run(), 'failed_before_install');
    assert.deepEqual(store.ends.map((e) => e.code), ['protective_on']);
    assert.deepEqual(store.maintenance, { reason: 'low_space', updateId: null }, 'low-space protection is left alone');

    store = new MemoryStore(() => t);
    git.workingTreeState = async () => ({ clean: false, changed: ['compose.yaml'], headTag: 'v1.0.0' });
    assert.equal(await run(), 'refused');
    assert.deepEqual(store.ends.map((e) => e.code), ['local_changes']);

    store = new MemoryStore(() => t);
    git.workingTreeState = async () => ({ clean: true, changed: [], headTag: 'v1.0.0' });
    git.fetchCandidate = async () => ({ ok: false, code: 'fetch_failed' });
    assert.equal(await run(), 'refused');
    assert.deepEqual(store.ends.map((e) => e.code), ['fetch_failed']);
    assert.ok(!runner.calls.some((c) => c.cmd === 'docker'));
  });

  test('a cancel or a new time before the conditional start wins: nothing is installed', async () => {
    store.begin = async () => false;
    store.state = 'cancelled';
    assert.equal(await run(), 'cancelled');
    assert.deepEqual(store.stepLine(), ['recheck:skipped']);
    assert.ok(!runner.calls.some((c) => c.cmd === 'docker'));
  });

  test('tidy keeps the previous version\'s images and removes older ones', async () => {
    world.images = [
      'kainow-app:1.1.0', 'kainow-ops:1.1.0', 'kainow-updater:1.1.0',
      'kainow-app:1.0.0', 'kainow-ops:1.0.0', 'kainow-updater:1.0.0',
      'kainow-app:0.9.2', 'kainow-ops:0.9.2', 'kainow-updater:0.0.0',
      'kainow-app:1.2.0', // left by a failed preparation of a newer release (final review M3)
      'kainow-app:latest', 'postgres:16', 'someone-else:0.1.0',
    ];
    await writeFile(join(dir, 'release-signers.previous'), 'OLD\n');
    assert.equal(await run(), 'succeeded');
    assert.deepEqual(world.removed, ['kainow-app:0.9.2', 'kainow-ops:0.9.2', 'kainow-updater:0.0.0', 'kainow-app:1.2.0']);
    const g = runner.lines('git');
    assert.ok(g.some((l) => l.includes('worktree remove --force') && l.includes(join('.kainow-staging', 'v1.1.0'))));
    assert.ok(g.includes('git update-ref -d refs/kainow/candidate/v1.1.0'));
    await assert.rejects(readFile(join(dir, 'release-signers.previous')), 'the kept signers file is removed');
  });

  test('an end before installing removes the staging checkout and the candidate ref (M3)', async () => {
    for (const fail of [() => (world.backupCodes = [1]), () => world.checkoutFails.add(COMMIT)]) {
      store = new MemoryStore(() => t);
      runner.calls.length = 0;
      world.checkoutFails.clear();
      world.head = 'v1.0.0';
      world.version = '1.0.0';
      world.api = world.worker = true;
      fail();
      assert.equal(await run(), 'failed_before_install');
      const g = runner.lines('git');
      assert.ok(g.some((l) => l.includes('worktree remove --force') && l.includes(join('.kainow-staging', 'v1.1.0'))), g.join('\n'));
      assert.ok(g.includes('git update-ref -d refs/kainow/candidate/v1.1.0'));
    }
    // and a refusal at the re-check
    store = new MemoryStore(() => t);
    runner.calls.length = 0;
    git.fetchCandidate = async () => ({ ok: true, tagObject: 'ef'.repeat(20) });
    assert.equal(await run(), 'refused');
    assert.ok(runner.lines('git').includes('git update-ref -d refs/kainow/candidate/v1.1.0'));
  });

  test('the old images are never removed before succeeded', async () => {
    world.images = ['kainow-app:0.9.2', 'kainow-app:1.0.0'];
    const base = runner.run.bind(runner);
    runner.run = async (cmd, args, opts) => {
      if (cmd === 'docker' && args[0] === 'image' && args[1] === 'rm') assert.equal(store.state, 'succeeded');
      return base(cmd, args, opts);
    };
    for (const fail of [
      () => world.checkoutFails.add(COMMIT),
      () => (world.migrateCode = 1),
      () => world.healthyVersions.delete('1.1.0'),
      () => (world.backupCodes = [1]),
    ]) {
      store = new MemoryStore(() => t);
      world.checkoutFails.clear();
      world.migrateCode = 0;
      world.healthyVersions = new Set(['1.0.0', '1.1.0']);
      world.head = 'v1.0.0';
      world.version = '1.0.0';
      world.api = world.worker = true;
      world.migrated = false;
      fail();
      assert.notEqual(await run(), 'succeeded');
      assert.deepEqual(world.removed, []);
    }
    store = new MemoryStore(() => t);
    world.checkoutFails.clear();
    world.migrateCode = 0;
    world.healthyVersions = new Set(['1.0.0', '1.1.0']);
    world.head = 'v1.0.0';
    world.version = '1.0.0';
    world.api = world.worker = true;
    store.onMaintenanceOff = () => undefined;
    assert.equal(await run(), 'succeeded');
    assert.deepEqual(world.removed, ['kainow-app:0.9.2']);
  });

  // ---- re-entry: the updater dies at each step (Review Focus 2) ----

  /** Runs until the crash, then a later tick re-enters with the row as stored; returns the final state. */
  async function crashThenResume(crash: CrashAt): Promise<UpdateState> {
    store.crash = crash;
    let first: UpdateState | 'crashed';
    try {
      first = await run();
    } catch (err) {
      assert.ok(err instanceof Crash, String(err));
      first = 'crashed';
    }
    if (first !== 'crashed') return first;
    // The crashed tick never turned maintenance off with the code half-switched.
    if (store.maintenance === null) assert.equal(world.head, 'v1.0.0');
    return run(update({ state: store.state }));
  }

  /** Before the migration: back on the previous code, images and signers, running, maintenance off. */
  async function assertWentBack(code: FailureCode) {
    assert.equal(store.state, 'failed_before_install');
    assert.equal(store.ends.at(-1)?.code, code);
    assert.equal(world.head, 'v1.0.0');
    assert.ok(world.api && world.worker);
    assert.equal(world.version, '1.0.0');
    assert.equal(store.maintenance, null);
    assert.equal(await signers(), 'OLD\n');
    assert.ok(!composeLines().includes('run --rm --no-deps migrate'));
  }
  /** After the migration started: previous code, notice page, maintenance still on. */
  async function assertNoticePage(code: FailureCode) {
    assert.equal(store.state, 'failed_after_migration');
    assert.equal(store.ends.at(-1)?.code, code);
    assert.equal(world.head, 'v1.0.0');
    assert.ok(world.notice);
    assert.ok(!world.api && !world.worker);
    assert.ok(store.maintenance);
    assert.equal(await signers(), 'OLD\n');
    assert.deepEqual(store.notices, []);
  }
  async function assertSucceeded() {
    assert.equal(store.state, 'succeeded');
    assert.equal(world.head, COMMIT);
    assert.equal(store.maintenance, null);
    assert.equal(await signers(), 'NEW\n');
  }

  for (const at of ['start', 'end'] as const) {
    test(`re-entry after a crash at the ${at} of recheck`, async () => {
      const s = await crashThenResume({ step: 'recheck', at });
      if (at === 'start') {
        // Still ready: the next tick simply installs.
        assert.equal(s, 'succeeded');
        await assertSucceeded();
      } else {
        assert.equal(s, 'failed_before_install');
        await assertWentBack('checkout_failed');
        assert.ok(!composeLines().includes('stop api worker'));
      }
    });
    test(`re-entry after a crash at the ${at} of maintenance_on`, async () => {
      assert.equal(await crashThenResume({ step: 'maintenance_on', at }), 'failed_before_install');
      await assertWentBack('checkout_failed');
      assert.ok(!composeLines().includes('stop api worker'), 'nothing was stopped, nothing to start');
    });
    test(`re-entry after a crash at the ${at} of backup`, async () => {
      assert.equal(await crashThenResume({ step: 'backup', at }), 'failed_before_install');
      await assertWentBack('backup_failed');
    });
    test(`re-entry after a crash at the ${at} of stop`, async () => {
      assert.equal(await crashThenResume({ step: 'stop', at }), 'failed_before_install');
      await assertWentBack('checkout_failed');
      assert.ok(composeLines().includes('up -d --no-deps api worker'));
    });
    test(`re-entry after a crash at the ${at} of switch_code`, async () => {
      assert.equal(await crashThenResume({ step: 'switch_code', at }), 'failed_before_install');
      if (at === 'end') assert.ok(runner.lines('git').includes(`git -c advice.detachedHead=false checkout --detach ${COMMIT}`));
      await assertWentBack('checkout_failed');
    });
    test(`re-entry after a crash at the ${at} of migrate`, async () => {
      assert.equal(await crashThenResume({ step: 'migrate', at }), 'failed_after_migration');
      await assertNoticePage('migration_failed');
    });
    test(`re-entry after a crash at the ${at} of start`, async () => {
      assert.equal(await crashThenResume({ step: 'start', at }), 'failed_after_migration');
      await assertNoticePage('start_failed');
    });
    test(`re-entry after a crash at the ${at} of health`, async () => {
      assert.equal(await crashThenResume({ step: 'health', at }), 'failed_after_migration');
      await assertNoticePage('health_failed');
    });
    test(`re-entry after a crash at the ${at} of maintenance_off`, async () => {
      assert.equal(await crashThenResume({ step: 'maintenance_off', at }), 'succeeded');
      await assertSucceeded();
      assert.equal(store.notices.filter((n) => n === 'update_succeeded').length, 1);
    });
    test(`a crash at the ${at} of tidy leaves the update succeeded`, async () => {
      assert.equal(await crashThenResume({ step: 'tidy', at }), 'succeeded');
      await assertSucceeded();
    });
    test(`re-entry after a crash at the ${at} of go_back`, async () => {
      world.checkoutFails.add(COMMIT);
      assert.equal(await crashThenResume({ step: 'go_back', at }), 'failed_before_install');
      await assertWentBack('checkout_failed');
    });
    test(`re-entry after a crash at the ${at} of notice_page`, async () => {
      world.migrateCode = 1;
      assert.equal(await crashThenResume({ step: 'notice_page', at }), 'failed_after_migration');
      await assertNoticePage('migration_failed');
    });
  }

  test('a row no longer installing is left alone on re-entry', async () => {
    store.state = 'failed_after_migration';
    assert.equal(await run(update({ state: 'installing' })), 'failed_after_migration');
    assert.equal(runner.calls.length, 0);
  });
});

describe('install helpers', () => {
  test('resumePoint: migrate started → failed after migration unless health passed; otherwise go back', () => {
    const s = (...xs: Array<[string, StepRow['outcome']]>): StepRow[] => xs.map(([step, outcome]) => ({ step, outcome, failureCode: null }));
    assert.deepEqual(resumePoint([]), { kind: 'go_back' });
    assert.deepEqual(resumePoint(s(['recheck', 'passed'], ['maintenance_on', 'passed'], ['backup', 'running'])), { kind: 'go_back' });
    assert.deepEqual(resumePoint(s(['stop', 'passed'], ['switch_code', 'passed'])), { kind: 'go_back' });
    assert.deepEqual(resumePoint(s(['switch_code', 'passed'], ['migrate', 'running'])), { kind: 'failed_after_migration' });
    assert.deepEqual(resumePoint(s(['migrate', 'passed'], ['start', 'passed'], ['health', 'running'])), { kind: 'failed_after_migration' });
    assert.deepEqual(resumePoint(s(['migrate', 'passed'], ['health', 'passed'])), { kind: 'continue_from', step: 'maintenance_off' });
    assert.deepEqual(resumePoint(s(['migrate', 'passed'], ['health', 'passed'], ['maintenance_off', 'running'])), {
      kind: 'continue_from',
      step: 'maintenance_off',
    });
  });

  test('lastRunId reads the backup command\'s last line', () => {
    assert.equal(lastRunId(`Backup set x written.\nrun ${RUN_ID} succeeded\n`), RUN_ID);
    assert.equal(lastRunId(`run ${RUN_ID} succeeded\nsomething else\n`), null);
    assert.equal(lastRunId(''), null);
  });

  test('parsePs reads both Compose output forms', () => {
    const a = { ID: 'a', Service: 'api', State: 'running', Health: 'healthy' };
    const w = { ID: 'w', Service: 'worker', State: 'running', Health: '' };
    assert.deepEqual(parsePs(JSON.stringify([a, w])), [a, w]);
    assert.deepEqual(parsePs(`${JSON.stringify(a)}\n${JSON.stringify(w)}\n`), [a, w]);
    assert.deepEqual(parsePs('not json'), []);
  });

  test('post-check exits 0 only when the migration levels agree and the version is the expected one', async () => {
    const out: string[] = [];
    const deps = (db: string, code: string, version: string) => ({
      migrationLevel: async () => db,
      codeLevel: () => code,
      version: () => version,
      log: (l: string) => out.push(l),
    });
    assert.equal(await runPostCheck(['--expect', '1.1.0'], deps('0040_x.sql', '0040_x.sql', '1.1.0')), 0);
    assert.equal(await runPostCheck(['--expect', '1.1.0'], deps('0039_x.sql', '0040_x.sql', '1.1.0')), 1);
    assert.equal(await runPostCheck(['--expect', '1.1.0'], deps('0040_x.sql', '0040_x.sql', '1.0.0')), 1);
    assert.equal(await runPostCheck(['--expect', '1.1'], deps('a', 'a', '1.1')), 2);
    assert.equal(await runPostCheck([], deps('a', 'a', '1.1.0')), 2);
  });
});
