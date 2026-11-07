import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSegments } from './segments.ts';

const TEXT = 'We agreed to ship on Friday. Ali emails Sam.';

test('plain text with no passages is one piece', () => {
  assert.deepEqual(buildSegments(TEXT, []), [{ start: 0, end: TEXT.length, text: TEXT, ids: [] }]);
});

test('a passage splits the text into before, passage and after, and the pieces rejoin to the original', () => {
  const segs = buildSegments(TEXT, [{ id: 'a', quoteStart: 29, quoteEnd: 44 }]);
  assert.deepEqual(segs.map((s) => [s.text, s.ids]), [['We agreed to ship on Friday. ', []], ['Ali emails Sam.', ['a']]]);
  assert.equal(segs.map((s) => s.text).join(''), TEXT);
});

test('overlapping passages share the stretch they have in common', () => {
  const segs = buildSegments(TEXT, [
    { id: 'a', quoteStart: 0, quoteEnd: 28 },
    { id: 'b', quoteStart: 17, quoteEnd: 44 },
  ]);
  assert.deepEqual(segs.map((s) => [s.start, s.end, s.ids]), [[0, 17, ['a']], [17, 28, ['a', 'b']], [28, 44, ['b']]]);
  assert.equal(segs.map((s) => s.text).join(''), TEXT);
});

test('two proposals on exactly the same passage both claim it', () => {
  const segs = buildSegments(TEXT, [{ id: 'a', quoteStart: 0, quoteEnd: 5 }, { id: 'b', quoteStart: 0, quoteEnd: 5 }]);
  assert.deepEqual(segs[0].ids, ['a', 'b']);
});

test('passages that were not found, or do not fit the text, are ignored', () => {
  const segs = buildSegments(TEXT, [
    { id: 'none', quoteStart: null, quoteEnd: null },
    { id: 'past', quoteStart: 10, quoteEnd: 999 },
    { id: 'backwards', quoteStart: 20, quoteEnd: 10 },
    { id: 'negative', quoteStart: -3, quoteEnd: 4 },
  ]);
  assert.equal(segs.length, 1);
  assert.deepEqual(segs[0].ids, []);
});

test('offsets count UTF-16 units, so text after an emoji lines up', () => {
  const text = '\u{1F600} done now';
  const segs = buildSegments(text, [{ id: 'a', quoteStart: 3, quoteEnd: 7 }]);
  assert.equal(segs.find((s) => s.ids.length)?.text, 'done');
});
