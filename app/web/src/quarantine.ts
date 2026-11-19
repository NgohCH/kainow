/**
 * Reporting a suspected secret, reviewing and releasing a held item, the Possible copies list, security reviewers and
 * quarantined-original grants (sub-project 5b). The pure helpers here word what the screens print and check what the
 * forms send; the server decides every change again. The marked text is never kept: forms clear it after sending, and
 * nothing here ever builds a line from it.
 */
import { blockedRunText, isBlockedCode } from './ai.ts';
import { api } from './api.ts';
import { formatDay } from './format.ts';

export type ItemKind =
  | 'message' | 'source' | 'task' | 'decision' | 'question' | 'risk' | 'proposal' | 'human_proposal'
  | 'answer' | 'report_draft' | 'summary' | 'minutes_draft' | 'feedback' | 'thread';

// Exact labels (spec 7.2, 7.4, 7.5, 7.7).
export const HELD_LABEL = 'Held — suspected credential, under review';
export const UNDER_REVIEW_LABEL = 'Credential removed — under review';
export const POSSIBLE_COPY_LABEL = 'Possible credential removed — awaiting check';
export const WAITING_FOR_KEY_LABEL = 'Waiting for the protected key';
export const DISCLOSURES_HEADING = 'Known disclosures (copies outside Kainow cannot be recalled)';
export const REVEAL_CONFIRMATION = 'I am viewing a quarantined credential for the stated purpose';
export const CREDENTIAL_MARKER = '[credential removed]';
/** The words that carry the marker's meaning without colour (screen readers hear these, and they print). */
export const MARKER_EQUIVALENT = 'credential removed';

export const MIN_MARK = 4;
export const REASON_MAX = 1000;

export const CASE_STATE_TEXT: Record<string, string> = {
  held: 'Held, being cleaned',
  cleaned: 'Cleaned, under review',
  released: 'Released',
  released_unchanged: 'Released unchanged (false alarm)',
};

const KIND_NOUN: Record<ItemKind, string> = {
  message: 'message',
  source: 'note',
  task: 'task',
  decision: 'decision',
  question: 'question',
  risk: 'risk',
  proposal: 'proposal',
  human_proposal: 'proposal',
  answer: 'AI answer',
  report_draft: 'report draft',
  summary: 'shareable summary',
  minutes_draft: 'minutes draft',
  feedback: 'feedback note',
  thread: 'discussion',
};
export const kindNoun = (k: string): string => KIND_NOUN[k as ItemKind] ?? k.replace(/_/g, ' ');

/** The cleaned text split so each `[credential removed]` can be drawn on its own (and joined back to the same text). */
export function markerSegments(text: string): Array<{ text: string; removed: boolean }> {
  const out: Array<{ text: string; removed: boolean }> = [];
  let at = 0;
  for (;;) {
    const i = text.indexOf(CREDENTIAL_MARKER, at);
    if (i < 0) break;
    if (i > at) out.push({ text: text.slice(at, i), removed: false });
    out.push({ text: CREDENTIAL_MARKER, removed: true });
    at = i + CREDENTIAL_MARKER.length;
  }
  if (at < text.length) out.push({ text: text.slice(at), removed: false });
  return out;
}

export interface ReportInput {
  marked: string[];
  reason: string;
}
export interface ReportProblems {
  marked: string | null;
  reason: string | null;
}

export function reasonProblem(reason: string): string | null {
  const r = reason.trim();
  if (r === '') return 'Give a reason.';
  if (r.length > REASON_MAX) return `Keep the reason to 1,000 characters or fewer (it is ${r.length.toLocaleString('en-US')}).`;
  return null;
}

/** Why a report cannot be sent yet (each null when fine). The server checks again, and refuses a secret typed into the reason. */
export function reportProblems(input: ReportInput): ReportProblems {
  const marked = input.marked.filter((m) => m.trim() !== '');
  let markedProblem: string | null = null;
  if (marked.length === 0) markedProblem = 'Select the secret in the text, or paste it, before reporting.';
  else if (marked.some((m) => m.length < MIN_MARK)) markedProblem = `The text to remove must be at least ${MIN_MARK} characters.`;
  return { marked: markedProblem, reason: reasonProblem(input.reason) };
}

export const reportBody = (kind: ItemKind, id: string, input: ReportInput) => ({
  kind,
  id,
  marked: input.marked.filter((m) => m.trim() !== ''),
  reason: input.reason.trim(),
});

// ---------------------------------------------------------------------------------------------------------------
// Possible copies
// ---------------------------------------------------------------------------------------------------------------

export interface PossibleCopy {
  kind: ItemKind;
  id: string;
  reference: string | null;
  foundAt: string;
  masked: boolean;
  decision: 'confirmed' | 'dismissed' | null;
  decidedAt: string | null;
  label: string | null;
}

