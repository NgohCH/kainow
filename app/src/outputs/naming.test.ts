import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fitPath, outputFileName, safeName } from './naming';

const codePoints = (s: string) => [...s].length;
const isLoneSurrogate = (s: string) => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

test('safeName handles illegal characters, diacritics, emoji and length', () => {
  // Each illegal character becomes one dash; dashes are not collapsed; whitespace runs become one space.
  assert.equal(safeName('Q3: "Plan" <draft>?'), 'Q3- -Plan- -draft--');
  assert.equal(safeName('a*b|c\\d/e'), 'a-b-c-d-e');
  assert.equal(safeName('  Minutes   of\tthe\nmeeting  '), 'Minutes of the meeting');
  // Leading and trailing spaces and dots are stripped.
  assert.equal(safeName(' ..Report.. '), 'Report');
  assert.equal(safeName('Kemaskini café 📎'), 'Kemaskini café 📎');
  assert.equal(safeName(''), 'Untitled');
  assert.equal(safeName(' . . '), 'Untitled');

  const long = 'a'.repeat(99) + '📎'.repeat(201);
  assert.equal(codePoints(long), 300);
  const cut = safeName(long);
  assert.equal(codePoints(cut), 100);
  assert.ok(!isLoneSurrogate(cut), 'no broken surrogate pair');
  assert.ok(cut.endsWith('📎'));
  assert.equal(codePoints(safeName('x'.repeat(300))), 100);
  assert.equal(codePoints(safeName('x'.repeat(300), 20)), 20);
  // A cut that leaves a trailing dot or space strips it too.
  assert.equal(safeName(`${'b'.repeat(9)}. tail`, 11), 'bbbbbbbbb');
});

test('outputFileName adds (2) suffix', () => {
  assert.equal(outputFileName('Weekly status', 1, 'docx'), 'Weekly status v1.docx');
  assert.equal(outputFileName('Weekly status', 3, 'pdf', 2), 'Weekly status v3 (2).pdf');
  assert.equal(outputFileName('Q3: plan?', 2, 'md'), 'Q3- plan- v2.md');
  const long = outputFileName('t'.repeat(300), 12, 'docx', 3);
  assert.ok(codePoints(long) <= 100, `${codePoints(long)} code points`);
  assert.ok(long.endsWith(' v12 (3).docx'));
});

test('fitPath keeps the total under 400 by shortening the title', () => {
  const parts = ['Engineering', 'Pump station renewal', '2026', 'Status reports'];
  assert.deepEqual(fitPath(parts, 'Weekly status v1.docx'), [...parts, 'Weekly status v1.docx']);

  const longParts = ['D'.repeat(100), 'P'.repeat(100), '2026', 'R'.repeat(100)];
  const name = outputFileName('T'.repeat(100), 1, 'docx');
  const fitted = fitPath(longParts, name);
  const total = codePoints(fitted.join('/'));
  assert.ok(total < 400, `total ${total}`);
  assert.deepEqual(fitted.slice(0, 4), longParts, 'folders are kept while the title can be shortened');
  assert.ok(fitted[4].endsWith(' v1.docx'));
  assert.ok(fitted[4].startsWith('T'));

  // Restricted: the output folder is the title too, and is shortened with it.
  const restricted = ['D'.repeat(100), 'P'.repeat(90) + ' (restricted)', 'T'.repeat(100)];
  const r = fitPath(restricted, outputFileName('T'.repeat(100), 2, 'pdf', 2), 400);
  assert.ok(codePoints(r.join('/')) < 400);
  assert.ok(r[3].endsWith(' v2 (2).pdf'));
  assert.equal(r[0], restricted[0]);

  // A small limit still gives a usable path.
  const tiny = fitPath(['Dept', 'Project'], outputFileName('Some long title here', 1, 'md'), 30);
  assert.ok(codePoints(tiny.join('/')) < 30, tiny.join('/'));
  assert.ok(tiny[2].endsWith(' v1.md'));
});
