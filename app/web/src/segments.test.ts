import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSegments, contextAround, markedSpan } from './segments.ts';

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

const REPEATED = { quoteStart: 29, quoteEnd: 32, occurrences: [{ start: 29, end: 32 }, { start: 33, end: 36 }], chosenOccurrence: null };

test('a repeated quote is marked at the place being looked at, the approved place, or else the first', () => {
  assert.deepEqual(markedSpan(REPEATED, undefined), { quoteStart: 29, quoteEnd: 32 });
  assert.deepEqual(markedSpan(REPEATED, 1), { quoteStart: 33, quoteEnd: 36 });
  assert.deepEqual(markedSpan({ ...REPEATED, chosenOccurrence: 1 }, 0), { quoteStart: 33, quoteEnd: 36 });
  assert.deepEqual(markedSpan(REPEATED, 7), { quoteStart: 29, quoteEnd: 32 });
  assert.deepEqual(markedSpan({ quoteStart: null, quoteEnd: null, chosenOccurrence: null }, 1), { quoteStart: null, quoteEnd: null });
});

test('context around a place trims, flattens line breaks and marks where the notes continue', () => {
  const t = 'Alpha beta.\nok. gamma delta epsilon';
  assert.deepEqual(contextAround(t, 12, 15, 5), { before: '…eta. ', match: 'ok.', after: ' gamm…' });
  assert.deepEqual(contextAround('ok.', 0, 3), { before: '', match: 'ok.', after: '' });
});