/** One row of the Possible copies list: kind, reference and date only. Whatever else an object carries is ignored. */
export function copyLine(c: PossibleCopy): { text: string; label: string | null; decided: boolean; decisionText: string | null } {
  const ref = c.reference ? ` — ${c.reference}` : '';
  const decided = c.decision !== null;
  return {
    text: `A ${kindNoun(c.kind)}${ref} — found ${formatDay(c.foundAt)}`,
    label: c.label,
    decided,
    decisionText: decided ? `${c.decision === 'confirmed' ? 'Confirmed as a copy' : 'Dismissed — not the secret'}${c.decidedAt ? `, ${formatDay(c.decidedAt)}` : ''}` : null,
  };
}

export const decisionBody = (places: Array<{ kind: ItemKind; id: string }>, decision: 'confirmed' | 'dismissed') => ({
  decisions: places.map((p) => ({ kind: p.kind, id: p.id, decision })),
});

// ---------------------------------------------------------------------------------------------------------------
// Runner failure codes
// ---------------------------------------------------------------------------------------------------------------

/** What a failed or blocked run says: `held` and the AI-not-available codes are worded; any other code shows the server's detail. */
export function runFailureText(code: string | null, detail: string | null): string {
  if (code === 'held') return HELD_LABEL;
  if (isBlockedCode(code)) return blockedRunText(code, detail);
  return detail ?? '';
}

// ---------------------------------------------------------------------------------------------------------------
// Reveal original
// ---------------------------------------------------------------------------------------------------------------

export interface RevealedValue {
  table: string;
  column: string;
  rowKey: Record<string, unknown>;
  text: string;
  marks: Array<{ start: number; end: number }>;
}
export interface Revealed {
  caseId: string;
  kind: ItemKind;
  itemId: string;
  notice: string;
  values: RevealedValue[];
}

/** The tables that hold an item's own text; its values are shown before values of history and derived rows. */
const OWN_TABLES: Partial<Record<ItemKind, string[]>> = {
  message: ['message_versions'],
  source: ['sources', 'source_versions'],
  task: ['tasks'],
  decision: ['decisions'],
  question: ['questions', 'question_answers'],
  risk: ['risks'],
  proposal: ['extraction_items', 'extraction_item_edits'],
  human_proposal: ['human_proposals'],
  answer: ['ai_answers'],
  report_draft: ['report_drafts', 'report_draft_versions'],
  summary: ['summary_versions', 'summaries'],
  minutes_draft: ['minutes_drafts'],
  feedback: ['ai_feedback'],
  thread: ['discussion_threads'],
};

export function revealLines(kind: ItemKind, values: RevealedValue[]): Array<{ heading: string; segments: Array<{ text: string; removed: boolean }> }> {
  const own = OWN_TABLES[kind] ?? [];
  const rank = (v: RevealedValue) => (own.includes(v.table) ? 0 : 1);
  return values
    .map((v, i) => ({ v, i }))
    .sort((a, b) => rank(a.v) - rank(b.v) || a.i - b.i)
    .map(({ v }) => {
      const segments: Array<{ text: string; removed: boolean }> = [];
      let at = 0;
      for (const m of [...v.marks].sort((a, b) => a.start - b.start)) {
        if (m.start < at || m.end > v.text.length || m.end <= m.start) continue;
        if (m.start > at) segments.push({ text: v.text.slice(at, m.start), removed: false });
        segments.push({ text: v.text.slice(m.start, m.end), removed: true });
        at = m.end;
      }
      if (at < v.text.length) segments.push({ text: v.text.slice(at), removed: false });
      return { heading: `${v.table} — ${v.column}`, segments };
    });
}

// ---------------------------------------------------------------------------------------------------------------
// Server shapes and calls
// ---------------------------------------------------------------------------------------------------------------

export interface HeldCase {
  caseId: string;
  kind: ItemKind;
  itemId: string;
  state: string;
  label: string | null;
  reference: string | null;
  reporter: string;
  reason: string | null;
  reportedAt: string;
  cleanedAt: string | null;
}
export type CaseView = HeldCase & { text: string | null; markers: Array<{ start: number; end: number }> };

export interface Disclosures {
  aiRequests: Array<{ at: string; provider: string; model: string }>;
  emails: Array<{ at: string; recipients: number }>;
  audienceSize: number;
}
export interface SecurityCase {
  caseId: string;
  projectId: string;
  project: string;
  kind: ItemKind;
  itemId: string;
  reporter: string | null;
  state: string;
  waitingForKey: boolean;
  label: string | null;
  reportedAt: string;
  closedAt: string | null;
  disclosures: Disclosures;
  disclosuresLabel: string;
  changedSinceCleaning: Array<{ table: string; rowKey: Record<string, unknown>; label: string }>;
  /** The reported item and its confirmed copies, each of which Reveal original can open. */
  items?: Array<{ kind: ItemKind; id: string; role: string }>;
  currentGrant?: boolean;
}
export interface Reviewer {
  id: string;
  name: string;
  email: string;
  designatedAt: string | null;
  designatedBy: string | null;
}
export interface Grant {
  id: string;
  requesterId: string;
  requester: string;
  purpose: string;
  hours: number;
  requestedAt: string;
  decision: 'approved' | 'declined' | null;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  expiresAt: string | null;
  revokedBy: string | null;
  revokedAt: string | null;
  revokeReason: string | null;
  caseIds: string[];
  status: 'waiting' | 'declined' | 'revoked' | 'expired' | 'current';
}
export interface ProtectedKeyStatus {
  loaded: boolean;
  casesWaiting: number;
  warning: string | null;
}

