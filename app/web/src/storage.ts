/**
 * Storage settings (sub-project 9): the words the Storage and Report types screens print and the checks the forms make
 * before sending. The server decides every change again. The client secret is write-only: nothing here builds a line from it.
 */
import { formatWhen, plural } from './format.ts';

// ---------------------------------------------------------------------------------------------------------------
// Connection and check states
// ---------------------------------------------------------------------------------------------------------------

export type ConnectionState = 'connected' | 'not_configured' | 'protected_key_missing' | 'refused' | 'unreachable' | 'not_checked';

const STATE_LABELS: Readonly<Record<ConnectionState, string>> = {
  connected: 'Connected',
  not_configured: 'Not set up',
  protected_key_missing: 'Waiting for the protected key',
  refused: 'Microsoft refused these credentials',
  unreachable: 'Could not reach Microsoft',
  not_checked: 'Not checked yet',
};

/** A state in words; an unknown value is shown as "Not checked yet" rather than a code. */
export function storageStateLabel(state: string | null | undefined): string {
  return state && Object.prototype.hasOwnProperty.call(STATE_LABELS, state) ? STATE_LABELS[state as ConnectionState] : STATE_LABELS.not_checked;
}

/** Only a working connection is calm; every other state asks for attention in words as well as colour. */
export const stateTone = (state: string | null | undefined): 'ok' | 'quiet' | 'warn' =>
  state === 'connected' ? 'ok' : state === 'not_checked' || state === 'not_configured' ? 'quiet' : 'warn';

export type CheckKey = 'reachable' | 'folder' | 'upload' | 'delete' | 'permissions' | 'library_permissions' | 'sharing_capability';

const CHECK_LINES: Readonly<Record<CheckKey, { ok: string; bad: string }>> = {
  reachable: { ok: 'The library can be reached', bad: 'The library could not be reached' },
  folder: { ok: 'A folder can be created', bad: 'A folder could not be created' },
  upload: { ok: 'A test file can be uploaded', bad: 'A test file could not be uploaded' },
  delete: { ok: 'The test file can be permanently deleted', bad: 'The test file could not be permanently deleted' },
  permissions: { ok: 'Folder permissions can be listed and created', bad: 'Folder permissions could not be listed or created' },
  library_permissions: { ok: 'Only site owners and Kainow can open the library', bad: 'Others can open the library' },
  sharing_capability: { ok: 'Folders can be shared with named people', bad: 'Folders could not be shared with named people' },
};

