import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type ManyProposal, buildItems, isTyped, itemProblem, manyCandidates, resultLine, startItem } from './authoriseMany.ts';

const proposal = (over: Partial<ManyProposal> = {}): ManyProposal => ({
  id: 'p1', kind: 'action', text: 'Plan', owner: null, due: null, reviewStatus: 'pending', proposedSubtasks: null,
  dueReading: { state: 'needs_date', earliest: null, latest: null }, ...over,
});
const people = [{ userId: 'u1', displayName: 'Ana', email: 'ana@example.org' }];

test('only people’s actions still waiting, without one already sent for more approvals', () => {
  const list = [proposal(), proposal({ id: 'p2', kind: 'risk' }), proposal({ id: 'p3', reviewStatus: 'approved' }), proposal({ id: 'p4' })];
  assert.deepEqual(manyCandidates(list, new Set(['p4'])).map((p) => p.id), ['p1']);
});

test('each needs its assignee and due date, its subtasks too unless left out', () => {
  const p = proposal({ proposedSubtasks: [{ title: 'Sub', description: 'More', due: '2027-01-02' }] });
  let s = startItem(p, people);
  assert.equal(s.subtasks[0].dueOn, '2027-01-02');
  assert.match(itemProblem(s)!, /assignee/);
  s = { ...s, assignee: 'u1' };
  assert.match(itemProblem(s)!, /due date/);
  s = { ...s, dueOn: '2027-01-01' };
  assert.match(itemProblem(s)!, /subtask/i);
  assert.equal(itemProblem({ ...s, subtasks: [{ ...s.subtasks[0], on: false }] }), null);
  s = { ...s, subtasks: [{ ...s.subtasks[0], assignee: '__invite__', email: 'new@example.org' }] };
  assert.equal(itemProblem(s), null);
  assert.deepEqual(buildItems([['p1', s]]), [
    { proposalId: 'p1', assigneeId: 'u1', dueOn: '2027-01-01', subtasks: [{ title: 'Sub', description: 'More', inviteEmail: 'new@example.org', dueOn: '2027-01-02' }] },
  ]);
});

test('a due date already given, and a person named in the proposal, are offered', () => {
  const s = startItem(proposal({ owner: 'Ana', dueReading: { state: 'exact', earliest: '2027-03-04', latest: '2027-03-04' } }), people);
  assert.deepEqual([s.dueOn, s.assignee], ['2027-03-04', 'u1']);
});

test('what was typed counts as unsaved even when it is not ticked', () => {
  const p = proposal();
  const start = startItem(p, people);
  assert.equal(isTyped({ on: false, terms: { ...start } }, start), false);
  assert.equal(isTyped({ on: true, terms: start }, start), true);
  assert.equal(isTyped({ on: false, terms: { ...start, dueOn: '2027-01-01' } }, start), true);
});

test('results in plain words', () => {
  assert.deepEqual(resultLine({ proposalId: 'p', ok: true, record: { kind: 'task', id: 't' } }), { word: 'Authorised', detail: 'It is now on the Work tab.' });
  assert.equal(resultLine({ proposalId: 'p', ok: true, waiting: true, request: { approvals: [{}], requiredApprovals: 2 } }).word, 'Waiting for 1 more approval');
  assert.deepEqual(resultLine({ proposalId: 'p', ok: false, error: 'Nope.' }), { word: 'Not authorised', detail: 'Nope.' });
});
