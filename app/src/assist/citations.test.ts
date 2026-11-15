import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { markersIn, validateCitations } from './citations';

describe('citations', () => {
  const sent = ['P1', 'P2', 'P3'];

  test('unknown marker fails', () => {
    const r = validateCitations('The pump was replaced [P1] and paid for [P9].', ['P1', 'P9'], sent);
    assert.equal(r.ok, false);
    assert.ok(!r.ok && r.detail.includes('P9'), JSON.stringify(r));
    assert.ok(!r.ok && !r.detail.includes('pump'), 'never echoes the answer text');
  });

  test('cited marker not sent fails', () => {
    const r = validateCitations('The pump was replaced [P1].', ['P1', 'P7'], sent);
    assert.equal(r.ok, false);
    assert.ok(!r.ok && r.detail.includes('P7'));
  });

  test('marker in the text but missing from cited fails', () => {
    const r = validateCitations('The pump was replaced [P1] on Monday [P2].', ['P1'], sent);
    assert.equal(r.ok, false);
    assert.ok(!r.ok && r.detail.includes('P2'));
  });

  test('markers all known passes', () => {
    assert.deepEqual(validateCitations('The pump was replaced [P1] on Monday [P3][P1].', ['P1', 'P3'], sent), { ok: true });
    assert.deepEqual(validateCitations('Nothing here answers the question.', [], sent), { ok: true });
    assert.deepEqual(validateCitations('Cited without a marker in the text.', ['P2'], sent), { ok: true });
  });

  test('markersIn lists each marker once in order', () => {
    assert.deepEqual(markersIn('a [P2] b [P10] c [P2] [p3] [P] [Px]'), ['P2', 'P10']);
  });
});
