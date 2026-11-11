import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  explanationSentence,
  historyLine,
  inheritanceLines,
  NOT_DELEGATED,
  NOT_EDITOR,
  organisationChange,
  orgDraftFrom,
  projectChange,
  projectDraftFrom,
  projectReadOnlyMessage,
  QUIET_MESSAGE,
  quietError,
  type OrgAnalysisView,
  type ProjectAnalysisView,
} from './analysisSettings.ts';

const org: OrgAnalysisView = { automatic: true, quietMinutes: 5, projectsMayChange: false, history: [] };
const proj = (over: Partial<ProjectAnalysisView> = {}): ProjectAnalysisView => ({
  automatic: true,
  quietMinutes: 5,
  projectsMayChange: true,
  source: { automatic: 'organisation', quietMinutes: 'organisation' },
  own: { automatic: null, quietMinutes: null },
  canEdit: true,
  history: [],
  ...over,
});

test('settings show effective value and inheritance and refuse 4 and 31 before sending', () => {
  const v = proj({ quietMinutes: 12, source: { automatic: 'organisation', quietMinutes: 'project' }, own: { automatic: null, quietMinutes: 12 } });
  assert.deepEqual(inheritanceLines(v), { automatic: 'From the organisation', quietMinutes: 'Set for this project' });
  assert.equal(
    explanationSentence(v),
    'Automatic analysis: after 12 minutes without new messages; maximum 2 analyses per thread in any rolling 20 minutes.',
  );
  assert.equal(explanationSentence({ automatic: false, quietMinutes: 12 }), 'Automatic analysis is off for this project.');
  for (const bad of ['4', '31', '', '5.5', 'abc', '-5']) assert.equal(quietError(bad), QUIET_MESSAGE, bad);
  for (const good of ['5', '30', ' 17 ']) assert.equal(quietError(good), null, good);
  // A refused value is never part of the change that would be sent.
  assert.equal(organisationChange(org, { ...orgDraftFrom(org), quietText: '4' }, 'why'), null);
  assert.equal(organisationChange(org, { ...orgDraftFrom(org), quietText: '31' }, 'why'), null);
  assert.deepEqual(organisationChange(org, { ...orgDraftFrom(org), quietText: '10', automatic: false }, ' why '), { automatic: false, quietMinutes: 10, reason: 'why' });
  assert.deepEqual(organisationChange(org, { ...orgDraftFrom(org), projectsMayChange: true }, 'why'), { projectsMayChange: true, reason: 'why' });
  assert.equal(organisationChange(org, orgDraftFrom(org), 'why'), null);
  // A project can set a value or hand it back (null).
  assert.deepEqual(projectChange(proj(), { ...projectDraftFrom(proj()), quietText: '20' }, 'r'), { quietMinutes: 20, reason: 'r' });
  assert.deepEqual(projectChange(v, { ...projectDraftFrom(v), quietBack: true }, 'r'), { quietMinutes: null, reason: 'r' });
  assert.equal(projectChange(proj(), { ...projectDraftFrom(proj()), quietBack: true }, 'r'), null);
  assert.deepEqual(historyLine({ id: '1', field: 'quiet_minutes', oldValue: '5', newValue: null, reason: 'back', actor: 'Ada Member', at: '' }), {
    who: 'Ada Member',
    what: 'changed quiet period from 5 minutes to the organisation’s value',
    reason: 'back',
  });
});

test('project settings read-only with the delegation message', () => {
  assert.equal(projectReadOnlyMessage(proj({ canEdit: false, projectsMayChange: false })), NOT_DELEGATED);
  assert.equal(projectReadOnlyMessage(proj({ canEdit: false, projectsMayChange: true })), NOT_EDITOR);
  assert.equal(projectReadOnlyMessage(proj()), null);
  assert.equal(NOT_DELEGATED, 'The Administrator has not allowed projects to change automatic analysis.');
});
