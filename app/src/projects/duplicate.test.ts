import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { type DuplicateChoices, duplicateProblems, findTerms, unconfirmedTerms } from './duplicate';

const NAME = "Give the new project a name different from the original's.";
const END = 'Give a planned end date or choose "No planned end".';
const PURPOSE = 'Change the purpose or confirm it is still correct.';

const choices = (over: Partial<DuplicateChoices> = {}): DuplicateChoices => ({
  original: { name: 'Site survey 2026', purpose: 'Survey the dummy site', plannedEnd: '2026-12-31' },
  name: 'Site survey 2027',
  plannedEnd: '2027-12-31',
  noPlannedEnd: false,
  purpose: 'Survey the second site',
  purposeConfirmed: false,
  texts: [],
  oldTerms: [],
  confirmedKeys: [],
  counts: { tasks: 0, risks: 0, resources: 0 },
  ...over,
});

describe('finding old terms', () => {
  const texts = [
    { key: 'a', text: 'Invite DUMMY  customer to the 2026 review' },
    { key: 'b', text: 'Nothing of it here' },
    { key: 'c', text: 'Café plan' },
  ];

  test('ignores case, runs of white space and how an accent is written', () => {
    assert.deepEqual(findTerms(texts, ['Dummy Customer', '2026', 'CAFÉ']), [
      { key: 'a', term: 'Dummy Customer' },
      { key: 'a', term: '2026' },
      { key: 'c', term: 'CAFÉ' },
    ]);
  });

  test('an empty term finds nothing', () => assert.deepEqual(findTerms(texts, ['', '  ']), []));

  test('a confirmed text is left out, with all its terms', () => {
    assert.deepEqual(unconfirmedTerms(texts, ['dummy customer', '2026', 'café'], ['a']), [{ key: 'c', term: 'café' }]);
  });
});

describe('what must be decided', () => {
  test('nothing is left when all is decided', () => assert.deepEqual(duplicateProblems(choices()), []));

  test('the name must differ, ignoring case and spaces', () => {
    assert.deepEqual(duplicateProblems(choices({ name: '  SITE survey 2026 ' })), [NAME]);
  });

  test('the planned end must differ or be left out on purpose', () => {
    assert.deepEqual(duplicateProblems(choices({ plannedEnd: '2026-12-31' })), ["Give a planned end date different from the original's."]);
    assert.deepEqual(duplicateProblems(choices({ plannedEnd: null })), [END]);
    assert.deepEqual(duplicateProblems(choices({ plannedEnd: null, noPlannedEnd: true })), []);
    assert.deepEqual(duplicateProblems(choices({ noPlannedEnd: true })), ['Give a planned end date or choose "No planned end", not both.']);
    const open = { name: 'Site survey 2026', purpose: 'Survey the dummy site', plannedEnd: null };
    assert.deepEqual(duplicateProblems(choices({ original: open, plannedEnd: null })), [END], 'also when the original had none');
    assert.deepEqual(duplicateProblems(choices({ original: open, plannedEnd: null, noPlannedEnd: true })), []);
  });

  test('the purpose must be changed or confirmed', () => {
    assert.deepEqual(duplicateProblems(choices({ purpose: ' Survey the dummy site ' })), [PURPOSE]);
    assert.deepEqual(duplicateProblems(choices({ purpose: 'Survey the dummy site', purposeConfirmed: true })), []);
  });

  test('texts still holding an old term', () => {
    const texts = [{ key: 'a', text: 'Plan 2026' }, { key: 'b', text: 'Close 2026' }];
    assert.deepEqual(duplicateProblems(choices({ texts, oldTerms: ['2026'] })), ['2 texts still hold an old term. Change each one or confirm it is still correct.']);
    assert.deepEqual(duplicateProblems(choices({ texts, oldTerms: ['2026'], confirmedKeys: ['a'] })), ['1 text still holds an old term. Change it or confirm it is still correct.']);
    assert.deepEqual(duplicateProblems(choices({ texts, oldTerms: ['2026'], confirmedKeys: ['a', 'b'] })), []);
  });

  test('all that is missing is said together', () => {
    assert.deepEqual(duplicateProblems(choices({ name: 'Site survey 2026', plannedEnd: null, purpose: 'Survey the dummy site' })), [NAME, END, PURPOSE]);
  });

  test('limits, with the counts, and nothing else', () => {
    assert.deepEqual(duplicateProblems(choices({ counts: { tasks: 500, risks: 200, resources: 200 } })), []);
    assert.deepEqual(duplicateProblems(choices({ name: 'Site survey 2026', counts: { tasks: 1501, risks: 201, resources: 202 } })), [
      'You chose 1,501 tasks and subtasks; at most 500 can be copied at once.',
      'You chose 201 risks; at most 200 can be copied at once.',
      'You chose 202 resource lines; at most 200 can be copied at once.',
    ]);
  });
});
