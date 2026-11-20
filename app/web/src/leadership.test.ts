import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { LEADERSHIP_FIELDS, defaultPrefs } from './prefs.ts';
import {
  grantStateLabel,
  leadershipQuery,
  reasonProblem,
  scopeLabel,
  settingsProblem,
  visibleFields,
} from './leadership.ts';

test('state labels', () => {
  assert.equal(grantStateLabel('scheduled'), 'Scheduled');
  assert.equal(grantStateLabel('active'), 'Active');
  assert.equal(grantStateLabel('ended'), 'Ended');
  assert.equal(grantStateLabel('revoked'), 'Revoked');
});

test('scope label wording', () => {
  assert.equal(scopeLabel({ scopeKind: 'organisation', departments: [], projects: [] }), 'The whole organisation');
  const d = scopeLabel({ scopeKind: 'departments', departments: [{ id: '1', name: 'Dept A' }, { id: '2', name: 'Dept B' }], projects: [] });
  assert.match(d, /^Departments: Dept A, Dept B/);
  assert.ok(d.includes('includes projects this department owns now and later'));
  const p = scopeLabel({ scopeKind: 'projects', departments: [], projects: [{ id: '1', name: 'Project X' }] });
  assert.equal(p, 'Projects: Project X');
  assert.ok(!p.includes('owns now and later'));
});

test('required fields cannot be hidden', () => {
  const prefs = defaultPrefs();
  prefs.leadership.fields.hidden = ['name', 'attentionFlags', 'refresh', 'stage'];
  const keys = visibleFields(prefs, LEADERSHIP_FIELDS).map((f) => f.key);
  for (const k of ['name', 'attentionFlags', 'refresh']) assert.ok(keys.includes(k), k);
  assert.ok(!keys.includes('stage'));
});

test('visible fields follow the saved order and add catalogue fields missing from it', () => {
  const prefs = defaultPrefs();
  prefs.leadership.fields.order = ['refresh', 'name', 'bogus'];
  const keys = visibleFields(prefs, LEADERSHIP_FIELDS).map((f) => f.key);
  assert.deepEqual(keys.slice(0, 2), ['refresh', 'name']);
  assert.ok(!keys.includes('bogus'));
  assert.equal(keys.length, LEADERSHIP_FIELDS.length);
});

test('the web catalogue matches the server catalogue (keys, order, required flags)', () => {
  const src = readFileSync(new URL('../../src/leadership/leadership-fields.ts', import.meta.url), 'utf8');
  const server = [...src.matchAll(/\{\s*key:\s*'([A-Za-z]+)',\s*label:\s*'([^']*)'(,\s*required:\s*true)?\s*\}/g)].map((m) => ({
    key: m[1],
    label: m[2],
    required: m[3] !== undefined,
  }));
  assert.equal(server.length, 17);
  assert.deepEqual(
    LEADERSHIP_FIELDS.map((f) => ({ key: f.key, label: f.label, required: f.required === true })),
    server,
  );
});

test('reason must be 1 to 1,000 characters after trim', () => {
  assert.notEqual(reasonProblem('   '), null);
  assert.equal(reasonProblem(' ok '), null);
  assert.equal(reasonProblem('a'.repeat(1000)), null);
  assert.notEqual(reasonProblem('a'.repeat(1001)), null);
});

test('settings problem: bounds and default above maximum', () => {
  const bounds = { archiveAfterMonths: { min: 1, max: 60 }, grantDefaultDays: { min: 1, max: 90 }, grantMaxDays: { min: 1, max: 365 }, invitationValidDays: { min: 1, max: 30 } };
  const ok = { archiveAfterMonths: 12, grantDefaultDays: 30, grantMaxDays: 90, invitationValidDays: 7, analyticsExportAllowed: true };
  assert.equal(settingsProblem(ok, bounds), null);
  assert.match(settingsProblem({ ...ok, archiveAfterMonths: 61 }, bounds) ?? '', /1.60/);
  assert.match(settingsProblem({ ...ok, invitationValidDays: 1.5 }, bounds) ?? '', /whole number/);
  assert.match(settingsProblem({ ...ok, grantDefaultDays: 60, grantMaxDays: 45 }, bounds) ?? '', /cannot be longer/);
});

test('leadership query keeps the default statuses off the wire', () => {
  assert.equal(leadershipQuery({ statuses: ['planned', 'active', 'deferred'], department: '', includeArchived: false }), '');
  assert.equal(leadershipQuery({ statuses: ['active', 'closed'], department: 'd1', includeArchived: true }), '?status=active%2Cclosed&department=d1&includeArchived=1');
});
