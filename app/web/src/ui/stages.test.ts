import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stageFlowFrom, validateTemplateDraft } from './stages.ts';

const GENERAL = {
  name: 'General',
  stages: [
    { name: 'Initiation', substages: ['Define Purpose', 'Identify Participants'] },
    { name: 'Planning', substages: [] },
    { name: 'Closure', substages: ['Close Project'] },
  ],
};

test('a sound template has nothing to fix', () => {
  assert.deepEqual(validateTemplateDraft(GENERAL), []);
});

test('an empty or too long name is refused', () => {
  assert.equal(validateTemplateDraft({ ...GENERAL, name: '  ' }).length, 1);
  assert.match(validateTemplateDraft({ ...GENERAL, name: 'x'.repeat(81) })[0], /1 to 80/);
  assert.deepEqual(validateTemplateDraft({ ...GENERAL, name: 'x'.repeat(80) }), []);
});

test('a template needs a stage, and at most 20', () => {
  assert.match(validateTemplateDraft({ name: 'A', stages: [] })[0], /at least one stage/);
  const many = Array.from({ length: 21 }, (_, i) => ({ name: `S${i}`, substages: [] }));
  assert.match(validateTemplateDraft({ name: 'A', stages: many })[0], /at most 20 stages/);
  assert.deepEqual(validateTemplateDraft({ name: 'A', stages: many.slice(0, 20) }), []);
});

test('stage names must differ, ignoring case; so must substage names', () => {
  const dup = validateTemplateDraft({ name: 'A', stages: [{ name: 'Plan', substages: [] }, { name: ' plan ', substages: [] }] });
  assert.match(dup[0], /appears twice/);
  const sub = validateTemplateDraft({ name: 'A', stages: [{ name: 'Plan', substages: ['Scope', 'SCOPE'] }] });
  assert.match(sub[0], /repeats one/);
});

test('every stage and substage needs a name', () => {
  assert.match(validateTemplateDraft({ name: 'A', stages: [{ name: '', substages: [] }] })[0], /each stage a name/);
  assert.match(validateTemplateDraft({ name: 'A', stages: [{ name: 'P', substages: [''] }] })[0], /each substage a name/);
});

const NOW = new Date('2026-11-24T04:00:00Z'); // 12:00 UTC+8
const active = (...names: string[]) => names.map((name) => ({ name, status: 'active' as const }));
const period = (stage: string, startedAt: string, endedAt: string | null) => ({ stage, startedAt, endedAt });

test('a General project in Execution: two done, the current one with its days, two to do', () => {
  const flow = stageFlowFrom(
    active('Initiation', 'Planning', 'Execution', 'Review & Acceptance', 'Closure'),
    [period('Initiation', '2026-10-01T00:00:00Z', '2026-10-05T00:00:00Z'), period('Planning', '2026-10-05T00:00:00Z', '2026-11-14T02:00:00Z'), period('Execution', '2026-11-14T02:00:00Z', null)],
    NOW,
  );
  assert.deepEqual(flow.map((s) => s.state), ['done', 'done', 'current', 'todo', 'todo']);
  assert.equal(flow[2].days, 10);
  assert.equal(flow[0].days, undefined);
});

test('a Research project in Proposal uses its own stage names', () => {
  const flow = stageFlowFrom(active('Proposal', 'Fieldwork', 'Analysis', 'Report'), [period('Proposal', '2026-11-24T01:00:00Z', null)], NOW);
  assert.deepEqual(flow.map((s) => `${s.name}:${s.state}`), ['Proposal:current', 'Fieldwork:todo', 'Analysis:todo', 'Report:todo']);
  assert.equal(flow[0].days, 0);
});

test('retired stages are left out, except a retired current stage, which stays in its place', () => {
  const stages = [{ name: 'A', status: 'active' as const }, { name: 'B', status: 'retired' as const }, { name: 'C', status: 'active' as const }, { name: 'D', status: 'retired' as const }];
  const flow = stageFlowFrom(stages, [period('A', '2026-11-01T00:00:00Z', '2026-11-10T00:00:00Z'), period('B', '2026-11-10T00:00:00Z', null)], NOW);
  assert.deepEqual(flow.map((s) => `${s.name}:${s.state}`), ['A:done', 'B:current', 'C:todo']);
});

test('a current stage that is not in the list is appended; with no open period nothing is current', () => {
  const odd = stageFlowFrom(active('A', 'B'), [period('A', '2026-11-01T00:00:00Z', '2026-11-10T00:00:00Z'), period('Old', '2026-11-10T00:00:00Z', null)], NOW);
  assert.deepEqual(odd.map((s) => `${s.name}:${s.state}`), ['A:done', 'B:todo', 'Old:current']);
  assert.ok(stageFlowFrom(active('A', 'B'), [], NOW).every((s) => s.state === 'todo'));
});

test('a stage skipped on the way (no period) is still to do, not done', () => {
  const flow = stageFlowFrom(active('A', 'B', 'C'), [period('A', '2026-11-01T00:00:00Z', '2026-11-02T00:00:00Z'), period('C', '2026-11-02T00:00:00Z', null)], NOW);
  assert.deepEqual(flow.map((s) => s.state), ['done', 'todo', 'current']);
});
