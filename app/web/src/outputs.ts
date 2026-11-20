/**
 * External outputs (sub-project 9): the register's types and the words its screens print. The server decides every
 * action again and sends most labels itself; these helpers say the same things in the same words when a screen has
 * only a state, and keep the spec's exact copy in one place.
 */
import { formatWhen, plural } from './format.ts';

// ---------------------------------------------------------------------------------------------------------------
// Types (as the server sends them)
// ---------------------------------------------------------------------------------------------------------------

export interface Person {
  id: string;
  displayName: string;
}

export type OutputStatus = 'submitted' | 'registered' | 'declined' | 'withdrawn';
export type VersionStatus = 'draft' | 'approved' | 'superseded';
export type CheckStatus = 'ok' | 'changed' | 'moved' | 'missing' | 'access_denied' | 'unverified';
export type FileAction = 'register_changed' | 'relink' | 'add_version';

export interface Filing {
  state: string;
  label: string;
  sharing?: string;
  checkStatus: CheckStatus | null;
  lastCheckedAt: string | null;
  path?: string | null;
  tryAgain?: true;
  location?: string;
  checkLabel?: string;
  recovery?: string;
  registering?: string;
  registerFailed?: string;
  actions?: FileAction[];
  destination?: string;
}

export interface OutputVersion {
  no: number;
  origin: string;
  format: string;
  status: VersionStatus;
  sizeBytes: number;
  createdAt: string;
  createdBy: Person;
  filing: Filing;
}

export interface OutputSummary {
  id: string;
  title: string;
  status: OutputStatus;
  reviewRequired: boolean;
  reviewLabel: string | null;
  reportType: { id: string; name: string } | null;
  categories: Array<{ id: string; name: string }>;
  issueDate: string | null;
  author: Person;
  aiAssisted: boolean;
  audience: { mode: 'project' | 'restricted' };
  latestVersion: OutputVersion | null;
  createdAt: string;
  registeredAt: string | null;
}

export interface OutputDetail extends Omit<OutputSummary, 'audience'> {
  projectId: string;
  registeredBy: Person | null;
  audience: { mode: 'project' | 'restricted'; people: Person[] };
  contributors: {
    people: Array<Person & { departmentId: string | null; departmentName: string | null }>;
    departments: Array<{ id: string; name: string }>;
  };
  versions: OutputVersion[];
  history: Array<{ kind: string; at: string; actor: Person | null; reason: string | null; versionNo: number | null }>;
  may: { register: boolean; decline: boolean; update: boolean; addVersion: boolean; changeAudience: boolean; review: boolean };
  notShared?: Array<{ person: Person; message: string }>;
}

export interface DeletedOutput {
  id: string;
  title: string;
  status: OutputStatus;
  deletedAt: string;
  deletedBy: Person;
  reason: string;
}

export interface ReportType {
  id: string;
  name: string;
}

export type FormatSource = 'organisation' | 'project';
export type ExportRole = 'pm' | 'deputy' | 'owner' | 'sponsor' | 'member' | 'audit' | 'oversight';

export interface OutputSettingsView {
  destination: { id: string; label: string; kind: string; status: string; needsNewLocation: boolean } | null;
  availableDestinations: Array<{ id: string; label: string; kind: string }>;
  formats: { input: Array<{ format: string; source: FormatSource }>; output: Array<{ format: string; source: FormatSource }> };
  approvedFormats: { input: string[]; output: string[] };
  projectFormats: { input: string[] | null; output: string[] | null };
  exportRoles: ExportRole[];
  editable: { destination: boolean; formats: boolean; exportRoles: boolean };
  sources: { destination: 'project' | 'none'; formats: { input: FormatSource; output: FormatSource }; exportRoles: FormatSource };
  updatedAt: string | null;
  maySubmit: boolean;
  mayExport: boolean;
}

// ---------------------------------------------------------------------------------------------------------------
// Exact copy (spec)
// ---------------------------------------------------------------------------------------------------------------

export const CHANGED_SINCE_APPROVAL = 'File changed since approval — this is not the approved content';
export const ACCESS_REVIEW = 'Access review required';
export const KEPT_AT_EXISTING = 'Kept at its existing location';
export const APPROVAL_NOTICE = 'Approving this document does not approve the commitments it mentions.';
export const MOVING_FILES = 'Moving files';
export const NOT_KEPT = 'Not filed — file no longer kept; generate or upload it again';
export const SHARING_OUTSIDE = 'Sharing for this document is managed outside Kainow';

export const notMovedLabel = (oldPath: string): string => `Files not moved — still at ${oldPath}`;
export const notSharedLabel = (email: string): string => `Not shared in SharePoint — no Microsoft account found for ${email}`;

// ---------------------------------------------------------------------------------------------------------------
// States in words
// ---------------------------------------------------------------------------------------------------------------

