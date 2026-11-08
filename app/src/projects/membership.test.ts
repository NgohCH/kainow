import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type MembershipRow, effectiveRoles, membershipState, requiredRolesCheck, separationCheck, todayUtc8 } from './membership';

const row = (userId: string, role: MembershipRow['role'], over: Partial<MembershipRow> = {}): MembershipRow => ({
  userId, role, startsOn: '2026-11-01', expiresOn: null, revokedAt: null, ...over,
});
const T = '2026-11-08';

test('today is the calendar day in UTC+8', () => {
  assert.equal(todayUtc8(new Date('2026-11-09T15:59:59Z')), '2026-11-09');
  assert.equal(todayUtc8(new Date('2026-11-09T16:00:00Z')), '2026-11-10');
});

test('membership state at the UTC+8 boundaries of start and expiry', () => {
  const starts = row('a', 'member', { startsOn: '2026-11-10' });
  assert.equal(membershipState(starts, todayUtc8(new Date('2026-11-09T15:59:59Z'))), 'scheduled');
  assert.equal(membershipState(starts, todayUtc8(new Date('2026-11-09T16:00:00Z'))), 'active');
  const ends = row('a', 'member', { expiresOn: '2026-11-10' });
  assert.equal(membershipState(ends, todayUtc8(new Date('2026-11-10T15:59:59Z'))), 'active');
  assert.equal(membershipState(ends, todayUtc8(new Date('2026-11-10T16:00:00Z'))), 'expired');
});

test('revocation wins over dates', () => {
  assert.equal(membershipState(row('a', 'pm', { revokedAt: new Date() }), T), 'revoked');
  assert.equal(membershipState(row('a', 'pm', { revokedAt: new Date(), startsOn: '2027-01-01' }), T), 'revoked');
});

test('effective roles are the active roles of that person only', () => {
  const rows = [row('a', 'pm'), row('a', 'owner', { startsOn: '2026-12-01' }), row('a', 'sponsor', { expiresOn: '2026-11-07' }), row('b', 'member')];
  assert.deepEqual(effectiveRoles(rows, 'a', T), ['pm']);
  assert.deepEqual(effectiveRoles(rows, 'c', T), []);
});

test('required roles: one PM, a different Member, and an Owner or Sponsor', () => {
  const full = [row('a', 'pm'), row('b', 'member'), row('c', 'sponsor')];
  assert.deepEqual(requiredRolesCheck(full, T, 'active'), { ok: true, missing: [] });
  assert.deepEqual(requiredRolesCheck([row('a', 'pm'), row('a', 'member'), row('a', 'owner')], T, 'active').missing, ['a Member who is not the Project Manager']);
  assert.deepEqual(requiredRolesCheck([row('a', 'pm'), row('d', 'pm'), row('b', 'member'), row('c', 'owner')], T, 'active').missing, ['a Project Manager']);
  assert.deepEqual(requiredRolesCheck([row('b', 'member'), row('c', 'owner')], T, 'active').missing, ['a Project Manager']);
  assert.deepEqual(requiredRolesCheck([row('a', 'pm'), row('b', 'member')], T, 'active').missing, ['an Owner or a Sponsor']);
  // A scheduled appointment counts once accepted, but not as active.
  const scheduledOwner = [row('a', 'pm'), row('b', 'member'), row('c', 'owner', { startsOn: '2026-12-01' })];
  assert.equal(requiredRolesCheck(scheduledOwner, T, 'accepted').ok, true);
  assert.deepEqual(requiredRolesCheck(scheduledOwner, T, 'active').missing, ['an Owner or a Sponsor']);
  // Expired and revoked appointments never count.
  assert.equal(requiredRolesCheck([row('a', 'pm'), row('b', 'member'), row('c', 'owner', { expiresOn: '2026-11-07' })], T, 'accepted').ok, false);
});

test('separation: combined roles allowed up to six people, not at seven', () => {
  const six = [row('a', 'pm'), row('a', 'owner'), ...['b', 'c', 'd', 'e', 'f'].map((u) => row(u, 'member'))];
  assert.deepEqual(separationCheck(six, T), { ok: true, reason: null });
  const seven = [...six, row('g', 'member')];
  assert.deepEqual(separationCheck(seven, T), { ok: false, reason: 'With seven or more people, the Project Manager, Owner and Sponsors must be different people.' });
  const sevenDistinct = [row('a', 'pm'), row('z', 'owner'), ...['b', 'c', 'd', 'e', 'f'].map((u) => row(u, 'member'))];
  assert.equal(separationCheck(sevenDistinct, T).ok, true);
});

test('one person in several roles counts once, and expired people do not count', () => {
  const rows = [row('a', 'pm'), row('a', 'owner'), row('a', 'sponsor'), row('a', 'member'), ...['b', 'c', 'd', 'e'].map((u) => row(u, 'member'))];
  assert.equal(separationCheck(rows, T).ok, true, 'five people');
  const withExpired = [...rows, row('x', 'member', { expiresOn: '2026-11-01' }), row('y', 'member', { revokedAt: new Date() })];
  assert.equal(separationCheck(withExpired, T).ok, true, 'still five current people');
  const withScheduled = [...rows, row('x', 'member', { startsOn: '2026-12-01' }), row('y', 'member', { startsOn: '2026-12-01' })];
  assert.equal(separationCheck(withScheduled, T).ok, false, 'scheduled people count: seven');
});

test('a hold sits between expiry and the dates', async () => {
  const { isHeld } = await import('./membership');
  const t1 = new Date('2026-11-05T00:00:00Z');
  const t2 = new Date('2026-11-06T00:00:00Z');
  const held = row('a', 'member', { heldAt: t1, restoredAt: null });
  assert.equal(isHeld(held), true);
  assert.equal(membershipState(held, T), 'on_hold');
  assert.equal(membershipState(row('a', 'member', { heldAt: t1, expiresOn: '2026-11-07' }), T), 'expired');
  assert.equal(membershipState(row('a', 'member', { heldAt: t1, revokedAt: t2 }), T), 'revoked');
  assert.equal(membershipState(row('a', 'member', { heldAt: t1, restoredAt: t2 }), T), 'active', 'restored after the hold');
  assert.equal(membershipState(row('a', 'member', { heldAt: t2, restoredAt: t1 }), T), 'on_hold', 'held again after a restore');
  assert.deepEqual(effectiveRoles([row('a', 'pm', { heldAt: t1 }), row('a', 'member')], 'a', T), ['member']);
  const rows = [row('a', 'pm'), row('b', 'member', { heldAt: t1 }), row('c', 'owner')];
  assert.deepEqual(requiredRolesCheck(rows, T, 'accepted').missing, ['a Member who is not the Project Manager']);
});
