import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FinanceSettingsView } from './finance.ts';
import {
  authorityText,
  budgetCardLines,
  dashboardFinanceLines,
  financeSettingsBody,
  hasChanges,
  itemProblem,
  nextAction,
  orgSettingsProblem,
  resourceCountsLine,
  resourcesCardText,
  settingsChangeText,
  sharePercent,
  thresholdProblem,
  thresholdsText,
  turnOffPreviewText,
} from './resourceScreens.ts';

test('turn-off preview uses the exact wording', () => {
  assert.equal(
    turnOffPreviewText({ entries: 4, budgetVersions: 2, pending: 1 }),
    'Finance sections will be hidden. 4 entries, 2 budget versions and 1 pending approvals are kept. Finance readers can still open Finance history.',
  );
});

test('thresholds: both empty inherit; whole 1 to 200, first below second', () => {
  assert.equal(thresholdProblem('', ''), null);
  assert.equal(thresholdProblem('80', '100'), null);
  assert.equal(thresholdProblem('1', '200'), null);
  for (const [a, b] of [['80', ''], ['', '100'], ['100', '80'], ['80', '80'], ['0', '10'], ['10', '201'], ['8.5', '10'], ['a', 'b']]) {
    assert.notEqual(thresholdProblem(a, b), null, `${a}/${b}`);
  }
});

test('effective thresholds say inherited or set for this project', () => {
  assert.match(thresholdsText({ thresholds: [80, 100], inherited: true }), /80% and 100%.*inherited from the organisation/);
  assert.match(thresholdsText({ thresholds: [70, 90], inherited: false }), /set for this project/);
});

test('authority text covers editor, not delegated and read-only', () => {
  assert.equal(authorityText({ editable: true, delegated: true }), 'You can change these settings.');
  assert.match(authorityText({ editable: false, delegated: false }), /Only the Administrator/);
  assert.match(authorityText({ editable: false, delegated: true }), /Deputies and others can only read/);
});

const current: FinanceSettingsView['settings'] = { tracking: 'enabled', currency: 'MYR', warnFirstPct: null, warnSecondPct: null, membersRead: false, grantsRead: false };

test('settings body carries only what changed, and the reason', () => {
  const form = { tracking: 'enabled', currency: 'MYR', first: '', second: '', membersRead: false, grantsRead: false, reason: ' because ' };
  assert.deepEqual(financeSettingsBody(current, form), { reason: 'because' });
  assert.equal(hasChanges(financeSettingsBody(current, form)), false);
  assert.deepEqual(financeSettingsBody(current, { ...form, tracking: 'not_required', first: '70', second: '90', membersRead: true }), {
    reason: 'because',
    tracking: 'not_required',
    warnFirstPct: 70,
    warnSecondPct: 90,
    membersRead: true,
  });
  assert.deepEqual(financeSettingsBody({ ...current, warnFirstPct: 70, warnSecondPct: 90 }, { ...form, first: '', second: '' }), { reason: 'because', warnFirstPct: null, warnSecondPct: null });
});

test('history change text names each changed setting', () => {
  assert.equal(
    settingsChangeText({ tracking: 'not_required', warnFirstPct: null }, { tracking: 'enabled', warnFirstPct: 70 }),
    'Financial tracking: Not required to Enabled; First warning: inherited to 70%',
  );
  assert.equal(settingsChangeText({ a: 1 }, { a: 1 }), 'No setting changed');
});

