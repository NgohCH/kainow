/**
 * Deleting, restoring, the project's "Deletions and restorations" list and the Deleted items view (sub-project 5a).
 * The pure helpers here word what the screens print and mirror who is offered each button; the server decides every
 * change again and explains any refusal.
 */
import { api } from './api.ts';
import { formatDay } from './format.ts';
import type { ProjectRole, ProjectStatus } from './projects.ts';

export type DeletedKind = 'message' | 'note' | 'minutes' | 'summary' | 'task' | 'decision' | 'question' | 'risk';
export type RecordKind = 'task' | 'decision' | 'question' | 'risk';
export type SourceKind = 'note' | 'minutes' | 'summary';

export interface HistoryLine {
  at: string;
  kind: DeletedKind | 'credential_report';
  action: 'deleted' | 'restored' | 'reported';
  actor: string | null;
  reason: string | null;
  /** For a credential report, the kind of item it was reported in. */
  itemKind?: string;
  /** Only for a holder of Inspect Deleted Content. */
  title?: string;
  href?: string;
  /** Present when this viewer may restore the item now (the server decides). */
  restore?: { kind: 'source' | RecordKind; id: string };
}

export interface DeletedItem {
  kind: DeletedKind;
  id: string;
  title: string;
  deletedBy: string;
  deletedAt: string;
  deleteReason: string;
  href: string;
}

/** One Deleted item opened by a holder: the list entry plus its stored content (which fields exist depends on the kind). */
export type DeletedDetail = DeletedItem & {
  text?: string;
  versionNo?: number;
  status?: string;
  dueOn?: string;
  assignee?: string;
  rationale?: string | null;
  severity?: string;
  mitigation?: string | null;
  reviewOn?: string | null;
  answers?: Array<{ text: string; author: string; at: string }>;
  no?: number;
  threadId?: string;
  author?: string;
  createdAt?: string;
};

export const KIND_NOUN: Record<DeletedKind, string> = {
  message: 'message',
  note: 'note',
  minutes: 'set of minutes',
  summary: 'summary',
  task: 'task',
  decision: 'decision',
  question: 'question',
  risk: 'risk',
};

/** What a quarantine case says it was reported in; an unknown kind is shown with its underscores as spaces. */
const ITEM_KIND_NOUN: Record<string, string> = { ...KIND_NOUN, notes: 'note', discussion: 'discussion', thread: 'discussion' };
const itemKindNoun = (k: string | undefined): string => (k ? (ITEM_KIND_NOUN[k] ?? k.replace(/_/g, ' ')) : 'item');

/** `3 Dec 2026 — A task was deleted by Aisyah Rahman — "Duplicate"`. Never carries the item's title or text. */
export function historyLineText(l: HistoryLine): string {
  const day = formatDay(l.at);
  if (l.kind === 'credential_report') {
    return `${day} — A suspected credential was reported in a ${itemKindNoun(l.itemKind)}${l.actor ? ` by ${l.actor}` : ''}`;
  }
  const noun = KIND_NOUN[l.kind];
  return `${day} — A ${noun} was ${l.action}${l.actor ? ` by ${l.actor}` : ''}${l.reason ? ` — "${l.reason}"` : ''}`;
}

/** The title and link of a line, which the server sends only to a holder of Inspect Deleted Content. */
export function historyLineTitle(l: HistoryLine): { title: string; href: string } | null {
  return l.title !== undefined && l.href !== undefined ? { title: l.title, href: l.href } : null;
}

/** `Deleted — Aisyah Rahman, 3 Dec 2026: Duplicate`. */
export const deletedLabel = (by: string, at: string, reason: string): string => `Deleted — ${by}, ${formatDay(at)}: ${reason}`;

/** `Record deletion delegated to Mei Lin by Daniel Tan`. */
export const delegationLabel = (pm: string, by: string): string => `Record deletion delegated to ${pm} by ${by}`;

export const REASON_MAX = 1000;
/** Why a deletion, restoration or delegation reason cannot be sent, or null. The server checks again (and for credentials). */
export function reasonProblem(reason: string): string | null {
  const r = reason.trim();
  if (r === '') return 'Give a reason.';
  if (r.length > REASON_MAX) return `Keep the reason to 1,000 characters or fewer (it is ${r.length.toLocaleString('en-US')}).`;
  return null;
}