export const OUTPUT_STATUS_LABEL: Readonly<Record<OutputStatus, string>> = {
  submitted: 'Submitted',
  registered: 'Registered',
  declined: 'Declined',
  withdrawn: 'Withdrawn',
};
export const outputStatusLabel = (s: string): string => OUTPUT_STATUS_LABEL[s as OutputStatus] ?? s;

const VERSION_STATUS: Readonly<Record<VersionStatus, string>> = {
  draft: 'Draft — not approved',
  approved: 'Approved',
  superseded: 'Superseded',
};
/** "Draft — not approved", "Approved" or "Superseded". */
export const versionStatusLabel = (s: string): string => VERSION_STATUS[s as VersionStatus] ?? s;

const ORIGINS: Readonly<Record<string, string>> = {
  draft_report: 'From a draft report',
  export: 'Saved export',
  upload: 'Uploaded file',
  link: 'Linked document',
  changed_file: 'Changed file registered',
};
export const originLabel = (o: string): string => ORIGINS[o] ?? o.replace(/_/g, ' ');

export const FORMAT_LABEL: Readonly<Record<string, string>> = { txt: 'TXT', md: 'Markdown', docx: 'DOCX', pdf: 'PDF', csv: 'CSV', other: 'Other' };
export const formatLabel = (f: string): string => FORMAT_LABEL[f] ?? f.toUpperCase();

const FILING: Readonly<Record<string, string>> = {
  not_filed: 'Not filed',
  pending: 'Waiting to file',
  storing: 'Waiting to file',
  stored: 'Filed',
  linked: KEPT_AT_EXISTING,
  not_kept: NOT_KEPT,
  withheld: 'Withheld',
  relocating: 'Moving',
  missing: 'Missing',
};

/**
 * A version's filing state in words: "Filing failed — <reason>" for a failure (the reason as the server words it),
 * "Kept at its existing location" for a linked document, "Not filed — file no longer kept; …" when its bytes are gone.
 */
export function filingLabel(state: string | null | undefined, reason?: string | null): string {
  if (state === 'failed') return `Filing failed — ${reason && reason.trim() ? reason.trim() : 'Kainow ran into a problem'}`;
  return FILING[state ?? 'not_filed'] ?? FILING.not_filed;
}

const CHECKS: Readonly<Record<CheckStatus, string>> = {
  ok: 'Checked',
  changed: 'Changed',
  moved: 'Moved',
  missing: 'Missing',
  access_denied: 'Access denied',
  unverified: 'Unverified',
};

/**
 * A check result with its time: "Checked 20 Nov 2026, 10:00 am"; "Never checked" when there is none. A changed file
 * of an Approved or Superseded version says plainly that it is not the approved content. An Unverified result keeps
 * the time of the last check that did happen.
 */
export function checkLabel(status: string | null | undefined, checkedAt: string | null | undefined, versionStatus?: string): string {
  if (!status) return 'Never checked';
  if (status === 'changed' && (versionStatus === 'approved' || versionStatus === 'superseded')) return CHANGED_SINCE_APPROVAL;
  const word = CHECKS[status as CheckStatus] ?? CHECKS.unverified;
  if (!checkedAt) return status === 'unverified' ? 'Unverified — never checked' : word;
  return status === 'unverified' ? `Unverified — last checked ${formatWhen(checkedAt)}` : `${word} ${formatWhen(checkedAt)}`;
}

/** Where an effective setting comes from (Q01). */
export function effectiveSourceLabel(source: FormatSource | 'none'): string {
  if (source === 'project') return 'Set for this project';
  if (source === 'organisation') return 'From the organisation';
  return 'Not chosen yet';
}

/** A source version's storage state (spec 9.1), for the PM, Deputies, Owner and Sponsors. */
export function sourceStorageLabel(state: string | null | undefined): string | null {
  if (state === 'stored') return 'Stored';
  if (state === 'waiting') return 'Waiting to store';
  if (state === 'failed') return 'Storage failed';
  return null;
}

export const FILE_ACTION_LABEL: Readonly<Record<FileAction, string>> = {
  register_changed: 'Register the changed content as a new version',
  relink: 'Relink the file',
  add_version: 'Add a new version',
};

export const EXPORT_ROLES: readonly ExportRole[] = ['pm', 'deputy', 'owner', 'sponsor', 'member', 'audit', 'oversight'];
export const EXPORT_ROLE_LABEL: Readonly<Record<ExportRole, string>> = {
  pm: 'Project Manager',
  deputy: 'Deputy Project Manager',
  owner: 'Owner',
  sponsor: 'Sponsor',
  member: 'Member',
  audit: 'Audit grant holders',
  oversight: 'Oversight grant holders',
};

// ---------------------------------------------------------------------------------------------------------------
// What a screen offers
// ---------------------------------------------------------------------------------------------------------------

export type ExportKind = 'tasks' | 'decisions' | 'questions' | 'risks' | 'outputs';
export const EXPORT_NAME: Readonly<Record<ExportKind, string>> = { tasks: 'tasks', decisions: 'decisions', questions: 'questions', risks: 'risks', outputs: 'output register' };

