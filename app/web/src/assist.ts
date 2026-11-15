// AI answers (spec 5.3, 5.4): the shapes the API returns, the calls, and the pure helpers the Ask panel and thread timeline use.
import { ApiError, api } from './api.ts';
import { todayUtc8 } from './changes.ts';
import type { MessageView, Person } from './discussion.ts';

export const MAX_QUESTION = 500;
export const BAD_QUESTION = `A question must be 1 to ${MAX_QUESTION} characters.`;
export const ANSWER_LABEL = 'AI answer — check the sources';
export const NOT_FOUND_NOTICE = 'Nothing in this project matched your question';
export const UNAVAILABLE_PREFIX = 'AI answer unavailable: ';
export const REANSWER_LABEL = 'Re-answer for this thread';
export const ANSWER_POLL_MS = 3_000;

export type AnswerStatus = 'queued' | 'running' | 'answered' | 'not_found' | 'failed' | 'blocked';

export interface AnswerSource {
  marker: string;
  location: string | null;
  href: string | null;
  cited: boolean;
  dropped: boolean;
}

export interface AnswerView {
  id: string;
  projectId: string;
  question: string | null;
  status: AnswerStatus;
  answerMarkdown: string | null;
  notice: string | null;
  unavailableReason: string | null;
  searchedWords: string[];
  label: string;
  askedBy: Person;
  askedByLabel: string;
  askedAt: string;
  answeredAt: string | null;
  model: string | null;
  visibility: 'private' | 'shared';
  sharedThreadId: string | null;
  sharedAt: string | null;
  hidden: boolean;
  sources: AnswerSource[];
  droppedCount: number;
}

/** An answer shared into a thread, as ThreadView.aiAnswers carries it. */
export interface ThreadAnswerView {
  id: string;
  askedBy: Person;
  question: string | null;
  answerMarkdown: string | null;
  sources: AnswerSource[];
  droppedCount: number;
  sharedAt: string;
  hidden: boolean;
  notice: string | null;
}

export const askQuestion = (projectId: string, question: string) => api.post<AnswerView>(`/projects/${projectId}/questions`, { question });
export const listQuestions = (projectId: string) => api.get<{ items: AnswerView[] }>(`/projects/${projectId}/questions`).then((r) => r.items);
export const getQuestion = (id: string) => api.get<AnswerView>(`/questions/${id}`);
export const shareQuestion = (id: string, threadId: string) => api.post<AnswerView>(`/questions/${id}/share`, { threadId });
export const reanswerQuestion = (id: string, threadId: string) => api.post<AnswerView>(`/questions/${id}/reanswer`, { threadId });
export const hideAnswer = (id: string, reason: string) => api.post<AnswerView>(`/questions/${id}/hide`, { reason });
export const unhideAnswer = (id: string, reason: string) => api.post<AnswerView>(`/questions/${id}/unhide`, { reason });

/** The problem with a question, shown before anything is sent: 1 to 500 characters. Null when it can be sent. */
export function questionProblem(text: string): string | null {
  const n = text.trim().length;
  return n < 1 || n > MAX_QUESTION ? BAD_QUESTION : null;
}

/** The counter beside the box, in characters of the trimmed question. */
export const questionCounter = (text: string): string => `${text.trim().length} / ${MAX_QUESTION}`;

/** Still being worked on: the panel polls every 3 seconds while any answer is in this state. */
export const isActive = (a: Pick<AnswerView, 'status'>): boolean => a.status === 'queued' || a.status === 'running';

/** The line that stands for an answer's state (the answer text itself is shown separately when there is one). */
export function statusText(a: Pick<AnswerView, 'status' | 'notice' | 'unavailableReason'>): string {
  switch (a.status) {
    case 'queued':
      return 'Waiting to start';
    case 'running':
      return 'Looking through the project';
    case 'answered':
      return a.notice ?? ANSWER_LABEL;
    case 'not_found':
      return a.notice ?? NOT_FOUND_NOTICE;
    case 'failed':
    case 'blocked':
      return a.notice ?? `${UNAVAILABLE_PREFIX}${a.unavailableReason ?? 'an unexpected error stopped the AI request'}`;
  }
}