/** One line of a destination check, in words: "Passed: ..." or "Failed: ...". An unknown key is shown as it is, never hidden. */
export function checkLineLabel(key: string, ok: boolean): string {
  const line = Object.prototype.hasOwnProperty.call(CHECK_LINES, key) ? CHECK_LINES[key as CheckKey] : null;
  const text = line ? (ok ? line.ok : line.bad) : key.replace(/_/g, ' ');
  return `${ok ? 'Passed' : 'Failed'}: ${text}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Sizes and counts
// ---------------------------------------------------------------------------------------------------------------

/** "1.5 MB": 1,024 steps, one decimal above bytes (the same as the server's confirmation text). */
export function sizeLabel(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = Math.max(0, bytes);
  let u = 0;
  while (size >= 1024 && u < units.length - 1) {
    size /= 1024;
    u++;
  }
  return `${u === 0 ? size : size.toFixed(1)} ${units[u]}`;
}

/** The provider's quota. When the provider does not report one it is "Unavailable", never zero (A17). */
export const quotaLabel = (bytes: number | null | undefined): string => (typeof bytes === 'number' && Number.isFinite(bytes) ? sizeLabel(bytes) : 'Unavailable');

export const filesLabel = (files: number, bytes: number): string => `${plural(files, 'file')} (${sizeLabel(bytes)})`;

// ---------------------------------------------------------------------------------------------------------------
// Destinations
// ---------------------------------------------------------------------------------------------------------------

export type DestinationKind = 'sharepoint_library' | 'onedrive' | 'local';
export type DestinationPurpose = 'source_area' | 'outputs';
export type DestinationStatus = 'proposed' | 'approved' | 'retiring' | 'withdrawn';

export const PURPOSE_LABELS: Readonly<Record<DestinationPurpose, string>> = { source_area: 'Source area', outputs: 'Outputs' };
export const KIND_LABELS: Readonly<Record<DestinationKind, string>> = { sharepoint_library: 'SharePoint library', onedrive: 'OneDrive account', local: 'Local folder (development only)' };
export const STATUS_LABELS: Readonly<Record<DestinationStatus, string>> = {
  proposed: 'Proposed, not approved yet',
  approved: 'Approved',
  retiring: 'Being moved away from',
  withdrawn: 'Withdrawn',
};

/** The kinds the add form offers: OneDrive only while directory lookup is on (D102). */
export function offeredKinds(directoryLookup: boolean): Array<{ value: 'sharepoint_library' | 'onedrive'; label: string }> {
  const kinds: Array<{ value: 'sharepoint_library' | 'onedrive'; label: string }> = [{ value: 'sharepoint_library', label: KIND_LABELS.sharepoint_library }];
  if (directoryLookup) kinds.push({ value: 'onedrive', label: KIND_LABELS.onedrive });
  return kinds;
}

export interface DestinationForm {
  kind: 'sharepoint_library' | 'onedrive';
  purpose: DestinationPurpose;
  label: string;
  siteUrl: string;
  libraryName: string;
  accountEmail: string;
  folderPath: string;
  reason: string;
}

export const emptyDestinationForm = (): DestinationForm => ({ kind: 'sharepoint_library', purpose: 'outputs', label: '', siteUrl: '', libraryName: '', accountEmail: '', folderPath: '', reason: '' });

const REASON_MAX = 1000;
export function reasonProblem(reason: string): string | null {
  const r = reason.trim();
  if (r === '') return 'Give a reason.';
  if (r.length > REASON_MAX) return `Keep the reason to 1,000 characters or fewer (it is ${r.length.toLocaleString('en-US')}).`;
  return null;
}

/** A plain-words problem with the new destination before it is sent; null when fine. The server checks again. */
export function destinationProblem(f: DestinationForm, directoryLookup: boolean): string | null {
  if (f.kind === 'onedrive' && !directoryLookup) return 'OneDrive destinations need directory lookup. Turn directory lookup on in the storage connection first.';
  if (f.label.trim() === '') return 'Give this destination a name.';
  if (f.label.trim().length > 100) return 'Keep the name to 100 characters or fewer.';
  if (f.kind === 'sharepoint_library') {
    if (!/^https:\/\/\S+$/i.test(f.siteUrl.trim())) return 'Give the site address, starting with https://.';
    if (f.libraryName.trim() === '') return 'Give the library name.';
  } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.accountEmail.trim())) {
    return 'Give the account email address.';
  }
  return reasonProblem(f.reason);
}

/** The body sent to add a destination: only the fields that belong to the chosen kind. */
export function destinationBody(f: DestinationForm): Record<string, string> {
  const body: Record<string, string> = { kind: f.kind, purpose: f.purpose, label: f.label.trim(), reason: f.reason.trim() };
  if (f.kind === 'sharepoint_library') {
    body.siteUrl = f.siteUrl.trim();
    body.libraryName = f.libraryName.trim();
  } else {
    body.accountEmail = f.accountEmail.trim();
  }
  if (f.folderPath.trim() !== '') body.folderPath = f.folderPath.trim();
  return body;
}

// ---------------------------------------------------------------------------------------------------------------
// Permissions the Microsoft administrator grants
// ---------------------------------------------------------------------------------------------------------------

export interface PermissionLine {
  name: string;
  /** Why it is needed, in words. */
  why: string;
}

/** The application permissions to grant: Sites.Selected always, User.ReadBasic.All only while directory lookup is on. */
export function permissionInstructions(directoryLookup: boolean): PermissionLine[] {
  const lines: PermissionLine[] = [{ name: 'Sites.Selected', why: 'Lets Kainow reach only the sites you grant it, one by one. It sees nothing else.' }];
  if (directoryLookup) lines.push({ name: 'User.ReadBasic.All', why: 'Lets Kainow look up people by email address, so folders can be shared with the right person and OneDrive accounts can be found.' });
  return lines;
}

export interface SiteGrantExample {
  /** The permission the Microsoft administrator grants on the site (spec 5.3: fullcontrol for every Kainow site). */
  role: 'fullcontrol';
  why: string;
  powershell: string;
  graph: string;
}

/**
 * What to run for one destination, with placeholder names only. Every Kainow site needs fullcontrol (spec 5.3): an
 * outputs site because Kainow shares each output folder with its readers, the source area because Kainow invites the
 * storage Administrators to its folder. Write is enough only when `npm run probe-storage` says "write sufficed: ok".
 */
export function siteGrantExample(purpose: DestinationPurpose, kind: DestinationKind): SiteGrantExample {
  const site = kind === 'onedrive' ? 'https://<tenant>-my.sharepoint.com/personal/<account>' : 'https://<tenant>.sharepoint.com/sites/<site-name>';
  const why =
    purpose === 'source_area'
      ? 'Full control on the site lets Kainow store source files in the source area and give the storage Administrators you designate direct access to its folder. Kainow only removes permissions it granted itself. Write is enough only if the storage probe (npm run probe-storage) shows "write sufficed: ok" for your tenant.'
      : 'Full control on the site lets Kainow create output folders and share each one with the people who may read it. Kainow only ever grants read, and only removes permissions it granted itself.';
  return {
    role: 'fullcontrol',
    why,
    powershell: `Grant-PnPAzureADAppSitePermission -AppId "<application-id>" -DisplayName "Kainow" -Site "${site}" -Permissions FullControl`,
    graph: `POST https://graph.microsoft.com/v1.0/sites/<site-id>/permissions\n{ "roles": ["fullcontrol"], "grantedToIdentities": [ { "application": { "id": "<application-id>", "displayName": "Kainow" } } ] }`,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------------------------------------------

export interface SharingRepairRow {
  project: string;
  projectId: string | null;
  folder: string;
  person: string | null;
  kind: 'access' | 'output_move';
  state: 'failed' | 'revoking' | 'move_failed';
  since: string;
  level?: string;
}

const REPAIR_STATE: Readonly<Record<SharingRepairRow['state'], string>> = {
  failed: 'Access could not be given',
  revoking: 'Access is being removed',
  move_failed: 'Files could not be moved',
};
export const repairStateLabel = (state: string): string => (Object.prototype.hasOwnProperty.call(REPAIR_STATE, state) ? REPAIR_STATE[state as SharingRepairRow['state']] : 'Needs attention');

export function repairLine(r: SharingRepairRow): string {
  const who = r.person ? `${r.person} · ` : '';
  return `${r.project} · ${r.folder} · ${who}${repairStateLabel(r.state)} since ${formatWhen(r.since)}`;
}

export interface MoveProgress {
  from: { id: string; label: string };
  to: { id: string; label: string } | null;
  startedAt: string;
  reason: string | null;
  files: number;
  bytes: number;
  toMove: number;
  moved: number;
  failed: number;
}

export function moveProgressText(m: MoveProgress): string {
  const to = m.to ? m.to.label : 'the new source area';
  const left = plural(m.toMove, 'file');
  const failed = m.failed > 0 ? `, ${plural(m.failed, 'file')} could not be moved yet and will be tried again` : '';
  return `Moving the source area from ${m.from.label} to ${to}: ${m.moved} moved, ${left} still to move${failed}.`;
}

/** The confirmation for moving the source area must repeat the file count and size shown to the Administrator. */
export function moveConfirmProblem(typedFiles: string, typedBytes: string, actual: { files: number; bytes: number }): string | null {
  const digits = /^\d+$/;
  if (!digits.test(typedFiles.trim()) || !digits.test(typedBytes.trim())) return 'Type the number of files and the size in bytes to confirm, using digits only.';
  if (Number(typedFiles) !== actual.files || Number(typedBytes) !== actual.bytes) {
    return `The numbers do not match. The source area holds ${filesLabel(actual.files, actual.bytes)}, which is ${actual.bytes.toLocaleString('en-US')} bytes.`;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Client secret and identifiers
// ---------------------------------------------------------------------------------------------------------------

/** The client secret is trimmed and 10–200 printable characters (spec 8.1). The text is never echoed. */
export function secretProblem(secret: string): string | null {
  const s = secret.trim();
  if (s.length < 10 || s.length > 200) return 'The client secret must be 10 to 200 characters.';
  if (/[^\x20-\x7e]/.test(s)) return 'The client secret can only hold printable characters.';
  return null;
}

export const SECRET_STATE_LABEL: Readonly<Record<'none' | 'saved' | 'unreadable', string>> = {
  none: 'No client secret saved',
  saved: 'A client secret is saved (it is never shown again)',
  unreadable: 'The saved client secret cannot be read. Enter it again',
};

export const FORMAT_LABELS: Readonly<Record<string, string>> = { txt: 'Plain text (.txt)', md: 'Markdown (.md)', docx: 'Word (.docx)', pdf: 'PDF (.pdf)', csv: 'CSV (.csv)' };

/** Whether two lists hold the same items, in any order. */
export const sameItems = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x) => b.includes(x));

export const onOff = (b: boolean): string => (b ? 'On' : 'Off');

/** "Last checked Tue 10 Nov 2026, 09:30 (UTC+8)" or "Never checked". */
export const lastCheckedLabel = (iso: string | null | undefined): string => (iso ? `Last checked ${formatWhen(iso)}` : 'Never checked');

// ---------------------------------------------------------------------------------------------------------------
// Report types
// ---------------------------------------------------------------------------------------------------------------

export const REPORT_TYPE_STATUS: Readonly<Record<'active' | 'retired', string>> = { active: 'In use', retired: 'Retired: kept for history, not offered for new outputs' };

/** The name is also the folder name at filing time: 1 to 100 characters. The server checks again. */
export function nameProblem(name: string): string | null {
  const n = name.trim();
  if (n === '') return 'Give a report type name.';
  if (n.length > 100) return 'Keep the report type name to 100 characters or fewer.';
  return null;
}
