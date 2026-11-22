import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OPS_BOUNDS, OPS_DEFAULTS, validateOpsSettings, type OpsSettings } from './settings';

const with_ = (over: object): string[] => validateOpsSettings({ ...OPS_DEFAULTS, ...over } as OpsSettings);

test('the defaults are 30, 80, 90, 5 and 30 and are valid', () => {
  assert.deepEqual(OPS_DEFAULTS, { backupRetentionDays: 30, storageWarningPct: 80, storageCriticalPct: 90, safeFloorGb: 5, diagnosticRetentionDays: 30 });
  assert.deepEqual(validateOpsSettings(OPS_DEFAULTS), []);
  assert.deepEqual(OPS_BOUNDS.backupRetentionDays, { min: 7, max: 365 });
  assert.deepEqual(OPS_BOUNDS.storageWarningPct, { min: 50, max: 95 });
  assert.deepEqual(OPS_BOUNDS.safeFloorGb, { min: 1, max: 1000 });
  assert.deepEqual(OPS_BOUNDS.diagnosticRetentionDays, { min: 7, max: 365 });
  assert.equal(OPS_BOUNDS.storageCriticalPct.max, 99);
});

test('values outside their bounds are refused', () => {
  const refused: object[] = [
    { backupRetentionDays: 6 }, { backupRetentionDays: 366 },
    { storageWarningPct: 49 }, { storageWarningPct: 96 },
    { storageCriticalPct: 80 }, { storageCriticalPct: 70 }, { storageCriticalPct: 100 },
    { safeFloorGb: 0 }, { safeFloorGb: 1001 },
    { diagnosticRetentionDays: 6 }, { diagnosticRetentionDays: 366 },
  ];
  for (const over of refused) assert.ok(with_(over).length > 0, JSON.stringify(over));
});

test('critical must be above warning', () => {
  assert.ok(with_({ storageWarningPct: 90, storageCriticalPct: 90 }).length > 0);
  assert.deepEqual(with_({ storageWarningPct: 90, storageCriticalPct: 91 }), []);
});

test('non-integers and non-numbers are refused', () => {
  for (const over of [{ backupRetentionDays: 30.5 }, { safeFloorGb: 2.5 }, { storageWarningPct: '80' }, { diagnosticRetentionDays: null }, { storageCriticalPct: NaN }]) {
    assert.ok(with_(over).length > 0, JSON.stringify(over));
  }
});

test('the bounds themselves are accepted', () => {
  for (const over of [
    { backupRetentionDays: 7 }, { backupRetentionDays: 365 },
    { storageWarningPct: 50 }, { storageWarningPct: 95, storageCriticalPct: 99 },
    { storageCriticalPct: 99 }, { safeFloorGb: 1 }, { safeFloorGb: 1000 },
    { diagnosticRetentionDays: 7 }, { diagnosticRetentionDays: 365 },
  ]) {
    assert.deepEqual(with_(over), [], JSON.stringify(over));
  }
});
