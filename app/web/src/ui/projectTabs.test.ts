import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectTabs, tabForHash, type ProjectTabsContext } from './projectTabs.ts';

const member: ProjectTabsContext = {
  roles: ['member'],
  isAdmin: false,
  contentAllowed: true,
  inspectDeleted: false,
  status: 'active',
  closingNeeded: false,
  deadlineReview: false,
  mayViewAi: false,
  waiting: 0,
  overdue: 0,
};
const keys = (ctx: ProjectTabsContext) => projectTabs(ctx).map((t) => t.key);
const texts = (ctx: ProjectTabsContext) => projectTabs(ctx).map((t) => t.text);

test('a Member with content access gets the tabs of spec 6.3 in order, without the AI or Assist review tabs', () => {
  assert.deepEqual(texts(member), [
    'Overview', 'Discussion', 'Notes', 'Proposals', 'Work', 'Timeline', 'Resources', 'Outputs', 'People', 'Settings', 'Drafts', 'Feedback',
  ]);
  assert.deepEqual(keys(member), [
    'overview', 'discussion', 'notes', 'proposals', 'work', 'timeline', 'resources', 'outputs', 'people', 'settings', 'drafts', 'feedback',
  ]);
});

test('a summary-only viewer gets no content tabs (the contentAllowed rule of today)', () => {
  assert.deepEqual(keys({ ...member, roles: [], contentAllowed: false }), ['overview', 'resources', 'people', 'settings']);
});

test('a Project Manager also gets AI and Assist review; Deleted items only with inspectDeleted', () => {
  const pm = { ...member, roles: ['pm'], mayViewAi: true };
  assert.deepEqual(keys(pm).slice(10), ['ai', 'drafts', 'review', 'feedback']);
  assert.equal(projectTabs(pm).find((t) => t.key === 'review')?.text, 'Assist review');
  assert.ok(keys({ ...pm, inspectDeleted: true }).includes('deleted'));
  assert.ok(!keys(pm).includes('deleted'));
  // An Owner reviews summaries; a Deputy reviews answers: both see Assist review, as today.
  assert.ok(keys({ ...member, roles: ['owner'] }).includes('review'));
  assert.ok(keys({ ...member, roles: ['deputy_pm'] }).includes('review'));
  // Assist review is content: not for a summary-only Administrator.
  assert.deepEqual(keys({ ...member, roles: [], isAdmin: true, contentAllowed: false, mayViewAi: true }), ['overview', 'resources', 'people', 'settings', 'ai']);
});

test('Closing shows only while closingNeeded, Deadline review only while deadlineReview', () => {
  assert.ok(!keys(member).includes('closing'));
  assert.ok(!keys(member).includes('deadline-review'));
  assert.deepEqual(keys({ ...member, closingNeeded: true, deadlineReview: true }).slice(-2), ['closing', 'deadline-review']);
});

test('badges: Proposals when items wait, Work when tasks are overdue, none at zero', () => {
  assert.ok(projectTabs(member).every((t) => t.badge === undefined));
  const tabs = projectTabs({ ...member, waiting: 3, overdue: 2 });
  assert.deepEqual(tabs.find((t) => t.key === 'proposals')?.badge, { count: 3, meaning: 'review' });
  assert.deepEqual(tabs.find((t) => t.key === 'work')?.badge, { count: 2, meaning: 'overdue' });
  assert.equal(tabs.filter((t) => t.badge).length, 2);
  const review = projectTabs({ ...member, deadlineReview: true, deadlineTasks: 4 }).find((t) => t.key === 'deadline-review');
  assert.deepEqual(review?.badge, { count: 4, meaning: 'review' });
});

test('a summary-only viewer gets no Proposals or Work badge even if counts arrive', () => {
  const tabs = projectTabs({ ...member, contentAllowed: false, waiting: 3, overdue: 2 });
  assert.ok(tabs.every((t) => t.badge === undefined));
});

test('tabForHash: old addresses keep their place', () => {
  assert.equal(tabForHash('notes'), 'notes');
  assert.equal(tabForHash(undefined), 'overview');
  assert.equal(tabForHash('run'), 'proposals');
  assert.equal(tabForHash('resources/report'), 'resources');
  assert.equal(tabForHash('discussion'), 'discussion');
  assert.equal(tabForHash('deadline-review'), 'deadline-review');
  // A person's proposal was linked as notes/<id>: it now lives on the Proposals tab.
  assert.equal(tabForHash('notes', '0f8fad5b-d9cb-469f-a165-70867728950e'), 'proposals');
});
