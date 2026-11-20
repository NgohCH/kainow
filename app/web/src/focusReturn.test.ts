import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openerSelector, returnTarget } from './focusReturn.ts';

test('the opener selector quotes the key safely', () => {
  assert.equal(openerSelector('spending'), '[data-opener="spending"]');
  assert.equal(openerSelector('a"b\\c'), '[data-opener="a\\"b\\\\c"]');
});

test('focus returns only when a form closes, to the opener or the named heading', () => {
  assert.equal(returnTarget('spending', null, null), 'spending');
  assert.equal(returnTarget('spending', null, 'resources-heading'), '#resources-heading');
  assert.equal(returnTarget(null, null, null), null);
  assert.equal(returnTarget('a', 'b', null), null);
  assert.equal(returnTarget(null, 'a', null), null);
});
