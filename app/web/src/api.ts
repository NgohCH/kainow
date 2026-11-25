export class ApiError extends Error {
  readonly status: number;
  /** The parsed body of the refusal, when the server sent one (a 409 may carry the current copy). */
  readonly data: unknown;
  /** The server's machine code when it sent one (for example 'protective_read_only'). */
  readonly code: string | null;
  constructor(message: string, status: number, data?: unknown) {
    super(message);
    this.status = status;
    this.data = data;
    const c = (data as { code?: unknown } | undefined)?.code;
    this.code = typeof c === 'string' ? c : null;
  }
}

/**
 * Protective read-only mode refused a change (503 `protective_read_only`; the message is the server's fixed text). A person's own
 * save shows this text and keeps its form; a background or automatic request (mark as read) shows nothing.
 */
export const isProtectiveRefusal = (e: unknown): e is ApiError => e instanceof ApiError && e.status === 503 && e.code === 'protective_read_only';

// (import.meta.env is missing when the pure helpers are tested under plain node.)
// In development Vite serves the page and proxies /api to the API; in production the API serves the page itself.
const BASE = import.meta.env?.DEV ? '/api' : '';

// Given by the server at sign-in and on /auth/me; sent back on every request that changes something.
let csrfToken: string | null = null;
export const setCsrfToken = (t: string | null | undefined): void => {
  csrfToken = t ?? null;
};

// --- While Kainow restarts after an update (10b spec 7.2) ---
// The web app remembers whether the last word from the server was update maintenance (the banner or the public state with
// reason 'update', or a save refused with 'update_in_progress'). A network failure after that, or a proxy's 502/503/504
// (Kainow is published on 127.0.0.1, so a shared installation sits behind one), is the update stopping Kainow: it says
// so, asks /health every 15 seconds, and reloads the page only when Kainow answers ok or the failed-update notice page
// answers (it marks every answer with NOTICE_HEADER). Anything else, a proxy's error page included, keeps waiting.
export const RESTART_MESSAGE = 'Kainow is restarting after an update…';
export const RESTART_RETRY_MS = 15_000;
/** Set to '1' on every answer of the notice page (app/src/updater/notice-server.ts). */
export const NOTICE_HEADER = 'X-Kainow-Notice';

export interface RestartEnv {
  fetch: (url: string) => Promise<{ ok: boolean; headers: { get(name: string): string | null } }>;
  setTimeout: (fn: () => void, ms: number) => unknown;
  reload: () => void;
}
const browserRestartEnv = (): RestartEnv => ({
  fetch: (url) => globalThis.fetch(url, { cache: 'no-store', credentials: 'same-origin' }),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  reload: () => globalThis.location?.reload(),
});
let restartEnv: RestartEnv | null = null;
/** Tests replace the timers, /health and the reload. */
export const setRestartEnv = (env: RestartEnv | null): void => {
  restartEnv = env;
};

let lastWasUpdateMaintenance = false;
let restarting = false;
const restartListeners = new Set<(on: boolean) => void>();

export const isRestarting = (): boolean => restarting;
/** Called with true when the restart message should show. Returns the unsubscribe. */
export function onRestarting(cb: (on: boolean) => void): () => void {
  restartListeners.add(cb);
  return () => {
    restartListeners.delete(cb);
  };
}
export function resetRestartForTests(): void {
  lastWasUpdateMaintenance = false;
  restarting = false;
  restartListeners.clear();
  restartEnv = null;
}

/** The banner and the public state say whether update maintenance is on. */
function noteMaintenance(path: string, data: unknown): void {
  if (!path.startsWith('/operations/banner') && !path.startsWith('/operations/public-state')) return;
  const d = data as { protective?: unknown; reason?: unknown } | undefined;
  lastWasUpdateMaintenance = d?.protective === true && d?.reason === 'update';
}

const isJson = (res: Response): boolean => (res.headers.get('Content-Type') ?? '').includes('application/json');

