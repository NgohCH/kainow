import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MAX_TERMS, STOP_WORDS, buildTerms } from './terms';

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

  test("every word of PostgreSQL's english stop list is a stop word here", () => {
    // PostgreSQL 16 tsearch_data/english.stop.
    const pg = `i me my myself we our ours ourselves you your yours yourself yourselves he him his himself she her hers herself it its itself
      they them their theirs themselves what which who whom this that these those am is are was were be been being have has had having do does
      did doing a an the and but if or because as until while of at by for with about against between into through during before after above
      below to from up down in out on off over under again further then once here there when where why how all any both each few more most other
      some such no nor not only own same so than too very s t can will just don should now`.split(/\s+/);
    assert.deepEqual(pg.filter((w) => !STOP_WORDS.has(w)), []);
    assert.deepEqual(buildTerms('Only the very same pump, once more, over and out'), ['pump']);
  });
});
