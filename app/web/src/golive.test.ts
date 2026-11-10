import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bannerText, closedText, linkKind, stepState } from './golive.ts';

test('bannerText gives the count in words', () => {
  assert.equal(bannerText(3, 11), 'Go-live: 3 of 11 steps done');
  assert.equal(bannerText(0, 11), 'Go-live: 0 of 11 steps done');
});

const base = { done: false, tickedBy: null, tickedAt: null, skipped: false } as const;

test('stepState says who did it and when, in UTC+8', () => {
  assert.equal(stepState(base), 'Not done');
  assert.equal(stepState({ ...base, done: true, tickedBy: 'kainow', tickedAt: '2026-11-11T02:00:00.000Z' }), 'Done by Kainow on 11 Nov 2026');
  assert.equal(stepState({ ...base, done: true, tickedBy: { id: 'u1', name: 'Ana Admin' }, tickedAt: '2026-11-11T17:00:00.000Z' }), 'Done by Ana Admin on 12 Nov 2026');
  assert.equal(stepState({ ...base, done: true, skipped: true, tickedBy: { id: 'u1', name: 'Ana Admin' }, tickedAt: '2026-11-11T02:00:00.000Z' }), 'Skipped by Ana Admin on 11 Nov 2026');
});

test('closedText and linkKind', () => {
  assert.equal(closedText('2026-12-01T01:00:00.000Z'), 'Closed on 1 Dec 2026');
  assert.equal(linkKind('#/people'), 'page');
  assert.equal(linkKind('INSTALL.md, the section on backups'), 'text');
});
