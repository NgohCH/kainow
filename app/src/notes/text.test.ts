import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_TEXT_CHARS, NoteTextError, locateQuote, normaliseText } from './text';

test('line ends become LF and a leading BOM is dropped', () => {
  assert.equal(normaliseText('﻿a\r\nb\rc\nd'), 'a\nb\nc\nd');
});

test('text is stored in NFC', () => {
  const decomposed = 'café';
  const out = normaliseText(decomposed);
  assert.equal(out, 'café');
  assert.equal(out.length, 4);
});

test('empty, blank and NUL text is refused', () => {
  for (const bad of ['', '  \n\t ', '﻿', 'a\u0000b']) {
    assert.throws(() => normaliseText(bad), NoteTextError);
  }
});

test('text over the length limit is refused, the limit itself is allowed', () => {
  assert.equal(normaliseText('a'.repeat(MAX_TEXT_CHARS)).length, MAX_TEXT_CHARS);
  assert.throws(() => normaliseText('a'.repeat(MAX_TEXT_CHARS + 1)), NoteTextError);
});

test('normalising twice changes nothing', () => {
  const once = normaliseText('Ré́sumé\r\n');
  assert.equal(normaliseText(once), once);
});

test('a quote is located by character offset, and the offsets slice the stored text', () => {
  const text = 'We agreed to ship on Friday.\nAli will email Sam.';
  const [m] = locateQuote(text, 'Ali will email Sam.');
  assert.deepEqual(m, { start: 29, end: 48, occurrence: 0 });
  assert.equal(text.slice(m.start, m.end), 'Ali will email Sam.');
});

test('a repeated quote gives every place, numbered by occurrence', () => {
  const text = 'ok. ok. ok.';
  const hits = locateQuote(text, 'ok.');
  assert.deepEqual(hits.map((h) => [h.start, h.occurrence]), [[0, 0], [4, 1], [8, 2]]);
});

test('offsets count UTF-16 code units, so an emoji is two', () => {
  const text = '\u{1F600} done';
  const [m] = locateQuote(text, 'done');
  assert.equal(m.start, 3);
  assert.equal(text.slice(m.start, m.end), 'done');
});

test('a quote with CRLF or decomposed accents still matches', () => {
  const text = 'line one\nsolé';
  assert.equal(locateQuote(text, 'line one\r\nsolé').length, 1);
});

test('a missing or empty quote matches nowhere', () => {
  assert.deepEqual(locateQuote('abc', 'xyz'), []);
  assert.deepEqual(locateQuote('abc', ''), []);
});
