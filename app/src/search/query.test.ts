import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException } from '@nestjs/common';
import { KIND_ORDER, SEARCH_KINDS, hrefFor, parseKinds, parseOffset, parsePhrase } from './query';

const MIN = 'Type at least one word of 3 or more letters.';

test('parsePhrase splits on whitespace and wraps each word in a pattern', () => {
  assert.deepEqual(parsePhrase('  Vendor   PENANG '), { words: ['Vendor', 'PENANG'], patterns: ['%Vendor%', '%PENANG%'] });
});

test('parsePhrase needs one word of 3 or more letters', () => {
  assert.throws(() => parsePhrase('a b cd'), (e) => e instanceof BadRequestException && e.message === MIN);
  assert.throws(() => parsePhrase(undefined), (e) => e instanceof BadRequestException && e.message === MIN);
  assert.throws(() => parsePhrase('   '), (e) => e instanceof BadRequestException && e.message === MIN);
});

test('parsePhrase limits the length to 200 characters', () => {
  assert.throws(() => parsePhrase('x'.repeat(201)), (e) => e instanceof BadRequestException && e.message === 'Search is limited to 200 characters.');
  assert.equal(parsePhrase('x'.repeat(200)).words.length, 1);
});

test('parsePhrase escapes LIKE wildcards and backslashes', () => {
  const bs = String.fromCharCode(92);
  assert.deepEqual(parsePhrase('50% file_name a' + bs + 'b').patterns, ['%50' + bs + '%%', '%file' + bs + '_name%', '%a' + bs + bs + 'b%']);
});

test('parsePhrase keeps the first eight words', () => {
  const r = parsePhrase('one two three four five six seven eight nine');
  assert.equal(r.words.length, 8);
  assert.equal(r.words[7], 'eight');
});

test('parsePhrase normalises to NFC', () => {
  const r = parsePhrase('café plan');
  assert.equal(r.words[0], 'café');
});

test('parseKinds', () => {
  assert.deepEqual(parseKinds('task,decision'), ['task', 'decision']);
  assert.deepEqual(parseKinds(undefined), [...SEARCH_KINDS]);
  assert.deepEqual(parseKinds(''), [...SEARCH_KINDS]);
  assert.throws(() => parseKinds('task,bogus'), (e) => e instanceof BadRequestException && e.message === 'Unknown kind: bogus.');
});

test('parseOffset', () => {
  const msg = 'Offset must be a whole number of 0 or more.';
  assert.equal(parseOffset(undefined), 0);
  assert.equal(parseOffset('20'), 20);
  assert.throws(() => parseOffset('-1'), (e) => e instanceof BadRequestException && e.message === msg);
  assert.throws(() => parseOffset('1.5'), (e) => e instanceof BadRequestException && e.message === msg);
  assert.throws(() => parseOffset('abc'), (e) => e instanceof BadRequestException && e.message === msg);
});

test('KIND_ORDER', () => {
  assert.deepEqual(KIND_ORDER, { project: 0, person: 1, task: 2, decision: 3, question: 4, risk: 5, ai_proposal: 6, human_proposal: 6, note: 7 });
});

test('hrefFor', () => {
  const base = { projectId: 'P', itemId: 'I', runId: null, versionNo: null, isCurrent: true };
  assert.equal(hrefFor({ ...base, kind: 'project' }), '#/projects/P');
  assert.equal(hrefFor({ ...base, kind: 'person' }), '#/projects/P/people');
  assert.equal(hrefFor({ ...base, kind: 'note' }), '#/notes/I');
  assert.equal(hrefFor({ ...base, kind: 'note', versionNo: 3, isCurrent: true }), '#/notes/I');
  assert.equal(hrefFor({ ...base, kind: 'note', versionNo: 2, isCurrent: false }), '#/notes/I/v/2');
  assert.equal(hrefFor({ ...base, kind: 'ai_proposal', runId: 'R' }), '#/runs/R');
  assert.equal(hrefFor({ ...base, kind: 'human_proposal' }), '#/projects/P/notes/I');
  for (const k of ['task', 'decision', 'question', 'risk'] as const) assert.equal(hrefFor({ ...base, kind: k }), '#/projects/P/work/I');
});
