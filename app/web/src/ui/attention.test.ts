import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { NeedsYouItem } from '../dashboard.ts';
import { groupAttention, KIND_GROUP } from './attention.ts';

const item = (kind: NeedsYouItem['kind']): NeedsYouItem => ({ kind, projectId: 'p', projectName: 'P', label: kind, since: null, link: '#/x' });
const ALL: NeedsYouItem['kind'][] = ['approval', 'minutes', 'question', 'copies', 'deadline_review', 'resources', 'overdue', 'blocked', 'due_soon', 'risk_review'];

test('all ten kinds are mapped to a group', () => {
  assert.equal(Object.keys(KIND_GROUP).length, 10);
  const groups = groupAttention(ALL.map(item));
  assert.equal(groups.reduce((n, g) => n + g.items.length, 0), 10);
});
test('each kind lands in its group, in the order Overdue, Review and decisions, Blocked, Due soon', () => {
  const g = groupAttention([...ALL].reverse().map(item));
  assert.deepEqual(g.map((x) => x.group), ['overdue', 'review', 'blocked', 'dueSoon']);
  assert.deepEqual(g.map((x) => x.heading), ['Overdue', 'Review and decisions', 'Blocked', 'Due soon']);
  assert.deepEqual(g.map((x) => x.meaning), ['overdue', 'review', 'blocked', 'dueSoon']);
  assert.deepEqual(g[1].items.map((i) => i.kind).sort(), ['approval', 'deadline_review', 'minutes', 'question']);
  assert.deepEqual(g[3].items.map((i) => i.kind).sort(), ['copies', 'due_soon', 'resources', 'risk_review']);
});
test('empty groups are dropped', () => {
  assert.deepEqual(groupAttention([]), []);
  assert.deepEqual(groupAttention([item('blocked')]).map((x) => x.group), ['blocked']);
});
