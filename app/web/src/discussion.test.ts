import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  analysisBox,
  announcement,
  initialThread,
  messageActions,
  messageLines,
  mergeMessages,
  parseThreadHash,
  pollDelay,
  threadReducer,
  type AnalysisStatusView,
  type MessageView,
  type ThreadView,
} from './discussion.ts';
import { formatWhen } from './format.ts';

const ada = { id: 'u-ada', displayName: 'Ada Member' };
const ben = { id: 'u-ben', displayName: 'Ben Member' };
const AT = '2026-11-11T02:31:00.000Z';

function msg(no: number, over: Partial<MessageView> = {}): MessageView {
  return {
    id: `m${no}`,
    no,
    author: ada,
    createdAt: AT,
    edited: false,
    version: 1,
    state: 'visible',
    text: `text ${no}`,
    notice: null,
    replyTo: null,
    ...over,
  };
}

function thread(messages: MessageView[], over: Partial<ThreadView> = {}): ThreadView {
  return {
    id: 't1',
    projectId: 'p1',
    kind: 'discussion',
    title: 'Berth plan',
    audience: { mode: 'project', namedUsers: [], changedAt: null },
    meetingDate: null,
    state: null,
    messages,
    present: [],
    canPost: true,
    canModerate: false,
    ...over,
  };
}

test('mergeMessages keeps order and newest versions', () => {
  const old = [msg(1), msg(2, { version: 2, edited: true, text: 'second, edited' }), msg(3)];
  const fresh = [msg(2, { version: 1, text: 'stale copy' }), msg(3, { version: 2, edited: true, text: 'third, edited' }), msg(4)];
  const merged = mergeMessages(old, fresh);
  assert.deepEqual(merged.map((m) => m.no), [1, 2, 3, 4]);
  assert.equal(merged[1].text, 'second, edited');
  assert.equal(merged[2].text, 'third, edited');
});

test('mergeMessages takes a moderation change that does not bump the version', () => {
  const merged = mergeMessages([msg(1)], [msg(1, { state: 'hidden', text: null, notice: 'Hidden by Pam: off topic' })]);
  assert.equal(merged[0].state, 'hidden');
  assert.equal(merged.length, 1);
});

test('mergeMessages does not mutate its inputs', () => {
  const old = [msg(2), msg(1)];
  mergeMessages(old, [msg(3)]);
  assert.deepEqual(old.map((m) => m.no), [2, 1]);
});

test('pollDelay', () => {
  assert.equal(pollDelay(true), 5_000);
  assert.equal(pollDelay(false), 30_000);
});

test('thread view shows edited, notices and reply quotes', () => {
  const lines = messageLines(
    msg(5, { author: ben, edited: true, version: 2, replyTo: { id: 'm2', no: 2, quote: 'Shall we book the hall?', notice: null } }),
  );
  assert.equal(lines.byline, `#5 · Ben Member · ${formatWhen(AT)}`);
  assert.equal(lines.edited, true);
  assert.equal(lines.replyLine, 'In reply to #2: “Shall we book the hall?”');
  assert.equal(lines.text, 'text 5');

  const hidden = messageLines(
    msg(6, { state: 'hidden', text: null, notice: 'Hidden by Pam Manager: off topic', replyTo: { id: 'm1', no: 1, quote: null, notice: 'Reply to a deleted message' } }),
  );
  assert.equal(hidden.notice, 'Hidden by Pam Manager: off topic');
  assert.equal(hidden.text, null);
  assert.equal(hidden.replyLine, 'Reply to a deleted message (#1)');
  // An author still reads their own hidden text next to the notice.
  const own = messageLines(msg(7, { state: 'hidden', text: 'my words', notice: 'Hidden by Pam Manager: off topic' }));
  assert.equal(own.text, 'my words');
  assert.equal(own.notice, 'Hidden by Pam Manager: off topic');
});