export const GRANT_STATUS_TEXT: Record<Grant['status'], string> = {
  waiting: 'Waiting for an Administrator to decide',
  declined: 'Declined',
  revoked: 'Revoked',
  expired: 'Expired',
  current: 'Current',
};

export const reportSecret = (projectId: string, body: ReturnType<typeof reportBody> & { holderUserId?: string }) => api.post<{ caseId: string }>(`/projects/${projectId}/secret-reports`, body);
export const listHeld = async (projectId: string) => (await api.get<{ cases: HeldCase[] }>(`/projects/${projectId}/held`)).cases;
export interface AwaitingCase {
  caseId: string;
  kind: ItemKind;
  reportedAt: string;
  awaiting: number;
}
export const listAwaiting = async (projectId: string) => (await api.get<{ cases: AwaitingCase[] }>(`/projects/${projectId}/possible-copies`)).cases;
/** `3 places awaiting a check`. */
export const awaitingText = (n: number): string => `${n} ${n === 1 ? 'place' : 'places'} awaiting a check`;
export const getCase = (caseId: string) => api.get<CaseView>(`/quarantine/cases/${caseId}`);
export const markMore = (caseId: string, marked: string[]) => api.post<{ caseId: string; rows: number; places: number }>(`/quarantine/cases/${caseId}/mark-more`, { marked });
export const releaseCase = (caseId: string, reason: string) => api.post<{ caseId: string; state: 'released'; copies: number }>(`/quarantine/cases/${caseId}/release`, { reason });
export const listCopies = async (caseId: string) => (await api.get<{ copies: PossibleCopy[] }>(`/quarantine/cases/${caseId}/copies`)).copies;
export const decideCopies = (caseId: string, places: Array<{ kind: ItemKind; id: string }>, decision: 'confirmed' | 'dismissed') =>
  api.post<{ decided: unknown[] }>(`/quarantine/cases/${caseId}/copies`, decisionBody(places, decision));

export const listReviewers = async () => (await api.get<{ reviewers: Reviewer[] }>('/security/reviewers')).reviewers;
export const designateReviewer = (userId: string, reason: string) => api.post<unknown>(`/security/reviewers/${userId}/designate`, { reason });
export const undesignateReviewer = (userId: string, reason: string) => api.post<unknown>(`/security/reviewers/${userId}/undesignate`, { reason });
export const listSecurityCases = async () => (await api.get<{ cases: SecurityCase[] }>('/security/cases')).cases;
export const listAdminCases = async () => (await api.get<{ cases: SecurityCase[] }>('/security/admin-cases')).cases;
export const listGrants = async () => (await api.get<{ grants: Grant[] }>('/security/grants')).grants;
export const requestGrant = (caseIds: string[], purpose: string, hours: number) => api.post<{ grantId: string }>('/security/grants', { caseIds, purpose, hours });
export const decideGrant = (id: string, decision: 'approved' | 'declined', reason: string) => api.post<unknown>(`/security/grants/${id}/decide`, { decision, reason });
export const extendGrant = (id: string, hours: number, reason: string) => api.post<unknown>(`/security/grants/${id}/extend`, { hours, reason });
export const revokeGrant = (id: string, reason: string) => api.post<unknown>(`/security/grants/${id}/revoke`, { reason });
export const revealOriginal = (caseId: string, kind: ItemKind, itemId: string) =>
  api.post<Revealed>(`/security/cases/${caseId}/items/${kind}/${itemId}/reveal`, { confirm: true });
export const releaseUnchanged = (caseId: string, reason: string) =>
  api.post<{ caseId: string; state: 'released_unchanged'; restored: number; changed: Array<{ table: string }> }>(`/security/cases/${caseId}/release-unchanged`, { reason });

/** The lines under the persistent protected-key warning. The key also seals AI keys, so the warning names them (spec 5.2). */
export function protectedKeyLines(status: { loaded: boolean; casesWaiting: number }): string[] {
  const cases = `${status.casesWaiting} ${status.casesWaiting === 1 ? 'case is' : 'cases are'} held and waiting`;
  const ai = 'AI keys cannot be saved, checked or used until it is installed, so every AI request ends blocked.';
  if (status.loaded) return [`${cases} to be cleaned.`];
  return [
    `The protected key file is missing or unreadable.${status.casesWaiting > 0 ? ` ${cases}.` : ''} Reported items stay hidden, including authorised records, until it is back.`,
    ai,
  ];
}
