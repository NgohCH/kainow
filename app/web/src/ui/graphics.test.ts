import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stackedBarLegend, stackedBarText, stageFlowText } from './graphics.ts';

test('stage flow text names the current stage, its days and the done stages', () => {
  const s = (name: string, state: 'done' | 'current' | 'todo', days?: number) => ({ name, state, days });
  const stages = [s('Initiation', 'done'), s('Design', 'done'), s('Build', 'current', 34), s('Test', 'todo'), s('Close', 'todo')];
  assert.equal(stageFlowText(stages), 'Stage 3 of 5: Build, 34 days. Done: Initiation, Design.');
  assert.equal(stageFlowText([s('Plan', 'current', 1)]), 'Stage 1 of 1: Plan, 1 day.');
  assert.equal(stageFlowText([s('Plan', 'todo')]), 'No stage is under way.');
  assert.equal(stageFlowText([]), 'No stages.');
});
test('stacked bar legend omits zero counts and rounds percentages to whole numbers', () => {
  const parts = [{ meaning: 'active' as const, label: 'Done', count: 5 }, { meaning: 'off' as const, label: 'Cancelled', count: 0 }, { meaning: 'blocked' as const, label: 'Open', count: 7 }];
  const l = stackedBarLegend(parts);
  assert.deepEqual(l.map((p) => [p.label, p.percent]), [['Done', 42], ['Open', 58]]);
  assert.equal(stackedBarText(parts), '12 in all: 5 Done (42%), 7 Open (58%).');
  assert.equal(stackedBarText([{ meaning: 'off', label: 'Open', count: 0 }]), 'None.');
});
