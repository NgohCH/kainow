import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SETTINGS_CATALOGUE, filterSettings, summaryCounts } from './settings.ts';

test('the catalogue has the 18 settings of spec 7.8, in order, with unique keys and addresses', () => {
  assert.equal(SETTINGS_CATALOGUE.length, 18);
  assert.equal(new Set(SETTINGS_CATALOGUE.map((s) => s.key)).size, 18);
  assert.equal(new Set(SETTINGS_CATALOGUE.map((s) => s.href)).size, 18);
  assert.deepEqual(SETTINGS_CATALOGUE.map((s) => s.title), [
    'Organisation', 'Administrators', 'Departments', 'Email domains', 'Leadership access',
    'Approvals', 'Reminders and email', 'Access and records', 'Resources and finance', 'Report types', 'Stage templates',
    'AI', 'Email delivery', 'Storage',
    'Operations', 'Go-live checklist', 'Escalated feedback', 'Security review',
  ]);
  assert.deepEqual(SETTINGS_CATALOGUE.filter((s) => s.reviewerOnly).map((s) => s.key), ['securityReview']);
  assert.equal(SETTINGS_CATALOGUE.find((s) => s.key === 'stageTemplates')?.href, '#/stage-templates');
});

test('filterSettings matches title and purpose, ignoring case', () => {
  assert.deepEqual(filterSettings(SETTINGS_CATALOGUE, 'remind').map((s) => s.title), ['Reminders and email']);
  assert.equal(filterSettings(SETTINGS_CATALOGUE, '  ').length, 18);
  assert.equal(filterSettings(SETTINGS_CATALOGUE, 'zzzz').length, 0);
});

test('summaryCounts counts unknown as off', () => {
  assert.deepEqual(summaryCounts([{ state: 'ok' }, { state: 'ok' }, { state: 'attention' }, { state: 'failing' }, { state: 'off' }, { state: 'unknown' }]), { ok: 2, attention: 1, failing: 1, off: 2 });
});
