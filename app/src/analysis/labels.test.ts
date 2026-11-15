import assert from 'node:assert/strict';
import { test } from 'node:test';
import { triggerLabel, triggerLabelSql } from './labels';

test('automatic triggers have fixed labels and people are named', () => {
  assert.equal(triggerLabel('quiet_period', null), 'Automatic: quiet period');
  assert.equal(triggerLabel('meeting_end', null), 'Automatic: meeting ended');
  assert.equal(triggerLabel('minutes_published', null), 'Automatic: minutes published');
  assert.equal(triggerLabel('button', 'Ada Member'), 'Ada Member');
  assert.equal(triggerLabel('selection', 'Ada Member'), 'Ada Member');
  assert.equal(triggerLabel(null, null), null);
  assert.match(triggerLabelSql('x.trigger', 'n.name'), /WHEN 'meeting_end' THEN 'Automatic: meeting ended'/);
});
