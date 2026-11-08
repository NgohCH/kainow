import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type DueReading, isCalendarDate, readDue } from './due';

const M = '2026-11-04'; // a Wednesday
const MAY = '2026-05-14';

const base = { earliest: null, latest: null, event: null, reason: null, note: null, usedMeetingDate: false };
const exact = (day: string, usedMeetingDate = false): DueReading => ({ ...base, state: 'exact', earliest: day, latest: day, usedMeetingDate });
const range = (earliest: string, latest: string, usedMeetingDate = false, note: string | null = null): DueReading =>
  ({ ...base, state: 'range', earliest, latest, usedMeetingDate, note });
const event = (name: string): DueReading => ({ ...base, state: 'event', event: name });
const needs = (reason: string): DueReading => ({ ...base, state: 'needs_date', reason });
const SEVERAL = 'several dates in one item';

type Case = [due: string | null, meetingDate: string | null, expected: DueReading, dueEvent?: string | null];

const CASES: Case[] = [
  ['5 November 2026', M, exact('2026-11-05')],
  ['5 November 2026', null, exact('2026-11-05')],
  ['End of November 2026', null, exact('2026-11-30')],
  ['By end of November 2026', M, exact('2026-11-30')],
  ['end of november 2026', null, exact('2026-11-30')],
  ['End of February 2028', null, exact('2028-02-29')],
  ['end of Feb 2027', null, exact('2027-02-28')],
  ['End July', MAY, exact('2026-07-31', true)],
  ['End July', M, exact('2027-07-31', true)],
  ['End July', null, needs('no year and no meeting date')],
  ['June', MAY, range('2026-06-01', '2026-06-30', true)],
  ['June', M, range('2027-06-01', '2027-06-30', true)],
  ['June 2027', null, range('2027-06-01', '2027-06-30')],
  ['Mid-July', MAY, range('2026-07-10', '2026-07-20', true)],
  ['early June 2027', null, range('2027-06-01', '2027-06-10')],
  ['late June 2027', null, range('2027-06-21', '2027-06-30')],
  ['August–September 2026', null, range('2026-08-01', '2026-09-30')],
  ['August-September 2026', null, range('2026-08-01', '2026-09-30')],
  ['December 2026', null, range('2026-12-01', '2026-12-31')],
  ['Before December 2026', null, exact('2026-11-30')],
  ['before 16 November 2026', null, exact('2026-11-15')],
  ['1 July', MAY, exact('2026-07-01', true)],
  ['1 July', M, exact('2027-07-01', true)],
  ['15 June', null, needs('no year and no meeting date')],
  ['Friday', M, exact('2026-11-06', true)],
  ['Friday', '2026-11-06', exact('2026-11-13', true)],
  ['Friday', null, needs('relative wording and no meeting date')],
  ['Monday', '2026-12-30', exact('2027-01-04', true)],
  ['Immediate', M, range('2026-11-04', '2026-11-07', true)],
  ['  Immediate ', M, range('2026-11-04', '2026-11-07', true)],
  ['immediately', M, range('2026-11-04', '2026-11-07', true)],
  ['ASAP', M, range('2026-11-04', '2026-11-07', true)],
  ['Within 1 week', M, range('2026-11-04', '2026-11-11', true)],
  ['within one week', M, range('2026-11-04', '2026-11-11', true)],
  ['within two weeks', M, range('2026-11-04', '2026-11-18', true)],
  ['within 2 days', M, range('2026-11-04', '2026-11-06', true)],
  ['next 3 days', M, range('2026-11-05', '2026-11-07', true)],
  ['Immediate', null, needs('relative wording and no meeting date')],
  ['After approval', M, event('After approval')],
  ['Before June rollout', M, event('Before June rollout')],
  ['Before rollout', null, event('Before rollout')],
  ['Upon finalisation', M, event('Upon finalisation')],
  ['Next Senate/MCM', M, event('Next Senate/MCM')],
  ['During any future POC', null, event('During any future POC')],
  ['Before Go-Live in November 2026', M, event('Before Go-Live in November 2026')],
  [' After approval  ', M, event('After approval')],
  [null, M, event('approval by Dr Goh'), 'approval by Dr Goh'],
  ['After approval', M, event('approval by the Dean'), 'approval by the Dean'],
  ['5 November 2026', M, exact('2026-11-05'), 'approval by the Dean'],
  ['Every 3–5 years', M, needs('a period or repeat, not a deadline')],
  ['Throughout the required transition period in 2027', M, needs('a period or repeat, not a deadline')],
  ['Ongoing', M, needs('a period or repeat, not a deadline')],
  [null, M, needs('no due given')],
  ['   ', M, needs('no due given')],
  ['Submission: 6 November 2026; approval: 9 November 2026; setup: 11 November 2026', null, range('2026-11-06', '2026-11-11', false, SEVERAL)],
  ['Draft: 5 November 2026; poster: before 16 November 2026', null, range('2026-11-05', '2026-11-15', false, SEVERAL)],
  ['Dry run: 6 November 2026; data removal: before go-live', null, needs('several dates in one item; not all are dates')],
  ['16 November 2026 for the announcement', null, exact('2026-11-16')],
  ['15 Disember 2026', null, exact('2026-12-15')],
  ['Dis 2026', null, range('2026-12-01', '2026-12-31')],
  ['Mac 2027', null, range('2027-03-01', '2027-03-31')],
  ['31 February 2027', null, needs('wording not understood')],
  ['sometime soon', M, needs('wording not understood')],
];

test('readDue reads every due wording seen so far', () => {
  for (const [due, meetingDate, expected, dueEvent] of CASES) {
    assert.deepEqual(readDue({ due, dueEvent: dueEvent ?? null, meetingDate }), expected, `${JSON.stringify(due)} with meeting ${meetingDate}`);
  }
});

test("a reviewer's due replaces the reading of the wording", () => {
  const input = { due: 'Friday', dueEvent: null, meetingDate: null };
  assert.deepEqual(readDue(input, { earliest: '2026-11-10', latest: '2026-11-12', event: null }), range('2026-11-10', '2026-11-12'));
  assert.deepEqual(readDue(input, { earliest: '2026-11-10', latest: null, event: null }), exact('2026-11-10'));
  assert.deepEqual(readDue(input, { earliest: '2026-11-10', latest: '2026-11-10', event: null }), exact('2026-11-10'));
  assert.deepEqual(readDue(input, { earliest: null, latest: null, event: 'Senate approval' }), event('Senate approval'));
  assert.deepEqual(readDue(input, { earliest: null, latest: null, event: null }), needs('relative wording and no meeting date'));
  assert.deepEqual(readDue(input, null), needs('relative wording and no meeting date'));
});

test('isCalendarDate accepts only real days written YYYY-MM-DD', () => {
  assert.equal(isCalendarDate('2028-02-29'), true);
  assert.equal(isCalendarDate('2026-11-04'), true);
  for (const v of ['2027-02-29', '2026-13-01', '2026-00-10', '4 Nov 2026', '', null, undefined, 20261104]) {
    assert.equal(isCalendarDate(v), false, String(v));
  }
});
