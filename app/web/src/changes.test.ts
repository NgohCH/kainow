import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type ChangeKind, approvalsLine, isPastDay, kindLabel, termsRows, todayUtc8, waitingLine } from './changes.ts';

test('the approvals line counts approvals and names who gave them', () => {
  assert.equal(approvalsLine({ requiredApprovals: 2, approvals: [{ name: 'Ann' }] }), 'Approvals 1 of 2: Ann');
  assert.equal(approvalsLine({ requiredApprovals: 3, approvals: [{ name: 'Ann' }, { name: 'Bo' }] }), 'Approvals 2 of 3: Ann, Bo');
  assert.equal(approvalsLine({ requiredApprovals: 2, approvals: [] }), 'Approvals 0 of 2');
});

test('every kind of change has a plain label', () => {
  const kinds: ChangeKind[] = ['authorise_proposal', 'amend_task', 'cancel_task', 'supersede_decision', 'withdraw_decision', 'deadline_review', 'reconcile_completion', 'risk_handover'];
  const labels = kinds.map(kindLabel);
  assert.equal(new Set(labels).size, 8);
  assert.ok(labels.every((l) => l.length > 0));
  assert.equal(kindLabel('cancel_task'), 'Cancel a task');
});

test('an amendment shows only what changes, side by side', () => {
  const rows = termsRows('amend_task', { dueOn: '2026-12-15', reason: 'Supplier is late' }, { dueOn: '2026-12-01', title: 'Order stock' });
  assert.deepEqual(rows, [{ label: 'Due date', from: '2026-12-01', to: '2026-12-15' }]);
});

test('an amendment can change the wording and the assignee', () => {
  const rows = termsRows('amend_task', { title: 'Order more stock', assigneeId: 'u2', reason: 'x' }, { title: 'Order stock', names: { u1: 'Ann', u2: 'Bo' }, assigneeId: 'u1' });
  assert.deepEqual(rows, [
    { label: 'Wording', from: 'Order stock', to: 'Order more stock' },
    { label: 'Assignee', from: 'Ann', to: 'Bo' },
  ]);
});

test('a new subtask is shown as an addition', () => {
  const rows = termsRows('amend_task', { addSubtask: { title: 'Call supplier', inviteEmail: 'x@example.org', dueOn: '2026-12-10' }, reason: 'r' }, {});
  assert.deepEqual(rows, [
    { label: 'New subtask', from: '', to: 'Call supplier' },
    { label: 'Assignee', from: '', to: 'x@example.org (invited)' },
    { label: 'Due date', from: '', to: '2026-12-10' },
  ]);
});

test('a cancellation shows the reason and what happens to each subtask', () => {
  const rows = termsRows('cancel_task', { reason: 'No longer needed', subtasks: { s1: 'cancel', s2: 'keep' } }, { subtaskTitles: { s1: 'Draft', s2: 'Review' } });
  assert.deepEqual(rows, [
    { label: 'Reason', from: '', to: 'No longer needed' },
    { label: 'Subtask: Draft', from: 'Unfinished', to: 'Cancel' },
    { label: 'Subtask: Review', from: 'Unfinished', to: 'Keep' },
  ]);
});

test('a deadline review shows the due date', () => {
  assert.deepEqual(termsRows('deadline_review', { dueOn: '2027-01-31' }, { dueOn: '2026-11-30' }), [{ label: 'Due date', from: '2026-11-30', to: '2027-01-31' }]);
});

test('replacing a decision shows the old and new wording; withdrawing shows the reason and the work flagged', () => {
  assert.deepEqual(termsRows('supersede_decision', { statement: 'Use B', reason: 'A failed', affected: [{ kind: 'task', id: 't' }] }, { statement: 'Use A' }), [
    { label: 'Decision', from: 'Use A', to: 'Use B' },
    { label: 'Reason', from: '', to: 'A failed' },
    { label: 'Work to review', from: '', to: '1 item' },
  ]);
  assert.deepEqual(termsRows('withdraw_decision', { reason: 'Moot', affected: [] }, {}), [
    { label: 'Reason', from: '', to: 'Moot' },
    { label: 'Work to review', from: '', to: 'None' },
  ]);
});

test('a request still needing approvals says how many', () => {
  assert.equal(waitingLine({ requiredApprovals: 2, approvals: [{}] }), 'Waiting for 1 more approval');
  assert.equal(waitingLine({ requiredApprovals: 3, approvals: [{}] }), 'Waiting for 2 more approvals');
});

test('a due date is past only when before today in Malaysia', () => {
  const now = Date.parse('2026-11-09T17:00:00Z'); // 10 November, 01:00 in UTC+8
  assert.equal(todayUtc8(now), '2026-11-10');
  assert.equal(isPastDay('2026-11-09', now), true);
  assert.equal(isPastDay('2026-11-10', now), false);
  assert.equal(isPastDay('', now), false);
});

test('the closing summary says how many items still need a disposition', async () => {
  const { closureSummary } = await import('./changes.ts');
  assert.equal(closureSummary({ ready: true, missing: [] }), 'Ready to close.');
  assert.equal(closureSummary({ ready: false, missing: [{ kind: 'task', id: 'a', why: 'x' }] }), '1 item still needs a disposition.');
  const three = [1, 2, 3].map((n) => ({ kind: 'task', id: String(n), why: 'x' }));
  assert.equal(closureSummary({ ready: false, missing: three }), '3 items still need a disposition.');
});
