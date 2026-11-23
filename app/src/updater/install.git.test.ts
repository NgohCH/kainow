/**
 * Two automatic updates in a row against real git (final review C1): throwaway release repositories and keys
 * (testing/git-releases.ts), the real preparation and installation code over in-memory stores, docker faked.
 * After the first update the Kainow folder must be on the new release's tag, so the second update's preparation
 * passes `not_on_release` and the tick reports the running tag.
 */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { gitToolsMissing, makeReleaseRepos, type Key, type ReleaseRepos } from '../testing/git-releases';
import { git, workingTreeState } from './git';
import { installWithStore, type BeforeEnd, type InstallStep, type InstallStore, type StepRow } from './install';
import { prepareWithStore, type PrepareEnd, type PrepareStep, type PrepareStore } from './prepare';
import type { RunOptions, RunResult, Runner } from './runner';
import type { FailureCode, UpdateState } from './states';
import type { TickUpdate } from './tick';

const GB = 1024 ** 3;
const RUN_ID = '0190a000-0000-7000-8000-00000000beef';

let skip: string | false = false;
let r: ReleaseRepos;
let key: Key;

before(async () => {
  const missing = await gitToolsMissing();
  if (missing) {
    skip = `skipped: ${missing}`;
    return;
  }
  r = await makeReleaseRepos();
  key = await r.newKey('release');
});

after(async () => {
  if (r) await r.cleanup();
});

async function must(dir: string, args: string[]): Promise<string> {
  const x = await git(dir, args);
  if (x.code !== 0) throw new Error(`git ${args.join(' ')} failed (${x.code}): ${x.stderr}`);
  return x.stdout.trim();
}

/** Publishes a signed release whose tree carries its own release/release-signers. */
async function publish(version: string): Promise<string> {
  const commit = await r.release(version, { 'release/release-signers': r.signersText([key]) });
  await r.tag(`v${version}`, { key });
  await r.pushTag(`v${version}`);
  await r.pushMain();
  return commit;
}

class MemoryPrepareStore implements PrepareStore {
  state: string = 'approved';
  tagObject: string | null = null;
  ends: PrepareEnd[] = [];
  async begin() {
    if (this.state !== 'approved' && this.state !== 'preparing') return false;
    this.state = 'preparing';
    return true;
  }
  async stillPreparing() {
    return this.state === 'preparing';
  }
  async startStep(_id: string, _step: PrepareStep) {
    return '0';
  }
  async endStep() {}
  async saveVerified(_id: string, tagObject: string) {
    this.tagObject = tagObject;
    return this.state === 'preparing';
  }
  async finish(_id: string, end: PrepareEnd) {
    if (this.state !== 'preparing') return false;
    this.state = end.state;
    this.ends.push(end);
    return true;
  }
  async safeFloorGb() {
    return 1;
  }
}

class MemoryInstallStore implements InstallStore {
  state: UpdateState = 'ready';
  steps: { step: string; outcome: StepRow['outcome']; code: FailureCode | null }[] = [];
  ends: BeforeEnd[] = [];
  maintenance = false;
  async closeRunning() {}
  async begin() {
    if (this.state !== 'ready') return false;
    this.state = 'installing';
    return true;
  }
  async reenter() {
    return null;
  }
  async stateOf() {
    return this.state;
  }
  async startStep(_id: string, step: InstallStep) {
    this.steps.push({ step, outcome: 'running', code: null });
    return String(this.steps.length - 1);
  }
  async endStep(id: string, outcome: 'passed' | 'failed' | 'skipped', code: FailureCode | null) {
    Object.assign(this.steps[Number(id)], { outcome, code });
  }
  async protective() {
    return { protective: this.maintenance, reason: this.maintenance ? 'update' : null, updateId: this.maintenance ? 'u' : null };
  }
  async maintenanceOn() {
    this.maintenance = true;
    return true;
  }
  async savePreUpdateRun() {}
  async endBefore(_id: string, from: 'ready' | 'installing', end: BeforeEnd) {
    this.maintenance = false;
    if (this.state !== from) return false;
    this.state = end.state;
    this.ends.push(end);
    return true;
  }
  async succeed() {
    this.maintenance = false;
    this.state = 'succeeded';
  }
  async failAfter(_id: string, state: 'failed_after_migration' | 'failed_needs_attention') {
    this.state = state;
  }
}

/** Real git; docker answers as a healthy installation whose staged release builds images for `next`. */
class GitAndFakeDocker implements Runner {
  next = '';
  running = '';
  async run(cmd: 'git' | 'docker', args: string[], opts?: RunOptions): Promise<RunResult> {
    if (cmd === 'git') return git(opts?.cwd ?? r.install, args, opts?.env, opts?.timeoutMs);
    const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' });
    if (args[0] === 'run') return ok(`${this.next}\n`); // the built image's version
    if (args[0] === 'inspect') return ok('0 2026-12-01T04:00:00Z\n');
    if (args[0] === 'image') return ok('');
    const tail = args.slice(args.lastIndexOf('--profile') + 2);
    const i = tail.indexOf('config');
    if (i >= 0 && tail[i + 1] === '-q') return ok();
    if (i >= 0) {
      const staged = args[args.indexOf('--project-directory') + 1].includes('.kainow-staging');
      const v = staged ? this.next : this.running;
      return ok(
        JSON.stringify({
          name: 'kainow',
          services: {
            db: { image: 'postgres:16', volumes: [], environment: { POSTGRES_DB: 'kainow' } },
            api: { image: `kainow-app:${v}` },
            worker: { image: `kainow-app:${v}` },
            ops: { image: `kainow-ops:${v}` },
            updater: { image: `kainow-updater:${v}` },
          },
        }),
      );
    }
    if (tail.join(' ').includes('backup-cli.js')) return ok(`run ${RUN_ID} succeeded\n`);
    if (tail[0] === 'ps') {
      return ok(
        [
          JSON.stringify({ ID: 'a1', Service: 'api', State: 'running', Health: 'healthy' }),
          JSON.stringify({ ID: 'w1', Service: 'worker', State: 'running', Health: '' }),
        ].join('\n'),
      );
    }
    return ok();
  }
}

