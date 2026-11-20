import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { chooseExpired, parseSetName } from './expiry';

const NOW = new Date('2026-11-21T12:00:00Z');
const DAY = 86_400_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

type S = Parameters<typeof chooseExpired>[0][number];
const set = (name: string, over: Partial<S> = {}): S => ({
  name,
  runId: name,
  kind: 'daily',
  finishedAt: ago(DAY),
  succeeded: true,
  incomplete: false,
  ...over,
});

describe('chooseExpired', () => {
  test('keeps sets younger than the retention period and removes older ones', () => {
    const sets = [set('new', { finishedAt: ago(5 * DAY) }), set('old', { finishedAt: ago(31 * DAY) }), set('newest', { finishedAt: ago(DAY) })];
    assert.deepEqual(chooseExpired(sets, 30, NOW), ['old']);
  });

  test('always keeps the newest succeeded set and the newest succeeded pre_update set, even at 400 days', () => {
    const sets = [
      set('daily-old', { finishedAt: ago(400 * DAY) }),
      set('daily-older', { finishedAt: ago(401 * DAY) }),
      set('pre-old', { kind: 'pre_update', finishedAt: ago(402 * DAY) }),
      set('pre-older', { kind: 'pre_update', finishedAt: ago(403 * DAY) }),
    ];
    // daily-old is the newest succeeded set overall; pre-old the newest pre_update.
    assert.deepEqual(chooseExpired(sets, 30, NOW).sort(), ['daily-older', 'pre-older']);
  });

  test('a failed set is never the kept one', () => {
    const sets = [set('bad', { succeeded: false, finishedAt: ago(40 * DAY) }), set('good', { finishedAt: ago(100 * DAY) })];
    assert.deepEqual(chooseExpired(sets, 30, NOW), ['bad']);
  });

  test('removes -incomplete sets older than a day and keeps a 23-hour-old one', () => {
    const sets = [
      set('inc-old', { incomplete: true, succeeded: false, finishedAt: ago(25 * 3_600_000) }),
      set('inc-new', { incomplete: true, succeeded: false, finishedAt: ago(23 * 3_600_000) }),
      set('good'),
    ];
    assert.deepEqual(chooseExpired(sets, 30, NOW), ['inc-old']);
  });

  test('exactly retentionDays x 24h old is kept; one second older is removed', () => {
    const sets = [
      set('exact', { finishedAt: ago(30 * DAY) }),
      set('over', { finishedAt: ago(30 * DAY + 1000) }),
      set('keeper', { finishedAt: ago(DAY) }),
      set('keeper-pre', { kind: 'pre_update', finishedAt: ago(DAY) }),
    ];
    assert.deepEqual(chooseExpired(sets, 30, NOW), ['over']);
  });
});

describe('parseSetName', () => {
  const id = '0192f3c4-7a10-7b2e-8c3d-123456789abc';
  test('reads the stamp, kind, run id and the incomplete suffix', () => {
    const p = parseSetName(`2026-11-21T0200Z-pre_update-${id}-incomplete`);
    assert.ok(p);
    assert.equal(p.kind, 'pre_update');
    assert.equal(p.runId, id);
    assert.equal(p.incomplete, true);
    assert.equal(p.at.toISOString(), '2026-11-21T02:00:00.000Z');
    assert.equal(parseSetName(`2026-11-21T0200Z-daily-${id}`)?.incomplete, false);
  });
  test('refuses anything else', () => {
    assert.equal(parseSetName('lost+found'), null);
    assert.equal(parseSetName(`2026-11-21T0200Z-weekly-${id}`), null);
  });
});
