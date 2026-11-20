import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type HistoryLine,
  deletedLabel,
  flagSentence,
  delegationLabel,
  historyLineText,
  historyLineTitle,
  mayDelegateDeletion,
  mayDeleteRecord,
  mayDeleteSource,
  mayRestoreRecord,
  mayRestoreSource,
  OUTPUT_EVENT_TEXT,
  reasonProblem,
  restoreDialogView,
} from './history.ts';

const line = (over: Partial<HistoryLine> = {}): HistoryLine => ({
  at: '2026-12-03T02:00:00.000Z',
  kind: 'task',
  action: 'deleted',
  actor: 'Aisyah Rahman',
  reason: 'Duplicate',
  ...over,
});

test('history line text names kind, actor and reason, in UTC+8', () => {
  assert.equal(historyLineText(line()), '3 Dec 2026 — A task was deleted by Aisyah Rahman — "Duplicate"');
  assert.equal(
    historyLineText(line({ at: '2026-12-05T17:30:00.000Z', kind: 'note', action: 'restored', actor: 'Daniel Tan', reason: 'It belongs here after all' })),
    '6 Dec 2026 — A note was restored by Daniel Tan — "It belongs here after all"',
  );
  assert.equal(historyLineText(line({ kind: 'minutes' })), '3 Dec 2026 — A set of minutes was deleted by Aisyah Rahman — "Duplicate"');
});

test('history line has no title without the scope', () => {
  const plain = line();
  assert.equal(historyLineTitle(plain), null);
  assert.ok(!historyLineText(plain).includes('Secret plan'));
  // With the scope the server adds the title; the sentence itself still never carries it (the screen shows it as a link).
  const scoped = line({ title: 'Secret plan', href: '#/projects/p/deleted/task/t' });
  assert.deepEqual(historyLineTitle(scoped), { title: 'Secret plan', href: '#/projects/p/deleted/task/t' });
  assert.ok(!historyLineText(scoped).includes('Secret plan'));
});

test('credential report lines name the reporter only when the server sent one', () => {
  const report = line({ kind: 'credential_report', action: 'reported', actor: null, reason: null, itemKind: 'note' });
  assert.equal(historyLineText(report), '3 Dec 2026 — A suspected credential was reported in a note');
  assert.equal(historyLineText({ ...report, actor: 'Mei Lin' }), '3 Dec 2026 — A suspected credential was reported in a note by Mei Lin');
});

test('a rejected AI key line names the connection label and Kainow, never a key', () => {
  const l = line({ kind: 'ai_connection', action: 'key_rejected', actor: null, reason: null, label: 'Main' });
  assert.equal(
    historyLineText(l),
    '3 Dec 2026 — The key for AI connection "Main" was refused; AI requests skip this connection until the key is replaced (recorded by Kainow)',
  );
});

test('deleted label format', () => {
  assert.equal(deletedLabel('Aisyah Rahman', '2026-12-03T02:00:00.000Z', 'Duplicate'), 'Deleted — Aisyah Rahman, 3 Dec 2026: Duplicate');
});

test('delegation label format', () => {
  assert.equal(delegationLabel('Mei Lin', 'Daniel Tan'), 'Record deletion delegated to Mei Lin by Daniel Tan');
});

test('restore dialog shows the names before confirming', () => {
  const loading = restoreDialogView(null);
  assert.equal(loading.canConfirm, false);
  assert.deepEqual(loading.names, []);
  const ready = restoreDialogView(['Aisyah Rahman', 'Daniel Tan']);
  assert.equal(ready.intro, 'These people will be able to see it again');
  assert.deepEqual(ready.names, ['Aisyah Rahman', 'Daniel Tan']);
  assert.equal(ready.canConfirm, true);
  const nobody = restoreDialogView([]);
  assert.equal(nobody.canConfirm, true);
  assert.match(nobody.empty ?? '', /No one/);
});

test('reason problem: required and at most 1,000 characters', () => {
  assert.match(reasonProblem('   ') ?? '', /reason/i);
  assert.equal(reasonProblem('Duplicate'), null);
  assert.equal(reasonProblem('x'.repeat(1000)), null);
  assert.match(reasonProblem('x'.repeat(1001)) ?? '', /1,000/);
});

test('who is offered Delete and Restore mirrors the matrix', () => {
  assert.equal(mayDeleteSource(['pm'], 'active'), true);
  assert.equal(mayDeleteSource(['owner'], 'planned'), true);
  assert.equal(mayDeleteSource(['deputy_pm'], 'active'), false);
  assert.equal(mayDeleteSource(['pm'], 'closed'), false);
  assert.equal(mayRestoreSource(['sponsor']), true);
  assert.equal(mayRestoreSource(['member']), false);
  assert.equal(mayDeleteRecord(['owner'], 'active', false), true);
  assert.equal(mayDeleteRecord(['pm'], 'active', false), false);
  assert.equal(mayDeleteRecord(['pm'], 'active', true), true);
  assert.equal(mayDeleteRecord(['pm'], 'deferred', true), false);
  assert.equal(mayRestoreRecord(['pm'], false), false);
  assert.equal(mayRestoreRecord(['pm'], true), true);
  assert.equal(mayDelegateDeletion(['sponsor']), true);
  assert.equal(mayDelegateDeletion(['pm']), false);
});

test('a review flag on a deleted decision reads sensibly', () => {
  assert.equal(flagSentence({ id: 'd1', statement: 'Use the north berth', status: 'superseded' }), '“Use the north berth” is now superseded');
  assert.equal(flagSentence({ id: null, statement: 'a deleted record', status: 'superseded' }), 'The decision this depends on is now a deleted record');
});

test('department transfer lines name both departments and the folder choice', () => {
  const t = line({ kind: 'department_transfer', action: 'transferred', actor: 'Daniel Tan', reason: 'Re-organised', fromDepartment: 'Water Services', toDepartment: 'Roads', folderChoice: 'move' });
  assert.equal(
    historyLineText(t),
    '3 Dec 2026 — The owning department changed from Water Services to Roads by Daniel Tan; its filed outputs were moved to the new department — "Re-organised"',
  );
  assert.ok(!historyLineText({ ...t, folderChoice: null }).includes('filed outputs'));
  assert.ok(historyLineText({ ...t, folderChoice: 'keep' }).includes('stayed where they were'));
});

test('output lines say what happened, naming the output only when the server gave its title', () => {
  const o = line({ kind: 'output', action: 'registered', actor: 'Aisyah Rahman', reason: null, output: { id: 'O', title: 'Weekly status' } });
  assert.equal(historyLineText(o), '3 Dec 2026 — The output "Weekly status" was registered by Aisyah Rahman');
  assert.equal(historyLineText({ ...o, action: 'deleted', actor: null, reason: 'Twice', output: { id: 'O', title: null } }), '3 Dec 2026 — An output was deleted — "Twice"');
  assert.ok(!historyLineText({ ...o, action: 'filed' }).includes('undefined'));
  assert.ok(!historyLineText({ ...o, action: 'something_new' }).includes('undefined'));
  for (const k of Object.keys(OUTPUT_EVENT_TEXT)) assert.ok(historyLineText({ ...o, action: k }).includes('output'));
});