test('two automatic updates in a row: the folder is on the new release tag after each (C1)', async (ctx) => {
  if (skip) return ctx.skip(skip);
  // The installation as INSTALL.md leaves it: at the signed v1.0.0 tag, trusting the release key.
  await publish('1.0.0');
  await must(r.install, ['fetch', '-q', '--tags', 'origin']);
  await must(r.install, ['-c', 'advice.detachedHead=false', 'checkout', '-q', '--detach', 'v1.0.0']);
  await writeFile(join(r.install, 'release-signers'), r.signersText([key]));
  assert.equal((await workingTreeState(r.install)).headTag, 'v1.0.0');

  let t = new Date('2026-12-01T04:00:00Z').getTime();
  const runner = new GitAndFakeDocker();
  const lines: string[] = [];
  const common = {
    runner,
    installDir: r.install,
    projectName: 'kainow',
    now: () => new Date(t),
    log: (l: string) => lines.push(l),
  };

  for (const [from, to] of [
    ['1.0.0', '1.1.0'],
    ['1.1.0', '1.2.0'],
  ]) {
    const commit = await publish(to);
    runner.running = from;
    runner.next = to;
    const startsAt = new Date(t + 60 * 60_000);
    const u: TickUpdate = {
      id: `0190a000-0000-7000-8000-00000000000${to.at(2)}`,
      state: 'approved',
      fromVersion: from,
      toVersion: to,
      tag: `v${to}`,
      commit,
      tagObject: null,
      startsAt,
      expectedMinutes: 30,
      preUpdateBackupRunId: null,
    };

    const ps = new MemoryPrepareStore();
    const prepared = await prepareWithStore({ ...common, statfs: () => ({ total: 500 * GB, free: 100 * GB }) }, ps, u);
    assert.equal(prepared, 'ready', `preparing v${to}: ${JSON.stringify(ps.ends)} ${lines.join(' | ')}`);
    assert.ok(ps.tagObject);

    t = startsAt.getTime();
    const is = new MemoryInstallStore();
    const sleep = async (ms: number) => {
      t += ms;
    };
    const ended = await installWithStore({ ...common, sleep }, is, { ...u, state: 'ready', tagObject: ps.tagObject });
    assert.equal(ended, 'succeeded', `installing v${to}: ${JSON.stringify(is.steps)} ${lines.join(' | ')}`);

    // The folder is on the new release's tag, and the local tag is the verified, signed tag object.
    const w = await workingTreeState(r.install);
    assert.deepEqual(w, { clean: true, changed: [], headTag: `v${to}` });
    assert.equal(await must(r.install, ['rev-parse', `refs/tags/v${to}`]), ps.tagObject);
    assert.equal(await must(r.install, ['rev-parse', 'HEAD']), commit);
    // Going back to it by name (go_back, the failed path, recover) resolves.
    assert.equal(await must(r.install, ['rev-parse', `v${from}^{commit}`]).then((x) => x.length > 0), true);
    t += 60 * 60_000;
  }
});

test('a local tag that is not the verified object refuses the install before anything is touched', async (ctx) => {
  if (skip) return ctx.skip(skip);
  // The folder is at v1.2.0 from the test above; a local v1.3.0 that points elsewhere (here: at the v1.1.0 tag object).
  const commit = await publish('1.3.0');
  const stray = await must(r.install, ['rev-parse', 'refs/tags/v1.1.0']);
  await must(r.install, ['update-ref', 'refs/tags/v1.3.0', stray]);
  let t = new Date('2026-12-02T04:00:00Z').getTime();
  const runner = new GitAndFakeDocker();
  runner.running = '1.2.0';
  runner.next = '1.3.0';
  const remote = (await git(r.origin, ['rev-parse', 'refs/tags/v1.3.0'])).stdout.trim();
  const is = new MemoryInstallStore();
  const ended = await installWithStore(
    { runner, installDir: r.install, projectName: 'kainow', now: () => new Date(t), log: () => undefined, sleep: async (ms) => void (t += ms) },
    is,
    {
      id: '0190a000-0000-7000-8000-000000000009',
      state: 'ready',
      fromVersion: '1.2.0',
      toVersion: '1.3.0',
      tag: 'v1.3.0',
      commit,
      tagObject: remote,
      startsAt: new Date(t),
      expectedMinutes: 30,
      preUpdateBackupRunId: null,
    },
  );
  assert.equal(ended, 'refused');
  assert.equal(is.ends[0].code, 'tag_changed');
  assert.deepEqual(is.steps.map((s) => s.step), ['recheck']);
  assert.equal(await must(r.install, ['rev-parse', 'refs/tags/v1.3.0']), stray, 'the stray tag is not overwritten');
  assert.equal((await workingTreeState(r.install)).headTag, 'v1.2.0');
});
