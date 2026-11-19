import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ACTIONS, can } from '../auth/permissions';
import { parseAnalyticsFilters, weekStarts, type AnalyticsFilters } from './filters';

// 2026-11-09 is a Monday.
const TODAY = '2026-11-09';
const ok = (q: Record<string, unknown>, today = TODAY) => {
  const f = parseAnalyticsFilters(q, today);
  assert.ok(!('error' in f), JSON.stringify(f));
  return f as AnalyticsFilters;
};

describe('analytics filters', () => {
  test('default period is last 12 weeks; weeks start Monday UTC+8', () => {
    const f = ok({});
    assert.equal(f.period, 'last_12w');
    assert.equal(f.to, TODAY);
    assert.equal(f.from, '2026-08-24');
    assert.deepEqual(f.statuses, ['planned', 'active', 'deferred']);
    assert.equal(f.ownership, 'both');
    assert.equal(f.includeArchived, false);
    assert.equal(f.departmentId, null);
    const weeks = weekStarts(f.from, f.to);
    assert.equal(weeks.length, 12);
    assert.equal(weeks[0], '2026-08-24');
    assert.equal(weeks[11], '2026-11-09');
    assert.ok(weeks.every((w) => new Date(`${w}T00:00:00Z`).getUTCDay() === 1));
    // Mid-week today: the current week starts on the Monday before.
    const mid = ok({ period: 'last_4w' }, '2026-11-12');
    assert.equal(mid.from, '2026-10-19');
    assert.deepEqual(weekStarts(mid.from, mid.to), ['2026-10-19', '2026-10-26', '2026-11-02', '2026-11-09']);
    // A range starting mid-week begins at that week's Monday.
    assert.deepEqual(weekStarts('2026-11-04', '2026-11-10'), ['2026-11-02', '2026-11-09']);
  });

  test('this month and last month bounds', () => {
    assert.deepEqual([ok({ period: 'this_month' }).from, ok({ period: 'this_month' }).to], ['2026-11-01', '2026-11-09']);
    assert.deepEqual([ok({ period: 'last_month' }).from, ok({ period: 'last_month' }).to], ['2026-10-01', '2026-10-31']);
    const jan = ok({ period: 'last_month' }, '2027-01-15');
    assert.deepEqual([jan.from, jan.to], ['2026-12-01', '2026-12-31']);
    const leap = ok({ period: 'last_month' }, '2028-03-02');
    assert.equal(leap.to, '2028-02-29');
    assert.equal(ok({ period: 'last_52w' }).from, '2025-11-17');
  });

  test('bad period is error', () => {
    const e = parseAnalyticsFilters({ period: 'last_5w' }, TODAY);
    assert.ok('error' in e && e.error.length > 0);
    assert.ok('error' in parseAnalyticsFilters({ period: ['a', 'b'] }, TODAY));
    assert.ok('error' in parseAnalyticsFilters({ status: 'active,bogus' }, TODAY));
    assert.ok('error' in parseAnalyticsFilters({ department: 'nope' }, TODAY));
    assert.ok('error' in parseAnalyticsFilters({ ownership: 'all' }, TODAY));
    assert.ok('error' in parseAnalyticsFilters({ includeArchived: 'maybe' }, TODAY));
  });

  test('other filters parse', () => {
    const d = '0192f6c0-0000-7000-8000-000000000001';
    const f = ok({ department: d, status: 'closed,active', ownership: 'owned', includeArchived: '1' });
    assert.equal(f.departmentId, d);
    assert.deepEqual(f.statuses, ['closed', 'active']);
    assert.equal(f.ownership, 'owned');
    assert.equal(f.includeArchived, true);
  });

  test('analytics.view exists and audit.view does not', () => {
    assert.ok((ACTIONS as readonly string[]).includes('analytics.view'));
    assert.ok(!(ACTIONS as readonly string[]).includes('audit.view'));
    assert.equal(can('enterprise_administrator', 'analytics.view'), true);
    assert.equal(can('member', 'analytics.view'), false);
    assert.equal(can('enterprise_administrator', 'audit.view'), false);
  });
});
