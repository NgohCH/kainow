import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError } from './api.ts';
import {
  BAD_QUESTION,
  defaultPeriod,
  diffWord,
  emptyDraftForm,
  lineDiff,
  newDraftBody,
  newDraftProblem,
  REGENERATE_WARNING,
  staleCurrent,
  versionLabel,
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

// --- Drafts ---

const form = (over: Partial<ReturnType<typeof emptyDraftForm>> = {}) => ({ ...emptyDraftForm('specification'), ...over });

test('new-draft form requires sources for specification and free-form', () => {
  assert.match(newDraftProblem(form())!, /Choose 1 to 10 sources or threads/);
  assert.equal(newDraftProblem(form({ sourceIds: ['s1'] })), null);
  assert.match(newDraftProblem(form({ sourceIds: Array.from({ length: 6 }, (_, i) => `s${i}`), threadIds: Array.from({ length: 5 }, (_, i) => `t${i}`) }))!, /1 to 10/);
  const free = emptyDraftForm('free_form');
  assert.match(newDraftProblem({ ...free, sourceIds: ['s1'] })!, /title must be 1 to 200/);
  assert.match(newDraftProblem({ ...free, title: 'T', sourceIds: ['s1'] })!, /brief must be 1 to 2,000/);
  assert.match(newDraftProblem({ ...free, title: 'T', brief: 'x'.repeat(2001), sourceIds: ['s1'] })!, /brief/);
  assert.match(newDraftProblem({ ...free, title: 'x'.repeat(201), brief: 'b', sourceIds: ['s1'] })!, /title/);
  assert.equal(newDraftProblem({ ...free, title: 'T', brief: 'b', threadIds: ['t1'] }), null);
  // Record kinds need none, and send no chosen list.
  assert.equal(newDraftProblem(emptyDraftForm('status')), null);
  assert.equal(newDraftBody(emptyDraftForm('risks')).chosen, undefined);
  assert.deepEqual(newDraftBody({ ...free, title: ' T ', brief: 'b', sourceIds: ['s1'] }), { kind: 'free_form', title: 'T', brief: 'b', chosen: { sourceIds: ['s1'], threadIds: [] } });
  // Period for specification and free-form is optional but must be a pair.
  assert.match(newDraftProblem(form({ sourceIds: ['s1'], periodFrom: '2026-11-01' }))!, /two dates/);
  assert.match(newDraftProblem(form({ sourceIds: ['s1'], periodFrom: '2026-11-05', periodTo: '2026-11-01' }))!, /two dates/);
});

test('default period is the last 14 days in UTC+8', () => {
  // 2026-11-15 17:00 UTC is 2026-11-16 01:00 in UTC+8.
  assert.deepEqual(defaultPeriod(Date.parse('2026-11-15T17:00:00Z')), { from: '2026-11-03', to: '2026-11-16' });
  assert.deepEqual(defaultPeriod(Date.parse('2026-11-15T15:59:00Z')), { from: '2026-11-02', to: '2026-11-15' });
  const f = emptyDraftForm('status', Date.parse('2026-11-15T17:00:00Z'));
  assert.deepEqual([f.periodFrom, f.periodTo], ['2026-11-03', '2026-11-16']);
  const s = emptyDraftForm('specification');
  assert.deepEqual([s.periodFrom, s.periodTo], ['', '']);
  assert.deepEqual(defaultPeriod(Date.parse('2026-03-05T00:00:00Z')), { from: '2026-02-20', to: '2026-03-05' });
});

test('compare shows two versions', () => {
  const d = lineDiff('# T\nkeep\nold line\nend', '# T\nkeep\nnew line\nend\nmore');
  assert.deepEqual(d.map((l) => `${l.op}:${l.text}`), ['same:# T', 'same:keep', 'removed:old line', 'added:new line', 'same:end', 'added:more']);
  assert.deepEqual(['added', 'removed', 'same'].map((o) => diffWord(o as 'added')), ['Added', 'Removed', 'Unchanged']);
  assert.ok(lineDiff('a', 'a').every((l) => l.op === 'same'));
  assert.equal(versionLabel({ origin: 'ai', editedByLabel: null }), 'AI draft — not approved');
  assert.equal(versionLabel({ origin: 'human', editedByLabel: 'Edited by Ada Member' }), 'Edited by Ada Member');
});

test('regenerate warns that edits are not included', () => {
  assert.match(REGENERATE_WARNING, /does not include edits people made/);
});

test('a stale edit carries the current version', () => {
  const cur = { id: 'd1' };
  assert.deepEqual(staleCurrent(new ApiError('Someone changed this since you opened it', 409, { current: cur })), cur);
  assert.equal(staleCurrent(new ApiError('x', 400, { current: cur })), null);
  assert.equal(staleCurrent(new Error('x')), null);
});

test('footnote references, definitions and tables read as text tokens', () => {
  const md = [
    '# Report',
    '',
    '## Open tasks',
    '',
    '| Task | Owner |',
    '| --- | --- |',
    '| [Fix it](#/projects/p/work/t1) | Ada \\| Bo |',
    '| [Evil](https://evil.example/x) | <b>x</b> |',
    '',
    'The vendor slipped.[^P1][^P2] **Bold** here.',
    '',
    '## Sources',
    '',
    '[^P1]: [Notes \\[draft\\] 5 Nov](#/projects/p/notes/n1)',
    '[^P2]: [Elsewhere](https://evil.example/y)',
  ].join('\n');
  const blocks = parseMarkdown(md);
  const table = blocks.find((b) => b.t === 'table');
  assert.ok(table && table.t === 'table');
  assert.equal(table.head.length, 2);
  assert.deepEqual(table.rows[0][0], [{ t: 'link', text: 'Fix it', href: '#/projects/p/work/t1' }]);
  assert.deepEqual(table.rows[0][1], [{ t: 'text', text: 'Ada | Bo' }]);
  // A link out of the app stays plain text (never an anchor); raw tags stay text.
  assert.deepEqual(table.rows[1][0], [{ t: 'text', text: '[Evil](https://evil.example/x)' }]);
  assert.deepEqual(table.rows[1][1], [{ t: 'text', text: '<b>x</b>' }]);
  const para = blocks.find((b) => b.t === 'p' && b.inlines.some((i) => i.t === 'fnref'));
  assert.ok(para && para.t === 'p');
  assert.deepEqual(para.inlines.filter((i) => i.t === 'fnref').map((i) => i.text), ['P1', 'P2']);
  const defs = blocks.find((b) => b.t === 'defs');
  assert.ok(defs && defs.t === 'defs');
  assert.deepEqual(defs.items, [
    { marker: 'P1', label: 'Notes [draft] 5 Nov', href: '#/projects/p/notes/n1' },
    { marker: 'P2', label: 'Elsewhere', href: null },
  ]);
  // A line that merely has a pipe is not a table.
  assert.equal(parseMarkdown('a | b').some((b) => b.t === 'table'), false);
});

test('a hidden brief is ignored once the kind is a record kind', () => {
  const f = { ...emptyDraftForm('status'), brief: 'x'.repeat(5000) };
  assert.equal(newDraftProblem(f), null);
  assert.equal(newDraftBody({ ...f, brief: 'left over' }).brief, undefined);
});

test('adversarial Markdown lines tokenize quickly', () => {
  const lines = ['['.repeat(100_000), `[${'a'.repeat(99_990)}`, `|a|\n|${' '.repeat(99_990)}`, `|${'-'.repeat(50_000)}${' '.repeat(49_990)}x`, '[a]('.repeat(20_000), '**a'.repeat(33_000), ' '.repeat(99_990) + '|'];
  // Generous: the point is that nothing grows quadratically, not how fast this machine is.
  const t = Date.now();
  for (const l of lines) parseMarkdown(l);
  assert.ok(Date.now() - t < 2000, 'adversarial lines took too long');
});

test('a table with alignment colons is still a table', () => {
  const b = parseMarkdown(['| a | b |', '|:--|--:|', '| 1 | 2 |'].join(String.fromCharCode(10)));
  assert.equal(b.length, 1);
  assert.equal(b[0].t, 'table');
  assert.equal(parseMarkdown(['| a | b |', '|:-:|:--|', '| 1 | 2 |'].join(String.fromCharCode(10)))[0].t, 'table');
});

// --- Task 13: shareable summaries and review lists ---
import {
  answerIdFromHash,
  approvalLines,
  highlightPieces,
  leaveOutCounter,
  leaveOutProblem,
  markProgress,
  markText,
  marksResolved,
  mayDraftSummary,
  newSummaryBody,
  openMarks,
  reasonProblem,
  reviewActions,
  type SummaryMark,
} from './assist.ts';

const mk = (id: string, kind: 'leave_out' | 'name', phrase: string, places: Array<[number, number]>, intended = false): SummaryMark => ({
  id,
  kind,
  phrase,
  places: places.map(([start, end]) => ({ start, end })),
  intended,
  intendedBy: null,
  intendedAt: null,
});

test('marks are listed with text equivalents and Approve stays disabled until all are resolved', () => {
  const marks = [mk('a', 'leave_out', 'Project Falcon', [[4, 18]]), mk('b', 'name', 'Dana Cole', [[30, 39]])];
  assert.equal(markText(marks[0]), 'Leave-out phrase: “Project Falcon” — not yet resolved');
  assert.equal(markText({ ...marks[1], intended: true }), 'Name: “Dana Cole” — Intended');
  assert.equal(marksResolved(marks), false);
  assert.equal(markProgress(marks), '0 of 2 marks resolved');
  assert.equal(marksResolved([{ ...marks[0], intended: true }, marks[1]]), false);
  assert.deepEqual(openMarks([{ ...marks[0], intended: true }, marks[1]]).map((m) => m.id), ['b']);
  assert.equal(marksResolved(marks.map((m) => ({ ...m, intended: true }))), true);
  assert.equal(marksResolved([]), true);
  // The text is cut at the marks, so each place shows with its kind and the rest stays plain.
  const body = 'See Project Falcon notes from Dana Cole today';
  const pieces = highlightPieces(body, marks.map((m, i) => ({ ...m, places: [i === 0 ? { start: 4, end: 18 } : { start: 30, end: 39 }] })));
  assert.equal(pieces.map((p) => p.text).join(''), body);
  assert.deepEqual(pieces.filter((p) => p.marks.length).map((p) => [p.text, p.marks[0].kind]), [['Project Falcon', 'leave_out'], ['Dana Cole', 'name']]);
  // Overlapping places are joined without losing text; out-of-range places are ignored.
  const o = highlightPieces('abcdefgh', [mk('x', 'leave_out', 'bcde', [[1, 5]]), mk('y', 'name', 'defg', [[3, 7]]), mk('z', 'name', 'q', [[50, 60]])]);
  assert.equal(o.map((p) => p.text).join(''), 'abcdefgh');
  assert.deepEqual(o.map((p) => [p.text, p.marks.map((m) => m.id)]), [['a', []], ['bc', ['x']], ['de', ['x', 'y']], ['fg', ['y']], ['h', []]]);
});

test('approve confirmation lists who gains access', () => {
  const lines = approvalLines({ versionNo: 3, audience: 'restricted', gainAccess: [{ id: '1', displayName: 'Ben' }, { id: '2', displayName: 'Cy' }] });
  assert.deepEqual(lines, ['Version 3 will be approved.', 'Audience: Restricted, the people named.', 'These people gain access: Ben, Cy.']);
  assert.match(approvalLines({ versionNo: 1, audience: 'project', gainAccess: [{ id: '1', displayName: 'Ben' }] })[2], /^This person gains access: Ben\.$/);
  assert.match(approvalLines({ versionNo: 1, audience: 'project', gainAccess: [] })[2], /^No one gains access/);
  assert.match(approvalLines({ versionNo: 1, audience: 'project', gainAccess: [] })[1], /Project-wide/);
});

test('review lists show reason and actions per role', () => {
  assert.deepEqual(reviewActions('answer', ['pm']), ['clear', 'withdraw']);
  assert.deepEqual(reviewActions('draft', ['deputy_pm']), ['clear', 'withdraw']);
  assert.deepEqual(reviewActions('answer', ['owner']), []);
  assert.deepEqual(reviewActions('summary', ['owner']), ['confirm', 'withdraw']);
  assert.deepEqual(reviewActions('summary', ['sponsor']), ['confirm', 'withdraw']);
  assert.deepEqual(reviewActions('summary', ['deputy_pm']), []);
  assert.deepEqual(reviewActions('summary', ['member']), []);
  assert.notEqual(reasonProblem('  '), null);
  assert.notEqual(reasonProblem('x'.repeat(501)), null);
  assert.equal(reasonProblem('Checked with the team'), null);
});

test('summary request form: leave-out limit, audience body and who may draft', () => {
  assert.equal(leaveOutCounter('abc'), '3 / 1,000');
  assert.equal(leaveOutProblem('x'.repeat(1000)), null);
  assert.notEqual(leaveOutProblem('x'.repeat(1001)), null);
  assert.deepEqual(newSummaryBody('project', ['u1'], ' Budget '), { intendedAudience: { mode: 'project', namedUserIds: [] }, leaveOut: 'Budget' });
  assert.deepEqual(newSummaryBody('restricted', ['u1'], ''), { intendedAudience: { mode: 'restricted', namedUserIds: ['u1'] }, leaveOut: '' });
  assert.equal(mayDraftSummary(['deputy_pm'], true), true);
  assert.equal(mayDraftSummary(['pm'], false), false);
  assert.equal(mayDraftSummary(['member'], true), false);
});

test('the answer in a thread address is read from the query', () => {
  const id = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
  assert.equal(answerIdFromHash(`#/projects/p/threads/t?answer=${id}`), id);
  assert.equal(answerIdFromHash(`#/projects/p/threads/t?m=3&answer=${id}`), id);
  assert.equal(answerIdFromHash('#/projects/p/threads/t?answer=nope'), null);
  assert.equal(answerIdFromHash('#/projects/p/threads/t'), null);
});
