export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

// In development Vite serves the page and proxies /api to the API; in production the API serves the page itself.
const BASE = import.meta.env.DEV ? '/api' : '';

// Given by the server at sign-in and on /auth/me; sent back on every request that changes something.
let csrfToken: string | null = null;
export const setCsrfToken = (t: string | null | undefined): void => {
  csrfToken = t ?? null;
};

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
    throw new ApiError('Cannot reach the Kainow server. Check that it is running, then try again.', 0);
  }
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }
  if (!res.ok) {
    const m = (data as { message?: string | string[] } | undefined)?.message;
    const message = Array.isArray(m) ? m.join(' ') : m;
    throw new ApiError(message || `The server answered ${res.status}.`, res.status);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
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
  origin: 'paste' | 'upload';
  filename: string | null;
  mediaType: string | null;
  charCount: number;
  createdAt: string;
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
  quote: string;
  quoteStart: number | null;
  quoteEnd: number | null;
  quoteMatches: number;
  /** Where a repeated quote occurs (the first places only, if it repeats very often). Absent unless it repeats. */
  occurrences?: Array<{ start: number; end: number }>;
  /** Which of the occurrences the reviewer approved, 0-based. null unless approved and repeated. */
  chosenOccurrence: number | null;
  reviewStatus: ReviewStatus;
  /** The record authorising created, if any. */
  record: { kind: 'task' | 'decision' | 'question' | 'risk'; id: string } | null;
  /** Approved before records existed: it still needs authorising to become a record. */
  approvedWithoutRecord: boolean;
  /** True when a reviewer has changed the wording. `original` is then what the model said. */
  edited?: boolean;
  original?: { text: string; owner: string | null; due: string | null };
}

// --- Projects (V1.0 sub-project 1) ---
import type { ClosureOutcome, GrantKind, GrantState, MembershipState, ProjectRole, ProjectStatus } from './projects.ts';

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
}
