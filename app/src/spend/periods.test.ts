import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dayPeriod, monthPeriod } from './periods';

const iso = (d: Date): string => d.toISOString();

test('a month starts at midnight on the 1st in UTC+8', () => {
  const p = monthPeriod(new Date('2026-11-07T04:00:00Z')); // 12:00 on 7 November in UTC+8
  assert.equal(iso(p.start), '2026-10-31T16:00:00.000Z');
  assert.equal(iso(p.end), '2026-11-30T16:00:00.000Z');
});

test('the month changes exactly at midnight UTC+8, not at midnight UTC', () => {
  const lastMoment = monthPeriod(new Date('2026-10-31T15:59:59.999Z'));
  assert.equal(iso(lastMoment.start), '2026-09-30T16:00:00.000Z');
  assert.equal(iso(lastMoment.end), '2026-10-31T16:00:00.000Z');

  const firstMoment = monthPeriod(new Date('2026-10-31T16:00:00.000Z'));
  assert.equal(iso(firstMoment.start), '2026-10-31T16:00:00.000Z');
  assert.equal(iso(firstMoment.end), '2026-11-30T16:00:00.000Z');
});

test('the start of a period belongs to it and the end belongs to the next', () => {
  const p = monthPeriod(new Date('2026-11-15T00:00:00Z'));
  assert.equal(iso(monthPeriod(p.start).start), iso(p.start));
  assert.equal(iso(monthPeriod(p.end).start), iso(p.end));
  assert.notEqual(iso(monthPeriod(new Date(p.end.getTime() - 1)).start), iso(p.end));
});

test('December rolls into January', () => {
  const p = monthPeriod(new Date('2026-12-31T16:00:00Z')); // 00:00 on 1 January 2027 in UTC+8
  assert.equal(iso(p.start), '2026-12-31T16:00:00.000Z');
  assert.equal(iso(p.end), '2027-01-31T16:00:00.000Z');
});

test('February in a leap year has 29 days', () => {
  const p = monthPeriod(new Date('2028-02-15T00:00:00Z'));
  assert.equal(iso(p.start), '2028-01-31T16:00:00.000Z');
  assert.equal(iso(p.end), '2028-02-29T16:00:00.000Z');
});

test('a day starts at midnight in UTC+8', () => {
  const p = dayPeriod(new Date('2026-11-07T04:00:00Z'));
  assert.equal(iso(p.start), '2026-11-06T16:00:00.000Z');
  assert.equal(iso(p.end), '2026-11-07T16:00:00.000Z');
});

test('the day changes exactly at midnight UTC+8', () => {
  assert.equal(iso(dayPeriod(new Date('2026-11-09T15:59:59.999Z')).end), '2026-11-09T16:00:00.000Z');
  assert.equal(iso(dayPeriod(new Date('2026-11-09T16:00:00.000Z')).start), '2026-11-09T16:00:00.000Z');
});

test('the last day of a month ends where the next month starts', () => {
  const day = dayPeriod(new Date('2026-11-30T10:00:00Z')); // 18:00 on 30 November in UTC+8
  assert.equal(iso(day.end), iso(monthPeriod(new Date('2026-11-30T10:00:00Z')).end));
});
