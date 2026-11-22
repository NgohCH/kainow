import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { FakeRunner } from '../testing/fake-runner';
import { gitToolsMissing } from '../testing/git-releases';
import { RealRunner, maskSecrets } from './runner';

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
});