/** What a refused share tells the person, and whether the "Re-answer for this thread" button is offered. */
export function shareRefusal(e: unknown): { message: string; canReanswer: boolean } {
  if (e instanceof ApiError) {
    const data = e.data as { canReanswer?: boolean } | undefined;
    return { message: e.message, canReanswer: e.status === 409 && data?.canReanswer === true };
  }
  return { message: 'Something went wrong. Try again.', canReanswer: false };
}

/** The panel's list after a load: by id, the fresh copy wins, items the load did not know about (just asked) are kept; newest first. */
export function mergeViews(old: AnswerView[], fresh: AnswerView[]): AnswerView[] {
  const byId = new Map<string, AnswerView>();
  for (const a of old) byId.set(a.id, a);
  for (const a of fresh) byId.set(a.id, a);
  return [...byId.values()].sort((a, b) => b.askedAt.localeCompare(a.askedAt) || b.id.localeCompare(a.id));
}

/** A source is only linked when it points inside the app. */
export const safeHref = (href: string | null): string | null => (href !== null && href.startsWith('#/') ? href : null);

/** Joins a poll to what is shown: by id (the server returns every shared answer each time); the fresh copy wins. */
export function mergeAnswers(old: ThreadAnswerView[], fresh: ThreadAnswerView[]): ThreadAnswerView[] {
  const byId = new Map<string, ThreadAnswerView>();
  for (const a of old) byId.set(a.id, a);
  for (const a of fresh) byId.set(a.id, a);
  return [...byId.values()].sort((a, b) => a.sharedAt.localeCompare(b.sharedAt) || a.id.localeCompare(b.id));
}

export type TimelineItem =
  | { kind: 'message'; at: string; message: MessageView }
  | { kind: 'answer'; at: string; answer: ThreadAnswerView };

/** Messages and shared answers in one list by time; at the same instant the message comes first. */
export function mergeTimeline(messages: MessageView[], answers: ThreadAnswerView[]): TimelineItem[] {
  const items: TimelineItem[] = [
    ...messages.map((message): TimelineItem => ({ kind: 'message', at: message.createdAt, message })),
    ...answers.map((answer): TimelineItem => ({ kind: 'answer', at: answer.sharedAt, answer })),
  ];
  const t = (i: TimelineItem) => new Date(i.at).getTime();
  return items
    .map((item, index) => ({ item, index }))
    .sort((x, y) => t(x.item) - t(y.item) || (x.item.kind === y.item.kind ? x.index - y.index : x.item.kind === 'message' ? -1 : 1))
    .map((x) => x.item);
}

export const answersAnnouncement = (arrived: ThreadAnswerView[]): string =>
  arrived.length === 0 ? '' : arrived.length === 1 ? `An AI answer was shared by ${arrived[0].askedBy.displayName}` : `${arrived.length} AI answers were shared`;

/** Sources used: dropped ones carry no place, so they are only counted. */
export function sourcesSummary(sources: AnswerSource[], droppedCount: number): { shown: AnswerSource[]; droppedText: string | null } {
  return {
    shown: sources.filter((s) => !s.dropped),
    droppedText: droppedCount > 0 ? `${droppedCount} ${droppedCount === 1 ? 'passage was' : 'passages were'} no longer available` : null,
  };
}

// --- A small, safe Markdown reading: text becomes tokens that React prints as text, never as HTML. ---

export type Inline = { t: 'text' | 'bold' | 'code' | 'marker' | 'fnref' | 'link'; text: string; href?: string };
export type Block =
  | { t: 'p'; inlines: Inline[] }
  | { t: 'h'; inlines: Inline[] }
  | { t: 'ul' | 'ol'; items: Inline[][] }
  | { t: 'table'; head: Inline[][]; rows: Inline[][][] }
  /** Footnote definitions (the Sources list of a draft): `[^P1]: [place](#/link)`; the link is kept only if it stays inside the app. */
  | { t: 'defs'; items: Array<{ marker: string; label: string; href: string | null }> };

