import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatExpiry, membershipStateLabel, roleLabel, transitionsFor } from './projects.ts';

test('roles and membership states read as words', () => {
  assert.equal(roleLabel('pm'), 'Project Manager');
  assert.equal(roleLabel('deputy_pm'), 'Deputy Project Manager');
  assert.equal(roleLabel('sponsor'), 'Sponsor');
  assert.equal(membershipStateLabel('scheduled'), 'Starts later');
  assert.equal(membershipStateLabel('active'), 'Active');
  assert.equal(membershipStateLabel('expired'), 'Expired');
  assert.equal(membershipStateLabel('revoked'), 'Revoked');
});

test('an invitation expiry is shown exactly, in UTC+8', () => {
  assert.equal(formatExpiry('2026-11-16T06:30:00.000Z'), 'Expires 16 Nov 2026, 2:30 pm');
  assert.equal(formatExpiry('2026-11-15T16:05:00.000Z'), 'Expires 16 Nov 2026, 12:05 am');
});

test('lifecycle buttons follow who may make each change', () => {
  const ids = (s: Parameters<typeof transitionsFor>[0], roles: Parameters<typeof transitionsFor>[1], admin = false) =>
    transitionsFor(s, roles, admin).map((t) => t.to + (t.fastTrack ? ' (fast track)' : ''));
  assert.deepEqual(ids('draft', ['pm']), ['planned', 'active (fast track)']);
  assert.deepEqual(ids('draft', ['owner']), ['planned']);
  assert.deepEqual(ids('draft', ['member']), []);
  assert.deepEqual(ids('planned', ['sponsor']), ['active', 'closed']);
  assert.deepEqual(ids('planned', ['pm']), ['active']);
  assert.deepEqual(ids('active', ['pm']), ['deferred']);
  assert.deepEqual(ids('active', ['owner']), ['deferred', 'closed']);
  assert.deepEqual(ids('active', ['pm', 'owner']), ['deferred', 'closed']);
  assert.deepEqual(ids('deferred', [], true), ['active']);
  assert.deepEqual(ids('deferred', ['sponsor']), ['active', 'closed']);
  assert.deepEqual(ids('closed', ['owner']), ['active']);
  assert.deepEqual(ids('closed', [], true), []);
  const close = transitionsFor('planned', ['owner'], false).find((t) => t.to === 'closed');
  assert.deepEqual(close, { to: 'closed', label: 'Close as Abandoned', fastTrack: false, needs: { reason: true, outcome: true, stage: false }, outcomes: ['abandoned'] });
});

test('time in the current stage counts UTC+8 calendar days', async () => {
  const { stageDuration } = await import('./projects.ts');
  const now = new Date('2026-11-09T02:00:00Z'); // 9 Nov, 10:00 UTC+8
  assert.equal(stageDuration('2026-11-09T01:00:00Z', now), 'started today');
  assert.equal(stageDuration('2026-11-08T15:59:00Z', now), '1 day in this stage', '8 Nov 23:59 UTC+8');
  assert.equal(stageDuration('2026-11-08T16:00:00Z', now), 'started today', '9 Nov 00:00 UTC+8');
  assert.equal(stageDuration('2026-10-31T16:00:00Z', now), '8 days in this stage');
});
