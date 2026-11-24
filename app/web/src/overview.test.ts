import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { NeedsYouItem } from './dashboard.ts';
import { STAGES } from './projects.ts';
import { addDays, dueWithin, projectAttention, projectStageNames, stageSteps, taskStatusParts } from './overview.ts';
import { QUESTION_STATUS_MEANING, RISK_STATUS_MEANING, TASK_STATUS_MEANING, decisionMeaning } from './records.ts';

const NOW = new Date('2026-11-24T04:00:00Z'); // 12:00 UTC+8

test('the stage list comes from one place: the fixed five stages for now', () => {
  assert.deepEqual(projectStageNames(), STAGES);
});

test('stage steps mark earlier stages done, the current one with its days, later ones to come', () => {
  const steps = stageSteps(STAGES, { stage: 'Execution', startedAt: '2026-11-14T02:00:00Z' }, 'active', NOW);
  assert.deepEqual(steps.map((s) => s.state), ['done', 'done', 'current', 'todo', 'todo']);
  assert.equal(steps[2].days, 10);
  assert.equal(steps[0].days, undefined);
});

test('a stage started today counts 0 days; a draft without a stage has every stage to come', () => {
  assert.equal(stageSteps(STAGES, { stage: 'Initiation', startedAt: '2026-11-24T01:00:00Z' }, 'active', NOW)[0].days, 0);
  assert.ok(stageSteps(STAGES, null, 'draft', NOW).every((s) => s.state === 'todo'));
});

test('a closed project has every stage done; a stage not in the list is added as the current one', () => {
  assert.ok(stageSteps(STAGES, { stage: 'Closure', startedAt: '2026-11-01T00:00:00Z' }, 'closed', NOW).every((s) => s.state === 'done'));
  const odd = stageSteps(['A', 'B'], { stage: 'C', startedAt: '2026-11-24T00:00:00Z' }, 'active', NOW);
  assert.deepEqual(odd.map((s) => `${s.name}:${s.state}`), ['A:done', 'B:done', 'C:current']);
});

test('task status parts count each status, leave cancelled tasks out, and keep a fixed order', () => {
  const tasks = ['completed', 'completed', 'in_progress', 'blocked', 'not_started', 'cancelled'].map((status) => ({ status }));
  const parts = taskStatusParts(tasks);
  assert.deepEqual(parts.map((p) => [p.label, p.count, p.meaning]), [
    ['completed', 2, 'ok'],
    ['in progress', 1, 'dueSoon'],
    ['blocked', 1, 'blocked'],
    ['not started', 1, 'draft'],
  ]);
});

test('every record state has a meaning (symbol and word, never colour alone)', () => {
  assert.deepEqual(Object.keys(TASK_STATUS_MEANING).sort(), ['blocked', 'cancelled', 'completed', 'in_progress', 'not_started']);
  assert.deepEqual(Object.keys(QUESTION_STATUS_MEANING).sort(), ['answered', 'open', 'resolved', 'withdrawn']);
  assert.deepEqual(Object.keys(RISK_STATUS_MEANING).sort(), ['accepted', 'mitigating', 'open', 'resolved']);
  assert.equal(decisionMeaning('active'), 'active');
  assert.equal(decisionMeaning('superseded'), 'off');
  assert.equal(decisionMeaning('withdrawn'), 'off');
});

test('addDays moves a calendar day across month ends', () => {
  assert.equal(addDays('2026-11-24', 14), '2026-12-08');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
});

test('due within 14 days: unfinished tasks due from today to 14 days ahead, soonest first', () => {
  const t = (id: string, dueOn: string, status = 'not_started') => ({ id, title: id, dueOn, status });
  const tasks = [
    t('late', '2026-11-23'),
    t('today', '2026-11-24'),
    t('edge', '2026-12-08'),
    t('beyond', '2026-12-09'),
    t('done', '2026-11-25', 'completed'),
    t('gone', '2026-11-25', 'cancelled'),
    t('soon', '2026-11-26', 'blocked'),
  ];
  assert.deepEqual(dueWithin(tasks, '2026-11-24', 14).map((x) => x.id), ['today', 'soon', 'edge']);
});

test('the attention queue keeps only this project\'s items, in order', () => {
  const item = (projectId: string, label: string): NeedsYouItem => ({ kind: 'overdue', projectId, projectName: projectId, label, since: null, link: '#/' });
  const items = [item('p1', 'a'), item('p2', 'b'), item('p1', 'c')];
  assert.deepEqual(projectAttention(items, 'p1').map((i) => i.label), ['a', 'c']);
});
