import assert from 'node:assert/strict';
import { test } from 'node:test';
import { correctionLine, kindWord, needsReason, originalLine, setAsideWarning } from './corrections.ts';

test('a type change names the person, their role, the time in UTC+8 and every field changed', () => {
  const line = correctionLine({
    at: '2026-11-24T02:12:00.000Z',
    by: 'Daniel Tan',
    role: 'Project Manager',
    changed: ['type', 'text', 'owner'],
    from: { kind: 'action' },
    to: { kind: 'decision' },
    reason: 'It was agreed, not assigned.',
  });
  assert.equal(line, '24 Nov 2026 10:12 · Daniel Tan (Project Manager) changed type Task → Decision, wording, owner');
});

test('a wording-only change says wording; a person with no project role today is named alone', () => {
  const c = { at: '2026-11-24T02:12:00.000Z', by: 'Daniel Tan', role: null, changed: ['text' as const], from: { kind: 'risk' }, to: { kind: 'risk' }, reason: null };
  assert.equal(correctionLine(c), '24 Nov 2026 10:12 · Daniel Tan changed wording');
  assert.equal(correctionLine({ ...c, role: 'Owner', changed: ['due'] }), '24 Nov 2026 10:12 · Daniel Tan (Owner) changed due');
});

test("the original names the model, the type, the wording, the owner and the due as worded", () => {
  const o = { kind: 'action', text: 'Send the draft to the board.', owner: null, due: '5 Dec 2026', model: 'gpt-6.1-sol' };
  assert.equal(originalLine(o, '2026-11-21T08:40:00.000Z'), '21 Nov 2026 16:40 · AI (gpt-6.1-sol) proposed: Task, "Send the draft to the board.", owner not stated, due 5 Dec 2026');
});

test('an unknown model reads "AI proposed"; owner and due show when stated, or say not stated', () => {
  const o = { kind: 'question', text: 'Which room?', owner: 'Ann', due: null, model: null };
  assert.equal(originalLine(o, '2026-11-21T08:40:00.000Z'), '21 Nov 2026 16:40 · AI proposed: Question, "Which room?", owner Ann, due not stated');
});

test('the kind words: action is shown as Task', () => {
  assert.deepEqual(['action', 'decision', 'question', 'risk'].map(kindWord), ['Task', 'Decision', 'Question', 'Risk']);
});

test('a reason is needed only when the type changes', () => {
  assert.equal(needsReason('action', 'decision'), true);
  assert.equal(needsReason('action', 'action'), false);
});

test('the warning before saving counts the approvals set aside', () => {
  assert.equal(setAsideWarning('pending', 0), null);
  assert.equal(setAsideWarning('rejected', 0), null);
  assert.equal(setAsideWarning('approved', 0), 'Saving sends this proposal back to review and sets aside 1 approval.');
  assert.equal(setAsideWarning('pending', 1), 'Saving sends this proposal back to review and sets aside 1 approval.');
  assert.equal(setAsideWarning('pending', 2), 'Saving sends this proposal back to review and sets aside 2 approvals.');
});
