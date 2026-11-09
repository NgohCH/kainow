import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  approvalOutcome,
  checkReconciliation,
  checkReplacementDate,
  closureReadiness,
  effectiveCount,
  kindAllowedIn,
} from './rules';

test('effectiveCount uses the organisation count unless projects may override', () => {
  assert.equal(effectiveCount({ required: 2, projectsMayOverride: false }, { requiredApprovals: 1 }), 2);
  assert.equal(effectiveCount({ required: 2, projectsMayOverride: true }, { requiredApprovals: 3 }), 3);
  assert.equal(effectiveCount({ required: 2, projectsMayOverride: true }, { requiredApprovals: null }), 2);
});

test('approvalOutcome counts distinct eligible approvers', () => {
  assert.deepEqual(approvalOutcome({ required: 2, approverIds: ['a', 'a'], eligibleIds: ['a', 'b'] }), {
    state: 'pending', have: 1, need: 2, enough: true,
  });
  assert.equal(approvalOutcome({ required: 2, approverIds: ['a', 'x'], eligibleIds: ['a', 'b'] }).have, 1);
  assert.equal(approvalOutcome({ required: 2, approverIds: ['a', 'b'], eligibleIds: ['a', 'b'] }).state, 'authorised');
  assert.equal(approvalOutcome({ required: 2, approverIds: [], eligibleIds: ['a'] }).enough, false);
});

test('kindAllowedIn follows the project-state rules', () => {
  assert.equal(kindAllowedIn('deadline_review', 'closed', 'approve'), true);
  assert.equal(kindAllowedIn('amend_task', 'deferred', 'submit'), false);
  assert.equal(kindAllowedIn('amend_task', 'active', 'submit'), true);
  assert.equal(kindAllowedIn('cancel_task', 'deferred', 'submit'), false);
  assert.equal(kindAllowedIn('cancel_task', 'deferred', 'submit', { closureBatch: true }), true);
  assert.equal(kindAllowedIn('authorise_proposal', 'planned', 'approve'), true);
  assert.equal(kindAllowedIn('authorise_proposal', 'draft', 'approve'), false);
  assert.equal(kindAllowedIn('reconcile_completion', 'planned', 'submit'), false);
  assert.equal(kindAllowedIn('risk_handover', 'deferred', 'submit'), true);
  assert.equal(kindAllowedIn('risk_handover', 'deferred', 'approve'), false);
  assert.equal(kindAllowedIn('risk_handover', 'active', 'approve'), true);
});

test('closureReadiness names what is missing', () => {
  const base = { tasks: [], questions: [], risks: [], dispositions: [], pendingRequests: [] };
  const r = closureReadiness({
    ...base,
    tasks: [{ id: 't1', status: 'in_progress' }, { id: 't2', status: 'completed' }],
  });
  assert.equal(r.ready, false);
  assert.deepEqual(r.missing, [{ kind: 'task', id: 't1', why: 'No disposition yet' }]);

  const c = closureReadiness({
    ...base,
    tasks: [{ id: 't1', status: 'in_progress' }],
    dispositions: [{ recordKind: 'task', recordId: 't1', disposition: 'cancel', affectsDelivery: false }],
  });
  assert.equal(c.missing[0].why, 'Cancellation waiting for authorisation');
  const c2 = closureReadiness({
    ...base,
    tasks: [{ id: 't1', status: 'cancelled' }],
    dispositions: [{ recordKind: 'task', recordId: 't1', disposition: 'cancel', affectsDelivery: false }],
  });
  assert.equal(c2.ready, true);

  const h = closureReadiness({
    ...base,
    risks: [{ id: 'r1', status: 'open', reviewOn: null }],
    dispositions: [{ recordKind: 'risk', recordId: 'r1', disposition: 'handover', affectsDelivery: false }],
  });
  assert.equal(h.missing[0].why, 'Hand-over waiting for acceptance');
  const h2 = closureReadiness({
    ...base,
    risks: [{ id: 'r1', status: 'open', reviewOn: null }],
    dispositions: [{ recordKind: 'risk', recordId: 'r1', disposition: 'handover', affectsDelivery: false }],
    pendingRequests: [{ kind: 'risk_handover', targetId: 'r1', status: 'authorised' }],
  });
  assert.equal(h2.ready, true);
});

test('closureReadiness skips finished items and accepted risks without review', () => {
  const r = closureReadiness({
    tasks: [{ id: 't', status: 'cancelled' }],
    questions: [{ id: 'q1', status: 'resolved' }, { id: 'q2', status: 'withdrawn' }],
    risks: [
      { id: 'r1', status: 'resolved', reviewOn: null },
      { id: 'r2', status: 'accepted', reviewOn: null },
      { id: 'r3', status: 'accepted', reviewOn: '2027-01-01' },
    ],
    dispositions: [],
    pendingRequests: [],
  });
  assert.deepEqual(r.missing, [{ kind: 'risk', id: 'r3', why: 'No disposition yet' }]);
});

test('closureReadiness deliveredAllowed', () => {
  const base = { tasks: [], questions: [], risks: [], pendingRequests: [] };
  const d = (disposition: string, affectsDelivery = false) => ({
    recordKind: 'question', recordId: 'q', disposition, affectsDelivery,
  });
  assert.equal(closureReadiness({ ...base, dispositions: [] }).deliveredAllowed, true);
  assert.equal(closureReadiness({ ...base, dispositions: [d('keep')] }).deliveredAllowed, false);
  assert.equal(closureReadiness({ ...base, dispositions: [d('unresolved', true)] }).deliveredAllowed, false);
  assert.equal(closureReadiness({ ...base, dispositions: [d('unresolved', false)] }).deliveredAllowed, true);
});

test('checkReplacementDate', () => {
  const today = '2026-11-09';
  assert.equal(checkReplacementDate({ previous: '2026-11-10', proposed: '2026-11-10', today }),
    'Choose a date different from the previous due date.');
  assert.equal(checkReplacementDate({ previous: '2026-11-10', proposed: '2026-11-08', today }),
    'Choose a date that is not in the past.');
  assert.equal(checkReplacementDate({ previous: '2026-11-10', proposed: '2026-11-09', today }), null);
});

test('checkReconciliation', () => {
  const ok = { completedOn: '2026-11-05', today: '2026-11-09', pausedOn: '2026-11-01', explanation: 'Done by the vendor.' };
  assert.equal(checkReconciliation(ok), null);
  assert.equal(checkReconciliation({ ...ok, completedOn: '2026-11-10' }), 'The completion date cannot be in the future.');
  assert.equal(checkReconciliation({ ...ok, completedOn: '2026-10-31' }), 'The completion date cannot be before the pause began.');
  assert.equal(checkReconciliation({ ...ok, explanation: '   ' }), 'Explain how the work was completed.');
});
