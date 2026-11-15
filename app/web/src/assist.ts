// AI answers (spec 5.3, 5.4): the shapes the API returns, the calls, and the pure helpers the Ask panel and thread timeline use.
import { ApiError, api } from './api.ts';
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

export type Inline = { t: 'text' | 'bold' | 'code' | 'marker'; text: string };
export type Block =
  | { t: 'p'; inlines: Inline[] }
  | { t: 'h'; inlines: Inline[] }
  | { t: 'ul' | 'ol'; items: Inline[][] };

const INLINE = /(\*\*[^*\n]+\*\*)|(`[^`\n]+`)|(\[\s*P\d+(?:\s*[,;]\s*P\d+)*\s*\])/gi;

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
