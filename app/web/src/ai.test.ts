import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  KEY_INPUT,
  STATE_LABELS,
  aiTabPath,
  amountLabel,
  addBody,
  afterKeySubmit,
  blockedText,
  connectionBadge,
  emptyAddForm,
  formatMyr,
  includesUncertain,
  limitsBody,
  limitsDraft,
  meterText,
  modelBody,
  modelDraft,
  modelRows,
  moveId,
  nearestLimit,
  orgBody,
  orgDraft,
  projectIdFromHash,
  replaceBody,
  sourceText,
  usableMeter,
  type DisplayState,
} from './ai.ts';
import { runFailureText } from './quarantine.ts';

test('every connection state maps to its exact label', () => {
  const expected: Record<DisplayState, string> = {
    ready: 'Ready',
    unchecked: 'Unchecked',
    key_rejected: 'Key rejected',
    disabled: 'Disabled',
    model_withdrawn: 'Model withdrawn',
    waiting_for_key: 'Waiting for the protected key',
    key_unreadable: 'Key unreadable — enter it again',
  };
  for (const [state, label] of Object.entries(expected)) assert.equal(connectionBadge(state as DisplayState), label);
  assert.deepEqual(STATE_LABELS, expected);
});

test('amounts are labelled Confirmed, Uncertain or Reserved', () => {
  assert.equal(amountLabel('confirmed'), 'Confirmed');
  assert.equal(amountLabel('uncertain'), 'Uncertain');
  assert.equal(amountLabel('reserved'), 'Reserved');
});

test('the project readiness codes are worded', () => {
  assert.equal(blockedText('ai_not_set_up'), 'Blocked — AI is not set up for this project');
  assert.equal(blockedText('protected_key_missing'), 'Blocked — the protected key is not installed, so no AI key can be opened');
  assert.equal(blockedText('project_no_allowance'), 'Blocked — this project has no AI allowance');
  assert.equal(blockedText('project_allowance_used'), 'Blocked — no AI allowance is left for this project');
  assert.match(blockedText('no_eligible_connection'), /^Blocked — no AI connection in this project can be used/);
});

test('every spend_project_* code has wording that names the project level', () => {
  const codes = [
    'spend_project_not_configured',
    'spend_project_no_allowance',
    'spend_project_cap_would_be_exceeded',
    'spend_project_daily_no_allowance',
    'spend_project_daily_cap_would_be_exceeded',
    'spend_project_user_no_allowance',
    'spend_project_user_cap_would_be_exceeded',
  ];
  for (const c of codes) {
    const t = blockedText(c);
    assert.match(t, /^Blocked — /, c);
    assert.match(t, /project/i, c);
  }
  assert.match(blockedText('spend_project_daily_no_allowance'), /daily/);
  assert.match(blockedText('spend_project_user_cap_would_be_exceeded'), /your personal/);
});

test('organisation spend codes keep their wording and an unknown code stays plain', () => {
  assert.equal(blockedText('spend_no_allowance'), 'Blocked — there is no AI allowance');
  assert.equal(blockedText('something_new'), 'Blocked — AI could not run this request');
  assert.equal(blockedText(null), 'Blocked — AI could not run this request');
});

test('a blocked extraction run is worded from its code; other codes keep the server detail', () => {
  assert.equal(runFailureText('ai_not_set_up', 'AI is not set up for this project.'), 'Blocked — AI is not set up for this project');
  assert.equal(
    runFailureText('no_eligible_connection', 'No AI connection in this project is approved for extraction with restricted material and usable now.'),
    'Blocked — no AI connection approved for restricted material',
  );
  assert.equal(runFailureText('model_rejected', 'The AI service refused.'), 'The AI service refused.');
});

test('the key field is a password field that is not remembered', () => {
  assert.equal(KEY_INPUT.type, 'password');
  assert.equal(KEY_INPUT.autoComplete, 'off');
});

test('the key is cleared as the form is submitted, and nothing else is lost', () => {
  const key = `sk-test-${'x'.repeat(40)}`;
  const form = { ...emptyAddForm(), modelRef: 'm1', label: 'Primary', reason: 'First connection', apiKey: key };
  const body = addBody(form);
  assert.equal(body.apiKey, key);
  const after = afterKeySubmit(form);
  assert.equal(after.apiKey, '');
  assert.equal(after.label, 'Primary');
  assert.equal(JSON.stringify(after).includes(key), false);
  assert.deepEqual(replaceBody({ apiKey: ` ${key} `, reason: ' New key ' }), { apiKey: key, reason: 'New key' });
});

