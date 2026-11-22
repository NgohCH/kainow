import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { writeAudit } from '../audit/audit';
import { uuidv7 } from '../common/uuid7';
import type { StorageConnector } from '../storage/connector';
import { StorageWaitingForKey } from '../storage/connector-factory';
import { type StorageDeps, registerStorageDailyTask, registerStorageFinalFailure, registerStorageHandler } from '../storage/jobs';
import { queueStorageJob } from '../storage/outbox';
import { quickXorHash } from '../storage/quickxor';
import { loadStorageSettings } from '../storage/settings';
import { type DestinationRef, type ItemState, StorageError, type StoredRef } from '../storage/types';
import { afterFiled, ensureOutputFolder, heldCaseAtConfirm, moveNamed, recordedFolderPath, versionFileName } from './filing';
import { queueWithhold } from '../storage/withhold';
import { PathTooLong, fitPath, outputFileName } from './naming';
import { isWholeProject } from './readers';

/**
 * Checks and reconciliation of output files (spec 5.7, 5.8, D107). A filed (stored) or registered (linked) output file
 * is looked up by its provider item id and compared with what Kainow recorded: Checked, Changed, Moved, Missing,
 * Access denied, or Unverified when the provider could not be asked. Each newly found Changed, Moved or Missing writes
 * an output event and tells the PM and Deputies, once per change of state. The PM or a Deputy then relinks a moved or
 * missing file (only into an approved destination) or registers changed content as a new version.
 */

type Db = Pool | PoolClient;
export type CheckStatus = 'ok' | 'changed' | 'moved' | 'missing' | 'access_denied' | 'unverified';
/** What checks need: no key, only connectors built by the factory. */
export type CheckDeps = Pick<StorageDeps, 'pool' | 'connectors' | 'clock' | 'notify' | 'log'>;

export const CHANGED_SINCE_APPROVAL = 'File changed since approval — this is not the approved content';
export const NOT_RECOVERED = 'The approved content could not be recovered from storage';
export const NOT_APPROVED_PLACE =
  'This place is not an approved storage location. An Enterprise Administrator must approve it as a destination before the file can be relinked.';
export const KAINOW_FILES = 'Kainow cannot register a document from the folders Kainow files outputs and sources in.';
export const SHARED_FILE = 'Another output version already stands for this file.';
export const NOTHING_TO_RELINK = 'This file is where Kainow recorded it.';
export const GIVE_LINK = 'Kainow cannot find the file. Give a link to where it is now.';
export const NOT_SAME_FILE = 'This is not the file Kainow recorded: its content is different.';
export const NOT_CHANGED = 'Only a file found changed can be registered as a new version.';
export const ALREADY_REGISTERED = 'This change is already registered as a new version.';
export const CHANGE_GONE = 'The file matches what Kainow recorded again, so there is nothing to register.';
export const ONLY_REGISTERED = 'Versions are added to a registered output.';
export const BUSY = 'This change is already being registered.';
export const SAME_TIME = 'Someone else changed this output at the same time. Try again.';
export const PATH_TOO_LONG = 'The folder path is too long for a new file here.';
export const NO_FILE = 'This version has no file in storage.';
export const NOT_FILED_BY_KAINOW = 'Only a file Kainow filed can be registered as a new version; a linked document stays as it is.';
export const NO_PLACEMENT = 'This output has no folder in an approved destination to file the new version in.';

/** The notice kinds a newly found change raises (worded by makeStorageNotify); the subject is the stored file. */
export const OUTPUT_FILE_CHANGED = 'output_file_changed';
export const OUTPUT_FILE_MOVED = 'output_file_moved';
export const OUTPUT_FILE_MISSING = 'output_file_missing';
const FOUND: Partial<Record<CheckStatus, { event: string; notice: string }>> = {
  changed: { event: 'changed_found', notice: OUTPUT_FILE_CHANGED },
  moved: { event: 'moved_found', notice: OUTPUT_FILE_MOVED },
  missing: { event: 'missing_found', notice: OUTPUT_FILE_MISSING },
};
const BAD: readonly CheckStatus[] = ['changed', 'moved', 'missing', 'access_denied'];
/** The states that stop a file being opened, downloaded or approved (the approval handler uses this list too). */
export const BLOCKING: readonly string[] = ['changed', 'missing', 'access_denied'];
/** The states a file can be relinked from: it is elsewhere or out of reach, its content as recorded. */
const RELINKABLE: readonly CheckStatus[] = ['moved', 'missing', 'access_denied'];
/** A file checked this recently is opened on its recorded result without asking the provider again (spec 5.7). */
export const OPEN_CHECK_MS = 60_000;
const MAX_FOLDER_DEPTH = 64;
const MAX_SUFFIX = 20;
const RESTORE_FAILED = 'Restoring an output file from its version history failed; it stays flagged as changed.';
const UPLOAD_UNCERTAIN = 'Uploading a changed output file as a new version did not finish; a copy may be left in storage.';
const UNRECORDED_KEPT = 'A changed output file uploaded as a new version was not recorded and could not be removed; it may be left in storage.';

const LABELS: Readonly<Record<CheckStatus, string>> = {
  ok: 'Checked',
  changed: 'Changed',
  moved: 'Moved',
  missing: 'Missing',
  access_denied: 'Access denied',
  unverified: 'Unverified',
};

/** A refusal for the person asking (409): the message is fixed text. */
export class FileActionRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FileActionRefused';
  }
}

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const logFixed = (deps: CheckDeps, message: string): void => (deps.log ?? ((m) => console.warn(m)))(message);
/** Paths are kept without a leading slash (`Department/Project/…/name.ext`); providers give them with one. */
export const plainPath = (p: string | null | undefined): string => (p ?? '').replace(/^\/+/, '');
const extOf = (name: string): string => /\.([A-Za-z0-9]+)$/.exec(name.trim())?.[1].toLowerCase() ?? '';

