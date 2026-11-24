import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  SETTING_KEYS, aiRule, approvalsRule, emailDeliveryRule, escalatedFeedbackRule, goLiveRule, leadershipRule, operationsRule,
  securityReviewRule, settle, stageTemplatesRule, storageRule,
} from './rules';

describe('settings summary rules', () => {
  test('AI lists approved models as "<model id> (<Provider>)" and names the fallback', () => {
    const s = aiRule({ models: [{ modelId: 'gpt-test-1', provider: 'openai' }, { modelId: 'claude-test-1', provider: 'anthropic' }] });
    assert.equal(s.state, 'ok');
    assert.equal(s.values[0].value, 'gpt-test-1 (OpenAI), claude-test-1 (Anthropic)');
    assert.equal(s.values[1].label, 'Fallback');
    assert.equal(aiRule({ models: [] }).state, 'attention');
    const many = aiRule({ models: ['a', 'b', 'c'].map((m) => ({ modelId: m, provider: 'openai' })) });
    assert.match(many.values[0].value, /and 1 more$/);
  });

  test('email delivery is failing when any email failed in the last 24 hours', () => {
    assert.equal(emailDeliveryRule({ provider: 'm365', failedLast24h: 1, waiting: 0 }).state, 'failing');
    assert.equal(emailDeliveryRule({ provider: 'm365', failedLast24h: 0, waiting: 2 }).state, 'ok');
  });

  test('leadership access needs attention when requests wait', () => {
    assert.equal(leadershipRule({ active: 2, scheduled: 0, waitingForAction: 1 }).state, 'attention');
    assert.equal(leadershipRule({ active: 2, scheduled: 0, waitingForAction: 0 }).state, 'ok');
  });

  test('storage is off when no destination is approved', () => {
    const base = { connection: 'not_configured' as const, failedFiles: 0, sharingToRepair: 0 };
    assert.equal(storageRule({ ...base, approvedDestinations: 0 }).state, 'off');
    assert.equal(storageRule({ ...base, approvedDestinations: 1, connection: 'connected' }).state, 'ok');
    assert.equal(storageRule({ ...base, approvedDestinations: 1, connection: 'unreachable' }).state, 'failing');
    assert.equal(storageRule({ ...base, approvedDestinations: 1, connection: 'connected', failedFiles: 2 }).state, 'attention');
  });

  test('operations takes the Operations page status', () => {
    const ok = { backupStatus: 'healthy', worstStorageLevel: 'normal', protectiveOn: false, lastDrill: 'passed' } as const;
    assert.equal(operationsRule(ok).state, 'ok');
    assert.equal(operationsRule({ ...ok, protectiveOn: true }).state, 'failing');
    assert.equal(operationsRule({ ...ok, backupStatus: 'last_failed' }).state, 'failing');
    assert.equal(operationsRule({ ...ok, worstStorageLevel: 'critical' }).state, 'failing');
    assert.equal(operationsRule({ ...ok, backupStatus: 'none' }).state, 'attention');
    assert.equal(operationsRule({ ...ok, worstStorageLevel: 'warning' }).state, 'attention');
    assert.equal(operationsRule({ ...ok, lastDrill: 'failed' }).state, 'attention');
  });

  test('escalated feedback needs attention when any is open; go-live is ok when closed', () => {
    assert.equal(escalatedFeedbackRule({ open: 1 }).state, 'attention');
    assert.equal(escalatedFeedbackRule({ open: 0 }).state, 'ok');
    assert.equal(goLiveRule({ open: false, done: 9, total: 9 }).state, 'ok');
    assert.equal(goLiveRule({ open: true, done: 3, total: 9 }).state, 'attention');
  });

  test('security review needs attention when cases wait for the key', () => {
    assert.equal(securityReviewRule({ heldCases: 2, waitingForKey: 1 }).state, 'attention');
    assert.equal(securityReviewRule({ heldCases: 2, waitingForKey: 0 }).state, 'ok');
  });

  test('stage templates show the active count and up to three names', () => {
    const s = stageTemplatesRule({ activeNames: ['General', 'Software development', 'Product sales', 'Research project'], retired: 1 });
    assert.equal(s.state, 'ok');
    assert.deepEqual(s.values, [
      { label: 'Active', value: '4' },
      { label: 'Templates', value: 'General, Software development, Product sales and 1 more' },
      { label: 'Retired', value: '1' },
    ]);
    assert.deepEqual(stageTemplatesRule({ activeNames: ['General'], retired: 0 }).values, [
      { label: 'Active', value: '1' },
      { label: 'Templates', value: 'General' },
      { label: 'Retired', value: '0' },
    ]);
    assert.equal(stageTemplatesRule({ activeNames: ['A', 'B', 'C'], retired: 0 }).values[1].value, 'A, B, C');
  });

  test('a box never has more than three values', () => {
    const s = approvalsRule({ required: 2, projectsMayOverride: true, pending: 0 });
    assert.ok(s.values.length <= 3);
    assert.equal(SETTING_KEYS.length, 18);
    assert.equal(new Set(SETTING_KEYS).size, 18);
  });

  test('summary marks a failed read as unknown', async () => {
    const s = await settle('storage', async () => {
      throw new Error('connection refused to secret-host:5432');
    });
    assert.equal(s.key, 'storage');
    assert.equal(s.state, 'unknown');
    assert.equal(s.stateWord, 'Could not check');
    assert.ok(s.note && !s.note.includes('secret-host'));
    assert.deepEqual(s.values, []);
  });
});
