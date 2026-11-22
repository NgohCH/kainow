import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { FakeRunner } from '../testing/fake-runner';
import { gitToolsMissing } from '../testing/git-releases';
import { CODE_OUTPUT_TOO_LARGE, runProcess } from './process';
import { GIT_ENV, git, gitEnv } from './git';
import { RealRunner, dockerEnv, maskSecrets } from './runner';

describe('maskSecrets', () => {
  test('maskSecrets hides the password in a postgres URL', () => {
    const out = maskSecrets('connect to postgres://kainow:s3cr3t-Pa55@db:5432/kainow failed; also postgresql://u:p%40ss@h/x');
    assert.ok(!out.includes('s3cr3t-Pa55'));
    assert.ok(!out.includes('p%40ss'));
    assert.ok(out.includes('postgres://kainow:***@db:5432/kainow'));
    assert.ok(out.includes('postgresql://u:***@h/x'));
  });

  test('maskSecrets hides any password= value, in any case', () => {
    const out = maskSecrets('host=db password=hunter2 user=x PGPASSWORD=other "Password=q w"');
    assert.ok(!out.includes('hunter2'));
    assert.ok(!out.includes('other'));
    assert.match(out, /password=\*\*\*/);
    assert.match(out, /PGPASSWORD=\*\*\*/);
    assert.ok(out.includes('user=x'));
  });

  test('maskSecrets hides YAML and JSON password values as Compose prints them (final review #18)', () => {
    const yaml = 'services:\n  db:\n    environment:\n      POSTGRES_PASSWORD: hunter2\n      POSTGRES_USER: kainow\n    password:   "q w e"\n';
    const out = maskSecrets(yaml);
    assert.ok(!out.includes('hunter2') && !out.includes('q w e'), out);
    assert.match(out, /POSTGRES_PASSWORD: \*\*\*/);
    assert.ok(out.includes('POSTGRES_USER: kainow'));
    const json = maskSecrets('{"POSTGRES_PASSWORD":"hun\\"ter2","password": 1234,"user":"x"}');
    assert.ok(!json.includes('hun') && !json.includes('1234'), json);
    assert.ok(json.includes('"user":"x"'));
  });

  test('text without secrets is unchanged', () => {
    const t = 'Container kainow-api-1 Started\npostgres://db:5432/kainow (no password)';
    assert.equal(maskSecrets(t), t);
  });
});

describe('FakeRunner', () => {
  test('matches scripted responses by argument prefix, in order, and records every call', async () => {
    const r = new FakeRunner()
      .on('docker', ['compose', 'stop'], { code: 0, stdout: 'stopped', stderr: '' }, { times: 1 })
      .on('docker', ['compose'], { code: 3, stdout: '', stderr: 'busy' })
      .on('git', ['status'], (args) => ({ code: 0, stdout: args.join(' '), stderr: '' }));
    assert.deepEqual(await r.run('docker', ['compose', 'stop', 'api']), { code: 0, stdout: 'stopped', stderr: '' });
    assert.deepEqual(await r.run('docker', ['compose', 'stop', 'api']), { code: 3, stdout: '', stderr: 'busy' });
    assert.equal((await r.run('git', ['status', '--porcelain'], { cwd: '/x' })).stdout, 'status --porcelain');
    assert.deepEqual(await r.run('git', ['fetch']), { code: 0, stdout: '', stderr: '' }, 'unscripted calls succeed with no output');
    assert.deepEqual(
      r.calls.map((c) => [c.cmd, c.args.join(' ')]),
      [
        ['docker', 'compose stop api'],
        ['docker', 'compose stop api'],
        ['git', 'status --porcelain'],
        ['git', 'fetch'],
      ],
    );
    assert.equal(r.calls[2].opts?.cwd, '/x');
  });
});

