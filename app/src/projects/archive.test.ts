import assert from 'node:assert/strict';
import { test } from 'node:test';
import { archiveState } from './archive';

// Instants are UTC; 02:00Z is 10:00 in UTC+8, so the UTC+8 day equals the date shown.
const at = (day: string) => `${day}T02:00:00.000Z`;
const closed = (closedDay: string, today: string, events: Array<{ kind: 'archived' | 'unarchived'; at: string }> = []) =>
  archiveState({ status: 'closed', closedAt: at(closedDay), events, today, afterMonths: 12 });

test('archived twelve months after closing, in UTC+8', () => {
  assert.deepEqual(closed('2026-11-09', '2027-11-08'), { archived: false, automatic: false });
  assert.deepEqual(closed('2026-11-09', '2027-11-09'), { archived: true, automatic: true });
  assert.deepEqual(closed('2027-01-31', '2028-01-30'), { archived: false, automatic: false });
  assert.deepEqual(closed('2027-01-31', '2028-01-31'), { archived: true, automatic: true });
  assert.deepEqual(closed('2028-02-29', '2029-02-28'), { archived: true, automatic: true }, 'clamped to the last day of February');
  assert.deepEqual(archiveState({ status: 'active', closedAt: null, events: [], today: '2030-01-01', afterMonths: 12 }), { archived: false, automatic: false });
  // Closed at 23:30 on 9 Nov in UTC+8 (15:30Z): the year counts from 9 Nov.
  assert.deepEqual(archiveState({ status: 'closed', closedAt: '2026-11-09T15:30:00.000Z', events: [], today: '2027-11-09', afterMonths: 12 }), { archived: true, automatic: true });
});

test('manual archive and unarchive', () => {
  assert.deepEqual(closed('2026-11-09', '2026-11-10', [{ kind: 'archived', at: at('2026-11-10') }]), { archived: true, automatic: false });
  assert.deepEqual(closed('2026-11-09', '2027-12-01', [{ kind: 'unarchived', at: at('2027-11-20') }]), { archived: false, automatic: false });
  assert.deepEqual(
    closed('2026-11-09', '2026-11-12', [{ kind: 'archived', at: at('2026-11-10') }, { kind: 'unarchived', at: at('2026-11-11') }]),
    { archived: false, automatic: false },
  );
  assert.deepEqual(closed('2026-11-09', '2027-11-20', [{ kind: 'unarchived', at: at('2027-01-01') }]), { archived: true, automatic: true }, 'an unarchive before the year is up does not stop the automatic archive');
});

test('only events after the latest closing count, to the instant', () => {
  const closedAt = '2026-11-09T02:05:00.000Z';
  const earlier = { kind: 'archived' as const, at: '2026-11-09T02:00:00.000Z' };
  assert.deepEqual(archiveState({ status: 'closed', closedAt, events: [earlier], today: '2026-11-09', afterMonths: 12 }), { archived: false, automatic: false });
});

test('the delay is the one given: three months', () => {
  const three = (closedDay: string, today: string, events: Array<{ kind: 'archived' | 'unarchived'; at: string }> = []) =>
    archiveState({ status: 'closed', closedAt: at(closedDay), events, today, afterMonths: 3 });
  assert.deepEqual(three('2026-11-09', '2027-02-08'), { archived: false, automatic: false });
  assert.deepEqual(three('2026-11-09', '2027-02-09'), { archived: true, automatic: true });
  assert.deepEqual(three('2026-11-30', '2027-02-28'), { archived: true, automatic: true }, 'clamped to the last day of February');
});

test('an unarchive before the due date does not stop the automatic archive at the due date', () => {
  const unarchived = [{ kind: 'unarchived' as const, at: at('2027-01-01') }];
  const state = (afterMonths: number, today: string) => archiveState({ status: 'closed', closedAt: at('2026-11-09'), events: unarchived, today, afterMonths });
  assert.deepEqual(state(3, '2027-02-09'), { archived: true, automatic: true }, 'due 9 Feb, unarchived 1 Jan');
  assert.deepEqual(state(3, '2027-02-08'), { archived: false, automatic: false });
  assert.deepEqual(state(12, '2027-12-01'), { archived: true, automatic: true }, 'due 9 Nov 2027, unarchived before it');
  const late = [{ kind: 'unarchived' as const, at: at('2027-02-10') }];
  assert.deepEqual(archiveState({ status: 'closed', closedAt: at('2026-11-09'), events: late, today: '2027-03-01', afterMonths: 3 }), { archived: false, automatic: false }, 'unarchived on or after the due date stays unarchived');
});
