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
    audience: { id: 'a1', mode: 'project', namedUsers: [], changedAt: null },
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

// --- Task 16: meetings, minutes, publishing, audiences, evidence ---
import {
  accessChangedLabel,
  canMarkByOffset,
  occurrenceChoiceText,
  AI_DRAFT_LABEL,
  type AudienceView,
  diffLines,
  draftBanner,
  draftMinutesWarning,
  evidenceView,
  isAccessLost,
  meetingStartConfirmation,
  presentCandidates,
  publishConfirmation,
  readersOf,
  restrictedLabel,
  sourceFlagText,
} from './discussion.ts';
import { ApiError, type Membership } from './api.ts';

const member = (userId: string, displayName: string, role: Membership['role'], state: Membership['state'] = 'active'): Membership => ({
  id: `m-${userId}-${role}`,
  userId,
  displayName,
  email: `${userId}@example.org`,
  role,
  startsOn: '2026-01-01',
  expiresOn: null,
  state,
});
const team = [
  member('u-pm', 'Pat Manager', 'pm'),
  member('u-dep', 'Dee Deputy', 'deputy_pm'),
  member('u-own', 'Olu Owner', 'owner'),
  member('u-ada', 'Ada Member', 'member'),
  member('u-ben', 'Ben Member', 'member'),
  member('u-cy', 'Cy Member', 'member', 'revoked'),
];

test('diffLines marks added and removed lines', () => {
  assert.deepEqual(diffLines('a\nb\nc', 'a\nc\nd'), [
    { kind: 'same', text: 'a' },
    { kind: 'removed', text: 'b' },
    { kind: 'same', text: 'c' },
    { kind: 'added', text: 'd' },
  ]);
  assert.deepEqual(diffLines('same', 'same'), [{ kind: 'same', text: 'same' }]);
  assert.deepEqual(diffLines('', 'x'), [{ kind: 'added', text: 'x' }]);
});

test('minutes panel shows the AI draft label and dashed outline', () => {
  const ai = draftBanner({ origin: 'ai', label: AI_DRAFT_LABEL, editedFromVersion: null });
  assert.equal(ai.label, 'AI draft — not official minutes');
  assert.match(ai.className, /\bai-proposed\b/);
  const human = draftBanner({ origin: 'human', label: `${AI_DRAFT_LABEL} · Edited by Pat Manager`, editedFromVersion: 2 });
  assert.equal(human.label, 'AI draft — not official minutes · Edited by Pat Manager');
  assert.match(human.className, /\bai-proposed\b/);
  assert.equal(human.fromLine, 'Edited from version 2');
  assert.equal(ai.fromLine, null);
});

test('Draft minutes warns when a human version exists', () => {
  assert.equal(draftMinutesWarning(true), 'A new AI draft is built from the messages and does not include edits made by people');
  assert.equal(draftMinutesWarning(false), null);
});

test('publish confirmation shows the audience', () => {
  const project: AudienceView = { id: 'a1', mode: 'project', namedUsers: [], changedAt: null };
  assert.equal(publishConfirmation('Weekly review', 3, project, team), 'Publish version 3 of Weekly review to: everyone in the project (Project-wide).');
  const restricted: AudienceView = { id: 'a2', mode: 'restricted', namedUsers: [{ id: 'u-ada', displayName: 'Ada Member' }], changedAt: null };
  assert.equal(
    publishConfirmation('Weekly review', 3, restricted, team),
    'Publish version 3 of Weekly review to: Restricted — Ada Member, Dee Deputy, Olu Owner, Pat Manager.',
  );
});