const INLINE = /(\*\*[^*\n]+\*\*)|(`[^`\n]+`)|(\[\s*P\d+(?:\s*[,;]\s*P\d+)*\s*\])|(\[\^P\d+\])|(\[(?:\\.|[^\]\\\n])+\]\(#\/[^)\s]*\))/gi;

const FN_DEF = /^\s{0,3}\[\^(P\d+)\]:\s*(.*)$/i;
const FN_LINK = /^\[((?:\\.|[^\]\\])*)\]\(([^)\s]*)\)$/;
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/** The cells of one table row; `\|` is a pipe inside a cell. */
function splitRow(line: string): Inline[][] {
  const cells: string[] = [];
  let cur = '';
  for (let k = 0; k < line.length; k++) {
    if (line[k] === '\\' && line[k + 1] === '|') {
      cur += '|';
      k++;
    } else if (line[k] === '|') {
      cells.push(cur);
      cur = '';
    } else cur += line[k];
  }
  cells.push(cur);
  if (cells[0].trim() === '') cells.shift();
  if (cells.length > 0 && cells[cells.length - 1].trim() === '') cells.pop();
  return cells.map((c) => parseInline(c.trim()));
}

const isTableStart = (lines: string[], i: number): boolean =>
  lines[i].includes('|') && i + 1 < lines.length && lines[i + 1].includes('-') && TABLE_RULE.test(lines[i + 1]) && splitRow(lines[i]).length === splitRow(lines[i + 1]).length;

/** `[P1, P4]` becomes marker tokens P1 and P4 between plain separators; `**bold**` and `code` are kept. */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  const push = (t: Inline['t'], s: string) => {
    if (s) out.push({ t, text: s });
  };
  for (const m of text.matchAll(INLINE)) {
    push('text', text.slice(last, m.index));
    if (m[1]) push('bold', m[1].slice(2, -2));
    else if (m[2]) push('code', m[2].slice(1, -1));
    else if (m[4]) push('fnref', m[4].slice(2, -1).toUpperCase());
    else if (m[5]) {
      // A link is kept only when it points inside the app; otherwise its words stay as plain text.
      const k = m[5].lastIndexOf('](');
      const label = m[5].slice(1, k).replace(/\\([[\]])/g, '$1');
      const href = safeHref(m[5].slice(k + 2, -1));
      if (href) out.push({ t: 'link', text: label, href });
      else push('text', label);
    }
    else {
      push('text', '[');
      for (const p of m[3].slice(1, -1).split(/([,;])/)) {
        const s = p.trim();
        if (/^P\d+$/i.test(s)) push('marker', s.toUpperCase());
        else if (p === ',' || p === ';') push('text', `${p} `);
      }
      push('text', ']');
    }
    last = (m.index ?? 0) + m[0].length;
  }
  push('text', text.slice(last));
  return out;
}

export function parseMarkdown(md: string): Block[] {
  const blocks: Block[] = [];
  const BULLET = /^\s*[-*]\s+(.*)$/;
  const NUMBER = /^\s*\d+[.)]\s+(.*)$/;
  for (const chunk of md.replace(/\r\n?/g, '\n').split(/\n\s*\n/)) {
    const lines = chunk.split('\n').filter((l) => l.trim() !== '');
    let para: string[] = [];
    const flush = () => {
      if (para.length) blocks.push({ t: 'p', inlines: parseInline(para.join(' ')) });
      para = [];
    };
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (isTableStart(lines, i)) {
        flush();
        const head = splitRow(lines[i]);
        i += 2;
        const rows: Inline[][][] = [];
        while (i < lines.length && lines[i].includes('|')) {
          const cells = splitRow(lines[i]);
          while (cells.length < head.length) cells.push([]);
          rows.push(cells.slice(0, head.length));
          i++;
        }
        blocks.push({ t: 'table', head, rows });
        continue;
      }
      if (FN_DEF.test(line)) {
        flush();
        const items: Array<{ marker: string; label: string; href: string | null }> = [];
        while (i < lines.length && FN_DEF.test(lines[i])) {
          const [, marker, rest] = FN_DEF.exec(lines[i])!;
          const link = FN_LINK.exec(rest.trim());
          items.push(
            link
              ? { marker: marker.toUpperCase(), label: link[1].replace(/\\([[\]])/g, '$1'), href: safeHref(link[2]) }
              : { marker: marker.toUpperCase(), label: rest.trim(), href: null },
          );
          i++;
        }
        blocks.push({ t: 'defs', items });
        continue;
      }
      const heading = /^#{1,6}\s+(.*)$/.exec(line);
      const re = BULLET.test(line) ? BULLET : NUMBER.test(line) ? NUMBER : null;
      if (heading) {
        flush();
        blocks.push({ t: 'h', inlines: parseInline(heading[1]) });
        i++;
      } else if (re) {
        flush();
        const items: Inline[][] = [];
        while (i < lines.length && re.test(lines[i])) {
          items.push(parseInline(re.exec(lines[i])![1]));
          i++;
        }
        blocks.push({ t: re === BULLET ? 'ul' : 'ol', items });
      } else {
        para.push(line.trim());
        i++;
      }
    }
    flush();
  }
  return blocks;
}

// --- Drafts: reports and specifications (spec 6) ---

export type ReportKind = 'status' | 'decisions_actions' | 'risks' | 'specification' | 'free_form';
export const REPORT_KINDS: Array<{ value: ReportKind; label: string }> = [
  { value: 'status', label: 'Status report' },
  { value: 'decisions_actions', label: 'Decisions and actions log' },
  { value: 'risks', label: 'Risk summary' },
  { value: 'specification', label: 'Specification' },
  { value: 'free_form', label: 'Free-form' },
];
export const DRAFT_LABEL = 'AI draft — not approved';
export const DRAFT_POLL_MS = 3_000;
export const MAX_TITLE = 200;
export const MAX_BRIEF = 2_000;
export const MAX_BODY = 100_000;
export const MAX_CHOSEN = 10;
export const PERIOD_DAYS = 14;
export const REGENERATE_WARNING = 'A new AI version does not include edits people made to earlier versions.';
export const STALE_EDIT = 'Someone changed this since you opened it';

export type DraftStatus = 'queued' | 'running' | 'ready' | 'failed' | 'blocked';
export interface DraftVersion {
  id: string;
  no: number;
  origin: 'ai' | 'human';
  createdBy: Person | null;
  editedByLabel: string | null;
  createdAt: string;
}
export interface DraftListItem {
  id: string;
  kind: ReportKind;
  kindLabel: string;
  title: string;
  requestedBy: Person;
  createdAt: string;
  shared: boolean;
  inReview: boolean;
  status: DraftStatus;
  versionCount: number;
  updatedAt: string;
  notice: string | null;
}
export interface DraftView {
  id: string;
  projectId: string;
  kind: ReportKind;
  kindLabel: string;
  title: string;
  period: { from: string; to: string } | null;
  brief: string | null;
  chosen: { sourceIds: string[]; threadIds: string[] };
  requestedBy: Person;
  createdAt: string;
  shared: boolean;
  sharedAt: string | null;
  inReview: boolean;
  label: string;
  status: DraftStatus;
  unavailableReason: string | null;
  notice: string | null;
  canEdit: boolean;
  canRegenerate: boolean;
  canShare: boolean;
  canUnshare: boolean;
  versions: DraftVersion[];
  current: (DraftVersion & { body: string }) | null;
}
export interface NewDraft {
  kind: ReportKind;
  title?: string;
  periodFrom?: string;
  periodTo?: string;
  brief?: string;
  chosen?: { sourceIds: string[]; threadIds: string[] };
}

export const createDraft = (projectId: string, body: NewDraft) => api.post<DraftView>(`/projects/${projectId}/reports`, body);
export const listDrafts = (projectId: string) => api.get<{ items: DraftListItem[] }>(`/projects/${projectId}/reports`).then((r) => r.items);
export const getDraft = (id: string) => api.get<DraftView>(`/reports/${id}`);
export const getDraftVersion = (id: string, no: number) => api.get<DraftVersion & { body: string }>(`/reports/${id}/versions/${no}`);
export const editDraft = (id: string, body: string, basedOnVersion: number) => api.put<DraftView>(`/reports/${id}`, { body, basedOnVersion });
export const regenerateDraft = (id: string) => api.post<DraftView>(`/reports/${id}/regenerate`);
export const shareDraft = (id: string) => api.post<DraftView>(`/reports/${id}/share`);
export const unshareDraft = (id: string) => api.post<DraftView | { id: string; shared: false; visible: false }>(`/reports/${id}/unshare`);
export const draftDownloadUrl = (id: string, no: number) => api.url(`/reports/${id}/versions/${no}/markdown`);

export const isRecordKind = (k: ReportKind): boolean => k === 'status' || k === 'decisions_actions' || k === 'risks';
export const isDraftActive = (d: Pick<DraftView, 'status'>): boolean => d.status === 'queued' || d.status === 'running';

const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** The default period: the last 14 days to today, in UTC+8 (today and the 13 days before). */
export function defaultPeriod(now: number = Date.now()): { from: string; to: string } {
  const to = todayUtc8(now);
  return { from: addDays(to, -(PERIOD_DAYS - 1)), to };
}

export interface NewDraftForm {
  kind: ReportKind;
  title: string;
  brief: string;
  periodFrom: string;
  periodTo: string;
  sourceIds: string[];
  threadIds: string[];
}

const BAD_PERIOD = 'A period needs two dates, the first not after the second.';

/** What is wrong with the form, shown before anything is sent; null when it can be sent. */
export function newDraftProblem(f: NewDraftForm): string | null {
  const title = f.title.trim().length;
  const brief = f.brief.trim().length;
  const free = f.kind === 'free_form';
  if (title > MAX_TITLE || (free && title < 1)) return `A title must be 1 to ${MAX_TITLE} characters.`;
  if (brief > MAX_BRIEF || (free && brief < 1)) return 'A brief must be 1 to 2,000 characters.';
  if (!isRecordKind(f.kind)) {
    const n = f.sourceIds.length + f.threadIds.length;
    if (n < 1 || n > MAX_CHOSEN) return `Choose 1 to ${MAX_CHOSEN} sources or threads.`;
  }
  if ((f.periodFrom === '') !== (f.periodTo === '') || f.periodFrom > f.periodTo) return BAD_PERIOD;
  return null;
}

/** The request body for a form. Sources and threads are sent only for specification and free-form. */
export function newDraftBody(f: NewDraftForm): NewDraft {
  const body: NewDraft = { kind: f.kind };
  if (f.title.trim() !== '') body.title = f.title.trim();
  if (f.brief.trim() !== '') body.brief = f.brief.trim();
  if (f.periodFrom !== '' && f.periodTo !== '') {
    body.periodFrom = f.periodFrom;
    body.periodTo = f.periodTo;
  }
  if (!isRecordKind(f.kind)) body.chosen = { sourceIds: f.sourceIds, threadIds: f.threadIds };
  return body;
}

/** A fresh form for a kind: the record kinds start with the last 14 days filled in; the others have no period unless one is chosen. */
export function emptyDraftForm(kind: ReportKind, now: number = Date.now()): NewDraftForm {
  const p = isRecordKind(kind) ? defaultPeriod(now) : { from: '', to: '' };
  return { kind, title: '', brief: '', periodFrom: p.from, periodTo: p.to, sourceIds: [], threadIds: [] };
}

/** The line that labels a version: AI versions are not approved; human versions say who edited. */
export const versionLabel = (v: Pick<DraftVersion, 'origin' | 'editedByLabel'>): string =>
  v.origin === 'ai' ? DRAFT_LABEL : (v.editedByLabel ?? 'Edited by a person');

/** A stale edit (409) carries the draft as it is now; the editor offers that current version. */
export function staleCurrent(e: unknown): DraftView | null {
  if (e instanceof ApiError && e.status === 409) return (e.data as { current?: DraftView } | undefined)?.current ?? null;
  return null;
}

export type DiffLine = { op: 'same' | 'added' | 'removed'; text: string };

/** A simple line diff (longest common run of lines): lines only in `a` are removed, lines only in `b` are added. */
export function lineDiff(a: string, b: string): DiffLine[] {
  const x = a.replace(/\r\n?/g, '\n').split('\n');
  const y = b.replace(/\r\n?/g, '\n').split('\n');
  const n = x.length;
  const m = y.length;
  const t: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) t[i][j] = x[i] === y[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      out.push({ op: 'same', text: x[i] });
      i++;
      j++;
    } else if (t[i + 1][j] >= t[i][j + 1]) out.push({ op: 'removed', text: x[i++] });
    else out.push({ op: 'added', text: y[j++] });
  }
  while (i < n) out.push({ op: 'removed', text: x[i++] });
  while (j < m) out.push({ op: 'added', text: y[j++] });
  return out;
}

/** The words that stand for a diff line, so colour is never the only signal. */
export const diffWord = (op: DiffLine['op']): string => (op === 'added' ? 'Added' : op === 'removed' ? 'Removed' : 'Unchanged');
