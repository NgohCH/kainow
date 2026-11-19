import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CASE_STATE_TEXT,
  CREDENTIAL_MARKER,
  MARKER_EQUIVALENT,
  type PossibleCopy,
  copyLine,
  decisionBody,
  markerSegments,
  reportBody,
  reportProblems,
  revealLines,
  runFailureText,
} from './quarantine.ts';

test('marker segments split the cleaned text', () => {
  assert.deepEqual(markerSegments('The key is [credential removed] and the other [credential removed].'), [
    { text: 'The key is ', removed: false },
    { text: CREDENTIAL_MARKER, removed: true },
    { text: ' and the other ', removed: false },
    { text: CREDENTIAL_MARKER, removed: true },
    { text: '.', removed: false },
  ]);
  assert.deepEqual(markerSegments('nothing here'), [{ text: 'nothing here', removed: false }]);
  assert.deepEqual(markerSegments(''), []);
  assert.deepEqual(markerSegments('[credential removed]'), [{ text: CREDENTIAL_MARKER, removed: true }]);
  // The text equivalent is words, so the marker is not conveyed by colour alone.
  assert.match(MARKER_EQUIVALENT, /credential removed/i);
  // Joining the segments gives the text back.
  const t = 'a [credential removed][credential removed] b';
  assert.equal(markerSegments(t).map((s) => s.text).join(''), t);
});

test('report form requires a selection or pasted text and a reason', () => {
  assert.deepEqual(reportProblems({ marked: [], reason: 'It is a password' }).marked, 'Select the secret in the text, or paste it, before reporting.');
  assert.ok(reportProblems({ marked: ['abc'], reason: 'x' }).marked?.includes('4 characters'));
  assert.equal(reportProblems({ marked: ['Xy7!pass'], reason: 'x' }).marked, null);
  assert.equal(reportProblems({ marked: ['Xy7!pass'], reason: '   ' }).reason, 'Give a reason.');
  assert.equal(reportProblems({ marked: ['Xy7!pass'], reason: 'x'.repeat(1001) }).reason?.includes('1,000'), true);
  assert.deepEqual(reportProblems({ marked: ['Xy7!pass'], reason: 'It is a password' }), { marked: null, reason: null });
  // Blank entries are dropped, the reason is trimmed, nothing else is added.
  assert.deepEqual(reportBody('task', 'id-1', { marked: ['Xy7!pass', '  '], reason: ' It is a password ' }), {
    kind: 'task',
    id: 'id-1',
    marked: ['Xy7!pass'],
    reason: 'It is a password',
  });
});

test('possible copies list never shows the marked text', () => {
  const marked = 'Xy7!pass-secret';
  const copy = {
    kind: 'message',
    id: 'm1',
    reference: 'Message 4 in Site meeting',
    foundAt: '2026-12-03T02:00:00.000Z',
    masked: true,
    decision: null,
    decidedAt: null,
    label: 'Possible credential removed — awaiting check',
    // A stray field must never reach the screen.
    marked,
    text: marked,
  } as PossibleCopy;
  const line = copyLine(copy);
  assert.ok(!JSON.stringify(line).includes(marked));
  assert.match(line.text, /message/i);
  assert.match(line.text, /Message 4 in Site meeting/);
  assert.match(line.text, /3 Dec 2026/);
  assert.equal(line.label, 'Possible credential removed — awaiting check');
  assert.equal(line.decided, false);
  // A place not yet masked (waiting for the key) shows no reference.
  const waiting = copyLine({ ...copy, masked: false, reference: null, label: 'Waiting for the protected key' });
  assert.match(waiting.text, /message/i);
  assert.equal(waiting.label, 'Waiting for the protected key');
  assert.equal(copyLine({ ...copy, decision: 'dismissed', label: null, decidedAt: '2026-12-04T02:00:00.000Z' }).decided, true);
  assert.deepEqual(decisionBody([{ kind: 'message', id: 'm1' }], 'dismissed'), { decisions: [{ kind: 'message', id: 'm1', decision: 'dismissed' }] });
});

test('held code reads as a plain label and states are worded', () => {
  assert.equal(runFailureText('held', null), 'Held — suspected credential, under review');
  assert.equal(runFailureText('failed', 'Provider unavailable'), 'Provider unavailable');
  assert.equal(runFailureText(null, null), '');
  assert.equal(CASE_STATE_TEXT.released_unchanged, 'Released unchanged (false alarm)');
});

test("reveal shows the item's own columns first and marks the removed spans", () => {
  const lines = revealLines(
    'task',
    [
      { table: 'task_events', column: 'detail', rowKey: {}, text: 'Event note', marks: [] },
      { table: 'tasks', column: 'description', rowKey: {}, text: 'use pw Xy7!pass now', marks: [{ start: 7, end: 15 }] },
    ],
  );
  assert.equal(lines[0].heading, 'tasks — description');
  assert.equal(lines[0].segments.map((s) => s.text).join(''), 'use pw Xy7!pass now');
  assert.deepEqual(lines[0].segments.filter((s) => s.removed).map((s) => s.text), ['Xy7!pass']);
  assert.deepEqual(lines[1].segments, [{ text: 'Event note', removed: false }]);
});
