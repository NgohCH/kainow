import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { JOURNEYS, JOURNEY_WEIGHTS, mulberry32, pickJourney } from './journeys';
import { codeFromLog } from './sessions';

describe('load-test journeys', () => {
  test('the weights are exactly the spec 13.1 table', () => {
    assert.deepEqual(JOURNEY_WEIGHTS, {
      browse: 35,
      read: 15,
      write: 15,
      dashboards: 10,
      search: 8,
      approve: 7,
      extract: 5,
      analytics: 5,
    });
    assert.equal(
      JOURNEYS.reduce((sum, j) => sum + JOURNEY_WEIGHTS[j], 0),
      100,
    );
  });

  test('journey picker follows the weights within 2 percentage points over 100,000 draws (fixed seed)', () => {
    const rng = mulberry32(20261122);
    const counts = Object.fromEntries(JOURNEYS.map((j) => [j, 0])) as Record<string, number>;
    const draws = 100_000;
    for (let i = 0; i < draws; i++) counts[pickJourney(rng)]++;
    for (const j of JOURNEYS) {
      const share = (counts[j] / draws) * 100;
      assert.ok(Math.abs(share - JOURNEY_WEIGHTS[j]) <= 2, `${j}: ${share.toFixed(2)}% against ${JOURNEY_WEIGHTS[j]}%`);
    }
  });

  test('the same seed gives the same sequence', () => {
    const a = mulberry32(7);
    const b = mulberry32(7);
    for (let i = 0; i < 20; i++) assert.equal(pickJourney(a), pickJourney(b));
  });

  test('the sign-in code is the latest one logged for that address', () => {
    const log = [
      '[sign-in code, development only] load-002@example.org: 111111 (valid 10 minutes)',
      '[sign-in code, development only] load-003@example.org: 222222 (valid 10 minutes)',
      '[sign-in code, development only] load-002@example.org: 333333 (valid 10 minutes)',
    ].join('\n');
    assert.equal(codeFromLog(log, 'load-002@example.org'), '333333');
    assert.equal(codeFromLog(log, 'load-003@example.org'), '222222');
    assert.equal(codeFromLog(log, 'load-004@example.org'), null);
  });
});
