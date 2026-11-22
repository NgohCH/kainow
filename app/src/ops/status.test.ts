import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { type RunRow, backupStatus } from './status';

const NOW = new Date('2026-11-21T12:00:00Z');
const H = 3_600_000;
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);
let n = 0;
const run = (o: Partial<RunRow> & Pick<RunRow, 'outcome'>): RunRow => ({
  id: `run-${n++}`,
  kind: 'daily',
  startedAt: ago(H),
  finishedAt: o.outcome === 'running' ? null : ago(H),
  failureCode: null,
  ...o,
});

describe('backupStatus', () => {
  test('no runs is none', () => {
    assert.equal(backupStatus([], NOW).status, 'none');
  });

  test('only failed runs is none', () => {
    const r = backupStatus([run({ outcome: 'failed', failureCode: 'dump_failed' })], NOW);
    assert.equal(r.status, 'none');
    assert.equal(r.lastSuccess, undefined);
    assert.ok(r.lastAttempt);
  });

  test('a success 23h59m ago is healthy', () => {
    const s = run({ outcome: 'succeeded', startedAt: ago(24 * H), finishedAt: ago(23 * H + 59 * 60_000) });
    const r = backupStatus([s], NOW);
    assert.equal(r.status, 'healthy');
    assert.equal(r.lastSuccess, s);
    assert.equal(r.lastAttempt, s);
  });

  test('a success exactly 24h ago is healthy; 24h and 1 s is target exceeded', () => {
    assert.equal(backupStatus([run({ outcome: 'succeeded', finishedAt: ago(24 * H) })], NOW).status, 'healthy');
    assert.equal(backupStatus([run({ outcome: 'succeeded', finishedAt: ago(24 * H + 1000) })], NOW).status, 'target_exceeded');
  });

  test('the latest failed with a success 2 h ago is last_failed', () => {
    const ok = run({ outcome: 'succeeded', finishedAt: ago(2 * H), startedAt: ago(2 * H + 600_000) });
    const bad = run({ outcome: 'failed', failureCode: 'dump_failed', finishedAt: ago(H), startedAt: ago(H + 60_000) });
    const r = backupStatus([ok, bad], NOW);
    assert.equal(r.status, 'last_failed');
    assert.equal(r.lastSuccess, ok);
    assert.equal(r.lastAttempt, bad);
  });

  test('a running row 6h and 1 s old counts as failed; a younger one does not', () => {
    const ok = run({ outcome: 'succeeded', finishedAt: ago(7 * H), startedAt: ago(7 * H + 600_000) });
    const old = run({ outcome: 'running', startedAt: ago(6 * H + 1000), finishedAt: null });
    assert.equal(backupStatus([ok, old], NOW).status, 'last_failed');
    const young = run({ outcome: 'running', startedAt: ago(6 * H), finishedAt: null });
    assert.equal(backupStatus([ok, young], NOW).status, 'healthy');
  });

  test('a later success after a failure is healthy', () => {
    const bad = run({ outcome: 'failed', finishedAt: ago(3 * H), startedAt: ago(3 * H + 1000) });
    const ok = run({ outcome: 'succeeded', finishedAt: ago(H), startedAt: ago(H + 1000) });
    assert.equal(backupStatus([bad, ok], NOW).status, 'healthy');
  });
});
