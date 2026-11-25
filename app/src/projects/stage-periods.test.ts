import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProjectStatus } from './matrix';
import { clipPeriods } from './stage-periods';

const period = (start: string, end: string | null = null) => ({ startedAt: new Date(start), endedAt: end === null ? null : new Date(end) });
const to = (status: ProjectStatus, at: string) => ({ to: status, at: new Date(at) });
const shown = (periods: ReturnType<typeof period>[], transitions: ReturnType<typeof to>[]) => clipPeriods(periods, transitions).map((p) => [p.endedOn, p.stopped]);

const S = '2026-11-01T02:00:00Z';

test('a project with no transitions: periods as stored', () => {
  assert.deepEqual(shown([period(S, '2026-11-03T02:00:00Z'), period('2026-11-03T02:00:00Z')], []), [['2026-11-03', null], [null, null]]);
});

test('deferred: the open period stops at the deferral, on its UTC+8 day', () => {
  assert.deepEqual(shown([period(S)], [to('planned', S), to('active', S), to('deferred', '2026-11-05T15:59:59Z')]), [['2026-11-05', 'deferred']]);
  assert.deepEqual(shown([period(S)], [to('deferred', '2026-11-05T16:00:00Z')]), [['2026-11-06', 'deferred']]);
});

test('closed: it stops at the closure; an earlier stage is untouched', () => {
  const periods = [period(S, '2026-11-03T02:00:00Z'), period('2026-11-03T02:00:00Z')];
  assert.deepEqual(shown(periods, [to('closed', '2026-11-08T02:00:00Z')]), [['2026-11-03', null], ['2026-11-08', 'closed']]);
});

test('a project closed while Deferred stopped when it was deferred', () => {
  assert.deepEqual(shown([period(S)], [to('deferred', '2026-11-04T02:00:00Z'), to('closed', '2026-11-08T02:00:00Z')]), [['2026-11-04', 'deferred']]);
});

test('deferred, resumed, then closed; and closed then reopened', () => {
  const resumed = '2026-11-06T02:00:00Z';
  const history = [to('deferred', '2026-11-04T02:00:00Z'), to('active', resumed), to('closed', '2026-11-08T02:00:00Z')];
  assert.deepEqual(shown([period(S, resumed), period(resumed)], history), [['2026-11-04', 'deferred'], ['2026-11-08', 'closed']]);
  const reopened = '2026-11-09T02:00:00Z';
  assert.deepEqual(shown([period(S, resumed), period(resumed, reopened), period(reopened)], [...history, to('active', reopened)]), [
    ['2026-11-04', 'deferred'], ['2026-11-08', 'closed'], [null, null],
  ]);
});

test('started, deferred and resumed on one day: the first stops that day, the new one runs on', () => {
  const day = (time: string) => `2026-11-09T${time}Z`;
  const periods = [period(day('01:00:00'), day('03:00:00')), period(day('03:00:00'))];
  const history = [to('active', day('01:00:00')), to('deferred', day('02:00:00')), to('active', day('03:00:00'))];
  assert.deepEqual(shown(periods, history), [['2026-11-09', 'deferred'], [null, null]]);
  // Deferred a second time the same day: the new period stops too.
  assert.deepEqual(shown(periods, [...history, to('deferred', day('04:00:00'))]), [['2026-11-09', 'deferred'], ['2026-11-09', 'deferred']]);
});

test('a UTC day that is two days in UTC+8: the stop keeps its own day', () => {
  const periods = [period('2026-11-09T14:00:00Z', '2026-11-09T17:00:00Z'), period('2026-11-09T17:00:00Z')];
  assert.deepEqual(shown(periods, [to('deferred', '2026-11-09T15:00:00Z'), to('active', '2026-11-09T17:00:00Z')]), [['2026-11-09', 'deferred'], [null, null]]);
});

test('deferred and resumed in the same instant: the earlier period says so, the new one does not', () => {
  const at = '2026-11-09T02:00:00Z';
  assert.deepEqual(shown([period(S, at), period(at)], [to('deferred', at), to('active', at)]), [['2026-11-09', 'deferred'], [null, null]]);
});

test('a stage changed in the instant the project was deferred: only the new one stopped', () => {
  const at = '2026-11-09T02:00:00Z';
  assert.deepEqual(shown([period(S, at), period(at)], [to('deferred', at)]), [['2026-11-09', null], ['2026-11-09', 'deferred']]);
});

test('a period that begins inside a pause stops where it began, never before', () => {
  assert.deepEqual(shown([period('2026-11-05T02:00:00Z')], [to('deferred', '2026-11-04T02:00:00Z')]), [['2026-11-05', 'deferred']]);
});

test('the stored rows are left alone', () => {
  const p = period(S);
  clipPeriods([p], [to('deferred', '2026-11-04T02:00:00Z')]);
  assert.equal(p.endedAt, null);
});
