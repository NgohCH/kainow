import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProjectRole } from '../projects/membership';
import type { GrantKind } from '../projects/grants';
import { DEFAULT_FINANCE_SETTINGS, type ProjectFinanceSettings, effectiveThresholds, mayReadFinance } from './readers';

const ctx = (roles: ProjectRole[], grantKinds: GrantKind[] = [], isAdmin = false) => ({ roles, grantKinds, isAdmin });
const policy = (membersRead: boolean, grantsRead: boolean): ProjectFinanceSettings => ({ ...DEFAULT_FINANCE_SETTINGS, membersRead, grantsRead });
const POLICIES: Array<[boolean, boolean]> = [
  [false, false],
  [true, false],
  [false, true],
  [true, true],
];

test('the PM, a Deputy, the Owner and a Sponsor always read financial detail', () => {
  for (const role of ['pm', 'deputy_pm', 'owner', 'sponsor'] as ProjectRole[]) {
    for (const [m, g] of POLICIES) assert.equal(mayReadFinance(ctx([role]), policy(m, g)), true, `${role} ${m} ${g}`);
  }
});

test('a Member reads only when the project widens reading to Members', () => {
  for (const [m, g] of POLICIES) assert.equal(mayReadFinance(ctx(['member']), policy(m, g)), m, `member ${m} ${g}`);
});

test('an Audit or Oversight holder with no role reads only when the project widens reading to grant holders', () => {
  for (const kind of ['audit', 'oversight'] as GrantKind[]) {
    for (const [m, g] of POLICIES) assert.equal(mayReadFinance(ctx([], [kind]), policy(m, g)), g, `${kind} ${m} ${g}`);
  }
});

test('an Administrator with no role, or no one at all, never reads financial detail', () => {
  for (const [m, g] of POLICIES) {
    assert.equal(mayReadFinance(ctx([], [], true), policy(m, g)), false, `admin ${m} ${g}`);
    assert.equal(mayReadFinance(ctx([]), policy(m, g)), false, `nobody ${m} ${g}`);
  }
});

test('an Administrator who is also the Owner reads through the role; a Member holding a grant reads under either widening', () => {
  assert.equal(mayReadFinance(ctx(['owner'], [], true), policy(false, false)), true);
  assert.equal(mayReadFinance(ctx(['member'], ['audit']), policy(false, false)), false);
  assert.equal(mayReadFinance(ctx(['member'], ['audit']), policy(false, true)), true);
  assert.equal(mayReadFinance(ctx(['member'], ['audit']), policy(true, false)), true);
});

test('the defaults: not required, no currency, inherited thresholds, readers not widened', () => {
  assert.deepEqual(DEFAULT_FINANCE_SETTINGS, { tracking: 'not_required', currency: null, warnFirstPct: null, warnSecondPct: null, membersRead: false, grantsRead: false });
});

test('effective thresholds are the project’s own, or the organisation’s when inherited', () => {
  const org = { warnFirstPct: 80, warnSecondPct: 100 };
  assert.deepEqual(effectiveThresholds(DEFAULT_FINANCE_SETTINGS, org), [80, 100]);
  assert.deepEqual(effectiveThresholds({ ...DEFAULT_FINANCE_SETTINGS, warnFirstPct: 50, warnSecondPct: 150 }, org), [50, 150]);
});
