// Notes & discussion: the shapes the API returns, the calls, and the pure helpers the list and thread screens use.
import { api } from './api.ts';
import { formatWhen } from './format.ts';

export interface Person {
  id: string;
  displayName: string;
}

export type MessageState = 'visible' | 'hidden' | 'deleted';

export interface MessageView {
  id: string;
  no: number;
  author: Person;
  createdAt: string;
  edited: boolean;
  version: number;
  state: MessageState;
  text: string | null;
  notice: string | null;
  replyTo: { id: string; no: number; quote: string | null; notice: string | null } | null;
}

export interface ThreadView {
  id: string;
  projectId: string;
  kind: 'discussion' | 'meeting';
  title: string;
  audience: { mode: 'project' | 'restricted'; namedUsers: Person[]; changedAt: string | null };
  meetingDate: string | null;
  state: 'open' | 'ended' | null;
  messages: MessageView[];
  present: Person[];
  canPost: boolean;
  canModerate: boolean;
}

export interface DiscussionItem {
  kind: 'discussion' | 'meeting' | 'notes' | 'minutes' | 'submission';
  id: string;
  title: string;
  lastActivityAt: string;
  meetingDate: string | null;
  state: 'open' | 'ended' | null;
  audienceMode: 'project' | 'restricted';
  messageCount: number | null;
  label: string | null;
}

export interface MessageVersion {
  versionNo: number;
  text: string;
  createdAt: string;
}

export interface AnalysisStatusView {
  status: { state: string };
  line: string;
  explanation: string;
  lastFailure: string | null;
}

export type ModerationAction = 'hide' | 'unhide' | 'delete' | 'restore';

export const listDiscussion = (projectId: string) =>
  api.get<{ items: DiscussionItem[] }>(`/projects/${projectId}/discussion`).then((r) => r.items);
export const startThread = (projectId: string, title: string) =>
  api.post<ThreadView>(`/projects/${projectId}/threads`, { kind: 'discussion', title });
export const getThread = (threadId: string) => api.get<ThreadView>(`/threads/${threadId}`);
export const postMessage = (threadId: string, body: string, replyToId?: string) =>
  api.post<MessageView>(`/threads/${threadId}/messages`, { body, ...(replyToId ? { replyToId } : {}) });
export const editMessage = (messageId: string, body: string, basedOnVersion: number) =>
  api.put<MessageView>(`/messages/${messageId}`, { body, basedOnVersion });
export const moderate = (messageId: string, action: ModerationAction, reason: string) =>
  api.post<MessageView>(`/messages/${messageId}/${action}`, { reason });
export const messageVersions = (messageId: string) =>
  api.get<{ versions: MessageVersion[] }>(`/messages/${messageId}/versions`).then((r) => r.versions);
export const analysisStatus = (threadId: string) => api.get<AnalysisStatusView>(`/threads/${threadId}/analysis`);
export const analyseNow = (threadId: string, confirmRepeat = false) =>
  api.post(`/threads/${threadId}/analyse`, confirmRepeat ? { confirmRepeat: true } : {});
export const analyseSelected = (threadId: string, messageIds: string[]) => api.post(`/threads/${threadId}/analyse-selected`, { messageIds });

/** 5 seconds for an open thread on a visible tab, 30 seconds otherwise (spec 9). */
export function pollDelay(visible: boolean): number {
  return visible ? 5_000 : 30_000;
}

/** Joins what a poll brought to what is already shown: by id, the newer copy wins, in message order. */
export function mergeMessages(old: MessageView[], fresh: MessageView[]): MessageView[] {
  const byId = new Map<string, MessageView>();
  for (const m of old) byId.set(m.id, m);
  for (const m of fresh) {
    const had = byId.get(m.id);
    // A moderation change keeps the version number, so an equal version from the server is the newer copy.
    if (!had || m.version >= had.version) byId.set(m.id, m);
  }
  return [...byId.values()].sort((a, b) => a.no - b.no);
}

/** What the screen prints for one message. */
export function messageLines(m: MessageView): { byline: string; edited: boolean; text: string | null; notice: string | null; replyLine: string | null } {
  let replyLine: string | null = null;
  if (m.replyTo) {
    replyLine =
      m.replyTo.quote !== null
        ? `In reply to #${m.replyTo.no}: “${m.replyTo.quote}”`
        : `${m.replyTo.notice ?? 'Reply to an unavailable message'} (#${m.replyTo.no})`;
  }
  return { byline: `#${m.no} · ${m.author.displayName} · ${formatWhen(m.createdAt)}`, edited: m.edited, text: m.text, notice: m.notice, replyLine };
}

export type MessageActionName = 'reply' | 'edit' | 'hide' | 'unhide' | 'delete' | 'restore';