test('moving a connection up or down gives the whole order, and stops at the ends', () => {
  assert.deepEqual(moveId(['a', 'b', 'c'], 'b', 'up'), ['b', 'a', 'c']);
  assert.deepEqual(moveId(['a', 'b', 'c'], 'b', 'down'), ['a', 'c', 'b']);
  assert.equal(moveId(['a', 'b', 'c'], 'a', 'up'), null);
  assert.equal(moveId(['a', 'b', 'c'], 'c', 'down'), null);
  assert.equal(moveId(['a', 'b'], 'z', 'down'), null);
});

test('limits: blank is sent as null (no allowance), a blank attempts box is the organisation value', () => {
  const view = {
    project: { saved: false, monthlyLimitMyr: null, daily: { mode: 'not_applied' as const }, userMonthly: { mode: 'not_applied' as const }, maxAttempts: null, timeoutSeconds: null },
    organisation: { maxAttempts: 3, timeoutSeconds: 120, concurrency: 2, projectsMaySetLimits: true, projectsMayManageConnections: false },
    ceiling: { mode: 'limit' as const, limitMyr: '500.000000' },
    editable: true,
    sources: { maxAttempts: 'organisation' as const, timeoutSeconds: 'organisation' as const },
  };
  const d = limitsDraft(view);
  assert.equal(d.monthly, '');
  assert.deepEqual(limitsBody({ ...d, reason: ' Start ' }), {
    monthlyLimitMyr: null,
    daily: { mode: 'not_applied' },
    userMonthly: { mode: 'not_applied' },
    maxAttempts: null,
    timeoutSeconds: null,
    reason: 'Start',
  });
  const filled = limitsBody({ ...d, monthly: '120.5', dailyMode: 'limit', daily: '', userMode: 'limit', user: '10', attempts: '2', timeout: '60', reason: 'Set' });
  assert.equal(filled.monthlyLimitMyr, '120.5');
  assert.deepEqual(filled.daily, { mode: 'limit', limitMyr: null });
  assert.deepEqual(filled.userMonthly, { mode: 'limit', limitMyr: '10' });
  assert.equal(filled.maxAttempts, 2);
  assert.equal(filled.timeoutSeconds, 60);
});

test('organisation settings round trip with the new fields', () => {
  const settings = {
    myrPerUsd: '4.500000',
    monthlyLimitMyr: '1000.000000',
    daily: { mode: 'limit' as const, limitMyr: '50.000000' },
    userMonthly: { mode: 'not_applied' as const },
    projectsMaySetLimits: true,
    projectsMayManageConnections: false,
    projectCeiling: { mode: 'limit' as const, limitMyr: '300.000000' },
    maxAttempts: 3,
    timeoutSeconds: 120,
    concurrency: 2,
  };
  const d = orgDraft(settings);
  assert.equal(d.rate, '4.5');
  assert.equal(d.ceilingMode, 'limit');
  assert.equal(d.ceiling, '300');
  assert.equal(d.reason, '', 'the reason box starts empty');
  assert.deepEqual(orgBody({ ...d, reason: ' New quarter ' }), {
    myrPerUsd: '4.5',
    monthlyLimitMyr: '1000',
    daily: { mode: 'limit', limitMyr: '50' },
    userMonthly: { mode: 'not_applied' },
    projectsMaySetLimits: true,
    projectsMayManageConnections: false,
    projectCeiling: { mode: 'limit', limitMyr: '300' },
    maxAttempts: 3,
    timeoutSeconds: 120,
    concurrency: 2,
    reason: 'New quarter',
  });
});

test('a model form carries every field the server needs', () => {
  const blank = modelDraft(null);
  assert.equal(blank.provider, 'openai');
  assert.equal(blank.restrictedOk, false);
  const body = modelBody({ ...blank, modelId: ' gpt-x ', displayName: 'Model X', input: '1', cached: '0.5', cacheWrite: '', output: '4', dataTerms: 'Kept 30 days, no training', purposes: ['extraction'], reason: 'Approved by review' });
  assert.equal(body.modelId, 'gpt-x');
  assert.equal(body.cacheWriteUsdPerMillion, '0');
  assert.deepEqual(body.purposes, ['extraction']);
  assert.equal(body.restrictedOk, false);
});

