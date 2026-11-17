import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MARKER, cleanEdges, cleanJson, cleanText, mapOffset, removedSpans } from './clean-text';

const SECRET = 'Xy7!pass';

describe('cleanText (spec 7.4)', () => {
  test('replaces every occurrence', () => {
    const r = cleanText(`a ${SECRET} b ${SECRET} c`, [SECRET]);
    assert.equal(r.text, `a ${MARKER} b ${MARKER} c`);
    assert.equal(r.edits.length, 2);
    assert.deepEqual(r.edits[0], { from: 2, to: 10, newFrom: 2, newTo: 2 + MARKER.length });
    // Exact and case-sensitive: another casing is left alone.
    assert.equal(cleanText('xy7!PASS', [SECRET]).text, 'xy7!PASS');
    assert.deepEqual(cleanText('nothing here', [SECRET]), { text: 'nothing here', edits: [] });
    // Empty marks are ignored rather than looping.
    assert.equal(cleanText('abc', ['']).text, 'abc');
  });

  test('merges overlapping marks', () => {
    // Two marks overlapping each other, a mark overlapping itself, and two adjacent occurrences: one marker each.
    assert.equal(cleanText('x abcdef y', ['abcd', 'cdef']).text, `x ${MARKER} y`);
    assert.equal(cleanText('x aaaaa y', ['aaaa']).text, `x ${MARKER} y`);
    const adjacent = cleanText(`<${SECRET}${SECRET}>`, [SECRET]);
    assert.equal(adjacent.text, `<${MARKER}>`);
    assert.equal(adjacent.edits.length, 1);
    assert.deepEqual(adjacent.edits[0], { from: 1, to: 17, newFrom: 1, newTo: 1 + MARKER.length });
  });

  test('html-escaped form matched in html mode', () => {
    const secret = 'p<w>&"x\'y';
    const html = `<p>key: p&lt;w&gt;&amp;&quot;x&#39;y</p>`;
    assert.equal(cleanText(html, [secret]).text, html, 'not matched outside html mode');
    assert.equal(cleanText(html, [secret], true).text, `<p>key: ${MARKER}</p>`);
    // The raw form is still matched in html mode.
    assert.equal(cleanText(`raw ${secret}`, [secret], true).text, `raw ${MARKER}`);
  });

  test('offset inside a secret widens to the marker', () => {
    const { edits } = cleanText(`ab ${SECRET} cd`, [SECRET]); // secret at [3, 11)
    assert.equal(mapOffset(edits, 5, 'start'), 3);
    assert.equal(mapOffset(edits, 5, 'end'), 3 + MARKER.length);
    // Exactly at the secret's start or end.
    assert.equal(mapOffset(edits, 3, 'start'), 3);
    assert.equal(mapOffset(edits, 3, 'end'), 3);
    assert.equal(mapOffset(edits, 11, 'start'), 3 + MARKER.length);
    assert.equal(mapOffset(edits, 11, 'end'), 3 + MARKER.length);
    // Before the secret nothing moves.
    assert.equal(mapOffset(edits, 1, 'start'), 1);
  });

  test('offsets after the secret shift by the length difference', () => {
    const text = `${SECRET} one ${SECRET} two`;
    const { text: cleaned, edits } = cleanText(text, [SECRET]);
    const delta = MARKER.length - SECRET.length;
    const two = text.indexOf('two');
    assert.equal(mapOffset(edits, two, 'start'), two + 2 * delta);
    assert.equal(cleaned.slice(mapOffset(edits, two, 'start'), mapOffset(edits, text.length, 'end')), 'two');
    const one = text.indexOf('one');
    assert.equal(cleaned.slice(mapOffset(edits, one, 'start'), mapOffset(edits, one + 3, 'end')), 'one');
  });

  test('json leaves cleaned, keys untouched', () => {
    const value = { [SECRET]: `has ${SECRET}`, list: [SECRET, 3, null, { deep: `x${SECRET}` }], n: 1, b: true };
    assert.deepEqual(cleanJson(value, [SECRET]), {
      [SECRET]: `has ${MARKER}`,
      list: [MARKER, 3, null, { deep: `x${MARKER}` }],
      n: 1,
      b: true,
    });
    assert.equal(cleanJson(`plain ${SECRET}`, [SECRET]), `plain ${MARKER}`);
    assert.equal(cleanJson(null, [SECRET]), null);
  });

  test('a fragment of a secret at either end of a text is removed', () => {
    assert.equal(cleanEdges('quote ends Xy7!p', [SECRET]), `quote ends ${MARKER}`);
    assert.equal(cleanEdges('!pass starts it', [SECRET]), `${MARKER} starts it`);
    // Three characters or fewer are left: too short to be the secret.
    assert.equal(cleanEdges('ends Xy7', [SECRET]), 'ends Xy7');
    assert.equal(cleanEdges(`whole ${SECRET} inside`, [SECRET]), `whole ${MARKER} inside`);
  });
});

describe('removedSpans (spec 7.6, Reveal original)', () => {
  test('finds each removed span of the original from its cleaned form', () => {
    const original = `a ${SECRET} b ${SECRET}, and ${SECRET}`;
    const cleaned = cleanText(original, [SECRET]).text;
    const spans = removedSpans(original, cleaned);
    assert.ok(spans);
    assert.deepEqual(spans.map((s) => original.slice(s.start, s.end)), [SECRET, SECRET, SECRET]);
    assert.deepEqual(removedSpans(`${SECRET} only`, `${MARKER} only`), [{ start: 0, end: SECRET.length }]);
    assert.deepEqual(removedSpans('no secret', 'no secret'), []);
  });

  test('null when the stored value is not a cleaned form of the original', () => {
    assert.equal(removedSpans(`a ${SECRET} b`, 'something else entirely'), null);
    assert.equal(removedSpans(`a ${SECRET} b`, `a ${MARKER} c`), null);
    assert.equal(removedSpans('a b', `a ${MARKER} b`), null);
  });
});