/** What the restore dialog shows: the people first, and no confirming until they are known. `names` is null while loading. */
export function restoreDialogView(names: string[] | null): { intro: string; names: string[]; empty: string | null; canConfirm: boolean } {
  return {
    intro: 'These people will be able to see it again',
    names: names ?? [],
    empty: names !== null && names.length === 0 ? 'No one at present: nobody can read it under the current audience rules.' : null,
    canConfirm: names !== null,
  };
}

const OPEN: readonly ProjectStatus[] = ['draft', 'planned', 'active'];
const has = (roles: readonly ProjectRole[], ...want: ProjectRole[]) => roles.some((r) => want.includes(r));

/** Sources: Project Manager, Owner, Sponsor; deleting only while the project is Draft, Planned or Active. */
export const mayDeleteSource = (roles: readonly ProjectRole[], status: ProjectStatus): boolean => OPEN.includes(status) && has(roles, 'pm', 'owner', 'sponsor');
export const mayRestoreSource = (roles: readonly ProjectRole[]): boolean => has(roles, 'pm', 'owner', 'sponsor');
/** Records: Owner, Sponsor, or the Project Manager while deletion is delegated (D83). */
export const mayDeleteRecord = (roles: readonly ProjectRole[], status: ProjectStatus, delegated: boolean): boolean =>
  OPEN.includes(status) && (has(roles, 'owner', 'sponsor') || (delegated && has(roles, 'pm')));
export const mayRestoreRecord = (roles: readonly ProjectRole[], delegated: boolean): boolean => has(roles, 'owner', 'sponsor') || (delegated && has(roles, 'pm'));
export const mayDelegateDeletion = (roles: readonly ProjectRole[]): boolean => has(roles, 'owner', 'sponsor');

export const isRecordKind = (k: DeletedKind): k is RecordKind => k === 'task' || k === 'decision' || k === 'question' || k === 'risk';

/** The paths for deleting and restoring one item; a source and a record go to different routes. Messages use their own (Discussion). */
export function itemPaths(kind: SourceKind | RecordKind, id: string): { delete: string; restore: string; preview: string } {
  const base = isRecordKind(kind) ? `/records/${kind}/${id}` : `/sources/${id}`;
  return { delete: `${base}/delete`, restore: `${base}/restore`, preview: `${base}/restore-preview` };
}

export const deleteItem = (kind: SourceKind | RecordKind, id: string, reason: string) => api.post<unknown>(itemPaths(kind, id).delete, { reason });
export const restoreItem = (kind: SourceKind | RecordKind, id: string, reason: string) => api.post<unknown>(itemPaths(kind, id).restore, { reason });
export const restorePreview = async (kind: SourceKind | RecordKind, id: string): Promise<string[]> => (await api.get<{ names: string[] }>(itemPaths(kind, id).preview)).names;

export const listDeletions = async (projectId: string): Promise<HistoryLine[]> => (await api.get<{ lines: HistoryLine[] }>(`/projects/${projectId}/history/deletions`)).lines;
export const listDeletedItems = async (projectId: string): Promise<DeletedItem[]> => (await api.get<{ items: DeletedItem[] }>(`/projects/${projectId}/deleted-items`)).items;
export const getDeletedItem = (projectId: string, kind: DeletedKind, id: string) => api.get<DeletedDetail>(`/projects/${projectId}/deleted-items/${kind}/${id}`);

export const delegateDeletion = (projectId: string, reason: string) => api.post<unknown>(`/projects/${projectId}/record-deletion-delegation`, { reason });
export const revokeDeletionDelegation = (projectId: string, reason: string) => api.post<unknown>(`/projects/${projectId}/record-deletion-delegation/revoke`, { reason });

/** The sentence under a "Review: decision changed" flag. A decision that was deleted arrives with no id and the text "a deleted record". */
export function flagSentence(decision: { id: string | null; statement: string; status: string }): string {
  return decision.id === null ? 'The decision this depends on is now a deleted record' : `“${decision.statement}” is now ${decision.status}`;
}
