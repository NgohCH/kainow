// Notes & discussion: the shapes the API returns, the calls, and the pure helpers the list and thread screens use.
import { ApiError, api, type Membership } from './api.ts';
import { formatWhen } from './format.ts';

export interface Person {
  id: string;
  displayName: string;
}

export interface AudienceView {
  id: string;
  mode: 'project' | 'restricted';
  namedUsers: Person[];
  changedAt: string | null;
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
  audience: AudienceView;
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

// --- Meetings, minutes, publishing, audiences (Task 16) ---

export const AI_DRAFT_LABEL = 'AI draft — not official minutes';

export interface MinutesVersionSummary {
  versionNo: number;
  origin: 'ai' | 'human';
  author: Person | null;
  trigger: string | null;
  createdAt: string;
  coversThroughNo: number;
}

export interface DraftView {
  versionNo: number;
  origin: 'ai' | 'human';
  body: string;
  coversThroughNo: number;
  createdAt: string;
  author: Person | null;
  editedFromVersion: number | null;
  label: string;
}

export interface MinutesView {
  current: DraftView | null;
  versions: MinutesVersionSummary[];
  hasHumanVersion: boolean;
  canEdit: boolean;
  canPublish: boolean;
}

export interface PublishResult {
  sourceId: string;
  versionNo: number;
  extractionRunId: string | null;
  notice: string | null;
}

export interface AudienceChangeBody {
  mode: 'project' | 'restricted';
  namedUserIds: string[];
}

export const startMeeting = (projectId: string, body: { title: string; meetingDate: string; audience: AudienceChangeBody }) =>
  api.post<ThreadView>(`/projects/${projectId}/threads`, { kind: 'meeting', ...body });
export const setPresent = (threadId: string, userIds: string[]) => api.put<Person[]>(`/threads/${threadId}/present`, { userIds });
export const endMeeting = (threadId: string) => api.post<ThreadView>(`/threads/${threadId}/end`);
export const getMinutes = (threadId: string) => api.get<MinutesView>(`/threads/${threadId}/minutes`);
export const getMinutesVersion = (threadId: string, versionNo: number) => api.get<DraftView>(`/threads/${threadId}/minutes/${versionNo}`);
export const saveMinutes = (threadId: string, body: string, basedOnVersion: number) =>
  api.post<DraftView>(`/threads/${threadId}/minutes`, { body, basedOnVersion });
export const requestMinutesDraft = (threadId: string) => api.post(`/threads/${threadId}/minutes/draft`);
export const publishDraft = (threadId: string, versionNo: number) => api.post<PublishResult>(`/threads/${threadId}/minutes/${versionNo}/publish`);
export const submitDraft = (threadId: string, versionNo: number) => api.post<{ id: string }>(`/threads/${threadId}/minutes/${versionNo}/submit`);
export const publishSubmission = (sourceId: string, audience?: AudienceChangeBody) =>
  api.post<PublishResult>(`/notes/${sourceId}/publish`, audience ? { audience } : {});
export const returnSubmission = (sourceId: string, reason: string) => api.post(`/notes/${sourceId}/return`, { reason });
export const previewAudience = (audienceId: string, change: AudienceChangeBody) =>
  api.post<{ gain: Person[]; lose: Person[] }>(`/audiences/${audienceId}/preview`, change);
export const changeAudience = (audienceId: string, change: AudienceChangeBody, reason: string) =>
  api.put<{ mode: 'project' | 'restricted'; namedUsers: Person[] }>(`/audiences/${audienceId}`, { ...change, reason });

/** A poll answered 404 or 403: the person can no longer read this thread (access lost or the audience narrowed). */
export function isAccessLost(e: unknown): boolean {
  return e instanceof ApiError && (e.status === 404 || e.status === 403);
}

export const NOT_AVAILABLE = 'This thread is not available to you.';

/** Line-based diff by longest common subsequence, for comparing two versions of draft minutes. */
export function diffLines(a: string, b: string): Array<{ kind: 'same' | 'added' | 'removed'; text: string }> {
  const x = a === '' ? [] : a.split('\n');
  const y = b === '' ? [] : b.split('\n');
  const lcs: number[][] = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) {
      lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: Array<{ kind: 'same' | 'added' | 'removed'; text: string }> = [];
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) {
      out.push({ kind: 'same', text: x[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) out.push({ kind: 'removed', text: x[i++] });
    else out.push({ kind: 'added', text: y[j++] });
  }
  while (i < x.length) out.push({ kind: 'removed', text: x[i++] });
  while (j < y.length) out.push({ kind: 'added', text: y[j++] });
  return out;
}

/** The label and outline of a draft: every draft, edited or not, keeps the AI label and the dashed outline of AI proposals. */
export function draftBanner(d: Pick<DraftView, 'origin' | 'label' | 'editedFromVersion'>): { label: string; className: string; fromLine: string | null } {
  return {
    label: d.label,
    className: 'ai-proposed draft-box',
    fromLine: d.origin === 'human' && d.editedFromVersion !== null ? `Edited from version ${d.editedFromVersion}` : null,
  };
}

/** The warning beside the Draft minutes button once a person has edited the minutes. */
export function draftMinutesWarning(hasHumanVersion: boolean): string | null {
  return hasHumanVersion ? 'A new AI draft is built from the messages and does not include edits made by people' : null;
}

const byName = (a: Person, b: Person) => a.displayName.localeCompare(b.displayName) || a.id.localeCompare(b.id);
const RESTRICTED_ROLE = new Set(['pm', 'deputy_pm', 'owner', 'sponsor']);

/**
 * Who can read a source with this audience: for Project-wide every current participant, for Restricted the Project Manager,
 * Deputies, Owners and Sponsors plus the named people. `named` supplies names for named people who are not participants.
 */
export function readersOf(memberships: Membership[], mode: 'project' | 'restricted', namedIds: string[], named: Person[] = []): Person[] {
  const out = new Map<string, Person>();
  for (const m of memberships) {
    if (m.state !== 'active') continue;
    if (mode === 'project' || RESTRICTED_ROLE.has(m.role) || namedIds.includes(m.userId)) out.set(m.userId, { id: m.userId, displayName: m.displayName });
  }
  if (mode === 'restricted') for (const p of named) if (namedIds.includes(p.id) && !out.has(p.id)) out.set(p.id, p);
  return [...out.values()].sort(byName);
}

/** People who can be marked Present: current participants who can read the meeting. */
export function presentCandidates(memberships: Membership[], audience: AudienceView): Person[] {
  return readersOf(memberships, audience.mode, audience.namedUsers.map((p) => p.id), audience.namedUsers).filter((p) =>
    memberships.some((m) => m.userId === p.id && m.state === 'active'),
  );
}

/** The sentence under Start meeting, listing exactly who will be able to read. */
export function meetingStartConfirmation(memberships: Membership[], mode: 'project' | 'restricted', namedIds: string[]): string {
  if (mode === 'project') return 'Everyone in the project will be able to read this meeting and its minutes.';
  const names = readersOf(memberships, mode, namedIds).map((p) => p.displayName);
  return `Only these people will be able to read this meeting and its minutes: ${names.join(', ')}.`;
}

/** The line shown before publishing, naming the audience that will read the result. */
export function publishConfirmation(title: string, versionNo: number, audience: AudienceView, memberships: Membership[]): string {
  const who =
    audience.mode === 'project'
      ? 'everyone in the project (Project-wide)'
      : `Restricted — ${readersOf(memberships, 'restricted', audience.namedUsers.map((p) => p.id), audience.namedUsers)
          .map((p) => p.displayName)
          .join(', ')}`;
  return `Publish version ${versionNo} of ${title} to: ${who}.`;
}

export const restrictedLabel = (mode: 'project' | 'restricted'): string | null => (mode === 'restricted' ? 'Source restricted' : null);

const DAY = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kuala_Lumpur', day: 'numeric', month: 'short', year: 'numeric' });
const DAY_TIME = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kuala_Lumpur', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
/** "11 Nov 2026" in UTC+8. */
export const formatDay = (iso: string): string => DAY.format(new Date(iso)).replace(/\bSept\b/, 'Sep');
/** "11 Nov 10:31" in UTC+8. */
export const formatDayTime = (iso: string): string => DAY_TIME.format(new Date(iso)).replace(',', '').replace(/\bSept\b/, 'Sep');

/** "Access changed <d MMM yyyy>" for 30 days after a change. */
export function accessChangedLabel(changedAt: string | null, now: Date = new Date()): string | null {
  if (!changedAt) return null;
  const age = now.getTime() - new Date(changedAt).getTime();
  return age >= 0 && age <= 30 * 86_400_000 ? `Access changed ${formatDay(changedAt)}` : null;
}

export type SourceFlag = 'deleted' | 'hidden';
const FLAG_TEXT: Record<SourceFlag, string> = { deleted: 'Source message deleted — review', hidden: 'Source message hidden — review' };
export const sourceFlagText = (f: SourceFlag): string => FLAG_TEXT[f];

export interface DiscussionEvidence {
  threadId: string;
  messageNo: number;
  authorName: string;
  at: string;
}

/** The supporting quote of a record or proposal as the server sends it: the text, or a marker that it is in a restricted source. */
export type EvidenceSource =
  | { restricted: true }
  | { quote: string; sourceFlag?: SourceFlag | null; discussionEvidence?: DiscussionEvidence | null };

export type EvidenceShown =
  | { kind: 'restricted'; text: string }
  | { kind: 'quote'; quote: string; flag: string | null; from: string | null; href: string | null };

export function evidenceView(source: EvidenceSource, projectId?: string): EvidenceShown {
  if ('restricted' in source) return { kind: 'restricted', text: 'Evidence in a restricted source' };
  const ev = source.discussionEvidence ?? null;
  return {
    kind: 'quote',
    quote: source.quote,
    flag: source.sourceFlag ? sourceFlagText(source.sourceFlag) : null,
    from: ev ? `Message #${ev.messageNo} by ${ev.authorName}, ${formatDayTime(ev.at)}` : null,
    href: ev && projectId ? `${threadPath(projectId, ev.threadId)}?m=${ev.messageNo}` : null,
  };
}

/**
 * Whether the quote offsets of a proposal run can be used to mark passages in the text shown. A discussion transcript is shown
 * with hidden and deleted messages masked, which changes the length of the text, so offsets are never used for a discussion source,
 * whatever the items say.
 */
export function canMarkByOffset(sourceKind: string | undefined): boolean {
  return sourceKind !== 'discussion';
}

/** What the occurrence chooser prints for a place in a discussion transcript: the server's message label, never message text. */
export const occurrenceChoiceText = (label: string | null | undefined): string => label ?? 'A place in the discussion';