// ---------------------------------------------------------------------------------------------------------------------
// What people see
// ---------------------------------------------------------------------------------------------------------------------

/** The label of a check result; an Approved or Superseded version whose file changed says so plainly (spec 5.8). */
export function checkLabel(status: CheckStatus, versionStatus: string): string {
  if (status === 'changed' && (versionStatus === 'approved' || versionStatus === 'superseded')) return CHANGED_SINCE_APPROVAL;
  return LABELS[status] ?? LABELS.unverified;
}

/**
 * What the PM or a Deputy can do about a check result (nothing for anyone else). Registering changed content is offered
 * only for a file Kainow filed (never a linked document) and not while a request is under way.
 */
export function checkActions(status: CheckStatus, manages: boolean, file: { filed: boolean; pending?: boolean }): string[] {
  if (!manages) return [];
  if (status === 'changed') return file.filed && !file.pending ? ['register_changed'] : [];
  if (status === 'moved' || status === 'access_denied') return ['relink'];
  if (status === 'missing') return ['relink', 'add_version'];
  return [];
}

// ---------------------------------------------------------------------------------------------------------------------
// Approved places
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Whether the item lies under the folder `rootItemId`: its parents are walked up through the provider until that folder
 * (inside) or the top of the drive (outside: `driveRootId` when known, otherwise an item with no parent).
 */
export async function liesUnder(connector: StorageConnector, ref: DestinationRef, item: ItemState, rootItemId: string, driveRootId?: string): Promise<boolean> {
  if (driveRootId !== undefined && rootItemId === driveRootId) return true;
  let parent = item.parentId;
  for (let depth = 0; depth < MAX_FOLDER_DEPTH; depth++) {
    if (parent === rootItemId) return true;
    if (!parent || parent === driveRootId) return false;
    parent = (await connector.getItem(ref, parent)).parentId;
  }
  return false;
}

/**
 * A drive path (as a link resolves) made relative to a destination rooted at a folder of the drive, as every stored
 * path is; unchanged for a destination rooted at the drive root, or when the path is not under the folder.
 */
export async function pathInDestination(connector: StorageConnector, driveRef: DestinationRef, rootItemId: string, drivePath: string): Promise<string> {
  if (rootItemId === driveRef.rootItemId) return drivePath;
  const root = plainPath((await connector.getItem(driveRef, rootItemId)).path);
  const p = plainPath(drivePath);
  return root && p.startsWith(`${root}/`) ? `/${p.slice(root.length + 1)}` : drivePath;
}

/**
 * Whether the item is a file Kainow filed (any stored file but a link) or is, or lies under, a folder Kainow files
 * outputs or sources in (project, restricted root, output, year, report type, source root). A link may never point
 * there: Kainow resolves links with its own access, so registering one would hand out what SharePoint and Kainow's
 * readers rule keep from the person. A walk that does not reach the top of the drive counts as inside (fails closed).
 */
export async function inKainowFiles(db: Db, connector: StorageConnector, ref: DestinationRef, item: ItemState, driveRootId?: string): Promise<boolean> {
  const filed = await db.query(`SELECT 1 FROM stored_files WHERE drive_id = $1 AND item_id = $2 AND state <> 'linked' LIMIT 1`, [ref.driveId, item.itemId]);
  if (filed.rowCount) return true;
  const folders = new Set(
    (
      await db.query<{ item_id: string }>(
        `SELECT f.item_id FROM storage_folders f JOIN storage_destinations d ON d.id = f.destination_id
          WHERE d.drive_id = $1 AND f.level <> 'department'`,
        [ref.driveId],
      )
    ).rows.map((r) => r.item_id),
  );
  if (folders.size === 0) return false;
  if (folders.has(item.itemId)) return true;
  let parent = item.parentId;
  for (let depth = 0; depth < MAX_FOLDER_DEPTH; depth++) {
    if (!parent || parent === driveRootId) return false;
    if (folders.has(parent)) return true;
    parent = (await connector.getItem(ref, parent)).parentId;
  }
  return true;
}

export interface ApprovedPlace { id: string; connector: 'graph' | 'local'; rootItemId: string; label: string }

/**
 * The approved output destination the item lies in (any, not only the project's own), or null. `prefer` is tried first
 * (the destination the file was recorded in). `ref` names the item's drive.
 */