test('dashboard finance: not required, non-reader sentence, and reader figures', () => {
  assert.deepEqual(dashboardFinanceLines({ tracking: 'not_required' }), ['Financial tracking: Not required']);
  assert.deepEqual(dashboardFinanceLines({ tracking: 'enabled' }), ["Financial tracking is on; figures are visible to the project's finance readers."]);
  const lines = dashboardFinanceLines({
    tracking: 'enabled',
    currency: 'MYR',
    figures: { budget: '1000.00', spent: '800.00', balance: '200.00', percentUsed: 80, overBudget: false, level: 1, notInTotals: [], warnThresholds: [80, 100] },
    pendingAdjustments: 1,
    notInTotals: [{ currency: 'USD', amount: '50.00' }],
  });
  assert.equal(lines[0], 'Approved budget: MYR 1,000.00');
  assert.ok(lines.includes('Balance based on recorded expenditure: MYR 200.00'));
  assert.ok(lines.includes('Awaiting approval: 1 adjustment'));
  assert.ok(lines.includes('Not in totals: USD 50.00 awaiting conversion'));
  const none = dashboardFinanceLines({
    tracking: 'enabled',
    currency: 'MYR',
    figures: { budget: null, spent: '0.00', balance: null, percentUsed: null, overBudget: false, level: 0, notInTotals: [], warnThresholds: [80, 100] },
    pendingAdjustments: 0,
    notInTotals: [],
  });
  assert.equal(none[0], 'Approved budget: Not provided');
  assert.equal(none[none.length - 1], 'Based on recorded entries.');
});

test('resource counts and leadership cards', () => {
  assert.equal(resourceCountsLine({ needed: 2, arranged: 1, in_use: 3, finished: 5, cancelled: 1 }), 'Needed 2 · Arranged 1 · In use 3');
  assert.equal(resourcesCardText({ needed: 1, arranged: 2, inUse: 3, neededByPassed: 4 }), 'Needed 1 · Arranged 2 · In use 3 · Past needed-by date 4');
  assert.deepEqual(budgetCardLines({ tracking: 'not_required' }), ['Not required']);
  assert.deepEqual(budgetCardLines({ tracking: 'enabled', currency: 'MYR', budget: null, spent: '0.00', percentUsed: null, level: 0, overBudget: false }), [
    'Approved budget: Not provided',
    'Recorded spending: MYR 0.00',
    'Based on recorded entries.',
  ]);
  const l = budgetCardLines({ tracking: 'enabled', currency: 'SGD', budget: '100.00', spent: '120.00', percentUsed: 120, level: 2, overBudget: true });
  assert.ok(l.includes('Over budget') && l.includes('120% of the approved budget used') && l.includes('Second warning level reached (advisory)'));
});

test('sharePercent', () => {
  assert.equal(sharePercent('50.00', '200.00'), 25);
  assert.equal(sharePercent('0.00', '0.00'), 0);
  assert.equal(sharePercent('300', '200'), 100);
});

test('itemProblem follows the catalogue limits', () => {
  const ok = { kind: 'equipment', reference: 'P-04', name: 'Projector', categoryId: 'c1', description: '' };
  assert.equal(itemProblem(ok), null);
  assert.match(itemProblem({ ...ok, reference: ' ' }) ?? '', /reference/);
  assert.match(itemProblem({ ...ok, reference: 'x'.repeat(31) }) ?? '', /reference/);
  assert.match(itemProblem({ ...ok, name: 'x'.repeat(121) }) ?? '', /name/);
  assert.match(itemProblem({ ...ok, categoryId: '' }) ?? '', /category/);
  assert.match(itemProblem({ ...ok, description: 'x'.repeat(1001) }) ?? '', /description/);
});

test('orgSettingsProblem needs an enabled default and both thresholds', () => {
  const ok = { projectsMayManageFinance: true, defaultCurrency: 'MYR', enabledCurrencies: ['MYR', 'USD'], first: '80', second: '100' };
  assert.equal(orgSettingsProblem(ok), null);
  assert.match(orgSettingsProblem({ ...ok, enabledCurrencies: [] }) ?? '', /at least one/);
  assert.match(orgSettingsProblem({ ...ok, defaultCurrency: 'SGD' }) ?? '', /default currency/);
  assert.notEqual(orgSettingsProblem({ ...ok, first: '' }), null);
  assert.notEqual(orgSettingsProblem({ ...ok, first: '100', second: '100' }), null);
});

test('turning tracking off needs the preview before it saves', () => {
  assert.equal(nextAction({ changed: true, turningOff: true, previewShown: false }), 'preview');
  assert.equal(nextAction({ changed: true, turningOff: true, previewShown: true }), 'save');
  assert.equal(nextAction({ changed: true, turningOff: false, previewShown: false }), 'save');
  assert.equal(nextAction({ changed: false, turningOff: true, previewShown: true }), 'none');
});
