import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { type Machine, type RunResult, type Sample, aims, percentile, summarise, writeReport } from './report';

const machine: Machine = {
  label: 'Test PC',
  os: 'Windows 11',
  cpu: 'Test CPU',
  cores: 8,
  memoryGb: 16,
  disk: 'SSD 512 GB',
  docker: 'Docker 27.0.0',
  node: 'v22.12.0',
  database: 'PostgreSQL 16 in Docker Desktop',
};

const sample = (over: Partial<Sample>): Sample => ({ journey: 'browse', label: 'GET /projects', method: 'GET', status: 200, ms: 10, outcome: 'ok', ...over });

function result(samples: Sample[], over: Partial<RunResult> = {}): RunResult {
  return {
    params: { base: 'http://127.0.0.1:3310', users: 10, minutes: 30, thinkMs: [5000, 20000], seed: 1 },
    startedAt: '2026-11-23T01:00:00.000Z',
    endedAt: '2026-11-23T01:30:00.000Z',
    journeys: { browse: 1, read: 0, write: 0, dashboards: 0, search: 0, approve: 0, extract: 0, analytics: 0 },
    samples,
    ai: { requested: 4, succeeded: 4, notFinished: 0, failed: 0, queueWaitMs: [1000, 2000], runMs: [4000, 5000], slots: 2, maxInFlight: 2, maxIdleSlotWaitMs: 800 },
    email: { produced: 10, sent: 10, notSent: 0, sendDelayMs: [1000, 2000] },
    db: { maxConnections: 12, maxActive: 3, sizeBeforeBytes: 100 * 1024 * 1024, sizeAfterBytes: 110 * 1024 * 1024, slowest: null, slowestNote: 'not available' },
    worker: [{ queue: 'email', jobs: 5, p95LagMs: 900, maxLagMs: 1200 }],
    notes: [],
    ...over,
  };
}

describe('load-test report', () => {
  test('percentile is nearest-rank', () => {
    const xs = Array.from({ length: 100 }, (_, i) => i + 1);
    assert.equal(percentile(xs, 0.5), 50);
    assert.equal(percentile(xs, 0.95), 95);
    assert.equal(percentile(xs, 0.99), 99);
    assert.equal(percentile([], 0.95), null);
  });

  test('report computes p50/p95/p99 and lists expected refusals separately from errors', () => {
    const samples: Sample[] = [];
    for (let i = 1; i <= 100; i++) samples.push(sample({ ms: i }));
    samples.push(sample({ journey: 'approve', label: 'POST /proposals/:id/authorise', method: 'POST', status: 409, ms: 30, outcome: 'refusal' }));
    samples.push(sample({ journey: 'approve', label: 'POST /proposals/:id/authorise', method: 'POST', status: 500, ms: 40, outcome: 'error' }));
    samples.push(sample({ journey: 'approve', label: 'POST /proposals/:id/authorise', method: 'POST', status: 201, ms: 50, outcome: 'ok' }));

    const rows = summarise(samples);
    const browse = rows.find((r) => r.journey === 'browse')!;
    assert.equal(browse.count, 100);
    assert.equal(browse.errors, 0);
    assert.equal(browse.refusals, 0);
    assert.equal(browse.p50Ms, 50);
    assert.equal(browse.p95Ms, 95);
    assert.equal(browse.p99Ms, 99);
    const approve = rows.find((r) => r.journey === 'approve')!;
    assert.equal(approve.count, 3);
    assert.equal(approve.refusals, 1);
    assert.equal(approve.errors, 1);

    const md = writeReport(result(samples), machine);
    assert.match(md, /measured on Test PC; not a hardware guarantee/);
    assert.match(md, /\| browse \| 100 \| 0 \| 0 \| 50 \| 95 \| 99 \|/);
    assert.match(md, /\| approve \| 3 \| 1 \| 1 \|/);
    // Errors and expected refusals are listed apart, each with its status.
    assert.match(md, /### Errors\n\n\| Journey \| Request \| Status \| Count \|\n\|[-|]+\|\n\| approve \| POST \/proposals\/:id\/authorise \| 500 \| 1 \|/);
    assert.match(md, /### Expected refusals\n\n\| Journey \| Request \| Status \| Count \|\n\|[-|]+\|\n\| approve \| POST \/proposals\/:id\/authorise \| 409 \| 1 \|/);
  });

  test('aims table marks met and missed correctly', () => {
    const fast: Sample[] = [
      ...Array.from({ length: 50 }, () => sample({ ms: 200 })),
      ...Array.from({ length: 50 }, () => sample({ journey: 'write', label: 'POST /threads/:id/messages', method: 'POST', status: 201, ms: 300 })),
    ];
    const met = aims(result(fast));
    assert.deepEqual(
      met.map((a) => [a.aim, a.met]),
      [
        ['Page reads (GET)', true],
        ['Saves (POST/PUT/PATCH/DELETE)', true],
        ['Errors', true],
        ['AI queue', true],
        ['Email queue', true],
      ],
    );

    const slow: Sample[] = [
      ...Array.from({ length: 50 }, () => sample({ ms: 1500 })),
      ...Array.from({ length: 50 }, () => sample({ journey: 'write', label: 'POST /threads/:id/messages', method: 'POST', status: 201, ms: 2500 })),
      sample({ status: 500, outcome: 'error' }),
    ];
    const missed = aims(
      result(slow, {
        ai: { requested: 4, succeeded: 3, notFinished: 1, failed: 0, queueWaitMs: [1000], runMs: [4000], slots: 2, maxInFlight: 3, maxIdleSlotWaitMs: 800 },
        email: { produced: 10, sent: 9, notSent: 1, sendDelayMs: [1000, 400_000] },
      }),
    );
    assert.deepEqual(
      missed.map((a) => [a.aim, a.met]),
      [
        ['Page reads (GET)', false],
        ['Saves (POST/PUT/PATCH/DELETE)', false],
        ['Errors', false],
        ['AI queue', false],
        ['Email queue', false],
      ],
    );
    const md = writeReport(result(slow), machine);
    assert.match(md, /\| Page reads \(GET\) \| p95 under 1 s \| [\d,]+ ms \| missed \|/);
    assert.match(md, /\| Saves \(POST\/PUT\/PATCH\/DELETE\) \| p95 under 2 s \| [\d,]+ ms \| missed \|/);

    // Failed or blocked extractions (a seed without a protected key ends every one blocked) are a miss, even with none lost.
    const failed = aims(result(fast, { ai: { requested: 4, succeeded: 0, notFinished: 0, failed: 4, queueWaitMs: [], runMs: [], slots: 2, maxInFlight: 0, maxIdleSlotWaitMs: 0 } }));
    assert.equal(failed.find((a) => a.aim === 'AI queue')!.met, false);
    const oneFailed = aims(result(fast, { ai: { requested: 4, succeeded: 3, notFinished: 0, failed: 1, queueWaitMs: [1000], runMs: [4000], slots: 2, maxInFlight: 2, maxIdleSlotWaitMs: 0 } }));
    assert.equal(oneFailed.find((a) => a.aim === 'AI queue')!.met, false);

    // An idle slot while a request waited (more than the allowance) is a miss even with every run finished.
    const idle = aims(result(fast, { ai: { requested: 2, succeeded: 2, notFinished: 0, failed: 0, queueWaitMs: [20_000], runMs: [4000], slots: 2, maxInFlight: 1, maxIdleSlotWaitMs: 15_000 } }));
    assert.equal(idle.find((a) => a.aim === 'AI queue')!.met, false);
  });
});