test('the header meter words the project figure and the personal figure', () => {
  const base = { start: 's', end: 'e', usedMyr: '1', reservedMyr: '0', uncertainMyr: '0' };
  assert.equal(meterText({ kind: 'project', ...base, limitMyr: '10.000000', remainingMyr: '9.000000' }), 'This project’s AI allowance left this month: MYR 9.00 of MYR 10.00');
  assert.equal(meterText({ kind: 'personal', ...base, limitMyr: '5.000000', remainingMyr: '4.500000' }), 'Your AI allowance left in this project this month: MYR 4.50 of MYR 5.00');
  assert.equal(meterText({ kind: 'project', ...base, limitMyr: null, remainingMyr: '0.000000' }), 'This project has no AI allowance this month');
});

test('a meter without figures is not shown', () => {
  assert.equal(usableMeter({ kind: 'project' } as never), false);
  assert.equal(usableMeter(null), false);
  assert.equal(usableMeter({ kind: 'project', limitMyr: null, usedMyr: '0', remainingMyr: '0' }), true);
});

test('money is shown to two places, or more when the amount is smaller', () => {
  assert.equal(formatMyr('1.500000'), 'MYR 1.50');
  assert.equal(formatMyr('0.003200'), 'MYR 0.0032');
  assert.equal(formatMyr('0.000000'), 'MYR 0.00');
});

test('totals say how much of them is uncertain', () => {
  assert.equal(includesUncertain({ uncertainMyr: '0.200000' }), 'includes MYR 0.20 uncertain');
  assert.equal(includesUncertain({ uncertainMyr: '0.000000' }), '');
});

test('sources are plain words, the tab path matches the notice link, the project is read from the address', () => {
  assert.equal(sourceText('organisation'), 'the organisation’s value');
  assert.equal(sourceText('project'), 'this project’s own value');
  const id = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
  assert.equal(aiTabPath(id), `#/projects/${id}/ai`);
  assert.equal(projectIdFromHash(`#/projects/${id}/work`), id);
  assert.equal(projectIdFromHash('#/people'), null);
});

const model = (id: string, modelId: string, state: 'approved' | 'withdrawn') => ({
  id, provider: 'openai' as const, modelId, displayName: `Name ${modelId}`, state, purposes: ['extraction' as const], restrictedOk: false, dataTerms: '',
  prices: { inputUsdPerMillion: '1', cachedInputUsdPerMillion: '1', cacheWriteUsdPerMillion: '0', outputUsdPerMillion: '1' },
});
const conn = (projectName: string, modelId: string, usedMyr: string) => ({ projectName, projectId: projectName, modelId, provider: 'openai', usedMyr }) as never;

test('models in use list approved models, the projects whose connections used them, and what they cost this month', () => {
  const usage = { byConnection: [conn('Alpha', 'm1', '1.5'), conn('Beta', 'm1', '2.25'), conn('Alpha', 'm1', '1'), conn('Alpha', 'unknown', '3')] } as never;
  const rows = modelRows([model('1', 'm1', 'approved'), model('2', 'm2', 'approved'), model('3', 'm3', 'withdrawn')], usage);
  assert.deepEqual(rows.map((r) => [r.modelId, r.state, r.projects, r.month]), [
    ['m1', 'approved', ['Alpha', 'Beta'], 4.75],
    ['m2', 'approved', [], 0],
    ['unknown', 'unlisted', ['Alpha'], 3],
  ]);
  assert.equal(rows[0].name, 'Name m1');
  assert.equal(modelRows([], null).length, 0);
});

test('projects nearest their limit come first; a project with no limit saved comes last', () => {
  const sorted = nearestLimit([
    { projectId: 'a', name: 'A', used: 5, limit: null },
    { projectId: 'b', name: 'B', used: 2, limit: 10 },
    { projectId: 'c', name: 'C', used: 9, limit: 10 },
    { projectId: 'd', name: 'D', used: 1, limit: 0 },
  ]);
  assert.deepEqual(sorted.map((r) => r.projectId), ['c', 'b', 'a', 'd']);
});

test('connection states map to meanings: only Ready is calm', async () => {
  const { connectionMeaning } = await import('./ai.ts');
  assert.equal(connectionMeaning('ready'), 'ok');
  assert.equal(connectionMeaning('unchecked'), 'off');
  assert.equal(connectionMeaning('disabled'), 'off');
  assert.equal(connectionMeaning('key_rejected'), 'failing');
  assert.equal(connectionMeaning('waiting_for_key'), 'failing');
});
