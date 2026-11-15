import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MAX_TERMS, buildTerms } from './terms';

describe('buildTerms', () => {
  test('stop-word-only question yields no terms', () => {
    assert.deepEqual(buildTerms('What did we ... is it about?'), []);
    assert.deepEqual(buildTerms('Apa yang ada di sini, untuk kita?'), []);
    assert.deepEqual(buildTerms(''), []);
  });

  test('mixed English–Malay keeps content words', () => {
    assert.deepEqual(buildTerms('What did we decide about the pembekal untuk projek ini?'), ['decide', 'pembekal', 'projek']);
    assert.deepEqual(buildTerms('Vendor, VENDOR; vendor! mesyuarat (Isnin)'), ['vendor', 'mesyuarat', 'isnin']);
    assert.deepEqual(buildTerms('A b c pump'), ['pump'], 'single letters are dropped');
    assert.deepEqual(buildTerms("The team's budget"), ['team', 'budget']);
  });

  test('twelve terms at most', () => {
    const words = Array.from({ length: 20 }, (_, i) => `word${String.fromCharCode(97 + i)}`);
    const terms = buildTerms(words.join(' '));
    assert.equal(MAX_TERMS, 12);
    assert.equal(terms.length, 12);
    assert.deepEqual(terms, words.slice(0, 12));
  });
});