describe('RealRunner', () => {
  test('runs git in the given folder and reports its exit code', async (t) => {
    const missing = await gitToolsMissing();
    if (missing) return t.skip(missing);
    const dir = await mkdtemp(join(tmpdir(), 'kainow-runner-'));
    try {
      const r = new RealRunner(dir);
      const v = await r.run('git', ['--version']);
      assert.equal(v.code, 0);
      assert.match(v.stdout, /^git version/);
      const s = await r.run('git', ['status']);
      assert.notEqual(s.code, 0, 'not a repository');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a command that cannot start is code 127, never a throw', async () => {
    const r = new RealRunner(tmpdir(), { docker: 'kainow-no-such-command' });
    const res = await r.run('docker', ['version']);
    assert.equal(res.code, 127);
  });

  test('a command past its timeout is killed and is code 124', async () => {
    // node stands in for docker: it waits far longer than the timeout.
    const r = new RealRunner(tmpdir(), { docker: process.execPath });
    const started = Date.now();
    const res = await r.run('docker', ['-e', 'setTimeout(() => {}, 30000)'], { timeoutMs: 300 });
    assert.equal(res.code, 124);
    assert.ok(Date.now() - started < 10_000);
  });

  test('at the timeout the whole process tree is killed, grandchildren included', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kainow-tree-'));
    const pidFile = join(dir, 'grandchild.pid');
    try {
      // The child (standing in for docker) starts a grandchild (standing in for the Compose plugin) and both wait.
      const script =
        `const { spawn } = require('node:child_process');` +
        `const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });` +
        `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));` +
        `setInterval(() => {}, 1000);`;
      const r = new RealRunner(dir, { docker: process.execPath });
      const res = await r.run('docker', ['-e', script], { timeoutMs: 1500 });
      assert.equal(res.code, 124);
      const gpid = Number(await readFile(pidFile, 'utf8'));
      assert.ok(gpid > 0);
      // SIGTERM reaches the group at once; allow the kill to land.
      const deadline = Date.now() + 10_000;
      while (alive(gpid) && Date.now() < deadline) await sleep(100);
      assert.equal(alive(gpid), false, 'the grandchild is gone');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a synchronous spawn error is code 127, never a throw (final review #21)', async () => {
    const res = await runProcess(process.execPath, ['-e', 'x\0y'], { cwd: tmpdir(), env: process.env, timeoutMs: 5_000, maxBuffer: 1024 });
    assert.equal(res.code, 127);
  });

  test('docker gets only PATH, HOME, the locale, temp folders and DOCKER_* of the updater environment (final review #19)', async () => {
    assert.deepEqual(
      dockerEnv({ PATH: '/bin', HOME: '/h', DOCKER_HOST: 'unix:///x', DATABASE_URL: 'postgres://k:s@db/k', POSTGRES_PASSWORD: 's', COMPOSE_PROJECT_NAME: 'p', KAINOW_INSTALL_DIR: '/k' }),
      { PATH: '/bin', HOME: '/h', DOCKER_HOST: 'unix:///x' },
    );
    // node stands in for docker and prints what it was given.
    const saved = process.env.POSTGRES_PASSWORD;
    process.env.POSTGRES_PASSWORD = 'from-the-updater';
    try {
      const r = new RealRunner(tmpdir(), { docker: process.execPath });
      const res = await r.run('docker', ['-e', 'process.stdout.write(String(process.env.POSTGRES_PASSWORD))']);
      assert.equal(res.stdout, 'undefined');
    } finally {
      if (saved === undefined) delete process.env.POSTGRES_PASSWORD;
      else process.env.POSTGRES_PASSWORD = saved;
    }
  });

  test('git never takes GIT_* from the updater environment or the caller; GIT_ENV wins (final review #5)', async (t) => {
    const env = gitEnv({ GIT_CONFIG_GLOBAL: '/tmp/evil', GIT_DIR: '/x', GIT_CONFIG_VALUE_0: 'openpgp', OTHER: '1' });
    assert.equal(env.GIT_CONFIG_GLOBAL, GIT_ENV.GIT_CONFIG_GLOBAL);
    assert.equal(env.GIT_CONFIG_VALUE_0, 'ssh');
    assert.equal(env.GIT_DIR, undefined);
    assert.equal(env.OTHER, '1');
    const missing = await gitToolsMissing();
    if (missing) return t.skip(missing);
    const saved = process.env.GIT_CONFIG_VALUE_0;
    process.env.GIT_CONFIG_VALUE_0 = 'openpgp';
    try {
      const r = await git(tmpdir(), ['config', '--get', 'gpg.format'], { GIT_CONFIG_VALUE_0: 'x509' });
      assert.equal(r.stdout.trim(), 'ssh');
    } finally {
      if (saved === undefined) delete process.env.GIT_CONFIG_VALUE_0;
      else process.env.GIT_CONFIG_VALUE_0 = saved;
    }
  });

  test('output over the limit is its own code (125), not a timeout, and the tree is killed', async () => {
    const res = await runProcess(process.execPath, ['-e', `process.stdout.write('x'.repeat(4096)); setInterval(() => {}, 1000)`], {
      cwd: tmpdir(),
      env: process.env,
      timeoutMs: 20_000,
      maxBuffer: 1024,
    });
    assert.equal(res.code, CODE_OUTPUT_TOO_LARGE);
    assert.notEqual(res.code, 124);
  });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    // On Linux a killed process re-parented to a PID 1 that does not reap it stays a zombie (state Z): it is dead.
    if (process.platform === 'linux') {
      try {
        return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, 'utf8'));
      } catch {
        return false;
      }
    }
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}