test('message actions follow state, authorship and rights', () => {
  const open = { meId: ada.id, canPost: true, canModerate: false, canRestore: false };
  assert.deepEqual(messageActions(msg(1), open), ['reply', 'edit', 'delete']);
  assert.deepEqual(messageActions(msg(1, { author: ben }), open), ['reply']);
  const pm = { meId: 'u-pm', canPost: true, canModerate: true, canRestore: true };
  assert.deepEqual(messageActions(msg(1), pm), ['reply', 'hide', 'delete']);
  assert.deepEqual(messageActions(msg(1, { state: 'hidden' }), pm), ['unhide', 'delete']);
  assert.deepEqual(messageActions(msg(1, { state: 'deleted', text: null }), pm), ['restore']);
  assert.deepEqual(messageActions(msg(1, { state: 'deleted', text: null }), open), []);
  // Read-only (ended meeting, closed project, grant holder): nothing that writes.
  assert.deepEqual(messageActions(msg(1), { meId: ada.id, canPost: false, canModerate: false, canRestore: false }), []);
  // Restoring stays possible when posting no longer is.
  assert.deepEqual(messageActions(msg(1, { state: 'deleted', text: null }), { meId: 'u-pm', canPost: false, canModerate: false, canRestore: true }), ['restore']);
});

test('composer keeps its text across a poll', () => {
  let s = initialThread(thread([msg(1)]), ada.id);
  s = threadReducer(s, { type: 'draft', text: 'half-written reply' });
  s = threadReducer(s, { type: 'replyTo', id: 'm1' });
  s = threadReducer(s, { type: 'polled', thread: thread([msg(1), msg(2, { author: ben })]) });
  assert.equal(s.draft, 'half-written reply');
  assert.equal(s.replyToId, 'm1');
  assert.equal(s.thread.messages.length, 2);
});

test('an edit in progress survives a poll that brings the same message', () => {
  let s = initialThread(thread([msg(1)]), ada.id);
  s = threadReducer(s, { type: 'startEdit', id: 'm1', text: 'my words', basedOn: 1 });
  s = threadReducer(s, { type: 'editText', text: 'my words, changed' });
  s = threadReducer(s, { type: 'polled', thread: thread([msg(1, { version: 2, edited: true, text: 'someone else' })]) });
  assert.equal(s.editing?.text, 'my words, changed');
  assert.equal(s.editing?.basedOn, 1);
});

test('new message announced in the polite live region', () => {
  let s = initialThread(thread([msg(1)]), ada.id);
  assert.equal(s.announce, '');
  s = threadReducer(s, { type: 'polled', thread: thread([msg(1), msg(2, { author: ben })]) });
  assert.equal(s.announce, 'New message from Ben Member');
  s = threadReducer(s, { type: 'polled', thread: thread([msg(1), msg(2, { author: ben }), msg(3, { author: ben }), msg(4, { author: ben }), msg(5, { author: ada })]) });
  assert.equal(s.announce, '2 new messages');
  // Your own message, and a poll that brings nothing new, announce nothing.
  const same = threadReducer(s, { type: 'polled', thread: thread(s.thread.messages) });
  assert.equal(same.announce, '');
  assert.equal(announcement([msg(1, { author: ada })], ada.id), '');
});

test('status box shows the line and the explanation', () => {
  const st: AnalysisStatusView = {
    status: { state: 'waiting' },
    line: 'Analysis at 10:42 if no new messages',
    explanation: 'Automatic analysis: after 5 minutes without new messages; maximum 2 analyses per thread in any rolling 20 minutes.',
    lastFailure: null,
  };
  assert.deepEqual(analysisBox(st), [st.line, st.explanation]);
  assert.deepEqual(analysisBox({ ...st, lastFailure: 'the AI service did not answer' }), [st.line, st.explanation, 'Last analysis failed: the AI service did not answer']);
});

test('parseThreadHash reads the project, the thread and the message number', () => {
  assert.deepEqual(parseThreadHash('#/projects/p1/threads/t1?m=12'), { projectId: 'p1', threadId: 't1', messageNo: 12 });
  assert.deepEqual(parseThreadHash('#/projects/p1/threads/t1'), { projectId: 'p1', threadId: 't1', messageNo: null });
  assert.equal(parseThreadHash('#/projects/p1/notes'), null);
});
