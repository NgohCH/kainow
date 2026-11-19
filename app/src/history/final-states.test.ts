import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deletionRefusal } from './final-states';

test('cancelled and completed tasks are deletable, in-progress is not', () => {
  assert.equal(deletionRefusal('task', { status: 'cancelled' }), null);
  assert.equal(deletionRefusal('task', { status: 'completed' }), null);
  for (const status of ['not_started', 'in_progress', 'blocked']) {
    assert.equal(deletionRefusal('task', { status }), 'Cancel this task before deleting it.');
  }
});

test('accepted risk needs no further review', () => {
  assert.equal(deletionRefusal('risk', { status: 'resolved' }), null);
  assert.equal(deletionRefusal('risk', { status: 'accepted', noFurtherReview: true }), null);
  const refusal = 'Resolve this risk, or accept it with no further review, before deleting it.';
  assert.equal(deletionRefusal('risk', { status: 'accepted', noFurtherReview: false }), refusal);
  assert.equal(deletionRefusal('risk', { status: 'accepted' }), refusal);
  assert.equal(deletionRefusal('risk', { status: 'open' }), refusal);
  assert.equal(deletionRefusal('risk', { status: 'mitigating' }), refusal);
});

test('refusal names the state needed', () => {
  assert.equal(deletionRefusal('decision', { status: 'superseded' }), null);
  assert.equal(deletionRefusal('decision', { status: 'withdrawn' }), null);
  assert.equal(deletionRefusal('decision', { status: 'active' }), 'Withdraw or supersede this decision before deleting it.');
  assert.equal(deletionRefusal('question', { status: 'resolved' }), null);
  assert.equal(deletionRefusal('question', { status: 'withdrawn' }), null);
  for (const status of ['open', 'answered']) {
    assert.equal(deletionRefusal('question', { status }), 'Resolve or withdraw this question before deleting it.');
  }
});
