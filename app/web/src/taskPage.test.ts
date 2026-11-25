import assert from 'node:assert/strict';
import { test } from 'node:test';
import { amendDescription, blockedLine, descriptionNow, historyChanges, proposalHref, statusMeaning, taskHref } from './taskPage.ts';
import { parseProjectHash, tabForHash } from './ui/projectTabs.ts';

const P = '0f8fad5b-d9cb-469f-a165-70867728950e';
const T = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

test('a task has its own address, inside the project, with the Work tab open', () => {
  assert.equal(taskHref(P, T), `#/projects/${P}/tasks/${T}`);
  assert.deepEqual(parseProjectHash(taskHref(P, T)), { projectId: P, tab: 'task', itemId: T });
  assert.equal(tabForHash('task', T), 'work');
  assert.equal(parseProjectHash(`#/projects/${P}/tasks`), null);
  assert.equal(parseProjectHash(`#/projects/${P}/task/${T}`), null);
});

test('the old Work address and the other project addresses still parse', () => {
  assert.deepEqual(parseProjectHash(`#/projects/${P}/work/${T}`), { projectId: P, tab: 'work', itemId: T });
  assert.deepEqual(parseProjectHash(`#/projects/${P}/work`), { projectId: P, tab: 'work', itemId: undefined });
  assert.deepEqual(parseProjectHash(`#/projects/${P}`), { projectId: P, tab: 'overview', itemId: undefined });
  assert.deepEqual(parseProjectHash(`#/projects/${P}/resources/report`), { projectId: P, tab: 'resources/report', itemId: undefined });
  assert.deepEqual(parseProjectHash(`#/projects/${P}/notes/${T}`), { projectId: P, tab: 'notes', itemId: T });
  assert.equal(parseProjectHash(`#/projects/${P}/deleted/task/${T}`), null);
  assert.equal(parseProjectHash('#/projects'), null);
});

test('every status has a sentence on what it means', () => {
  assert.equal(statusMeaning('not_started'), 'Not started: nobody has begun the work yet.');
  assert.equal(statusMeaning('in_progress'), 'In progress: the work is under way.');
  assert.equal(statusMeaning('blocked'), 'Blocked: the work cannot continue. The due date has not moved.');
  assert.equal(statusMeaning('completed'), 'Completed: the work is finished.');
  assert.equal(statusMeaning('cancelled'), 'Cancelled: the work will not be done.');
});

test('a blocked task says why, who blocked it and when (UTC+8)', () => {
  const at = '2026-11-24T18:30:00.000Z';
  assert.match(blockedLine({ reason: 'Waiting for the permit', by: 'Ann', at }), /^Reason: Waiting for the permit\. Blocked by Ann, 25 Nov 2026/);
  assert.match(blockedLine({ reason: 'Why not?', by: 'Ann', at }), /^Reason: Why not\? Blocked by Ann/);
  assert.match(blockedLine({ reason: null, by: 'Ann', at }), /^Blocked by Ann, 25 Nov 2026/);
});

test('a proposal opens at its existing address', () => {
  assert.equal(proposalHref(P, { kind: 'run', runId: 'r', itemId: 'i' }), '#/runs/r');
  assert.equal(proposalHref(P, { kind: 'human', proposalId: T }), `#/projects/${P}/proposals/${T}`);
});

test('a change in the history shows the previous and new values', () => {
  const detail = {
    title: { from: 'A', to: 'B' },
    description: { from: null, to: 'Line 1\nLine 2' },
    assigneeId: { from: 'u1', to: 'u2' },
    dueOn: { from: '2026-11-01', to: '2026-11-09' },
  };
  assert.deepEqual(historyChanges(detail, { u1: 'Ann' }), [
    { label: 'Wording', from: 'A', to: 'B' },
    { label: 'Description', from: 'No description', to: 'Line 1\nLine 2' },
    { label: 'Assignee', from: 'Ann', to: 'Another person' },
    { label: 'Due date', from: '1 Nov 2026', to: '9 Nov 2026' },
  ]);
  assert.deepEqual(historyChanges({ description: { from: 'X', to: null } }, {}), [{ label: 'Description', from: 'X', to: 'No description' }]);
  assert.deepEqual(historyChanges(null, {}), []);
  assert.deepEqual(historyChanges({ explanation: 'text', completedOn: '2026-11-01' }, {}), []);
});

test('the description in a change: a proposed one is shown and sent even when the one in force is unknown', () => {
  const a = (current: string | null | undefined, proposed: string | null | undefined, typed: string | null = null) => amendDescription({ current, proposed, typed });
  // Revising before the read is done, or after it failed.
  assert.deepEqual(a(undefined, 'New'), { known: true, value: 'New', send: 'New' });
  assert.deepEqual(a(undefined, null), { known: true, value: '', send: '' }, 'a removal');
  assert.deepEqual(a(undefined, 'New', 'Newer'), { known: true, value: 'Newer', send: 'Newer' });
  assert.deepEqual(a(undefined, 'New', ''), { known: true, value: '', send: '' });
  // Nothing proposed and the one in force unknown: no field, and nothing sent.
  assert.deepEqual(a(undefined, undefined), { known: false, value: '', send: undefined });
  // Known: sent only when it differs.
  assert.deepEqual(a('Old', undefined), { known: true, value: 'Old', send: undefined });
  assert.deepEqual(a('Old', undefined, ' Old '), { known: true, value: ' Old ', send: undefined });
  assert.deepEqual(a('Old', undefined, ''), { known: true, value: '', send: '' });
  assert.deepEqual(a(null, undefined), { known: true, value: '', send: undefined });
  assert.deepEqual(a('Old', null), { known: true, value: '', send: '' });
  assert.deepEqual(a('Old', 'New'), { known: true, value: 'New', send: 'New' });
});

test('the description in force is said in words, also while it is read or when it cannot be', () => {
  assert.equal(descriptionNow('Old', false), 'Old');
  assert.equal(descriptionNow(null, false), 'No description');
  assert.equal(descriptionNow(undefined, false), 'Reading the description');
  assert.equal(descriptionNow(undefined, true), 'Could not be read');
});
