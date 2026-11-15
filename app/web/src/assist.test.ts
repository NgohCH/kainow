import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError } from './api.ts';
import {
  BAD_QUESTION,
  mergeAnswers,
  mergeTimeline,
  mergeViews,
  safeHref,
  parseInline,
  parseMarkdown,
  questionCounter,
  questionProblem,
  shareRefusal,
  sourcesSummary,
  statusText,
  type ThreadAnswerView,
} from './assist.ts';
import type { MessageView } from './discussion.ts';

const ada = { id: 'u-ada', displayName: 'Ada Member' };
const msg = (no: number, createdAt: string): MessageView =>
  ({ id: `m${no}`, no, author: ada, createdAt, edited: false, version: 1, state: 'visible', text: `t${no}`, notice: null, replyTo: null }) as MessageView;
const ans = (id: string, sharedAt: string, over: Partial<ThreadAnswerView> = {}): ThreadAnswerView => ({
  id,
  askedBy: ada,
  question: 'Q?',
  answerMarkdown: 'A',
  sources: [],
  droppedCount: 0,
  sharedAt,
  hidden: false,
  notice: null,
  ...over,
});

test('mergeTimeline orders by time', () => {
  const out = mergeTimeline([msg(1, '2026-11-11T02:00:00Z'), msg(2, '2026-11-11T04:00:00Z')], [ans('a1', '2026-11-11T03:00:00Z'), ans('a2', '2026-11-11T04:00:00Z')]);
  assert.deepEqual(out.map((i) => (i.kind === 'message' ? `m${i.message.no}` : i.answer.id)), ['m1', 'a1', 'm2', 'a2']);
});

test('mergeAnswers merges by id so polling does not duplicate', () => {
  const merged = mergeAnswers([ans('a1', '2026-11-11T03:00:00Z')], [ans('a1', '2026-11-11T03:00:00Z', { hidden: true }), ans('a2', '2026-11-11T05:00:00Z')]);
  assert.deepEqual(merged.map((a) => a.id), ['a1', 'a2']);
  assert.equal(merged[0].hidden, true);
});

test('status text for each status', () => {
  const base = { notice: null, unavailableReason: null };
  assert.equal(statusText({ ...base, status: 'queued' }), 'Waiting to start');
  assert.equal(statusText({ ...base, status: 'running' }), 'Looking through the project');
  assert.equal(statusText({ ...base, status: 'answered' }), 'AI answer — check the sources');
  assert.equal(statusText({ ...base, status: 'not_found' }), 'Nothing in this project matched your question');
  assert.equal(statusText({ ...base, status: 'failed', unavailableReason: 'no AI key is configured' }), 'AI answer unavailable: no AI key is configured');
  assert.equal(statusText({ notice: 'AI answer unavailable: you have no personal AI allowance', unavailableReason: 'x', status: 'blocked' }), 'AI answer unavailable: you have no personal AI allowance');
});

test('question counter refuses 501 before sending', () => {
  assert.equal(questionProblem('x'.repeat(500)), null);
  assert.equal(questionProblem('x'.repeat(501)), BAD_QUESTION);
  assert.equal(questionProblem('   '), BAD_QUESTION);
  assert.equal(questionCounter('x'.repeat(501)), '501 / 500');
});

test('share refusal offers Re-answer for this thread', () => {
  const e = new ApiError('This answer used information some people in this thread cannot read.', 409, { canReanswer: true });
  assert.deepEqual(shareRefusal(e), { message: 'This answer used information some people in this thread cannot read.', canReanswer: true });
  assert.equal(shareRefusal(new ApiError('This answer is already shared.', 409, {})).canReanswer, false);
  assert.equal(shareRefusal(new Error('x')).canReanswer, false);
});

test('dropped sources are only counted', () => {
  const s = sourcesSummary(
    [
      { marker: 'P1', location: 'Note', href: '#/notes/n', cited: true, dropped: false },
      { marker: 'P2', location: null, href: null, cited: false, dropped: true },
    ],
    1,
  );
  assert.equal(s.shown.length, 1);
  assert.equal(s.droppedText, '1 passage was no longer available');
});

test('markdown becomes tokens, never HTML; markers are found', () => {
  assert.deepEqual(
    parseInline('See [P1, P4] and **bold** <b>x</b>').map((t) => `${t.t}:${t.text}`),
    ['text:See ', 'text:[', 'marker:P1', 'text:, ', 'marker:P4', 'text:]', 'text: and ', 'bold:bold', 'text: <b>x</b>'],
  );
  const blocks = parseMarkdown('# Title\n\nOne line\ncontinues.\n\n- a\n- b\n\n1. x\n2. y');
  assert.deepEqual(blocks.map((b) => b.t), ['h', 'p', 'ul', 'ol']);
});

test('mergeViews keeps a just-asked item a poll did not know and lets the fresh copy win', () => {
  const v = (id: string, askedAt: string, status: string) => ({ id, askedAt, status }) as never;
  const merged = mergeViews([v('b', '2026-11-11T05:00:00Z', 'queued'), v('a', '2026-11-11T03:00:00Z', 'running')], [v('a', '2026-11-11T03:00:00Z', 'answered')]) as unknown as Array<{ id: string; status: string }>;
  assert.deepEqual(merged.map((x) => `${x.id}:${x.status}`), ['b:queued', 'a:answered']);
});

test('only in-app source links are used', () => {
  assert.equal(safeHref('#/notes/n1'), '#/notes/n1');
  assert.equal(safeHref('javascript:alert(1)'), null);
  assert.equal(safeHref('https://elsewhere.example.com'), null);
  assert.equal(safeHref(null), null);
});