/**
 * The export controls a person sees: none unless the server says they may export ("Export CSV" is hidden, not
 * disabled); "Save as output" only when they may also submit outputs.
 */
export function exportControls(policy: Pick<OutputSettingsView, 'mayExport' | 'maySubmit'> | null | undefined): Array<'export' | 'save'> {
  if (!policy?.mayExport) return [];
  return policy.maySubmit ? ['export', 'save'] : ['export'];
}

/** The export download path for a kind with the screen's current filters (empty values left out). */
export function exportPath(projectId: string, kind: ExportKind, filters: Record<string, string | undefined> = {}): string {
  const q = new URLSearchParams({ kind });
  for (const [k, v] of Object.entries(filters)) if (v) q.set(k, v);
  return `/projects/${projectId}/export?${q.toString()}`;
}

/** The notice an approval request shows: the server's own for an output approval, else the spec's exact words. */
export function approvalNoticeFor(request: { kind: string; notice?: string | null }): string | null {
  if (request.kind !== 'approve_output') return null;
  return request.notice && request.notice.trim() ? request.notice : APPROVAL_NOTICE;
}

const BLOCKS_APPROVAL: readonly string[] = ['changed', 'missing', 'access_denied'];

/**
 * Whether "Ask for approval" is offered on a version: a Draft that is filed (or a checked link) and whose last check
 * is not Changed, Missing or Access denied (spec 4.3). The server decides again.
 */
export function mayAskApproval(v: Pick<OutputVersion, 'status' | 'filing'>): boolean {
  if (v.status !== 'draft') return false;
  if (v.filing.state === 'stored') return !BLOCKS_APPROVAL.includes(v.filing.checkStatus ?? '');
  if (v.filing.state === 'linked') return v.filing.checkStatus === 'ok';
  return false;
}

/** "File it" (or "Try again") on a version not yet filed whose bytes Kainow still holds. */
export const mayFile = (v: Pick<OutputVersion, 'origin' | 'filing'>): boolean =>
  v.origin !== 'link' && (v.filing.state === 'not_filed' || (v.filing.state === 'failed' && v.filing.tryAgain === true));

/** A person an audience change affects, as the preview names them. */
export interface AffectedPerson {
  id: string;
  name: string;
}

/** Who would gain or lose access, in one sentence, for the widening/narrowing confirmation. */
export function audiencePreviewText(preview: { gaining: AffectedPerson[]; losing: AffectedPerson[] }): string {
  const names = (ps: AffectedPerson[]) => ps.map((p) => p.name).join(', ');
  const parts: string[] = [];
  if (preview.gaining.length) parts.push(`${plural(preview.gaining.length, 'person', 'people')} will gain access: ${names(preview.gaining)}.`);
  if (preview.losing.length) parts.push(`${plural(preview.losing.length, 'person', 'people')} will lose access: ${names(preview.losing)}.`);
  return parts.length ? parts.join(' ') : 'Nobody gains or loses access.';
}

// ---------------------------------------------------------------------------------------------------------------
// Opening a filed file (spec 5.7)
// ---------------------------------------------------------------------------------------------------------------

export interface OpenRefusal {
  state: string;
  label: string;
  actions: FileAction[];
}

/** Reads the 409 body of "Open" (`{ state, label, actions }`); null for anything else. */
export function openRefusal(body: unknown): OpenRefusal | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (typeof b.label !== 'string' || typeof b.state !== 'string') return null;
  const actions = Array.isArray(b.actions) ? (b.actions.filter((a) => typeof a === 'string' && a in FILE_ACTION_LABEL) as FileAction[]) : [];
  return { state: b.state, label: b.label, actions };
}

// ---------------------------------------------------------------------------------------------------------------
// Department transfer (spec 10)
// ---------------------------------------------------------------------------------------------------------------

export type FolderChoice = 'move' | 'keep';

/** The confirmation of a department change: how many filed files are affected and that sharing is unchanged. */
export function transferConfirmText(filedFiles: number, choice: FolderChoice | null, from: string, to: string): string {
  const head = `The project will belong to ${to} instead of ${from}.`;
  if (filedFiles === 0) return `${head} It has no filed outputs, so no files are affected.`;
  const files = plural(filedFiles, 'filed output file');
  const one = filedFiles === 1;
  const what =
    choice === 'move'
      ? `${files} will be moved with the project's folder into ${to}'s folder.`
      : `${files} will stay where ${one ? 'it is' : 'they are'}, labelled "${KEPT_AT_EXISTING} (filed under ${from})". New filings go to ${to}'s folder.`;
  return `${head} ${what} Who can open them in SharePoint does not change.`;
}

export interface TransferView {
  id: string;
  from: { id: string; name: string };
  to: { id: string; name: string };
  reason: string;
  folderChoice: FolderChoice | null;
  state: 'done' | 'moving' | 'move_failed';
  actor: string;
  at: string;
  label: string | null;
  tryAgain?: true;
}
