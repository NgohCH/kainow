import assert from 'node:assert/strict';
import { test } from 'node:test';
import { levelFor } from './levels';
import { OPS_DEFAULTS } from './settings';

test('levelFor follows the warning and critical levels', () => {
  assert.equal(levelFor(79.99, OPS_DEFAULTS), 'normal');
  assert.equal(levelFor(80, OPS_DEFAULTS), 'warning');
  assert.equal(levelFor(89.99, OPS_DEFAULTS), 'warning');
  assert.equal(levelFor(90, OPS_DEFAULTS), 'critical');
  assert.equal(levelFor(null, OPS_DEFAULTS), 'unknown');
  assert.equal(levelFor(60, { ...OPS_DEFAULTS, storageWarningPct: 60, storageCriticalPct: 70 }), 'warning');
});