export async function approvedPlaceOf(
  db: Db, connector: StorageConnector, ref: DestinationRef, item: ItemState, opts: { prefer?: string | null; driveRootId?: string } = {},
): Promise<ApprovedPlace | null> {
  const candidates = (
    await db.query<{ id: string; connector: 'graph' | 'local'; rootItemId: string | null; label: string }>(
      `SELECT id, connector, root_item_id AS "rootItemId", label FROM storage_destinations
        WHERE purpose = 'outputs' AND status = 'approved' AND drive_id = $1
        ORDER BY (id IS NOT DISTINCT FROM $2::uuid) DESC, created_at, id`,
      [ref.driveId, opts.prefer ?? null],
    )
  ).rows;
  for (const d of candidates) {
    if (d.rootItemId && (await liesUnder(connector, ref, item, d.rootItemId, opts.driveRootId))) return { ...d, rootItemId: d.rootItemId };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Checking one file
// ---------------------------------------------------------------------------------------------------------------------

export interface FileRow {
  id: string; project_id: string; state: string; destination_id: string | null; drive_id: string | null; item_id: string | null;
  path: string | null; name: string; size_bytes: string | null; sha256: string | null; provider_hash: string | null;
  etag: string | null; ctag: string | null; web_url: string | null; check_status: CheckStatus; last_checked_at: Date | null;
  dest_status: string | null;
}

export async function loadFile(db: Db, fileId: string): Promise<FileRow | undefined> {
  return (
    await db.query<FileRow>(
      `SELECT f.id, f.project_id, f.state, f.destination_id, f.drive_id, f.item_id, f.path, f.name, f.size_bytes, f.sha256,
              f.provider_hash, f.etag, f.ctag, f.web_url, f.check_status, f.last_checked_at, d.status AS dest_status
         FROM stored_files f LEFT JOIN storage_destinations d ON d.id = f.destination_id
        WHERE f.id = $1 AND f.purpose = 'output'`,
      [fileId],
    )
  ).rows[0];
}

const checkable = (f: FileRow | undefined): f is FileRow & { destination_id: string; item_id: string } =>
  !!f && (f.state === 'stored' || f.state === 'linked') && !!f.destination_id && !!f.item_id;

/**
 * Whether the provider's item differs in content from the record: size, then QuickXorHash where both are known, and
 * the content tag only when no hash can be compared (a registered link may have none). Never the eTag: a move or a
 * rename changes it without changing the content.
 */
function contentDiffers(f: FileRow, item: { size: number; providerHash: string | null; ctag: string | null }): boolean {
  if (f.size_bytes !== null && Number(f.size_bytes) !== item.size) return true;
  if (f.provider_hash && item.providerHash) return f.provider_hash !== item.providerHash;
  return !!f.ctag && !!item.ctag && f.ctag !== item.ctag;
}

interface Verdict { status: Exclude<CheckStatus, 'unverified'>; item?: ItemState; place?: ApprovedPlace }

/**
 * Looks the file up and decides. A destination no longer approved is Access denied without asking the provider.
 * Provider faults other than not found (Missing) and forbidden (Access denied) are thrown to the caller.
 */
async function inspect(deps: CheckDeps, f: FileRow & { destination_id: string; item_id: string }, conn?: { connector: StorageConnector; dest: DestinationRef }): Promise<Verdict> {
  if (f.dest_status !== 'approved') return { status: 'access_denied' };
  const { connector, dest } = conn ?? (await deps.connectors.forDestination(f.destination_id));
  let item: ItemState;
  try {
    item = await connector.getItem(dest, f.item_id);
  } catch (err) {
    if (err instanceof StorageError && err.code === 'not_found') return { status: 'missing' };
    if (err instanceof StorageError && err.code === 'forbidden') return { status: 'access_denied' };
    throw err;
  }
  const changed = contentDiffers(f, item);
  if (plainPath(item.path) === plainPath(f.path) && item.name === f.name) return { status: changed ? 'changed' : 'ok', item };
  // Somewhere else: as good as gone unless that place is in an approved destination (even if it was edited too, so
  // nothing is ever done next to it there); in one, Changed when edited, otherwise Moved.
  const place = await approvedPlaceOf(deps.pool, connector, dest, item, { prefer: f.destination_id });
  if (!place) return { status: 'missing', item };
  return changed ? { status: 'changed', item, place } : { status: 'moved', item, place };
}

/**
 * Records a check result. A newly found Changed, Moved or Missing writes its output event and notifies the PM and
 * Deputies; a file found as recorded again after any of those writes `checked`. Nothing is recorded if the file was
 * relinked meanwhile. A file found as recorded has its eTag, content tag and web URL refreshed; a moved file only its
 * web URL (the URL is kept only to open the file, so an open within the minute still finds it).
 */
async function record(deps: CheckDeps, f: FileRow, status: Exclude<CheckStatus, 'unverified'>, at: Date, item?: ItemState): Promise<void> {
  const c = await deps.pool.connect();
  try {
    await c.query('BEGIN');
    const now = (
      await c.query<{ check_status: CheckStatus }>(
        `SELECT check_status FROM stored_files WHERE id = $1 AND item_id IS NOT DISTINCT FROM $2 AND destination_id IS NOT DISTINCT FROM $3 FOR UPDATE`,
        [f.id, f.item_id, f.destination_id],
      )
    ).rows[0];
    if (now) {
      await c.query(`UPDATE stored_files SET check_status = $2, last_checked_at = $3 WHERE id = $1`, [f.id, status, at]);
      if (status === 'ok' && item) {
        await c.query(`UPDATE stored_files SET etag = $2, ctag = $3, web_url = COALESCE($4, web_url) WHERE id = $1`, [f.id, item.etag, item.ctag, item.webUrl]);
      } else if (status === 'moved' && item) {
        // Only where to open it: the recorded path, folder and identity stay until the PM or a Deputy relinks.
        await c.query(`UPDATE stored_files SET web_url = COALESCE($2, web_url) WHERE id = $1`, [f.id, item.webUrl]);
      }
      if (now.check_status !== status) {
        const v = (await c.query<{ id: string; output_id: string; version_no: number }>(`SELECT id, output_id, version_no FROM output_versions WHERE stored_file_id = $1`, [f.id])).rows[0];
        const found = FOUND[status];
        const kind = found?.event ?? (status === 'ok' && BAD.includes(now.check_status) ? 'checked' : null);
        if (v && kind) {
          await c.query(`INSERT INTO output_events (id, output_id, version_id, kind, actor_id, at, detail) VALUES ($1, $2, $3, $4, NULL, $5, $6)`, [
            uuidv7(at.getTime()), v.output_id, v.id, kind, at, JSON.stringify({ versionNo: v.version_no, was: now.check_status }),
          ]);
        }
        if (v && found) await deps.notify(c, { kind: found.notice, subjectId: f.id });
      }
    }
    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

/** Stamps the check time only (a fault with this one item): it goes behind the others next time. */
const stamp = (deps: CheckDeps, fileId: string, at: Date) => deps.pool.query(`UPDATE stored_files SET last_checked_at = $2 WHERE id = $1`, [fileId, at]);

export interface CheckOutcome { status: CheckStatus; item?: ItemState }

/**
 * Checks one output file now and records the result (spec 5.8). When the provider cannot be asked the answer is
 * Unverified and nothing is recorded: the previous result stays with its time (with `throwFaults`, the fault is thrown
 * instead, for a job to try again).
 */
export async function checkFile(deps: CheckDeps, fileId: string, opts: { throwFaults?: boolean } = {}): Promise<CheckOutcome> {
  const f = await loadFile(deps.pool, fileId);
  if (!checkable(f)) return { status: 'unverified' };
  let verdict: Verdict;
  try {
    verdict = await inspect(deps, f);
  } catch (err) {
    if (!(err instanceof StorageError || err instanceof StorageWaitingForKey)) throw err;
    if (opts.throwFaults) throw err;
    return { status: 'unverified' };
  }
  await record(deps, f, verdict.status, deps.clock(), verdict.item);
  return { status: verdict.status, item: verdict.item };
}

export async function checkStoredFile(deps: CheckDeps, storedFileId: string): Promise<CheckStatus> {
  return (await checkFile(deps, storedFileId)).status;
}

/**
 * The daily check of output files (spec 5.8), only when the Administrator has turned scheduled checks on: stored and
 * linked output files, never-checked first, then oldest check first, at most `limit` a run across the installation.
 * A destination whose connector cannot be had is left out (it takes no slots). The connection failing or being
 * throttled ends the run (the rest keep their place); a fault with one item stamps its time and moves on.
 */
export async function checkOutputs(deps: CheckDeps, at: Date, limit = 2000): Promise<{ checked: number; flagged: number }> {
  if (!(await loadStorageSettings(deps.pool)).scheduledChecks) return { checked: 0, flagged: 0 };
  const connectors = new Map<string, { connector: StorageConnector; dest: DestinationRef }>();
  const dead: string[] = [];
  const dests = await deps.pool.query<{ id: string; status: string }>(
    `SELECT DISTINCT d.id, d.status FROM stored_files f JOIN storage_destinations d ON d.id = f.destination_id
      WHERE f.purpose = 'output' AND f.state IN ('stored', 'linked') AND f.item_id IS NOT NULL ORDER BY d.id`,
  );
  for (const d of dests.rows) {
    if (d.status !== 'approved') continue; // decided without the provider
    try {
      connectors.set(d.id, await deps.connectors.forDestination(d.id));
    } catch (err) {
      if (!(err instanceof StorageWaitingForKey || err instanceof StorageError)) throw err;
      dead.push(d.id);
    }
  }
  const { rows } = await deps.pool.query<{ id: string }>(
    `SELECT id FROM stored_files
      WHERE purpose = 'output' AND state IN ('stored', 'linked') AND destination_id IS NOT NULL AND item_id IS NOT NULL
        AND destination_id <> ALL($2::uuid[])
      ORDER BY last_checked_at NULLS FIRST, id
      LIMIT $1`,
    [limit, dead],
  );
  let checked = 0;
  let flagged = 0;
  for (const r of rows) {
    const f = await loadFile(deps.pool, r.id);
    if (!checkable(f)) continue;
    let verdict: Verdict;
    try {
      verdict = await inspect(deps, f, connectors.get(f.destination_id));
    } catch (err) {
      if (err instanceof StorageWaitingForKey) break;
      if (!(err instanceof StorageError)) throw err;
      if (err.code === 'unauthorised' || err.code === 'throttled' || err.code === 'unreachable') break;
      checked++;
      await stamp(deps, f.id, at);
      continue;
    }
    checked++;
    if (FOUND[verdict.status] && f.check_status !== verdict.status) flagged++;
    await record(deps, f, verdict.status, at, verdict.item);
  }
  return { checked, flagged };
}

// ---------------------------------------------------------------------------------------------------------------------
// Relinking (spec 5.8: Moved and Missing)
// ---------------------------------------------------------------------------------------------------------------------

const RELINK_REASON = 'Relinked';

/**
 * Points a moved, missing or unreachable file at where it is now: the same item (found by its id), or the item a link
 * names. The place must be inside an approved output destination, the content must be what was recorded, and no other
 * stored file may already stand for the item. The reference and path are updated, `stored_file_moves` records old and
 * new, and the version's `relinked` event is written. A filed file keeps being placed by Kainow while it is in the
 * project's own output destination (moved back where its readers need it, spec 5.5); in another destination its
 * sharing stays as it is there.
 */
export async function relinkFile(deps: CheckDeps, fileId: string, actorId: string, url: string | null): Promise<void> {
  const f = await loadFile(deps.pool, fileId);
  if (!checkable(f)) throw new FileActionRefused(NO_FILE);
  if (!RELINKABLE.includes(f.check_status)) throw new FileActionRefused(NOTHING_TO_RELINK);

  let connector: StorageConnector;
  let ref: DestinationRef;
  let item: ItemState;
  let driveRootId: string | undefined;
  try {
    if (url) {
      connector = await deps.connectors.forNew('sharepoint_library');
      const resolved = await connector.resolveLink(url);
      if (!resolved.dest?.driveId) throw new FileActionRefused(NOT_APPROVED_PLACE);
      ref = resolved.dest;
      item = resolved.item;
      driveRootId = ref.rootItemId;
    } else {
      ({ connector, dest: ref } = await deps.connectors.forDestination(f.destination_id));
      item = await connector.getItem(ref, f.item_id);
    }
  } catch (err) {
    if (err instanceof StorageError && err.code === 'not_found') throw new FileActionRefused(GIVE_LINK);
    if (err instanceof StorageError && (err.code === 'forbidden' || (url && err.code === 'invalid'))) throw new FileActionRefused(NOT_APPROVED_PLACE);
    throw err;
  }
  const place = await approvedPlaceOf(deps.pool, connector, ref, item, { prefer: f.destination_id, driveRootId });
  if (!place) throw new FileActionRefused(NOT_APPROVED_PLACE);
  // A linked document is someone else's: it may not be pointed at anything Kainow filed or keeps folders for.
  if (f.state === 'linked' && (await inKainowFiles(deps.pool, connector, ref, item, driveRootId))) throw new FileActionRefused(KAINOW_FILES);
  if (await standsElsewhere(deps.pool, f.id, ref.driveId, item.itemId)) throw new FileActionRefused(SHARED_FILE);
  if (contentDiffers(f, item)) throw new FileActionRefused(NOT_SAME_FILE);
  // The path as seen from the destination it is in now.
  const there = await deps.connectors.forDestination(place.id);
  let now = await there.connector.getItem(there.dest, item.itemId);
  // A file Kainow filed keeps the name Kainow gave it (from the output's title as recorded, cleaned if a case cleaned
  // it): renamed back where it is now, and that name is what is recorded, never the provider's. A linked document is
  // someone else's and keeps its own name.
  let name = now.name;
  if (f.state === 'stored' && now.name !== f.name) ({ ref: now, name } = await moveNamed(there.connector, there.dest, item.itemId, now.parentId, f.name));
  const seen = plainPath(now.path);
  const path = seen.includes('/') ? `${seen.slice(0, seen.lastIndexOf('/'))}/${name}` : name;
  const at = deps.clock();

  const c = await deps.pool.connect();
  try {
    await c.query('BEGIN');
    const v = (
      await c.query<{ id: string; output_id: string; version_no: number }>(`SELECT id, output_id, version_no FROM output_versions WHERE stored_file_id = $1`, [f.id])
    ).rows[0];
    if (v) await c.query(`SELECT 1 FROM outputs WHERE id = $1 FOR UPDATE`, [v.output_id]);
    const cur = (
      await c.query<{ item_id: string | null; destination_id: string | null }>(`SELECT item_id, destination_id FROM stored_files WHERE id = $1 FOR UPDATE`, [f.id])
    ).rows[0];
    if (cur?.item_id !== f.item_id || cur?.destination_id !== f.destination_id) throw new FileActionRefused(SAME_TIME);
    if (await standsElsewhere(c, f.id, ref.driveId, item.itemId)) throw new FileActionRefused(SHARED_FILE);
    // A filed file keeps a Kainow folder only when it now sits directly in one (then placement and sharing still apply).
    const folder =
      f.state === 'stored'
        ? ((await c.query<{ id: string }>(`SELECT id FROM storage_folders WHERE destination_id = $1 AND item_id = $2`, [place.id, now.parentId])).rows[0]?.id ?? null)
        : null;
    await c.query(
      `UPDATE stored_files SET destination_id = $2, connector = $3, drive_id = $4, item_id = $5, path = $6, name = $7, etag = $8, ctag = $9,
              web_url = $10, check_status = 'ok', last_checked_at = $11, folder_id = $12
        WHERE id = $1`,
      [f.id, place.id, place.connector, ref.driveId, item.itemId, path, name, now.etag, now.ctag, now.webUrl, at, folder],
    );
    await c.query(
      `INSERT INTO stored_file_moves (id, stored_file_id, reason, old_destination_id, old_drive_id, old_item_id, old_path,
                                      new_destination_id, new_drive_id, new_item_id, new_path, actor_id, at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [uuidv7(at.getTime()), f.id, RELINK_REASON, f.destination_id, f.drive_id, f.item_id, f.path, place.id, ref.driveId, item.itemId, path, actorId, at],
    );
    if (v) {
      await c.query(`INSERT INTO output_events (id, output_id, version_id, kind, actor_id, at, detail) VALUES ($1, $2, $3, 'relinked', $4, $5, $6)`, [
        uuidv7(at.getTime()), v.output_id, v.id, actorId, at, JSON.stringify({ versionNo: v.version_no, otherDestination: place.id !== f.destination_id }),
      ]);
      await writeAudit(c, {
        at, action: 'output.relinked', actorUserId: actorId, subjectType: 'output', subjectId: v.output_id,
        detail: { versionNo: v.version_no, otherDestination: place.id !== f.destination_id },
      });
    }
    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

/** Whether a stored file other than `fileId` already stands for the provider item (in any state, links included). */
async function standsElsewhere(db: Db, fileId: string, driveId: string, itemId: string): Promise<boolean> {
  const r = await db.query(`SELECT 1 FROM stored_files WHERE drive_id = $1 AND item_id = $2 AND id <> $3`, [driveId, itemId, fileId]);
  return (r.rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------------------------------------------------
// Registering changed content as a new version (spec 5.8: Changed)
// ---------------------------------------------------------------------------------------------------------------------

/**
 * SQL for where a version's latest change stands (`idExpr` is a column or a `$n` placeholder only, never a value).
 * Events of one instant have no order, so a request is matched by counting: every request ends in exactly one
 * `changed_registered` or `change_register_failed`, so one is `pending` while requests outnumber their outcomes.
 * `registered` when a `changed_registered` is at or after the last `changed_found`; `failed` when, nothing pending and
 * nothing registered, a request for this change ended in failure.
 */
export function changeStateSql(idExpr: string): { registered: string; pending: string; failed: string } {
  const at = (kind: string) => `(SELECT max(at) FROM output_events WHERE version_id = ${idExpr} AND kind = '${kind}')`;
  const count = (kinds: string) => `(SELECT count(*) FROM output_events WHERE version_id = ${idExpr} AND kind IN (${kinds}))`;
  const registered = `COALESCE(${at('changed_registered')} >= ${at('changed_found')}, false)`;
  const pending = `(${count("'change_register_requested'")} > ${count("'changed_registered', 'change_register_failed'")})`;
  return {
    registered,
    pending,
    failed: `(NOT ${pending} AND NOT ${registered} AND COALESCE(${at('change_register_failed')} >= ${at('changed_found')}, false))`,
  };
}
const CHANGE_STATE = changeStateSql('$1');

async function changeState(db: Db, versionId: string): Promise<{ registered: boolean; pending: boolean }> {
  return (
    await db.query<{ registered: boolean; pending: boolean }>(`SELECT ${CHANGE_STATE.registered} AS registered, ${CHANGE_STATE.pending} AS pending`, [versionId])
  ).rows[0];
}

/** Shown on a version whose last request to register its change failed for good. */
export const REGISTER_FAILED = 'Registering the changed file as a new version failed. Try again.';
/** Shown while a request to register the change waits for its job. */
export const REGISTER_PENDING = 'Registering the changed file as a new version';

interface ChangedRow {
  version_id: string; output_id: string; version_no: number; format: string; title: string; project_id: string;
  output_status: string; deleted: boolean; held: boolean; file_id: string | null; placement_folder_id: string | null;
}

const loadChanged = async (db: Db, versionId: string): Promise<ChangedRow | undefined> =>
  (
    await db.query<ChangedRow>(
      `SELECT v.id AS version_id, v.output_id, v.version_no, v.format, o.title, o.project_id, o.status AS output_status,
              o.deleted_at IS NOT NULL AS deleted, (o.held_case_id IS NOT NULL OR v.held_case_id IS NOT NULL) AS held,
              v.stored_file_id AS file_id, o.placement_folder_id
         FROM output_versions v JOIN outputs o ON o.id = v.output_id
        WHERE v.id = $1`,
      [versionId],
    )
  ).rows[0];

/** Why a change may not be registered now (null when it may). Only a file Kainow filed: a linked document is never touched. */
function refusalFor(v: ChangedRow | undefined, f: FileRow | undefined): string | null {
  if (!v?.file_id || !checkable(f)) return NO_FILE;
  if (f.state !== 'stored') return NOT_FILED_BY_KAINOW;
  if (v.output_status !== 'registered' || v.deleted || v.held) return ONLY_REGISTERED;
  if (f.check_status !== 'changed') return NOT_CHANGED;
  return null;
}

/**
 * The PM's or a Deputy's request (API side, in the caller's transaction, the output locked): checks the change may be
 * registered, records `change_register_requested` with who asked, and queues the `register-changed` job.
 */
export async function requestChangeRegistration(c: PoolClient, versionId: string, actorId: string, at: Date): Promise<void> {
  const v = await loadChanged(c, versionId);
  const f = v?.file_id ? await loadFile(c, v.file_id) : undefined;
  const refused = refusalFor(v, f);
  if (refused) throw new FileActionRefused(refused);
  const state = await changeState(c, versionId);
  if (state.registered) throw new FileActionRefused(ALREADY_REGISTERED);
  if (state.pending) throw new FileActionRefused(BUSY);
  const row = v as ChangedRow;
  await c.query(`INSERT INTO output_events (id, output_id, version_id, kind, actor_id, at, detail) VALUES ($1, $2, $3, 'change_register_requested', $4, $5, $6)`, [
    uuidv7(at.getTime()), row.output_id, versionId, actorId, at, JSON.stringify({ versionNo: row.version_no }),
  ]);
  await writeAudit(c, {
    at, action: 'output.change_register_requested', actorUserId: actorId, subjectType: 'output', subjectId: row.output_id, detail: { versionNo: row.version_no },
  });
  await queueStorageJob(c, 'register-changed', versionId);
}

/**
 * The `register-changed` job (spec 5.8): registers the changed content of a filed version's file as a new Draft version
 * (origin `changed_file`) for whoever asked. The current content is downloaded and uploaded as a new file
 * `<Title> v<n+1>.<ext>` in the output's own folder (its placement, never next to wherever the original now is; never
 * overwriting: ` (2)`, ` (3)` …), confirmed by size and QuickXorHash, and recorded with its own stored file. Then the
 * provider's version history of the original is searched for the recorded content; if found it is restored and the
 * original is Checked again, otherwise it stays Changed and shows "The approved content could not be recovered from
 * storage". One run at a time per version; a request is carried out once. A refusal ends the request
 * (`change_register_failed`); a provider fault is tried again by the job's attempts.
 */
export async function registerChangedContent(deps: StorageDeps, versionId: string): Promise<void> {
  const lock = await deps.pool.connect();
  let broken: Error | undefined;
  try {
    const got = (await lock.query<{ ok: boolean }>(`SELECT pg_try_advisory_lock(hashtext('register-changed'), hashtext($1)) AS ok`, [versionId])).rows[0].ok;
    // Another worker is on it: this run is tried again later and then finds it done.
    if (!got) throw new StorageError('throttled', { retryAfterMs: 60_000 });
    try {
      await registerLocked(deps, versionId);
    } catch (err) {
      if (!(err instanceof FileActionRefused)) throw err;
      await registrationFailed(deps, versionId, err.message);
    } finally {
      try {
        await lock.query(`SELECT pg_advisory_unlock(hashtext('register-changed'), hashtext($1))`, [versionId]);
      } catch (err) {
        broken = err instanceof Error ? err : new Error('unlock failed');
      }
    }
  } finally {
    lock.release(broken);
  }
}

/** Ends a pending request: `change_register_failed` (the reason is fixed text), so the PM can ask again. */
export async function registrationFailed(deps: Pick<StorageDeps, 'pool' | 'clock'>, versionId: string, reason: string): Promise<void> {
  const c = await deps.pool.connect();
  try {
    await c.query('BEGIN');
    // The output row, as a successful registration locks it: the request ends once, one way or the other.
    await c.query(`SELECT 1 FROM outputs WHERE id = (SELECT output_id FROM output_versions WHERE id = $1) FOR UPDATE`, [versionId]);
    const at = deps.clock();
    await c.query(
      `INSERT INTO output_events (id, output_id, version_id, kind, actor_id, at, detail)
       SELECT $1, v.output_id, v.id, 'change_register_failed', NULL, $3, $4 FROM output_versions v WHERE v.id = $2 AND ${changeStateSql('v.id').pending}`,
      [uuidv7(at.getTime()), versionId, at, JSON.stringify({ reason })],
    );
    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

async function registerLocked(deps: StorageDeps, versionId: string): Promise<void> {
  const state = await changeState(deps.pool, versionId);
  if (!state.pending) return; // carried out already, or ended
  const actor = (
    await deps.pool.query<{ actor_id: string }>(
      `SELECT actor_id FROM output_events WHERE version_id = $1 AND kind = 'change_register_requested' ORDER BY at DESC, id DESC LIMIT 1`,
      [versionId],
    )
  ).rows[0].actor_id;
  const v = await loadChanged(deps.pool, versionId);
  const f = v?.file_id ? await loadFile(deps.pool, v.file_id) : undefined;
  const refused = refusalFor(v, f);
  if (refused) throw new FileActionRefused(refused);
  const row = v as ChangedRow;
  const file = f as FileRow & { destination_id: string; item_id: string };

  // Looked at again: still changed, and still somewhere approved (otherwise it is Missing and nothing is uploaded).
  const verdict = await inspect(deps, file);
  if (verdict.status !== 'changed' || !verdict.item) {
    await record(deps, file, verdict.status, deps.clock(), verdict.item);
    throw new FileActionRefused(verdict.status === 'ok' ? CHANGE_GONE : NOT_CHANGED);
  }
  const item = verdict.item;
  const source = await deps.connectors.forDestination(file.destination_id);
  const bytes = await source.connector.download(source.dest, file.item_id);
  // The content read must be the content the provider describes (it may have changed again while downloading).
  if (bytes.length !== item.size || (item.providerHash !== null && quickXorHash(bytes) !== item.providerHash)) throw new StorageError('server');

  // The output's own folder: where its versions are filed (spec 5.4), in that folder's destination.
  const placement = row.placement_folder_id
    ? (await deps.pool.query<{ destination_id: string; status: string }>(
        `SELECT f.destination_id, d.status FROM storage_folders f JOIN storage_destinations d ON d.id = f.destination_id WHERE f.id = $1`,
        [row.placement_folder_id],
      )).rows[0]
    : undefined;
  if (!placement || placement.status !== 'approved') throw new FileActionRefused(NO_PLACEMENT);
  const target = await deps.connectors.forDestination(placement.destination_id);
  const wholeProject = await isWholeProject(deps.pool, row.output_id, deps.clock());
  const folder = await ensureOutputFolder(deps, target.dest, row.project_id, row.output_id, wholeProject, target.connector);

  const latest = (await deps.pool.query<{ n: number }>(`SELECT COALESCE(max(version_no), 0)::int AS n FROM output_versions WHERE output_id = $1`, [row.output_id])).rows[0].n;
  const versionNo = latest + 1;
  const ext = extOf(file.name) || row.format;
  const placed = await uploadNew(deps, target.connector, target.dest, folder.itemId, folder.path, { title: row.title, versionNo, ext }, bytes);

  const at = deps.clock();
  let held = false;
  const c = await deps.pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT 1 FROM outputs WHERE id = $1 FOR UPDATE`, [row.output_id]);
    const now = (await c.query<{ n: number }>(`SELECT COALESCE(max(version_no), 0)::int AS n FROM output_versions WHERE output_id = $1`, [row.output_id])).rows[0].n;
    // Another version was added while this one uploaded: the upload is removed and the job tries again with the next number.
    if (now !== latest) throw new StorageError('conflict');
    if (!(await changeState(c, versionId)).pending) throw new FileActionRefused(ALREADY_REGISTERED);
    const fileId = uuidv7(at.getTime());
    const ref = placed.ref;
    // As filing's confirm: what is recorded comes from the database as it is now (the title, cleaned if a case cleaned
    // it while the file uploaded, and the recorded folder names), and a held output's new file is withheld, not shared.
    const title = (await c.query<{ title: string }>(`SELECT title FROM outputs WHERE id = $1`, [row.output_id])).rows[0].title;
    const heldBy = await heldCaseAtConfirm(c, row.output_id, null);
    const folderPath = (await recordedFolderPath(c, folder.recordId)) ?? folder.path;
    const name = versionFileName(folderPath, title, versionNo, ext, placed.suffix);
    const path = [...folderPath, name].join('/');
    await c.query(
      `INSERT INTO stored_files (id, purpose, project_id, destination_id, connector, drive_id, item_id, path, name, size_bytes, sha256, provider_hash,
                                 etag, ctag, web_url, state, check_status, last_checked_at, created_at, stored_at, folder_id)
       VALUES ($1, 'output', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'stored', 'ok', $15, $15, $15, $16)`,
      [fileId, row.project_id, target.dest.id, target.dest.connector, target.dest.driveId, ref.itemId, path, name, ref.size, sha256(bytes), ref.providerHash, ref.etag, ref.ctag, heldBy ? null : ref.webUrl, at, folder.recordId],
    );
    const newVersionId = uuidv7(at.getTime());
    const outputHeld = (await c.query<{ held: string | null }>(`SELECT held_case_id AS held FROM outputs WHERE id = $1`, [row.output_id])).rows[0].held;
    await c.query(
      `INSERT INTO output_versions (id, output_id, version_no, origin, format, stored_file_id, status, sha256, size_bytes, created_by, created_at, held_case_id)
       VALUES ($1, $2, $3, 'changed_file', $4, $5, 'draft', $6, $7, $8, $9, $10)`,
      [newVersionId, row.output_id, versionNo, row.format, fileId, sha256(bytes), bytes.length, actor, at, outputHeld],
    );
    const event = (kind: string, id: string, detail: Record<string, unknown>) =>
      c.query(`INSERT INTO output_events (id, output_id, version_id, kind, actor_id, at, detail) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [
        uuidv7(at.getTime()), row.output_id, id, kind, actor, at, JSON.stringify(detail),
      ]);
    await event('version_added', newVersionId, { versionNo, origin: 'changed_file', format: row.format, from: row.version_no });
    await event('changed_registered', versionId, { versionNo: row.version_no, newVersionNo: versionNo });
    await writeAudit(c, {
      at, action: 'output.changed_registered', actorUserId: actor, subjectType: 'output', subjectId: row.output_id,
      detail: { versionNo: row.version_no, newVersionNo: versionNo },
    });
    if (heldBy) {
      // Never shared: the withhold job moves it out of any shared folder under its cleaned name, then removes it.
      await queueWithhold(c, [fileId], heldBy);
    } else {
      if (name !== ref.name) await queueStorageJob(c, 'rename-output', row.output_id, { priority: 'urgent' });
      await afterFiled(c, { projectId: row.project_id, outputId: row.output_id, versionId: newVersionId, storedFileId: fileId }, at);
    }
    held = heldBy !== null;
    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    // Nothing was recorded: the upload is nobody's.
    await removeUnrecorded(deps, target.connector, target.dest, placed.ref.itemId);
    throw err;
  } finally {
    c.release();
  }

  // A held output's original is withheld with it: nothing is restored next to it.
  if (!held) await restoreOriginal(deps, source.connector, source.dest, file);
}

/** Uploads under the first free name; never overwrites and never adopts a file it did not just upload. */
async function uploadNew(
  deps: CheckDeps, connector: StorageConnector, dest: DestinationRef, folderId: string, folderParts: string[],
  n: { title: string; versionNo: number; ext: string }, bytes: Buffer,
): Promise<{ ref: StoredRef; path: string; suffix: number }> {
  const hash = quickXorHash(bytes);
  for (let suffix = 1; suffix <= MAX_SUFFIX; suffix++) {
    let parts: string[];
    try {
      parts = fitPath(folderParts, outputFileName(n.title, n.versionNo, n.ext, suffix));
    } catch (err) {
      if (err instanceof PathTooLong) throw new FileActionRefused(PATH_TOO_LONG);
      throw err;
    }
    if (parts.slice(0, -1).some((p, i) => p !== folderParts[i])) throw new FileActionRefused(PATH_TOO_LONG);
    const name = parts[parts.length - 1];
    let ref: StoredRef;
    try {
      ref = await connector.upload(dest, folderId, name, bytes, { conflict: 'fail' });
    } catch (err) {
      if (err instanceof StorageError && err.code === 'conflict') continue;
      if (err instanceof StorageError) logFixed(deps, UPLOAD_UNCERTAIN);
      throw err;
    }
    if (ref.size !== bytes.length || ref.providerHash !== hash) {
      await connector.removePermanently(dest, ref.itemId).catch(() => logFixed(deps, UNRECORDED_KEPT));
      throw new StorageError('server');
    }
    return { ref, path: parts.join('/'), suffix };
  }
  throw new StorageError('conflict');
}

async function removeUnrecorded(deps: CheckDeps, connector: StorageConnector, dest: DestinationRef, itemId: string): Promise<void> {
  if (await deps.pool.query(`SELECT 1 FROM stored_files WHERE drive_id = $1 AND item_id = $2`, [dest.driveId, itemId]).then((r) => (r.rowCount ?? 0) > 0)) return;
  await connector.removePermanently(dest, itemId).catch(() => logFixed(deps, UNRECORDED_KEPT));
}

/**
 * Looks through the original item's version history for the recorded content (same size, same QuickXorHash) and
 * restores it; the original is Checked again only once the provider shows the recorded content. The new version is
 * already recorded, so any fault here only leaves the original Changed (logged with fixed text), never fails the job.
 */
async function restoreOriginal(deps: CheckDeps, connector: StorageConnector, dest: DestinationRef, f: FileRow & { item_id: string }): Promise<boolean> {
  if (!f.provider_hash || f.size_bytes === null) return false;
  const size = Number(f.size_bytes);
  try {
    const versions = await connector.listVersions(dest, f.item_id, { size });
    const match = versions.find((x) => x.size === size && x.providerHash === f.provider_hash);
    if (!match) return false;
    await connector.restoreVersion(dest, f.item_id, match.id);
    const item = await connector.getItem(dest, f.item_id);
    if (contentDiffers(f, item)) return false;
    await record(deps, f, 'ok', deps.clock(), item);
    return true;
  } catch {
    logFixed(deps, RESTORE_FAILED);
    return false;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------------------------------------------------

registerStorageHandler('check', async (deps, storedFileId) => {
  await checkFile(deps, storedFileId, { throwFaults: true });
});
registerStorageHandler('register-changed', (deps, versionId) => registerChangedContent(deps, versionId));
// After the last attempt the request ends, so the PM sees it failed and can ask again.
registerStorageFinalFailure('register-changed', (deps, versionId) => registrationFailed(deps, versionId, REGISTER_FAILED));
registerStorageDailyTask('output-check', async (deps) => {
  await checkOutputs(deps, deps.clock());
});
