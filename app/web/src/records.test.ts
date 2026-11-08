import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QUESTION_STATUS_LABEL, RISK_STATUS_LABEL, SEVERITY_LABEL, TASK_STATUS_LABEL, defaultDueOn, likelyAssignee, splitNames } from './records.ts';

test('record states and severities read as words', () => {
  assert.deepEqual(Object.values(TASK_STATUS_LABEL), ['Not Started', 'In Progress', 'Blocked', 'Completed', 'Cancelled']);
  assert.deepEqual(Object.values(QUESTION_STATUS_LABEL), ['Open', 'Answered', 'Resolved', 'Withdrawn']);
  assert.deepEqual(Object.values(RISK_STATUS_LABEL), ['Open', 'Mitigating', 'Resolved', 'Accepted']);
  assert.deepEqual(Object.values(SEVERITY_LABEL), ['Low', 'Medium', 'High', 'Critical']);
});

test('a written name suggests one person, or nobody when unsure', () => {
  const people = [
    { userId: 'a', displayName: 'Su Ling Tan', email: 'suling.tan@help.edu.my' },
    { userId: 'b', displayName: 'Daniel Wong', email: 'daniel@help.edu.my' },
    { userId: 'c', displayName: 'Daniel Lee', email: 'jlee@help.edu.my' },
  ];
  assert.equal(likelyAssignee('Ms Su Ling', people), 'a');
  assert.equal(likelyAssignee('Mr Daniel', people), null, 'two people called Daniel');
  assert.equal(likelyAssignee('Puan Nora', people), null);
  assert.equal(likelyAssignee(null, people), null);
});

test('several people named in one owner are split', () => {
  assert.deepEqual(splitNames('Puan Aminah and Puan Zarina Hassan; Mr Daniel for overall coordination'), [
    'Puan Aminah',
    'Puan Zarina Hassan',
    'Mr Daniel for overall coordination',
  ]);
  assert.deepEqual(splitNames('Ann, Ben & Chen (EMS team)'), ['Ann', 'Ben', 'Chen']);
  assert.deepEqual(splitNames(null), []);
  assert.deepEqual(splitNames('Ann'), ['Ann']);
});

test('the due reading fills the date when it is a day or a range', () => {
  const base = { reason: null, note: null, event: null };
  assert.equal(defaultDueOn({ ...base, state: 'exact', earliest: '2026-11-20', latest: '2026-11-20' }), '2026-11-20');
  assert.equal(defaultDueOn({ ...base, state: 'range', earliest: '2026-11-18', latest: '2026-11-20' }), '2026-11-20');
  assert.equal(defaultDueOn({ ...base, state: 'event', earliest: null, latest: null, event: 'after the audit' }), null);
  assert.equal(defaultDueOn({ ...base, state: 'needs_date', earliest: null, latest: null }), null);
});
