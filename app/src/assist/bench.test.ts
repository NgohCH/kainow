import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { assertAssistBenchDatabase, runAssistBench } from './bench-cli';

describe('assist bench database guard', () => {
  test('accepts only databases whose name ends in _test or _bench', () => {
    assert.equal(assertAssistBenchDatabase('postgres://postgres:x@127.0.0.1:55432/kainow_bench'), 'kainow_bench');
    assert.equal(assertAssistBenchDatabase('postgres://postgres:x@127.0.0.1:55432/kainow_test'), 'kainow_test');
    for (const name of ['kainow', 'kainow_prod', 'kainow_test_old', 'kainow_benchmark', 'kainow_testing', 'postgres', 'test', 'bench', '']) {
      assert.throws(() => assertAssistBenchDatabase(`postgres://postgres:x@127.0.0.1:55432/${name}`), /must end in _test or _bench/, name);
    }
    assert.throws(() => assertAssistBenchDatabase('not a url'), /must end in _test or _bench/);
  });

  test('the refusal never prints the password and happens before any connection is made', async () => {
    await assert.rejects(
      runAssistBench('postgres://postgres:s3cret-pass@127.0.0.1:1/kainow'),
      (err: Error) => /must end in _test or _bench/.test(err.message) && !err.message.includes('s3cret-pass'),
    );
  });
});
