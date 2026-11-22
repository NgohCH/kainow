import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { FakeRunner } from '../testing/fake-runner';
import type { VerifyCode } from './git';
import {
  PREPARE_LIMIT_MS,
  SPACE_MARGIN_GB,
  composeFlags,
  missingVariable,
  prepareWithStore,
  projectNameFor,
  resolveProjectName,
  staleKainowImages,
  stagingDir,
  type PrepareDeps,
  type PrepareEnd,
  type PrepareGit,
  type PrepareStep,
  type PrepareStore,
} from './prepare';
import { WINDOW_GRACE_MS, type FailureCode } from './states';
import type { TickUpdate } from './tick';

const GB = 1024 ** 3;
const NOW = new Date('2026-12-01T04:00:00Z');
const TAG_OBJECT = 'ab'.repeat(20);
const COMMIT = 'cd'.repeat(20);

class MemoryStore implements PrepareStore {
  state = 'approved';
  floorGb = 5;
  steps: { step: PrepareStep; outcome: string; code: FailureCode | null }[] = [];
  verified: { tagObject: string; notes: string } | null = null;
  ends: PrepareEnd[] = [];
  async begin() {
    if (this.state !== 'approved' && this.state !== 'preparing') return false;
    this.state = 'preparing';
    return true;
  }
  async stillPreparing() {
    return this.state === 'preparing';
  }
  async startStep(_id: string, step: PrepareStep) {
    this.steps.push({ step, outcome: 'running', code: null });
    return String(this.steps.length - 1);
  }
  async endStep(id: string, outcome: 'passed' | 'failed', code: FailureCode | null) {
    Object.assign(this.steps[Number(id)], { outcome, code });
  }
  async saveVerified(_id: string, tagObject: string, notes: string) {
    if (this.state !== 'preparing') return false;
    this.verified = { tagObject, notes };
    return true;
  }
  async finish(_id: string, end: PrepareEnd) {
    if (this.state !== 'preparing') return false;
    this.state = end.state;
    this.ends.push(end);
    return true;
  }
  async safeFloorGb() {
    return this.floorGb;
  }
}

const update = (over: Partial<TickUpdate> = {}): TickUpdate => ({
  id: '0190a000-0000-7000-8000-000000000001',
  state: 'approved',
  fromVersion: '1.0.0',
  toVersion: '1.1.0',
  tag: 'v1.1.0',
  commit: COMMIT,
  tagObject: null,
  startsAt: new Date(NOW.getTime() + 3600_000),
  expectedMinutes: 30,
  preUpdateBackupRunId: null,
  ...over,
});

const dbJson = (image = 'postgres:16', volumes: unknown[] = [{ type: 'volume', source: 'kainow-db', target: '/var/lib/postgresql/data' }]) =>
  JSON.stringify({
    name: 'kainow',
    services: {
      db: { image, volumes, environment: { POSTGRES_USER: 'kainow', POSTGRES_PASSWORD: 'hunter2', POSTGRES_DB: 'kainow' } },
      api: { image: 'kainow-app:1.1.0' },
    },
  });

