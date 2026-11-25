import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MyTask, NeedsYouItem, PersonalDashboard, PersonalProject } from '../dashboard.ts';
import type { ProjectStatus } from '../projects.ts';
import { attentionFlags, greetingFor, groupProjects, historyLink, homeEmptyCopy, homeProjects, parseHistoryHash, progressText, reviewItems, statusWord, taskRows, todayLabel } from './home.ts';

const item = (kind: NeedsYouItem['kind']): NeedsYouItem => ({ kind, projectId: 'p', projectName: 'P', label: kind, since: null, link: '#/x' });
const task = (id: string, dueOn: string, status = 'todo'): MyTask => ({ id, title: id, projectId: 'p', projectName: 'P', dueOn, status });
const empty: PersonalDashboard = { needsYou: [], myTasks: { overdue: [], dueSoon: [], later: [], awaitingReview: [] }, projects: [], computedAt: '2026-11-24T00:00:00Z' };

test('an empty dashboard says nothing needs you and how to get into a project', () => {
  assert.deepEqual(homeEmptyCopy(empty), {
    needsYou: 'Nothing needs you.',
    projects: 'You are not in any project yet. A Project Manager adds you when a project needs you.',
  });
});
test('a full dashboard has no empty copy', () => {
  const full: PersonalDashboard = { ...empty, needsYou: [item('approval')], projects: [{ id: 'a', name: 'A', onHold: false }] };
  assert.deepEqual(homeEmptyCopy(full), { needsYou: null, projects: null });
});
test('reviewItems keeps approval, question, deadline_review and minutes and drops the rest', () => {
  const kinds: NeedsYouItem['kind'][] = ['approval', 'overdue', 'question', 'blocked', 'deadline_review', 'due_soon', 'minutes', 'copies'];
  assert.deepEqual(reviewItems(kinds.map(item)).map((i) => i.kind), ['approval', 'question', 'deadline_review', 'minutes']);
  assert.deepEqual(reviewItems([]), []);
});
test('the greeting follows the hour in UTC+8', () => {
  assert.equal(greetingFor('Mei Tan', new Date('2026-11-24T00:30:00Z')), 'Good morning, Mei');
  assert.equal(greetingFor('Mei Tan', new Date('2026-11-24T05:00:00Z')), 'Good afternoon, Mei');
  assert.equal(greetingFor('Mei', new Date('2026-11-24T12:00:00Z')), 'Good evening, Mei');
  assert.equal(greetingFor('Mei', new Date('2026-11-24T16:30:00Z')), 'Good morning, Mei');
});
test('today is written in UTC+8', () => {
  assert.equal(todayLabel(new Date('2026-11-24T20:00:00Z')), 'Wednesday 25 November 2026');
});
test('progress is in words', () => {
  assert.equal(progressText({ state: 'measurable', done: 31, total: 50, cancelled: 0, percent: 62 }), '62% (31 of 50 tasks)');
  assert.equal(progressText({ state: 'measurable', done: 0, total: 1, cancelled: 0, percent: 0 }), '0% (0 of 1 task)');
  assert.equal(progressText({ state: 'not_measurable', cancelled: 0 }), 'Not yet measurable');
});
test('attention flags are worded and empty when none', () => {
  assert.deepEqual(attentionFlags({ overdue: 2, blocked: 0, missingRole: true, noIndependentEscalation: false, deadlineReview: false }), ['2 overdue', 'Missing a required role']);
  assert.deepEqual(attentionFlags(undefined), []);
});
test('tasks list overdue first, then by due day', () => {
  const rows = taskRows({
    overdue: [task('o2', '2026-11-20'), task('o1', '2026-11-18')],
    dueSoon: [task('s', '2026-11-25')],
    later: [task('l', '2026-12-30')],
    awaitingReview: [task('a', '2026-11-10')],
    completed: [task('c', '2026-11-01', 'done')],
  });
  assert.deepEqual(rows.map((r) => r.id), ['o1', 'o2', 'c', 'a', 's', 'l']);
});
test('status words', () => assert.equal(statusWord('in_progress'), 'In progress'));

const listedProject = (id: string, status: ProjectStatus, archived = false) => ({ id, status, archived });
const LIST = [
  listedProject('d', 'draft'), listedProject('p', 'planned'), listedProject('a', 'active'), listedProject('x', 'deferred'), listedProject('c', 'closed'),
  listedProject('aa', 'active', true), listedProject('ax', 'deferred', true), listedProject('ac', 'closed', true),
];
const ids = (list: { id: string }[] | null) => list && list.map((p) => p.id).join(' ');
const grouped = (state: ProjectStatus | null, archived: boolean) => {
  const g = groupProjects(LIST, state, archived);
  return { current: ids(g.current), deferred: ids(g.deferred), closed: ids(g.closed) };
};

test('projects are grouped into current, Deferred and Closed; archived ones only when included, in their own group', () => {
  assert.deepEqual(grouped(null, false), { current: 'd p a', deferred: 'x', closed: 'c' });
  assert.deepEqual(grouped(null, true), { current: 'd p a aa', deferred: 'x ax', closed: 'c ac' });
});
test('a state tile shows only the group that state is in', () => {
  assert.deepEqual(grouped('active', false), { current: 'a', deferred: null, closed: null });
  assert.deepEqual(grouped('deferred', false), { current: null, deferred: 'x', closed: null });
  assert.deepEqual(grouped('closed', true), { current: null, deferred: null, closed: 'c ac' });
});
const homeProject = (id: string, status: string | null, archived = false): PersonalProject =>
  status === null
    ? { id, name: id, onHold: true }
    : { id, name: id, onHold: false, archived, header: { status, stage: null, completion: { state: 'not_measurable', cancelled: 0 }, flags: { overdue: 0, blocked: 0, missingRole: false, noIndependentEscalation: false, deadlineReview: false } } };
test('Home lists current projects and those where the membership is on hold, and counts the rest', () => {
  const h = homeProjects([homeProject('d', 'draft'), homeProject('h', null), homeProject('x', 'deferred'), homeProject('c', 'closed'), homeProject('aa', 'active', true)]);
  assert.deepEqual(h.current.map((p) => p.id), ['d', 'h', 'aa']);
  assert.deepEqual(h.history.map((p) => p.id), ['x', 'c']);
  assert.deepEqual(historyLink(h.history), { href: '#/projects/history', text: '2 in History' });
  assert.equal(historyLink([]), null);
});
test('a history with archived projects opens with them included, so the count is what the page lists', () => {
  assert.deepEqual(historyLink([homeProject('x', 'deferred'), homeProject('c', 'closed', true)]), { href: '#/projects/history/archived', text: '2 in History (1 archived)' });
  assert.deepEqual(parseHistoryHash('#/projects/history/archived'), { archived: true });
  assert.deepEqual(parseHistoryHash('#/projects/history'), { archived: false });
  assert.equal(parseHistoryHash('#/projects'), null);
});
test('with only Deferred or Closed projects, Home says there is none current', () => {
  assert.equal(homeEmptyCopy({ ...empty, projects: [homeProject('c', 'closed')] }).projects, 'None of your projects is current.');
});