/** The buttons a person sees under a message. The server decides again on every request. */
export function messageActions(
  m: MessageView,
  who: { meId: string; canPost: boolean; canModerate: boolean; canRestore: boolean },
): MessageActionName[] {
  if (m.state === 'deleted') return who.canRestore ? ['restore'] : [];
  const mine = m.author.id === who.meId;
  const out: MessageActionName[] = [];
  if (m.state === 'visible' && who.canPost) out.push('reply');
  if (m.state === 'visible' && who.canPost && mine) out.push('edit');
  if (who.canModerate) out.push(m.state === 'hidden' ? 'unhide' : 'hide');
  if ((mine && who.canPost) || who.canModerate) out.push('delete');
  return out;
}

/** The polite live-region sentence for messages that arrived by a poll; your own messages are not announced. */
export function announcement(arrived: MessageView[], meId: string): string {
  const others = arrived.filter((m) => m.author.id !== meId);
  if (others.length === 0) return '';
  return others.length === 1 ? `New message from ${others[0].author.displayName}` : `${others.length} new messages`;
}

/** The lines of the status box: the status, the settings sentence, and the last failure when there was one. */
export function analysisBox(s: AnalysisStatusView): string[] {
  return [s.line, s.explanation, ...(s.lastFailure ? [`Last analysis failed: ${s.lastFailure}`] : [])];
}

export interface ThreadState {
  thread: ThreadView;
  meId: string;
  draft: string;
  replyToId: string | null;
  editing: { id: string; text: string; basedOn: number } | null;
  announce: string;
}

export type ThreadAction =
  | { type: 'polled'; thread: ThreadView }
  | { type: 'draft'; text: string }
  | { type: 'replyTo'; id: string | null }
  | { type: 'startEdit'; id: string; text: string; basedOn: number }
  | { type: 'editText'; text: string }
  | { type: 'cancelEdit' }
  | { type: 'posted'; message: MessageView }
  | { type: 'merged'; message: MessageView };

export function initialThread(thread: ThreadView, meId: string): ThreadState {
  return { thread, meId, draft: '', replyToId: null, editing: null, announce: '' };
}

/** A poll replaces what the server owns (messages, rights, title) and leaves what the person is typing alone. */
export function threadReducer(s: ThreadState, a: ThreadAction): ThreadState {
  switch (a.type) {
    case 'polled': {
      const known = new Set(s.thread.messages.map((m) => m.id));
      const arrived = a.thread.messages.filter((m) => !known.has(m.id));
      return { ...s, thread: { ...a.thread, messages: mergeMessages(s.thread.messages, a.thread.messages) }, announce: announcement(arrived, s.meId) };
    }
    case 'draft':
      return { ...s, draft: a.text };
    case 'replyTo':
      return { ...s, replyToId: a.id };
    case 'startEdit':
      return { ...s, editing: { id: a.id, text: a.text, basedOn: a.basedOn } };
    case 'editText':
      return s.editing ? { ...s, editing: { ...s.editing, text: a.text } } : s;
    case 'cancelEdit':
      return { ...s, editing: null };
    case 'posted':
      return { ...s, thread: { ...s.thread, messages: mergeMessages(s.thread.messages, [a.message]) }, draft: '', replyToId: null, announce: '' };
    case 'merged':
      return { ...s, thread: { ...s.thread, messages: mergeMessages(s.thread.messages, [a.message]) }, announce: '' };
  }
}

/** `#/projects/<p>/threads/<t>?m=<no>`; the message number is optional. */
export function parseThreadHash(hash: string): { projectId: string; threadId: string; messageNo: number | null } | null {
  const m = /^#\/projects\/([0-9a-z-]+)\/threads\/([0-9a-z-]+)(?:\?(.*))?$/i.exec(hash);
  if (!m) return null;
  const no = new URLSearchParams(m[3] ?? '').get('m');
  return { projectId: m[1], threadId: m[2], messageNo: no && /^\d{1,9}$/.test(no) ? Number(no) : null };
}

export const threadPath = (projectId: string, threadId: string): string => `#/projects/${projectId}/threads/${threadId}`;

export const KIND_TAG: Record<DiscussionItem['kind'], string> = {
  discussion: 'Discussion',
  meeting: 'Meeting',
  notes: 'Notes',
  minutes: 'Minutes',
  submission: 'Submitted notes',
};

/** Where a list item opens. */
export function itemHref(projectId: string, i: DiscussionItem): string {
  return i.kind === 'discussion' || i.kind === 'meeting' ? threadPath(projectId, i.id) : `#/notes/${i.id}`;
}

export const audienceTag = (mode: 'project' | 'restricted'): string => (mode === 'restricted' ? 'Restricted' : 'Project-wide');
