// Feedback on AI output (spec 8): labels, form checks and who sees which actions. Pure, so they can be tested.
import { api } from './api.ts';

export type TargetKind = 'minutes_draft' | 'analysis_run' | 'proposal' | 'answer' | 'report_version' | 'summary_version';
export type Category = 'incorrect' | 'missed_item' | 'misleading' | 'other';
export type FeedbackStatus = 'open' | 'reviewed' | 'closed';

export const CATEGORY_LABEL: Record<Category, string> = { incorrect: 'Incorrect', missed_item: 'Missed item', misleading: 'Misleading', other: 'Other' };
export const CATEGORIES = Object.keys(CATEGORY_LABEL) as Category[];
export const STATUS_LABEL: Record<FeedbackStatus, string> = { open: 'Open', reviewed: 'Reviewed', closed: 'Closed' };
export const TARGET_LABEL: Record<TargetKind, string> = { minutes_draft: 'Draft minutes', analysis_run: 'Analysis', proposal: 'Proposal', answer: 'AI answer', report_version: 'Report draft', summary_version: 'Summary' };
export const MAX_NOTE = 2000;
export const NOTE_MESSAGE = `Write a note of 1 to ${MAX_NOTE.toLocaleString('en-US')} characters.`;
export const CATEGORY_MESSAGE = 'Choose what was wrong.';

export interface FeedbackView {
  /** "Possible credential removed — awaiting check" while this is a possible copy masked at once (history spec 7.4). */
  quarantineLabel?: string | null;
  id: string;
  projectId: string;
  targetKind: TargetKind;
  targetId: string;
  category: Category;
  note: string;
  status: FeedbackStatus;
  reporterId: string;
  reporterName: string;
  createdAt: string;
  escalatedAt: string | null;
}

export interface EscalatedRow { id: string; projectName: string; category: Category; model: string | null; runRef: string | null; at: string; escalationNote: string }

export const sendFeedback = (projectId: string, body: { targetKind: TargetKind; targetId: string; category: Category; note: string }) =>
  api.post<FeedbackView>(`/projects/${projectId}/feedback`, body);
export const listFeedback = (projectId: string) => api.get<{ feedback: FeedbackView[]; canReview: boolean }>(`/projects/${projectId}/feedback`);
export const setFeedbackStatus = (id: string, status: FeedbackStatus, note: string) => api.post<FeedbackView>(`/feedback/${id}/status`, { status, note });
export const escalateFeedback = (id: string, note: string) => api.post<FeedbackView>(`/feedback/${id}/escalate`, { note });
export const listEscalated = () => api.get<{ feedback: EscalatedRow[] }>('/admin/feedback');

/** Problems with the form, shown before anything is sent: a category is required, and a note of 1 to 2,000 characters. */
export function feedbackErrors(category: Category | '', note: string): string[] {
  const out: string[] = [];
  if (category === '') out.push(CATEGORY_MESSAGE);
  const n = note.trim().length;
  if (n < 1 || n > MAX_NOTE) out.push(NOTE_MESSAGE);
  return out;
}

/** Only AI output can be flagged; a draft version written by a person is refused by the server, so no button is offered. */
export const canFlagDraft = (d: { origin: 'ai' | 'human'; id?: string } | null): boolean => !!d && d.origin === 'ai' && !!d.id;

export interface StatusAction { to: FeedbackStatus; label: string }
const MOVES: Record<FeedbackStatus, StatusAction[]> = {
  open: [{ to: 'reviewed', label: 'Mark as reviewed' }],
  reviewed: [{ to: 'closed', label: 'Close' }, { to: 'open', label: 'Reopen' }],
  closed: [{ to: 'open', label: 'Reopen' }],
};
/** The status buttons for one item: the Project Manager and Deputy get the moves, nobody else gets any. */
export const statusActions = (status: FeedbackStatus, canReview: boolean): StatusAction[] => (canReview ? MOVES[status] : []);
export const canEscalate = (f: Pick<FeedbackView, 'escalatedAt'>, canReview: boolean): boolean => canReview && f.escalatedAt === null;

/** One line of the Administrator's list: project, category, model, run reference, time and the PM's note; nothing else. */
export function escalatedLine(r: EscalatedRow, formatWhen: (iso: string) => string): { id: string; fields: Array<[string, string]> } {
  return {
    id: r.id,
    fields: [
      ['Project', r.projectName],
      ['Category', CATEGORY_LABEL[r.category] ?? r.category],
      ['Model', r.model ?? 'Not recorded'],
      ['Run', r.runRef ?? 'Not recorded'],
      ['Escalated', formatWhen(r.at)],
      ['Note from the Project Manager', r.escalationNote],
    ],
  };
}