describe('preparing an update', () => {
  let dir: string;
  let store: MemoryStore;
  let runner: FakeRunner;
  let lines: string[];
  let free: number | null;
  let git: PrepareGit;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kainow-prepare-'));
    store = new MemoryStore();
    runner = new FakeRunner();
    lines = [];
    free = 100 * GB;
    git = {
      workingTreeState: async () => ({ clean: true, changed: [], headTag: 'v1.0.0' }),
      fetchCandidate: async () => ({ ok: true, tagObject: TAG_OBJECT }),
      verifyCandidate: async () => ({ ok: true, commit: COMMIT, notes: 'Notes for v1.1.0\n\n- one change' }),
    };
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const staging = () => stagingDir(dir, 'v1.1.0');
  const deps = (over: Partial<PrepareDeps> = {}): Omit<PrepareDeps, 'pool'> => ({
    runner,
    installDir: dir,
    projectName: 'kainow',
    now: () => NOW,
    log: (l) => lines.push(l),
    statfs: () => (free === null ? null : { total: 500 * GB, free }),
    git,
    ...over,
  });

  /** Docker answers: config ok, both configs alike (or as given), build ok, the image's version 1.1.0. */
  function docker(over: { next?: string; build?: { code: number; stdout?: string; stderr?: string }; configQ?: { code: number; stderr: string } } = {}) {
    runner.on('docker', ['compose'], (args) => {
      const i = args.indexOf('config');
      if (i >= 0 && args[i + 1] === '-q') return { code: over.configQ?.code ?? 0, stdout: '', stderr: over.configQ?.stderr ?? '' };
      if (i >= 0) {
        const projectDir = args[args.indexOf('--project-directory') + 1];
        return { code: 0, stdout: projectDir === dir ? dbJson() : (over.next ?? dbJson()), stderr: '' };
      }
      if (args.at(-1) === 'build') return { stdout: '', stderr: '', ...(over.build ?? { code: 0 }) };
      return { code: 0, stdout: '', stderr: '' };
    });
    runner.on('docker', ['run'], { code: 0, stdout: '1.1.0\n', stderr: '' });
    noRequirements();
  }
  /** The release has no release/requirements.json. */
  const noRequirements = () => runner.on('git', ['ls-tree'], { code: 0, stdout: '', stderr: '' });

  const run = (u = update(), d = deps()) => prepareWithStore(d, store, u);
  const added = () => runner.lines('git').filter((l) => l.includes('worktree add'));

  test('success sets ready, tag_object and release_notes', async () => {
    docker();
    assert.equal(await run(), 'ready');
    assert.equal(store.state, 'ready');
    assert.deepEqual(store.verified, { tagObject: TAG_OBJECT, notes: 'Notes for v1.1.0\n\n- one change' });
    assert.deepEqual(
      store.steps.map((s) => `${s.step}:${s.outcome}`),
      ['space:passed', 'working_tree:passed', 'verify:passed', 'staging:passed', 'compatibility:passed', 'build:passed'],
    );
    assert.deepEqual(added(), [`git -c advice.detachedHead=false worktree add --detach ${staging()} ${COMMIT}`]);
    assert.ok(!lines.some((l) => l.includes('hunter2')), 'config output is never logged');
  });

  test('refuses local_changes naming the changed tracked files', async () => {
    git.workingTreeState = async () => ({ clean: false, changed: ['app/src/main.ts', 'compose.yaml'], headTag: 'v1.0.0' });
    assert.equal(await run(), 'refused');
    const end = store.ends[0] as Extract<PrepareEnd, { code: FailureCode }>;
    assert.equal(end.code, 'local_changes');
    assert.match(end.summary, /app\/src\/main\.ts, compose\.yaml/);
    assert.ok(lines.some((l) => l.includes('app/src/main.ts')));
    assert.deepEqual(store.steps.at(-1), { step: 'working_tree', outcome: 'failed', code: 'local_changes' });
    assert.deepEqual(added(), []);
  });

  test('refuses not_on_release when HEAD is not at a release tag', async () => {
    git.workingTreeState = async () => ({ clean: true, changed: [], headTag: null });
    assert.equal(await run(), 'refused');
    assert.equal((store.ends[0] as { code: string }).code, 'not_on_release');
    store = new MemoryStore();
    git.workingTreeState = async () => ({ clean: true, changed: [], headTag: 'v0.9.0' });
    assert.equal(await run(), 'refused', 'a release tag other than the running version');
    assert.equal((store.ends[0] as { code: string }).code, 'not_on_release');
  });

  test('no_space_to_build below floor + 4 GB', async () => {
    assert.equal(SPACE_MARGIN_GB >= 4, true);
    free = (5 + SPACE_MARGIN_GB) * GB - 1;
    assert.equal(await run(), 'refused');
    assert.deepEqual(store.ends.map((e) => (e as { code: string }).code), ['no_space_to_build']);
    assert.deepEqual(store.steps, [{ step: 'space', outcome: 'failed', code: 'no_space_to_build' }]);

    store = new MemoryStore();
    free = null;
    assert.equal(await run(), 'refused', 'unknown free space is not enough');

    store = new MemoryStore();
    free = (5 + SPACE_MARGIN_GB) * GB;
    docker();
    assert.equal(await run(), 'ready', 'exactly floor + margin is enough');
  });

  test('each verify failure becomes refused with its code and the staging worktree is never created', async () => {
    const codes: VerifyCode[] = ['not_annotated', 'tag_name_mismatch', 'signature_invalid', 'commit_mismatch', 'version_mismatch', 'not_newer'];
    for (const code of codes) {
      store = new MemoryStore();
      git.verifyCandidate = async () => ({ ok: false, code });
      assert.equal(await run(), 'refused', code);
      assert.equal((store.ends[0] as { code: string }).code, code);
      assert.equal(store.verified, null);
    }
    store = new MemoryStore();
    git.fetchCandidate = async () => ({ ok: false, code: 'fetch_failed' });
    assert.equal(await run(), 'refused');
    assert.equal((store.ends[0] as { code: string }).code, 'fetch_failed');

    store = new MemoryStore();
    git.fetchCandidate = async () => ({ ok: true, tagObject: TAG_OBJECT });
    git.verifyCandidate = async () => ({ ok: true, commit: COMMIT, notes: '' });
    assert.equal(await run(update({ state: 'preparing', tagObject: 'ef'.repeat(20) })), 'refused', 'a tag object recorded earlier moved');
    assert.equal((store.ends[0] as { code: string }).code, 'tag_changed');

    assert.deepEqual(added(), []);
    assert.ok(runner.lines('git').some((l) => l === 'git update-ref -d refs/kainow/candidate/v1.1.0'));
  });

  test('verification uses the installed signers file and the approved commit', async () => {
    docker();
    let seen: unknown[] = [];
    git.verifyCandidate = async (...a) => {
      seen = a;
      return { ok: true, commit: COMMIT, notes: 'n' };
    };
    await run();
    assert.deepEqual(seen, [dir, 'v1.1.0', TAG_OBJECT, join(dir, 'release-signers'), { commit: COMMIT, runningVersion: '1.0.0' }]);
  });

  test('settings_missing when config -q fails, naming the variable but no value', async () => {
    docker({
      configQ: {
        code: 1,
        stderr: 'error while interpolating services.api.environment.NEW_SETTING: required variable NEW_SETTING is missing a value: Set it. POSTGRES_PASSWORD=hunter2',
      },
    });
    assert.equal(await run(), 'refused');
    const end = store.ends[0] as Extract<PrepareEnd, { code: FailureCode }>;
    assert.equal(end.code, 'settings_missing');
    assert.match(end.summary, /NEW_SETTING/);
    assert.ok(lines.some((l) => l.includes('NEW_SETTING')));
    assert.ok(!lines.some((l) => l.includes('hunter2')) && !end.summary.includes('hunter2'));
    assert.ok(!existsSync(staging()));
    assert.ok(runner.lines('git').some((l) => l.startsWith(`git worktree remove --force ${staging()}`)));
  });

  test('missingVariable reads Compose messages', () => {
    assert.equal(missingVariable('required variable AUTH_SECRET is missing a value: x'), 'AUTH_SECRET');
    assert.equal(missingVariable('yaml: line 3: mapping values are not allowed'), null);
  });

  test('db_service_changed when the db image differs', async () => {
    docker({ next: dbJson('postgres:17') });
    assert.equal(await run(), 'refused');
    assert.equal((store.ends[0] as { code: string }).code, 'db_service_changed');
    assert.ok(!lines.some((l) => l.includes('hunter2')));
  });

  test('a db bind mount relative to the project directory is not a difference', async () => {
    const bind = (root: string) => [{ type: 'bind', source: join(root, 'pg'), target: '/var/lib/postgresql/data' }];
    runner.on('docker', ['compose'], (args) => {
      if (args.includes('-q')) return { code: 0, stdout: '', stderr: '' };
      const projectDir = args[args.indexOf('--project-directory') + 1];
      if (args.includes('config')) return { code: 0, stdout: dbJson('postgres:16', bind(projectDir)), stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    });
    runner.on('docker', ['run'], { code: 0, stdout: '1.1.0\n', stderr: '' });
    noRequirements();
    assert.equal(await run(), 'ready');
  });

  test('manual_install and upgrade_path from requirements.json', async () => {
    const withRequirements = (json: string) => {
      store = new MemoryStore();
      runner = new FakeRunner();
      runner.on('git', ['ls-tree', '--name-only', COMMIT, '--', 'release/requirements.json'], { code: 0, stdout: 'release/requirements.json\n', stderr: '' });
      runner.on('git', ['show', `${COMMIT}:release/requirements.json`], { code: 0, stdout: json, stderr: '' });
      docker();
    };
    withRequirements('{"manual": true, "note": "Move the database first."}');
    assert.equal(await run(), 'refused');
    let end = store.ends[0] as Extract<PrepareEnd, { code: FailureCode }>;
    assert.equal(end.code, 'manual_install');
    assert.match(end.summary, /Move the database first\./);
    assert.ok(!runner.calls.some((c) => c.args.at(-1) === 'build'));

    withRequirements('{"minimumFrom": "1.0.5"}');
    assert.equal(await run(), 'refused');
    end = store.ends[0] as Extract<PrepareEnd, { code: FailureCode }>;
    assert.equal(end.code, 'upgrade_path');
    assert.match(end.summary, /v1\.0\.5/);

    withRequirements('{"minimumFrom": "1.0.0"}');
    assert.equal(await run(), 'ready', 'running exactly the minimum is fine');

    withRequirements('not json');
    assert.equal(await run(), 'refused', 'an unreadable requirements file is installed by hand');
    assert.equal((store.ends[0] as { code: string }).code, 'manual_install');

    store = new MemoryStore();
    runner = new FakeRunner();
    docker();
    assert.equal(await run(), 'ready', 'no requirements file');

    // git failing to answer (timeout, not started) is never read as "no requirements file" (final review #27).
    for (const code of [124, 125, 127, 128]) {
      store = new MemoryStore();
      runner = new FakeRunner();
      runner.on('git', ['ls-tree'], { code, stdout: '', stderr: '' });
      docker();
      assert.equal(await run(), 'failed_before_install', String(code));
      assert.equal((store.ends[0] as { code: string }).code, 'build_failed');
      assert.ok(!runner.calls.some((c) => c.args.at(-1) === 'build'));
    }
  });

  test('build_failed removes the staging worktree', async () => {
    docker({ build: { code: 1, stderr: 'failed to solve: connect postgres://kainow:hunter2@db/kainow' } });
    await mkdir(staging(), { recursive: true }); // as if the worktree had been made
    runner.on('git', ['-c', 'advice.detachedHead=false', 'worktree', 'add'], async () => {
      await mkdir(staging(), { recursive: true });
      return { code: 0, stdout: '', stderr: '' };
    });
    assert.equal(await run(), 'failed_before_install');
    assert.equal((store.ends[0] as { code: string }).code, 'build_failed');
    assert.ok(!existsSync(staging()));
    const g = runner.lines('git');
    const addAt = g.findIndex((l) => l.includes('worktree add'));
    assert.ok(g.slice(addAt).includes(`git worktree remove --force ${staging()}`));
    assert.ok(!lines.some((l) => l.includes('hunter2')), 'build output is masked');
  });

  test('build_timeout after 60 minutes', async () => {
    docker({ build: { code: 124 } });
    assert.equal(await run(), 'failed_before_install');
    assert.equal((store.ends[0] as { code: string }).code, 'build_timeout');
    const build = runner.calls.find((c) => c.args.at(-1) === 'build');
    assert.equal(build?.opts?.timeoutMs, PREPARE_LIMIT_MS);
    assert.equal(PREPARE_LIMIT_MS, 60 * 60_000);

    // Time already used counts against the build: past the limit, the build is not started.
    store = new MemoryStore();
    runner = new FakeRunner();
    docker();
    let t = NOW.getTime();
    assert.equal(await run(update(), deps({ now: () => new Date((t += 10 * 60_000)) })), 'failed_before_install');
    assert.equal((store.ends[0] as { code: string }).code, 'build_timeout');
    assert.ok(!runner.calls.some((c) => c.args.at(-1) === 'build'));
  });

  test('the build command uses the staging folder as project directory and the installation\'s .env', async () => {
    docker();
    assert.equal(await run(), 'ready');
    const s = staging();
    assert.deepEqual(runner.calls.find((c) => c.args.at(-1) === 'build')?.args, [
      'compose', '--project-directory', s, '--project-name', 'kainow', '--env-file', join(dir, '.env'), '-f', join(s, 'compose.yaml'),
      '--profile', 'updater', '--profile', 'ops', 'build',
    ]);
    await writeFile(join(dir, 'compose.override.yaml'), 'services: {}\n');
    store = new MemoryStore();
    runner = new FakeRunner();
    docker();
    assert.equal(await run(), 'ready');
    assert.deepEqual(runner.calls.find((c) => c.args.at(-1) === 'build')?.args, [
      'compose', '--project-directory', s, '--project-name', 'kainow', '--env-file', join(dir, '.env'), '-f', join(s, 'compose.yaml'),
      '-f', join(dir, 'compose.override.yaml'), '--profile', 'updater', '--profile', 'ops', 'build',
    ]);
    const q = runner.calls.find((c) => c.args.includes('-q'))!.args;
    assert.deepEqual(q, [...composeFlags(dir, 'kainow', s), 'config', '-q']);
    const runningConfig = runner.calls.find((c) => c.args.includes('json') && c.args[2] === dir)!.args;
    assert.deepEqual(runningConfig, [...composeFlags(dir, 'kainow', dir), 'config', '--format', 'json']);
    assert.deepEqual(runner.calls.find((c) => c.args[0] === 'run')!.args, [
      'run', '--rm', '--network', 'none', '--entrypoint', 'node', 'kainow-app:1.1.0', '-p', "require('/app/package.json').version",
    ]);
  });

  test('build_failed when the built image does not carry the release version', async () => {
    runner.on('docker', ['run'], { code: 0, stdout: '1.0.0\n', stderr: '' }, { times: 1 });
    docker();
    assert.equal(await run(), 'failed_before_install');
    assert.equal((store.ends[0] as { code: string }).code, 'build_failed');
  });

  test('a cancelled update found mid-preparation stops and removes staging', async () => {
    runner.on('docker', ['compose'], (args) => {
      if (args.at(-1) === 'build') store.state = 'cancelled'; // cancelled while the build runs
      return { code: 0, stdout: args.includes('json') ? dbJson() : '', stderr: '' };
    });
    runner.on('docker', ['run'], { code: 0, stdout: '1.1.0\n', stderr: '' });
    noRequirements();
    runner.on('git', ['-c', 'advice.detachedHead=false', 'worktree', 'add'], async () => {
      await mkdir(staging(), { recursive: true });
      return { code: 0, stdout: '', stderr: '' };
    });
    assert.equal(await run(), 'cancelled');
    assert.equal(store.state, 'cancelled');
    assert.deepEqual(store.ends, []);
    assert.ok(!existsSync(staging()));
    const g = runner.lines('git');
    assert.equal(g.at(-2), `git worktree remove --force ${staging()}`);

    // cancelled before the tick began: nothing is prepared
    runner = new FakeRunner();
    store = new MemoryStore();
    store.state = 'cancelled';
    assert.equal(await run(), 'cancelled');
    assert.deepEqual(store.steps, []);
    assert.ok(!runner.calls.some((c) => c.cmd === 'docker'));
  });

  test('a cancel found inside a step closes that step skipped, not failed (final review #26)', async () => {
    docker();
    git.verifyCandidate = async () => {
      store.state = 'cancelled'; // cancelled while the signature was checked
      return { ok: true, commit: COMMIT, notes: 'n' };
    };
    assert.equal(await run(), 'cancelled');
    assert.deepEqual(
      store.steps.map((s) => `${s.step}:${s.outcome}`),
      ['space:passed', 'working_tree:passed', 'verify:skipped'],
    );
    assert.deepEqual(store.ends, []);
  });

  test('re-entry: a staging checkout left by a dead tick is removed and preparation starts over', async () => {
    await mkdir(join(staging(), 'app'), { recursive: true });
    await writeFile(join(staging(), 'app', 'half.txt'), 'x');
    docker();
    runner.on('git', ['-c', 'advice.detachedHead=false', 'worktree', 'add'], () => {
      assert.ok(!existsSync(staging()), 'tidied before the worktree is made again');
      return { code: 0, stdout: '', stderr: '' };
    });
    store.state = 'preparing';
    assert.equal(await run(update({ state: 'preparing' })), 'ready');
    assert.equal(runner.lines('git')[0], `git worktree remove --force ${staging()}`);
  });

  test('a row still preparing more than 60 minutes after its start time ends failed_before_install build_timeout', async () => {
    docker();
    store.state = 'preparing';
    const startsAt = new Date(NOW.getTime() - PREPARE_LIMIT_MS - 60_000);
    assert.equal(await run(update({ state: 'preparing', startsAt })), 'failed_before_install');
    assert.equal(store.state, 'failed_before_install');
    assert.equal((store.ends[0] as { code: string }).code, 'build_timeout');
    assert.deepEqual(store.steps, [], 'no step is started');
    assert.ok(!runner.calls.some((c) => c.args.includes('build')));

    // An approved row the updater never saw until well after its start is not prepared either: window_missed (D125).
    store = new MemoryStore();
    runner = new FakeRunner();
    docker();
    assert.equal(await run(update({ startsAt })), 'failed_before_install');
    const end = store.ends[0] as Extract<PrepareEnd, { code: FailureCode }>;
    assert.equal(end.code, 'window_missed');
    assert.match(end.summary, /Approve it again with a new start time\./);
    assert.deepEqual(store.steps, [], 'no step is started');
    assert.ok(!runner.calls.some((c) => c.args.includes('build') || c.args.includes('fetch')));
  });

  test('window_missed: an approved row first seen 61 minutes late ends; at exactly 60 minutes it is still prepared', async () => {
    docker();
    assert.equal(await run(update({ startsAt: new Date(NOW.getTime() - WINDOW_GRACE_MS - 60_000) })), 'failed_before_install');
    assert.equal((store.ends[0] as { code: string }).code, 'window_missed');
    assert.equal(store.state, 'failed_before_install');

    // Exactly 60 minutes late is not past the grace; it then runs out of preparation time (build_timeout), as before.
    store = new MemoryStore();
    runner = new FakeRunner();
    docker();
    assert.equal(await run(update({ startsAt: new Date(NOW.getTime() - WINDOW_GRACE_MS) })), 'failed_before_install');
    assert.equal((store.ends[0] as { code: string }).code, 'build_timeout');

    // 59 minutes late: prepared with what is left of the hour.
    store = new MemoryStore();
    runner = new FakeRunner();
    docker();
    assert.equal(await run(update({ startsAt: new Date(NOW.getTime() - WINDOW_GRACE_MS + 60_000) })), 'ready');
  });

  test('image_version_mismatch: a staged kainow- image that keeps another version is refused before the build (I2)', async () => {
    const next = JSON.parse(dbJson());
    next.services.ops = { image: 'kainow-ops:1.0.0' };
    next.services.worker = { image: 'kainow-app:1.1.0' };
    docker({ next: JSON.stringify(next) });
    assert.equal(await run(), 'refused');
    const end = store.ends[0] as Extract<PrepareEnd, { code: FailureCode }>;
    assert.equal(end.code, 'image_version_mismatch');
    assert.deepEqual(store.steps.at(-1), { step: 'compatibility', outcome: 'failed', code: 'image_version_mismatch' });
    assert.ok(!runner.calls.some((c) => c.args.at(-1) === 'build'), 'nothing is built');
    assert.ok(lines.some((l) => l.includes('kainow-ops:1.0.0')));
    assert.ok(!lines.some((l) => l.includes('hunter2')), 'config output is never logged');
    assert.ok(!existsSync(staging()));
  });

  test('staleKainowImages lists kainow- images not on the version, and null when there is none or the JSON is bad', () => {
    const cfg = (images: Record<string, string>) =>
      JSON.stringify({ services: Object.fromEntries(Object.entries(images).map(([k, v]) => [k, { image: v }])) });
    assert.deepEqual(staleKainowImages(cfg({ api: 'kainow-app:1.1.0', db: 'postgres:16', ops: 'kainow-ops:1.1.0' }), '1.1.0'), []);
    assert.deepEqual(
      staleKainowImages(cfg({ api: 'kainow-app:1.0.0', worker: 'kainow-app:1.0.0', updater: 'kainow-updater:latest' }), '1.1.0'),
      ['kainow-app:1.0.0', 'kainow-updater:latest'],
    );
    assert.deepEqual(staleKainowImages(cfg({ api: 'kainow-app:11.1.0' }), '1.1.0'), ['kainow-app:11.1.0'], 'the whole version, not its end');
    assert.equal(staleKainowImages(cfg({ db: 'postgres:16' }), '1.1.0'), null);
    assert.equal(staleKainowImages('not json', '1.1.0'), null);
  });

  test('a retry after the start time gets only what is left of 60 minutes past the start', async () => {
    docker();
    store.state = 'preparing';
    const startsAt = new Date(NOW.getTime() - 20 * 60_000);
    assert.equal(await run(update({ state: 'preparing', startsAt })), 'ready');
    const build = runner.calls.find((c) => c.args.at(-1) === 'build');
    assert.equal(build?.opts?.timeoutMs, PREPARE_LIMIT_MS - 20 * 60_000);
  });

  test('resolveProjectName: the environment, else the name Compose resolves (read, never logged), else the folder', async () => {
    assert.equal(await resolveProjectName(runner, '/opt/Kainow', { COMPOSE_PROJECT_NAME: 'prod' }, (l) => lines.push(l)), 'prod');
    assert.equal(runner.calls.length, 0);
    runner.on('docker', ['compose'], { code: 0, stdout: JSON.stringify({ name: 'fromenvfile', services: { db: { environment: { POSTGRES_PASSWORD: 'hunter2' } } } }), stderr: '' }, { times: 1 });
    assert.equal(await resolveProjectName(runner, dir, {}, (l) => lines.push(l)), 'fromenvfile');
    const args = runner.calls[0].args;
    assert.deepEqual(args.slice(0, 5), ['compose', '--project-directory', dir, '--env-file', join(dir, '.env')]);
    assert.ok(!args.includes('--project-name'));
    assert.deepEqual(args.slice(-3), ['config', '--format', 'json']);
    runner.on('docker', ['compose'], { code: 1, stdout: '', stderr: 'POSTGRES_PASSWORD=hunter2 bad' }, { times: 1 });
    assert.equal(await resolveProjectName(runner, '/opt/Kainow', {}, (l) => lines.push(l)), 'kainow');
    assert.ok(!lines.some((l) => l.includes('hunter2')));
  });

  test('projectNameFor follows Compose: COMPOSE_PROJECT_NAME, else the folder name lower-cased', () => {
    assert.equal(projectNameFor({ COMPOSE_PROJECT_NAME: 'prod' }, '/opt/Kainow'), 'prod');
    assert.equal(projectNameFor({}, '/opt/Kainow'), 'kainow');
    assert.equal(projectNameFor({}, '/srv/My.Kainow/'), 'mykainow');
  });
});