function startRestartWatch(): void {
  if (restarting) return;
  restarting = true;
  for (const cb of restartListeners) cb(true);
  const env = restartEnv ?? browserRestartEnv();
  const retry = () => {
    env.setTimeout(() => {
      // Kainow healthy, or its notice page (503 for ever after a failed update): reload so people see it. A network
      // error or anything else (a proxy's 502/504 page) means it is still restarting.
      env.fetch(BASE + '/health').then(
        (r) => (r.ok || r.headers.get(NOTICE_HEADER) === '1' ? env.reload() : retry()),
        () => retry(),
      );
    }, RESTART_RETRY_MS);
  };
  retry();
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const isForm = body instanceof FormData;
  const isFile = body instanceof Blob;
  let res: Response;
  try {
    res = await fetch(BASE + path, {
      method,
      credentials: 'same-origin',
      headers: {
        ...(body !== undefined && !isForm ? { 'Content-Type': isFile ? body.type : 'application/json' } : {}),
        ...(method !== 'GET' && csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
      },
      body: body === undefined ? undefined : isForm || isFile ? body : JSON.stringify(body),
    });
  } catch {
    if (lastWasUpdateMaintenance) {
      startRestartWatch();
      throw new ApiError(RESTART_MESSAGE, 0, { code: 'restarting' });
    }
    throw new ApiError('Cannot reach the Kainow server. Check that it is running, then try again.', 0);
  }
  // Behind a proxy the stopped Kainow is a 502/503/504 from the proxy, not a network error; the notice page says itself.
  const kainowDown = res.status === 502 || res.status === 503 || res.status === 504;
  if (kainowDown && (res.headers.get(NOTICE_HEADER) === '1' || (lastWasUpdateMaintenance && !isJson(res)))) {
    startRestartWatch();
    throw new ApiError(RESTART_MESSAGE, 0, { code: 'restarting' });
  }
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }
  if (res.ok) noteMaintenance(path, data);
  else if (res.status === 503 && (data as { code?: unknown } | undefined)?.code === 'update_in_progress') lastWasUpdateMaintenance = true;
  if (!res.ok) {
    const m = (data as { message?: string | string[] } | undefined)?.message;
    const message = Array.isArray(m) ? m.join(' ') : m;
    throw new ApiError(message || `The server answered ${res.status}.`, res.status, data);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  delete: <T>(path: string, body?: unknown) => request<T>('DELETE', path, body),
  originalUrl: (sourceId: string, versionNo: number) => `${BASE}/notes/${sourceId}/versions/${versionNo}/original`,
  /** Sends a file as the request body itself, with its own type (a logo). */
  upload: <T>(path: string, file: Blob) => request<T>('PUT', path, file),
  /** The address of a server path for an <img> or <link>. */
  url: (path: string) => BASE + path,
};

export interface User {
  id: string;
  email: string;
  displayName: string;
  role: string;
}

export interface SourceSummary {
  id: string;
  title: string;
  createdAt: string;
  latestVersion: number;
  versionCount: number;
}

export interface VersionSummary {
  id: string;
  sourceId: string;
  versionNo: number;
  origin: 'paste' | 'upload' | 'meeting' | 'discussion';
  filename: string | null;
  mediaType: string | null;
  charCount: number;
  createdAt: string;
  /** Set (with the words to show) when the uploaded file is withheld because a credential was removed from its text. */
  originalWithheld?: string | null;
  /** Where the version's files stand in the source area (spec 9.1): shown to the PM, Deputies, Owner and Sponsors; null for others. */
  storage?: 'stored' | 'waiting' | 'failed' | null;
}

export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'blocked';

export interface Run {
  id: string;
  sourceVersionId: string;
  status: RunStatus;
  failureCode: string | null;
  failureDetail: string | null;
  attempts: number;
  itemCount: number | null;
  unlocatedCount: number | null;
  createdAt: string;
  finishedAt: string | null;
  /** Who asked for this run, or why it started automatically. */
  requestedByLabel?: string;
  /** The meeting date in force: the reviewer's for this version, else the one in the notes. */
  meetingDate: string | null;
  meetingDateSource: 'notes' | 'reviewer' | 'none';
}

/** Kainow's reading of a due (worked out by the server each time; never stored). Days are 'YYYY-MM-DD'. */
export interface DueReading {
  state: 'exact' | 'range' | 'event' | 'needs_date';
  earliest: string | null;
  latest: string | null;
  event: string | null;
  reason: string | null;
  note: string | null;
  usedMeetingDate: boolean;
}

/** A due a reviewer has set: dates, or the event the item waits on. */
export interface ReviewerDue {
  earliest: string | null;
  latest: string | null;
  event: string | null;
  /** The reviewer says the event the model named does not apply. */
  ignoreModelEvent: boolean;
}

export type Kind = 'decision' | 'action' | 'question' | 'risk';
export type ReviewStatus = 'pending' | 'approved' | 'rejected';

export interface Item {
  /** "Possible credential removed — awaiting check" while this is a possible copy masked at once (history spec 7.4). */
  quarantineLabel?: string | null;
  id: string;
  position: number;
  kind: Kind;
  text: string;
  owner: string | null;
  /** The due as worded (by the notes, or by a reviewer's edit). */
  due: string | null;
  /** The event the model says the item waits on, if any. */
  dueEvent: string | null;
  /** For a question: possible answers taken from the notes. Empty otherwise. */
  alternatives: string[];
  dueReading: DueReading;
  reviewerDue: ReviewerDue | null;
  /** Null when the quote's message is now hidden or deleted, or its source is Deleted (see quoteMasked). */
  quote: string | null;
  quoteMasked?: 'deleted' | 'hidden' | 'source_deleted' | null;
  quoteStart: number | null;
  quoteEnd: number | null;
  quoteMatches: number;
  /** Where a repeated quote occurs (the first places only, if it repeats very often). Absent unless it repeats. */
  occurrences?: Array<{ start: number; end: number; label?: string | null }>;
  /** Which of the occurrences the reviewer approved, 0-based. null unless approved and repeated. */
  chosenOccurrence: number | null;
  reviewStatus: ReviewStatus;
  /** The record authorising created, if any. */
  record: { kind: 'task' | 'decision' | 'question' | 'risk'; id: string } | null;
  /** Approved before records existed: it still needs authorising to become a record. */
  approvedWithoutRecord: boolean;
  /** The record is in view today (neither Deleted nor held): it can be linked to. */
  recordOpens?: boolean;
  /** Set when the quote lies in a discussion message that is now hidden or deleted, or the source is Deleted. */
  sourceFlag?: 'deleted' | 'hidden' | 'source_deleted' | null;
  /** Set when the quote was cleaned of a credential and needs a second look. */
  quoteChanged?: string | null;
  /** Set when the quote lies in a discussion message: which message, by whom and when. */
  discussionEvidence?: { threadId: string; messageNo: number; authorName: string; at: string } | null;
  /** True when a reviewer has changed the proposal. `original` is what the model said, whether or not it was changed. */
  edited?: boolean;
  /** The model's own proposal and the model that made it (null when unknown). `kind` above is the kind in force. */
  original?: { kind: Kind; text: string; owner: string | null; due: string | null; model: string | null };
  /** Every reviewer correction, newest first (D130). */
  corrections?: Correction[];
}

/** One reviewer correction of an AI proposal: who, their project role today, when, the fields changed and why. */
export interface Correction {
  at: string;
  by: string;
  role: string | null;
  changed: Array<'type' | 'text' | 'owner' | 'due'>;
  from: { kind: string };
  to: { kind: string };
  reason: string | null;
}

// --- Projects (V1.0 sub-project 1) ---
import type { ClosureOutcome, GrantKind, GrantState, MembershipState, ProjectRole, ProjectStatus } from './projects.ts';
import type { ProjectStage, StageChange } from './ui/stages.ts';

export interface Department {
  id: string;
  name: string;
  status: 'active' | 'retired';
}

export interface ProjectSummary {
  id: string;
  name: string;
  status: ProjectStatus;
  owningDepartment: string;
  stage: { stage: string; substage: string | null } | null;
  /** Set while the project is Deferred, or Closed: the UTC+8 day and the reason or outcome (D138). */
  deferred: { on: string; reason: string | null } | null;
  closed: { on: string; outcome: ClosureOutcome | null } | null;
  myRoles: ProjectRole[];
  missingAccountability: boolean;
  /** Set when the person reads this project through an Audit or Oversight grant only. */
  access: GrantKind | null;
  /** A member is On Hold (shown to role managers only). */
  onHold: boolean;
  archived: boolean;
  /** Tasks assigned to you here that are not finished. */
  myOpenTasks: number;
}

export interface AdminProjectRow {
  id: string;
  name: string;
  status: ProjectStatus;
  owningDepartment: string;
  roleHolders: Array<{ displayName: string; role: ProjectRole; state: MembershipState }>;
}

export interface Membership {
  id: string;
  userId: string;
  displayName: string;
  email: string;
  role: ProjectRole;
  startsOn: string;
  expiresOn: string | null;
  state: MembershipState;
  /** Shown to role managers for a held membership. */
  holdReason?: string | null;
}

export interface Grant {
  id: string;
  kind: GrantKind;
  purpose: string;
  scope: string;
  startsOn: string;
  expiresOn: string;
  state: GrantState;
  user: { id: string; displayName: string; email: string };
  requestedBy: string;
  decidedBy: string | null;
  decisionReason: string | null;
  suspendReason: string | null;
  revokeReason: string | null;
  /** The grant includes Inspect Deleted Content (chosen when it was requested). */
  inspectDeleted?: boolean;
  /** This viewer may approve or decline it (a manager who is neither the grantee nor the recorder). */
  mayDecide: boolean;
  /** The viewer's own access: they may not extend or restore it. */
  self: boolean;
}

export interface Finding {
  id: string;
  finding: string;
  recommendation: 'restore' | 'revoke';
  recordedBy: string;
  at: string;
}

export interface InvitationRow {
  id: string;
  email: string;
  role: ProjectRole;
  startsOn: string;
  expiresOn: string | null;
  issuedAt: string;
  expiresAt: string;
  status: 'invited' | 'accepted' | 'declined' | 'revoked' | 'expired';
  kind?: 'role' | 'handover';
  outgoingRole?: 'deputy_pm' | 'member' | 'leave' | null;
}

export interface StagePeriod {
  stage: string;
  substage: string | null;
  startedAt: string;
  endedAt: string | null;
  /** What stopped it, when the project was deferred or closed while it ran; `endedAt` is then that moment (D138). */
  stopped: 'deferred' | 'closed' | null;
  reason: string | null;
}

export interface Transition {
  from: ProjectStatus;
  to: ProjectStatus;
  reason: string | null;
  outcome: ClosureOutcome | null;
  fastTrack: boolean;
  at: string;
  actor: string;
}

export interface Project {
  id: string;
  name: string;
  purpose: string;
  plannedEnd: string | null;
  status: ProjectStatus;
  closureOutcome: ClosureOutcome | null;
  createdAt: string;
  owningDepartment: { id: string; name: string };
  contributingDepartments: Array<{ id: string; name: string }>;
  stage: StagePeriod | null;
  stagePeriods: StagePeriod[];
  /** The project's own stages, in order; retired ones keep their place (D131). */
  stages: ProjectStage[];
  /** The changes to them, newest first: everyone who can read the project sees who changed what and why. */
  stageChanges: StageChange[];
  stageTemplate: { id: string; name: string } | null;
  transitions: Transition[];
  memberships: Membership[];
  invitations: InvitationRow[];
  myRoles: ProjectRole[];
  isAdmin: boolean;
  missingAccountability: boolean;
  missingRoles: string[];
  onHold: boolean;
  access: GrantKind | null;
  grants: Grant[];
  archived: boolean;
  archivedAutomatically: boolean;
  openReviewFlags?: number;
  /** The viewer's own Active grant includes Inspect Deleted Content. */
  inspectDeleted?: boolean;
  /** Set while an Owner or Sponsor lets the Project Manager delete and restore records (D83). */
  recordDeletionDelegation?: { pm: string; by: string; reason: string; at: string } | null;
}
