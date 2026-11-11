import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CUSTODIAN_FIRST, bannerText, closedText, installText, linkKind, stepLinkHidden, stepState, tickWaitText } from './golive.ts';

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

test('installText names the INSTALL.md section for the mailbox and backups steps', () => {
  assert.equal(installText('INSTALL.md, the section on Microsoft 365 email'), 'See INSTALL.md: Microsoft 365 email');
  assert.equal(installText('INSTALL.md, the section on Back up'), 'See INSTALL.md: Back up');
});

test('stepLinkHidden makes each step link unique for screen readers', () => {
  assert.equal(stepLinkHidden(3), ' (step 3)');
});

const step = { key: 'test_email', mode: 'confirm', done: false, canTick: false } as const;

test('tickWaitText explains a disabled test-email Mark done, and nothing else', () => {
  assert.equal(tickWaitText(step, false), 'Send a test email first, then check it arrived.');
  assert.equal(tickWaitText({ ...step, canTick: true }, false), null, 'enabled once a test email was sent');
  assert.equal(tickWaitText({ ...step, done: true }, false), null);
  assert.equal(tickWaitText(step, true), null, 'closed');
  assert.equal(tickWaitText({ ...step, key: 'calendar' }, false), null);
});

test('tickWaitText explains a disabled recovery Mark done until the custodian is recorded', () => {
  const recovery = { ...step, key: 'recovery' } as const;
  assert.equal(tickWaitText(recovery, false), 'Record the recovery custodian on the Organisation page first.');
  assert.equal(CUSTODIAN_FIRST, 'Record the recovery custodian on the Organisation page first.');
  assert.equal(tickWaitText({ ...recovery, canTick: true }, false), null, 'enabled once the custodian is recorded');
  assert.equal(tickWaitText({ ...recovery, done: true }, false), null);
  assert.equal(tickWaitText(recovery, true), null, 'closed');
});
