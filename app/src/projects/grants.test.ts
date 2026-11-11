import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MembershipRow } from './membership';
import { type GrantRow, defaultGrantEnd, grantGivesAccess, grantSpanOk, grantState, mayDecide } from './grants';

const grant = (over: Partial<GrantRow> = {}): GrantRow => ({
  id: 'g', userId: 'x', kind: 'audit', startsOn: '2026-11-10', expiresOn: '2026-11-20', requestedBy: 'r', decision: 'approved',
  suspendedAt: null, revokedAt: null, ...over,
});

test('grant state follows decision, suspension and dates', () => {
  assert.equal(grantState(grant({ decision: null }), '2026-11-12'), 'requested');
  assert.equal(grantState(grant({ decision: 'declined' }), '2026-11-12'), 'declined');
  assert.equal(grantState(grant(), '2026-11-09'), 'scheduled');
  assert.equal(grantState(grant(), '2026-11-10'), 'active');
  assert.equal(grantState(grant(), '2026-11-20'), 'active');
  assert.equal(grantState(grant(), '2026-11-21'), 'expired');
  assert.equal(grantState(grant({ suspendedAt: new Date() }), '2026-11-12'), 'suspended');
  assert.equal(grantState(grant({ suspendedAt: new Date(), revokedAt: new Date() }), '2026-11-12'), 'revoked');
  assert.equal(grantState(grant({ decision: null, revokedAt: new Date() }), '2026-11-12'), 'revoked');
});

test('grant spans', () => {
  assert.equal(defaultGrantEnd('2026-11-09'), '2026-12-09');
  assert.equal(grantSpanOk('2026-11-09', '2027-02-07'), true, '90 days');
  assert.equal(grantSpanOk('2026-11-09', '2027-02-08'), false, '91 days');
  assert.equal(grantSpanOk('2026-11-09', '2026-11-08'), false, 'end before start');
  assert.equal(grantSpanOk('2026-11-09', '2026-11-09'), true, 'one day');
});

test('nobody decides their own grant or the one they recorded', () => {
  assert.deepEqual(mayDecide({ deciderId: 'x', grant: grant() }), { allowed: false, reason: 'Nobody can approve access for themselves.' });
  assert.deepEqual(mayDecide({ deciderId: 'r', grant: grant() }), { allowed: false, reason: 'The person who recorded the request cannot also decide it.' });
  assert.deepEqual(mayDecide({ deciderId: 'z', grant: grant() }), { allowed: true });
});

test('a hold suspends the grant in that project', () => {
  const m = (userId: string, held: boolean): MembershipRow => ({
    userId, role: 'member', startsOn: '2026-11-01', expiresOn: null, revokedAt: null, heldAt: held ? new Date('2026-11-05T00:00:00Z') : null, restoredAt: null,
  });
  assert.equal(grantGivesAccess(grant(), '2026-11-12', []), true);
  assert.equal(grantGivesAccess(grant(), '2026-11-12', [m('x', true)]), false);
  assert.equal(grantGivesAccess(grant(), '2026-11-12', [m('y', true)]), true);
  assert.equal(grantGivesAccess(grant(), '2026-11-09', []), false, 'not yet started');
});
