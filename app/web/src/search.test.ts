import assert from 'node:assert/strict';
import { test } from 'node:test';
import { highlight, parseSearchHash, searchedLine, searchPath, searchWords, snippetRepeatsTitle, statusLabel } from './search.ts';

test('highlight marks each word, ignoring case', () => {
  assert.deepEqual(highlight('Choose Vendor in Penang', ['vendor', 'pen']), [
    { text: 'Choose ', mark: false },
    { text: 'Vendor', mark: true },
    { text: ' in ', mark: false },
    { text: 'Pen', mark: true },
    { text: 'ang', mark: false },
  ]);
});

test('highlight treats punctuation as plain text, not a pattern', () => {
  assert.deepEqual(highlight('a.b(c)', ['.b(']), [
    { text: 'a', mark: false },
    { text: '.b(', mark: true },
    { text: 'c)', mark: false },
  ]);
});

test('highlight merges overlapping words into one mark', () => {
  assert.deepEqual(highlight('vendor', ['vend', 'endor']), [{ text: 'vendor', mark: true }]);
});

test('highlight with no words or empty text', () => {
  assert.deepEqual(highlight('plain', []), [{ text: 'plain', mark: false }]);
  assert.deepEqual(highlight('', ['x']), []);
});

test('searchWords splits like the server', () => {
  assert.deepEqual(searchWords('  a  vendor   Penang x '), ['vendor', 'Penang']);
  assert.equal(searchWords('aa bb cc dd ee ff gg hh ii jj').length, 8);
});

test('searchPath and parseSearchHash round-trip, including & and spaces', () => {
  const p = '/search?' + 'q=' + encodeURIComponent('R&D "new vendor"');
  assert.equal(searchPath({ q: 'R&D "new vendor"' }).startsWith('/search?q='), true);
  assert.equal(searchPath({ q: 'R&D "new vendor"' }), p);
  const full = searchPath({ q: 'a & b', kinds: ['task', 'note'], archived: true, project: 'p1', offset: 20 });
  assert.deepEqual(parseSearchHash('#' + full), { q: 'a & b', kinds: ['task', 'note'], archived: true, project: 'p1' });
  assert.match(full, /offset=20/);
});

test('parseSearchHash defaults', () => {
  assert.deepEqual(parseSearchHash('#/search'), { q: '', kinds: [], archived: false, project: null });
  assert.deepEqual(parseSearchHash('#/search?q=x'), { q: 'x', kinds: [], archived: false, project: null });
});

test('searchedLine pluralises', () => {
  assert.equal(searchedLine(1), 'Searched 1 project you can currently see');
  assert.equal(searchedLine(7), 'Searched 7 projects you can currently see');
});

test('statusLabel uses the words the rest of the app uses', () => {
  assert.equal(statusLabel('task', 'not_started'), 'Not Started');
  assert.equal(statusLabel('task', 'in_progress'), 'In Progress');
  assert.equal(statusLabel('decision', 'superseded'), 'Superseded');
  assert.equal(statusLabel('question', 'answered'), 'Answered');
  assert.equal(statusLabel('risk', 'mitigating'), 'Mitigating');
  assert.equal(statusLabel('project', 'deferred'), 'Deferred');
  assert.equal(statusLabel('ai_proposal', 'pending'), 'Not reviewed');
  assert.equal(statusLabel('human_proposal', 'rejected'), 'Rejected');
});

test('statusLabel falls back to the raw value', () => {
  assert.equal(statusLabel('task', 'odd_state'), 'odd_state');
  assert.equal(statusLabel('mystery', 'pending'), 'pending');
});

test('snippetRepeatsTitle ignores case and spacing', () => {
  assert.equal(snippetRepeatsTitle('Choose  vendor', 'choose vendor '), true);
  assert.equal(snippetRepeatsTitle('Choose vendor', 'Choose vendor for Penang'), false);
  assert.equal(snippetRepeatsTitle('x', null), false);
});
