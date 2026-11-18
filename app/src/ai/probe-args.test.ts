import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { ProbeUsageError, modelFor, resolveProbe } from './probe-args';

const FAKE_OPENAI = `sk-test-${'x'.repeat(40)}`;

describe('resolveProbe', () => {
  test('--provider defaults to openai and is removed from the arguments', () => {
    const r = resolveProbe(['folder', 'gpt-x'], { OPENAI_API_KEY: FAKE_OPENAI });
    assert.equal(r.provider, 'openai');
    assert.equal(r.apiKey, FAKE_OPENAI);
    assert.deepEqual(r.args, ['folder', 'gpt-x']);
  });

  test('--provider anthropic and --provider=anthropic read ANTHROPIC_API_KEY', () => {
    const env = { ANTHROPIC_API_KEY: ' sk-ant-test-key ', OPENAI_API_KEY: FAKE_OPENAI };
    for (const argv of [['--provider', 'anthropic', 'folder'], ['folder', '--provider=anthropic']]) {
      const r = resolveProbe(argv, env);
      assert.equal(r.provider, 'anthropic');
      assert.equal(r.apiKey, 'sk-ant-test-key');
      assert.deepEqual(r.args, ['folder']);
    }
  });

  test('an unknown provider is a usage error', () => {
    assert.throws(() => resolveProbe(['--provider', 'other'], {}), (e: Error) => e instanceof ProbeUsageError && /--provider must be openai or anthropic/.test(e.message));
    assert.throws(() => resolveProbe(['--provider'], {}), /--provider must be openai or anthropic/);
  });

  test('a missing key names the variable and nothing else', () => {
    assert.throws(() => resolveProbe(['--provider', 'anthropic'], { OPENAI_API_KEY: FAKE_OPENAI }), (e: Error) => e instanceof ProbeUsageError && e.message === 'ANTHROPIC_API_KEY is not set' && !e.message.includes('xxxx'));
    assert.throws(() => resolveProbe([], { OPENAI_API_KEY: '   ' }), /^Error: OPENAI_API_KEY is not set$|OPENAI_API_KEY is not set/);
  });

  test('openai has a default model; anthropic needs one named', () => {
    assert.equal(modelFor('openai', undefined), 'gpt-6.1-sol');
    assert.equal(modelFor('anthropic', 'claude-test'), 'claude-test');
    assert.throws(() => modelFor('anthropic', undefined), (e: Error) => e instanceof ProbeUsageError && /model id/.test(e.message));
  });
});

describe('the three probe commands', () => {
  const root = join(__dirname, '..');
  const cases: Array<[string, string[]]> = [
    ['extraction/probe-cli.js', []],
    ['analysis/probe-minutes-cli.js', ['some-folder']],
    ['assist/probe-assist-cli.js', ['some-folder']],
  ];
  for (const [file, rest] of cases) {
    test(`${file} --provider anthropic without ANTHROPIC_API_KEY exits 2 with "ANTHROPIC_API_KEY is not set"`, () => {
      const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, OPENAI_API_KEY: FAKE_OPENAI };
      const r = spawnSync(process.execPath, [join(root, file), '--provider', 'anthropic', ...rest, 'claude-test'], { env, encoding: 'utf8' });
      assert.equal(r.status, 2, r.stderr);
      assert.match(r.stderr, /ANTHROPIC_API_KEY is not set/);
      assert.ok(!r.stderr.includes(FAKE_OPENAI) && !r.stdout.includes(FAKE_OPENAI), 'no key value is printed');
    });

    test(`${file} without OPENAI_API_KEY exits 2 naming OPENAI_API_KEY`, () => {
      const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ANTHROPIC_API_KEY: 'sk-ant-test-key' };
      const r = spawnSync(process.execPath, [join(root, file), ...rest], { env, encoding: 'utf8' });
      assert.equal(r.status, 2, r.stderr);
      assert.match(r.stderr, /OPENAI_API_KEY is not set/);
      assert.ok(!r.stderr.includes('sk-ant-test-key'));
    });
  }
});