test('start Restricted meeting lists exactly who can read', () => {
  assert.deepEqual(readersOf(team, 'restricted', []).map((p) => p.displayName), ['Dee Deputy', 'Olu Owner', 'Pat Manager']);
  assert.deepEqual(readersOf(team, 'restricted', ['u-ben']).map((p) => p.displayName), ['Ben Member', 'Dee Deputy', 'Olu Owner', 'Pat Manager']);
  // A revoked member is not a reader, and Project-wide lists every current participant once.
  assert.deepEqual(readersOf(team, 'project', []).map((p) => p.displayName), ['Ada Member', 'Ben Member', 'Dee Deputy', 'Olu Owner', 'Pat Manager']);
  assert.equal(
    meetingStartConfirmation(team, 'restricted', ['u-ben']),
    'Only these people will be able to read this meeting and its minutes: Ben Member, Dee Deputy, Olu Owner, Pat Manager.',
  );
  assert.equal(meetingStartConfirmation(team, 'project', []), 'Everyone in the project will be able to read this meeting and its minutes.');
});

test('Present list offers only people who can read the meeting', () => {
  const restricted: AudienceView = { id: 'a2', mode: 'restricted', namedUsers: [{ id: 'u-ada', displayName: 'Ada Member' }], changedAt: null };
  assert.deepEqual(presentCandidates(team, restricted).map((p) => p.id), ['u-ada', 'u-dep', 'u-own', 'u-pm']);
});

test('a masked quote shows the marker and the flag, never text', () => {
  assert.deepEqual(evidenceView({ quote: null, quoteMasked: 'deleted', sourceFlag: 'deleted' }), { kind: 'quote', quote: '[Message deleted]', flag: 'Source message deleted — review', from: null, href: null });
  assert.equal((evidenceView({ quote: null, quoteMasked: 'hidden', sourceFlag: 'hidden' }) as { quote: string }).quote, '[Message hidden]');
});

test('record evidence shows restricted text for outsiders', () => {
  assert.deepEqual(evidenceView({ restricted: true }), { kind: 'restricted', text: 'Evidence in a restricted source' });
  assert.deepEqual(evidenceView({ quote: 'We agreed to ship.', sourceFlag: null, discussionEvidence: null }), { kind: 'quote', quote: 'We agreed to ship.', flag: null, from: null, href: null });
  const ev = { threadId: 't1', messageNo: 12, authorName: 'Ada Member', at: '2026-11-11T02:31:00.000Z' };
  const found = evidenceView({ quote: 'Ship it', sourceFlag: 'hidden', discussionEvidence: ev }, 'p1');
  assert.deepEqual(found, {
    kind: 'quote',
    quote: 'Ship it',
    flag: 'Source message hidden — review',
    from: 'Message #12 by Ada Member, 11 Nov 10:31',
    href: '#/projects/p1/threads/t1?m=12',
  });
  assert.equal(sourceFlagText('deleted'), 'Source message deleted — review');
});

test('offsets are never used to mark a discussion source, with or without evidence on the items', () => {
  assert.equal(canMarkByOffset('discussion'), false);
  assert.equal(canMarkByOffset('notes'), true);
  assert.equal(canMarkByOffset('minutes'), true);
  assert.equal(canMarkByOffset(undefined), true);
});

test('the occurrence chooser uses the server label', () => {
  assert.equal(occurrenceChoiceText('Message #2 by Ada Member, 11 Nov 10:31'), 'Message #2 by Ada Member, 11 Nov 10:31');
  assert.equal(occurrenceChoiceText('Hidden or deleted message'), 'Hidden or deleted message');
  assert.equal(occurrenceChoiceText(null), 'A place in the discussion');
});

test('Source restricted and Access changed labels', () => {
  assert.equal(restrictedLabel('restricted'), 'Source restricted');
  assert.equal(restrictedLabel('project'), null);
  const now = new Date('2026-11-20T00:00:00Z');
  assert.equal(accessChangedLabel('2026-11-11T02:31:00.000Z', now), 'Access changed 11 Nov 2026');
  assert.equal(accessChangedLabel('2026-10-01T02:31:00.000Z', now), null);
  assert.equal(accessChangedLabel(null, now), null);
});

test('a poll answered 404 or 403 means access was lost', () => {
  assert.equal(isAccessLost(new ApiError('x', 404)), true);
  assert.equal(isAccessLost(new ApiError('x', 403)), true);
  assert.equal(isAccessLost(new ApiError('x', 500)), false);
  assert.equal(isAccessLost(new Error('x')), false);
});
