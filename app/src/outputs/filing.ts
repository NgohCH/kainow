import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { uuidv7 } from '../common/uuid7';
import type { StorageConnector } from '../storage/connector';
import {
  type StorageDeps, type StorageFailureCode, registerStorageDailyTask, registerStorageFinalFailure, registerStorageHandler,
} from '../storage/jobs';
import { queueStorageJob } from '../storage/outbox';
import { quickXorHash } from '../storage/quickxor';
import { type DestinationRef, type FolderRef, StorageError, type StoredRef } from '../storage/types';
import { MAX_NAME, PathTooLong, RESTRICTED_SUFFIX, fitPath, outputFileName, safeName } from './naming';
import { isWholeProject } from './readers';
import { sharingAfterFiled } from './sharing';

/**
 * Filing an output version (spec 5.4, D103): the version's bytes are uploaded to the project's output destination under
 * `Department / Project / Year / Report Type` (an output read by the whole project) or
 * `Department / Project (restricted) / <output folder>` (any other), named `<Title> v<n>.<ext>`, and reported filed only
 * once the provider's size and QuickXorHash match what Kainow sent. The bytes then leave the database.
 *
 * Folder keys follow the quarantine registry's contract: department `<dept>`, project `<dept>/<project>`, year
 * `<dept>/<project>/<yyyy>`, report type `<dept>/<project>/<yyyy>/<type>`, restricted root `<dept>/<project>/restricted`,
 * output folder `<dept>/<project>/output/<output>`.
 */

export const NO_DESTINATION = 'Choose where this project files its outputs first (Project settings › Outputs).';
export const DIFFERENT_FILE = 'A different file already has this name';
export const NOT_KEPT = 'Not filed — file no longer kept; generate or upload it again';
export const ALREADY_FILED = 'This version is already filed.';
export const BEING_FILED = 'This version is already being filed.';
export const LINKED_NOT_FILED = 'A linked version stays where it is and is not filed.';
export const REGISTER_FIRST = 'Register this output before filing it.';

/** A failure code recorded on the stored file when even the shortest names do not fit (not a provider code). */
const PATH_TOO_LONG = 'path_too_long';
/** The version's bytes were gone when the job ran. */
const BYTES_GONE = 'not_kept';
/** The output was withdrawn, deleted or held (or the version held) when the job ran: Try again once it may be filed. */
const NOT_FILEABLE = 'not_fileable';

/** The reason shown after "Filing failed — " for each failure code. */
const FILING_REASONS: Readonly<Record<string, string>> = {
  unreachable: 'The storage service could not be reached',
  timeout: 'The storage service took too long to answer',
  throttled: 'The storage service asked Kainow to slow down',
  unauthorised: 'The storage connection was not accepted',
  forbidden: 'The storage connection does not have permission for this',
  not_found: 'A folder Kainow files into was not found',
  conflict: DIFFERENT_FILE,
  too_large: 'The file is too large for the storage service',
  quota: 'The storage location is full',
  server: 'The storage service reported an error',
  invalid: 'The output destination is not available',
  unsupported: 'The storage service does not support this',
  internal: 'Kainow ran into a problem',
  [PATH_TOO_LONG]: 'The folder path is too long',
  [BYTES_GONE]: 'The file is no longer kept',
  [NOT_FILEABLE]: 'The output was withdrawn, deleted or held before it was filed',
};

/** "Filing failed — <reason>" for a failed version (spec 5.4). */
export function filingFailedLabel(code: string | null): string {
  return `Filing failed — ${FILING_REASONS[code ?? 'internal'] ?? FILING_REASONS.internal}`;
}

/** How many ` (n)` suffixes are tried when other files or folders already have the name, before the attempt fails `conflict`. */
const MAX_SUFFIX = 20;

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const tailOf = (n: number): string => (n > 1 ? ` (${n})` : '');
const logFixed = (deps: StorageDeps, message: string): void => (deps.log ?? ((m) => console.warn(m)))(message);

const STRAY_REMOVED = 'An earlier upload of an output version was left where it no longer belongs; it has been removed.';
const STRAY_KEPT = 'An earlier upload of an output version could not be checked or removed; it may be left in storage.';
const UNRECORDED_REMOVED = 'An output version uploaded while its filing changed was not recorded; the upload has been removed.';
const UNRECORDED_KEPT = 'An output version uploaded while its filing changed was not recorded and could not be removed; it may be left in storage.';

// ---------------------------------------------------------------------------------------------------------------------
// Requesting (API side)
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Records that a version is to be filed in `destinationId` and queues the `file-output` job in the caller's
 * transaction. The caller holds the output (and so the version) locked and has checked the version may be filed. A
 * version whose filing failed keeps its one stored file, put back to pending ("Try again"), with the record of where
 * its last upload went (so a stray copy is found again); otherwise a new stored file is added and linked to the
 * version, so a version never has more than one.
 */
export async function requestFiling(
  c: PoolClient,
  v: { versionId: string; projectId: string; storedFileId: string | null; fileName: string },
  destinationId: string,
  at: Date,
): Promise<void> {
  if (v.storedFileId) {
    const r = await c.query(
      `UPDATE stored_files SET state = 'pending', destination_id = $2, failure_code = NULL, attempts = 0 WHERE id = $1 AND state = 'failed'`,
      [v.storedFileId, destinationId],
    );
    if (r.rowCount !== 1) throw new Error('only a failed filing can be tried again');
  } else {
    const id = uuidv7(at.getTime());
    await c.query(
      `INSERT INTO stored_files (id, purpose, project_id, destination_id, name, state, created_at) VALUES ($1, 'output', $2, $3, $4, 'pending', $5)`,
      [id, v.projectId, destinationId, v.fileName, at],
    );
    const r = await c.query(`UPDATE output_versions SET stored_file_id = $2 WHERE id = $1 AND stored_file_id IS NULL`, [v.versionId, id]);
    if (r.rowCount !== 1) throw new Error('the version already has a stored file');
  }
  await queueStorageJob(c, 'file-output', v.versionId);
}

// ---------------------------------------------------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------------------------------------------------

/** A folder an output version is filed in, its `storage_folders` row, and the folder names from the destination root down to it. */
export interface OutputFolder extends FolderRef {
  recordId: string;
  path: string[];
}

interface FolderFacts {
  departmentId: string; departmentName: string; projectName: string; title: string;
  year: string; reportTypeId: string; reportTypeName: string; placementFolderId: string | null;
}

async function folderFacts(deps: StorageDeps, projectId: string, outputId: string): Promise<FolderFacts> {
  const r = (
    await deps.pool.query<FolderFacts>(
      `SELECT p.owning_department_id AS "departmentId", d.name AS "departmentName", p.name AS "projectName", o.title,
              to_char(o.issue_date, 'YYYY') AS year, o.report_type_id AS "reportTypeId", t.name AS "reportTypeName",
              o.placement_folder_id AS "placementFolderId"
         FROM outputs o JOIN projects p ON p.id = o.project_id JOIN departments d ON d.id = p.owning_department_id
         LEFT JOIN report_types t ON t.id = o.report_type_id
        WHERE o.id = $1 AND o.project_id = $2`,
      [outputId, projectId],
    )
  ).rows[0];
  if (!r) throw new Error('output not found for filing');
  return r;
}

type FolderLevel = 'department' | 'project' | 'year' | 'report_type' | 'restricted_root' | 'output';

/**
 * One folder on the way down. `adopt` levels (department, year, report type) take an existing folder of the name, as
 * they hold nothing of their own; the others (project, restricted root, output folder) are shared by Kainow with
 * particular people (spec 5.5), so they are only ever created, never adopted: on a clash the name gets ` (2)`, ` (3)` ….
 */
interface Level { level: FolderLevel; key: string; adopt: boolean; name: (n: number) => Promise<string | null> }

interface FolderRecord { id: string; item_id: string; name: string; level: FolderLevel; key: string }

const recordedFolder = async (deps: StorageDeps, destinationId: string, level: FolderLevel, key: string): Promise<FolderRecord | undefined> =>
  (
    await deps.pool.query<FolderRecord>(
      `SELECT id, item_id, name, level, key FROM storage_folders WHERE destination_id = $1 AND level = $2 AND key = $3`,
      [destinationId, level, key],
    )
  ).rows[0];

/**
 * The output's folder (spec 5.4). An output keeps the folder its first filed version went to (`placement_folder_id`),
 * so later changes to its issue date or report type never split its versions, as long as its readers stay the same
 * kind (the whole project, or not). Otherwise the folder is derived, created where missing and recorded in
 * `storage_folders`; a folder already recorded is reused by item id with the name it was created with, so renaming a
 * department, project or report type in Kainow never renames or moves folders. One worker at a time per destination
 * and project decides folder names.
 */
export async function ensureOutputFolder(
  deps: StorageDeps, dest: DestinationRef, projectId: string, outputId: string, wholeProject: boolean, connector?: StorageConnector,
): Promise<OutputFolder> {
  const f = await folderFacts(deps, projectId, outputId);
  const placed = await placementFolder(deps, dest, f.placementFolderId, wholeProject);
  if (placed) return placed;

  const conn = connector ?? (await deps.connectors.forDestination(dest.id)).connector;
  const d = f.departmentId;
  const p = `${d}/${projectId}`;
  const levels: Level[] = [{ level: 'department', key: d, adopt: true, name: async () => safeName(f.departmentName) }];
  if (wholeProject) {
    if (!f.year || !f.reportTypeId) throw new StorageError('invalid'); // a registered output always has both
    levels.push(
      { level: 'project', key: p, adopt: false, name: async (n) => `${safeName(f.projectName, MAX_NAME - tailOf(n).length)}${tailOf(n)}` },
      { level: 'year', key: `${p}/${f.year}`, adopt: true, name: async () => f.year },
      { level: 'report_type', key: `${p}/${f.year}/${f.reportTypeId}`, adopt: true, name: async () => safeName(f.reportTypeName) },
    );
  } else {
    levels.push(
      {
        level: 'restricted_root',
        key: `${p}/restricted`,
        adopt: false,
        // Named after the project folder as created, if there is one, so the two stay side by side after a rename.
        name: async (n) => {
          const base = (await recordedFolder(deps, dest.id, 'project', p))?.name ?? f.projectName;
          return `${safeName(base, MAX_NAME - RESTRICTED_SUFFIX.length - tailOf(n).length)}${tailOf(n)}${RESTRICTED_SUFFIX}`;
        },
      },
      {
        level: 'output',
        key: `${p}/output/${outputId}`,
        adopt: false,
        // Another output folder of the project already named so is skipped without asking the provider.
        name: async (n) => {
          const name = `${safeName(f.title, MAX_NAME - tailOf(n).length)}${tailOf(n)}`;
          const taken = await deps.pool.query(
            `SELECT 1 FROM storage_folders WHERE destination_id = $1 AND level = 'output' AND key LIKE $2 AND lower(name) = lower($3)`,
            [dest.id, `${p}/output/%`, name],
          );
          return taken.rowCount ? null : name;
        },
      },
    );
  }

  const lockKey = `${dest.id}/${projectId}`;
  const lock = await deps.pool.connect();
  let broken: Error | undefined;
  try {
    await lock.query(`SELECT pg_advisory_lock(hashtext('output-folders'), hashtext($1))`, [lockKey]);
    try {
      let parent: string | null = null;
      let rec: FolderRecord | undefined;
      const path: string[] = [];
      for (const l of levels) {
        rec = await recordedFolder(deps, dest.id, l.level, l.key);
        if (!rec) {
          const made = await makeFolder(conn, dest, parent, l);
          await deps.pool.query(
            `INSERT INTO storage_folders (id, destination_id, level, key, item_id, name, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (destination_id, level, key) DO NOTHING`,
            [uuidv7(), dest.id, l.level, l.key, made.itemId, made.name, deps.clock()],
          );
          rec = await recordedFolder(deps, dest.id, l.level, l.key);
          if (!rec) throw new Error('folder record missing');
        }
        parent = rec.item_id;
        path.push(rec.name);
      }
      const last = rec as FolderRecord;
      return { itemId: last.item_id, name: last.name, recordId: last.id, path };
    } finally {
      try {
        await lock.query(`SELECT pg_advisory_unlock(hashtext('output-folders'), hashtext($1))`, [lockKey]);
      } catch (err) {
        broken = err instanceof Error ? err : new Error('unlock failed');
      }
    }
  } finally {
    lock.release(broken);
  }
}

/** Adopts or creates one folder (see Level). */
async function makeFolder(conn: StorageConnector, dest: DestinationRef, parent: string | null, l: Level): Promise<FolderRef> {
  if (l.adopt) {
    const name = await l.name(1);
    return conn.ensureFolder(dest, parent, name as string);
  }
  for (let n = 1; n <= MAX_SUFFIX; n++) {
    const name = await l.name(n);
    if (name === null) continue;
    try {
      return await conn.createFolder(dest, parent, name);
    } catch (err) {
      if (!(err instanceof StorageError && err.code === 'conflict')) throw err;
    }
  }
  throw new StorageError('conflict');
}

/**
 * The output's fixed folder, with its path rebuilt from the recorded folders above it; null when it has none in this
 * destination or its readers have changed kind (a report type folder for an output read by the whole project, an
 * output folder for any other).
 */
async function placementFolder(deps: StorageDeps, dest: DestinationRef, placementId: string | null, wholeProject: boolean): Promise<OutputFolder | null> {
  if (!placementId) return null;
  const rec = (
    await deps.pool.query<FolderRecord>(`SELECT id, item_id, name, level, key FROM storage_folders WHERE id = $1 AND destination_id = $2`, [placementId, dest.id])
  ).rows[0];
  if (!rec || rec.level !== (wholeProject ? 'report_type' : 'output')) return null;
  const [d, proj, third] = rec.key.split('/');
  const above: Array<[FolderLevel, string]> = wholeProject
    ? [['department', d], ['project', `${d}/${proj}`], ['year', `${d}/${proj}/${third}`]]
    : [['department', d], ['restricted_root', `${d}/${proj}/restricted`]];
  const path: string[] = [];
  for (const [level, key] of above) {
    const a = await recordedFolder(deps, dest.id, level, key);
    if (!a) return null;
    path.push(a.name);
  }
  return { itemId: rec.item_id, name: rec.name, recordId: rec.id, path: [...path, rec.name] };
}

// ---------------------------------------------------------------------------------------------------------------------
// The file-output job
// ---------------------------------------------------------------------------------------------------------------------

interface JobRow {
  version_id: string; output_id: string; version_no: number; format: string; stored_file_id: string | null;
  version_held: boolean; title: string; project_id: string; status: string; deleted: boolean; output_held: boolean;
  file_state: string | null; destination_id: string | null; bytes: Buffer | null;
  upload_destination_id: string | null; upload_folder_id: string | null; upload_name: string | null;
}

async function loadJob(deps: StorageDeps, versionId: string): Promise<JobRow | undefined> {
  return (
    await deps.pool.query<JobRow>(
      `SELECT v.id AS version_id, v.output_id, v.version_no, v.format, v.stored_file_id, v.held_case_id IS NOT NULL AS version_held,
              o.title, o.project_id, o.status, o.deleted_at IS NOT NULL AS deleted, o.held_case_id IS NOT NULL AS output_held,
              f.state AS file_state, f.destination_id, b.bytes, f.upload_destination_id, f.upload_folder_id, f.upload_name
         FROM output_versions v JOIN outputs o ON o.id = v.output_id
         LEFT JOIN stored_files f ON f.id = v.stored_file_id
         LEFT JOIN output_version_bytes b ON b.output_version_id = v.id
        WHERE v.id = $1`,
      [versionId],
    )
  ).rows[0];
}

/**
 * The `file-output` job (spec 5.4, 5.6). One worker at a time per version (an advisory lock; a second run meanwhile
 * fails retryably), a version already filed is left alone, and before each upload the exact folder and name are
 * recorded, so an upload whose answer was lost is found there on the next attempt and adopted only when its size and
 * hash match: a version never gets a second copy and never takes over another's file. Every attempt rechecks the
 * output: a withdrawn, deleted or held output (or held version) fails at once as not fileable, for Try again later. A
 * failed attempt puts the file back to pending with the attempt counted and keeps the bytes.
 */
export async function fileOutputVersion(deps: StorageDeps, versionId: string): Promise<void> {
  const lock = await deps.pool.connect();
  let broken: Error | undefined;
  try {
    const got = (await lock.query<{ ok: boolean }>(`SELECT pg_try_advisory_lock(hashtext('file-output'), hashtext($1)) AS ok`, [versionId])).rows[0].ok;
    // Another worker is filing this version: this run is tried again later and then finds it filed.
    if (!got) throw new StorageError('throttled', { retryAfterMs: 60_000 });
    try {
      await fileLocked(deps, versionId);
    } finally {
      try {
        await lock.query(`SELECT pg_advisory_unlock(hashtext('file-output'), hashtext($1))`, [versionId]);
      } catch (err) {
        broken = err instanceof Error ? err : new Error('unlock failed');
      }
    }
  } finally {
    lock.release(broken);
  }
}

async function fileLocked(deps: StorageDeps, versionId: string): Promise<void> {
  const v = await loadJob(deps, versionId);
  if (!v || !v.stored_file_id || !v.destination_id) return;
  if (v.file_state !== 'pending' && v.file_state !== 'storing') return;
  if (v.status !== 'registered' || v.deleted || v.output_held || v.version_held) {
    await markFilingFailed(deps, versionId, NOT_FILEABLE);
    return;
  }
  const fileId = v.stored_file_id;
  if (!v.bytes) {
    await markFilingFailed(deps, versionId, BYTES_GONE);
    return;
  }
  const approved = (await deps.pool.query(`SELECT 1 FROM storage_destinations WHERE id = $1 AND purpose = 'outputs' AND status = 'approved'`, [v.destination_id])).rowCount;
  if (!approved) throw new StorageError('invalid');
  const { connector, dest } = await deps.connectors.forDestination(v.destination_id);
  const bytes = v.bytes;

  await deps.pool.query(`UPDATE stored_files SET state = 'storing' WHERE id = $1 AND state = 'pending'`, [fileId]);
  let placed: { ref: StoredRef; parts: string[]; folder: OutputFolder };
  try {
    const wholeProject = await isWholeProject(deps.pool, v.output_id, deps.clock());
    const folder = await ensureOutputFolder(deps, dest, v.project_id, v.output_id, wholeProject, connector);
    placed = { ...(await put(deps, connector, dest, folder, v, bytes)), folder };
  } catch (err) {
    const code = err instanceof PathTooLong ? PATH_TOO_LONG : err instanceof StorageError ? err.code : 'internal';
    await deps.pool.query(
      `UPDATE stored_files SET state = 'pending', attempts = attempts + 1, failure_code = $2 WHERE id = $1 AND state = 'storing'`,
      [fileId, code],
    );
    // A path that cannot be shortened enough will not fit next time either.
    if (err instanceof PathTooLong) throw new StorageError('invalid');
    throw err;
  }

  const at = deps.clock();
  const { ref, parts, folder } = placed;
  const c = await deps.pool.connect();
  let recorded = false;
  try {
    await c.query('BEGIN');
    const now = (
      await c.query<{ stored_file_id: string | null }>(`SELECT stored_file_id FROM output_versions WHERE id = $1 FOR UPDATE`, [versionId])
    ).rows[0];
    const state = (await c.query<{ state: string }>(`SELECT state FROM stored_files WHERE id = $1 FOR UPDATE`, [fileId])).rows[0]?.state;
    if (now?.stored_file_id === fileId && state === 'storing') {
      await c.query(
        `UPDATE stored_files SET state = 'stored', destination_id = $2, connector = $3, drive_id = $4, item_id = $5, path = $6, name = $7,
                size_bytes = $8, sha256 = $9, provider_hash = $10, etag = $11, ctag = $12, web_url = $13, stored_at = $14, failure_code = NULL
          WHERE id = $1`,
        [fileId, dest.id, dest.connector, dest.driveId, ref.itemId, parts.join('/'), ref.name, ref.size, sha256(bytes), ref.providerHash, ref.etag, ref.ctag, ref.webUrl, at],
      );
      // The output's versions all go here from now on (spec 5.4: every version lives in the same place).
      await c.query(`UPDATE outputs SET placement_folder_id = $2 WHERE id = $1 AND placement_folder_id IS DISTINCT FROM $2`, [v.output_id, folder.recordId]);
      // Only once the provider has confirmed the file do its bytes leave the database.
      await c.query(`DELETE FROM output_version_bytes WHERE output_version_id = $1`, [versionId]);
      await c.query(`INSERT INTO output_events (id, output_id, version_id, kind, actor_id, at, detail) VALUES ($1, $2, $3, 'filed', NULL, $4, $5)`, [
        uuidv7(at.getTime()), v.output_id, versionId, at, JSON.stringify({ versionNo: v.version_no }),
      ]);
      await afterFiled(c, { projectId: v.project_id, outputId: v.output_id, versionId, storedFileId: fileId }, at);
      recorded = true;
    }
    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    await removeUnrecorded(deps, connector, dest, ref.itemId);
    throw err;
  } finally {
    c.release();
  }
  // The filing changed while the file was uploading (Try again elsewhere, or another worker): this copy is nobody's.
  if (!recorded) await removeUnrecorded(deps, connector, dest, ref.itemId);
}

async function removeUnrecorded(deps: StorageDeps, connector: StorageConnector, dest: DestinationRef, itemId: string): Promise<void> {
  if (await referencedElsewhere(deps, null, dest.driveId, itemId)) return;
  try {
    await connector.removePermanently(dest, itemId);
    logFixed(deps, UNRECORDED_REMOVED);
  } catch {
    logFixed(deps, UNRECORDED_KEPT);
  }
}

/** Whether another stored file (any but `fileId`) already stands for the provider item. */
async function referencedElsewhere(deps: StorageDeps, fileId: string | null, driveId: string, itemId: string): Promise<boolean> {
  const r = await deps.pool.query(`SELECT 1 FROM stored_files WHERE drive_id = $1 AND item_id = $2 AND id IS DISTINCT FROM $3`, [driveId, itemId, fileId]);
  return (r.rowCount ?? 0) > 0;
}

/**
 * Uploads the version as `<Title> v<n>.<ext>` and confirms it: size and QuickXorHash must match what Kainow sent.
 * First the previous attempt's recorded target: in the same folder, the file there is adopted when it matches and no
 * other stored file stands for it (the answer was lost); in another place (the destination or the readers changed),
 * that earlier upload is removed as a stray. Then names are tried in order, each recorded before it is sent; a name
 * already taken (by anyone) moves to the next ` (2)`, ` (3)` …, so nothing is ever overwritten or taken over. A fresh
 * upload the provider reports differently is removed (best effort) and the attempt fails.
 */
async function put(
  deps: StorageDeps, connector: StorageConnector, dest: DestinationRef, folder: OutputFolder, v: JobRow, bytes: Buffer,
): Promise<{ ref: StoredRef; parts: string[] }> {
  const fileId = v.stored_file_id as string;
  const hash = quickXorHash(bytes);
  const matches = (r: StoredRef) => r.size === bytes.length && r.providerHash === hash;
  if (v.upload_destination_id && v.upload_folder_id && v.upload_name) {
    if (v.upload_destination_id === dest.id && v.upload_folder_id === folder.itemId) {
      const found = await connector.findChild(dest, folder.itemId, v.upload_name);
      if (found && matches(found) && !(await referencedElsewhere(deps, fileId, dest.driveId, found.itemId))) {
        return { ref: found, parts: [...folder.path, found.name] };
      }
    } else {
      await removeStray(deps, fileId, v.upload_destination_id, v.upload_folder_id, v.upload_name, matches);
    }
  }
  for (let suffix = 1; suffix <= MAX_SUFFIX; suffix++) {
    const parts = fitPath(folder.path, outputFileName(v.title, v.version_no, v.format, suffix));
    // Folders already exist: only the file name may be shortened.
    if (parts.slice(0, -1).some((p, i) => p !== folder.path[i])) throw new PathTooLong();
    const name = parts[parts.length - 1];
    await deps.pool.query(`UPDATE stored_files SET upload_destination_id = $2, upload_folder_id = $3, upload_name = $4 WHERE id = $1`, [
      fileId, dest.id, folder.itemId, name,
    ]);
    let ref: StoredRef;
    try {
      ref = await connector.upload(dest, folder.itemId, name, bytes, { conflict: 'fail' });
    } catch (err) {
      if (!(err instanceof StorageError && err.code === 'conflict')) throw err;
      continue;
    }
    if (!matches(ref)) {
      await connector.removePermanently(dest, ref.itemId).catch(() => undefined);
      throw new StorageError('server');
    }
    return { ref, parts };
  }
  throw new StorageError('conflict');
}

/** Removes this version's earlier upload from a place it no longer belongs, if it is there, matches and is nobody else's. Best effort. */
async function removeStray(
  deps: StorageDeps, fileId: string, destinationId: string, folderId: string, name: string, matches: (r: StoredRef) => boolean,
): Promise<void> {
  try {
    const { connector, dest } = await deps.connectors.forDestination(destinationId);
    const found = await connector.findChild(dest, folderId, name);
    if (found && matches(found) && !(await referencedElsewhere(deps, fileId, dest.driveId, found.itemId))) {
      await connector.removePermanently(dest, found.itemId);
      logFixed(deps, STRAY_REMOVED);
    }
  } catch {
    logFixed(deps, STRAY_KEPT);
  }
}

/**
 * Runs in the transaction that records a version filed: sharing is set at once (spec 5.4) by queuing `share-sync` for
 * the project folder or the output's own folder (and placing the output again if its readers changed while it uploaded).
 */
export async function afterFiled(
  c: PoolClient, filed: { projectId: string; outputId: string; versionId: string; storedFileId: string }, at: Date,
): Promise<void> {
  await sharingAfterFiled(c, filed.outputId, at);
}

/**
 * Marks a version's filing failed: after the last attempt (the job's code), or at once when the output may not be
 * filed or the bytes are gone. The version shows "Filing failed — <reason>" with Try again.
 */
export async function markFilingFailed(deps: StorageDeps, versionId: string, code: StorageFailureCode | typeof NOT_FILEABLE | typeof BYTES_GONE): Promise<void> {
  const c = await deps.pool.connect();
  try {
    await c.query('BEGIN');
    const r = (
      await c.query<{ output_id: string; version_no: number }>(
        `UPDATE stored_files f SET state = 'failed', failure_code = CASE WHEN f.failure_code = $2 AND $3 = 'invalid' THEN f.failure_code ELSE $3 END
           FROM output_versions v
          WHERE v.id = $1 AND f.id = v.stored_file_id AND f.state IN ('pending', 'storing')
        RETURNING v.output_id, v.version_no`,
        [versionId, PATH_TOO_LONG, code],
      )
    ).rows[0];
    if (r) {
      const at = deps.clock();
      await c.query(`INSERT INTO output_events (id, output_id, version_id, kind, actor_id, at, detail) VALUES ($1, $2, $3, 'filing_failed', NULL, $4, $5)`, [
        uuidv7(at.getTime()), r.output_id, versionId, at, JSON.stringify({ versionNo: r.version_no, code }),
      ]);
    }
    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Unfiled bytes (spec 5.4: Kainow is not the document store)
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Drops the bytes of Draft versions not filed by `kept_until` (90 days after they were made). A version being filed
 * (pending or storing) or held keeps them. The version then shows "Not filed — file no longer kept; generate or upload
 * it again". Returns how many were dropped.
 */
export async function dropUnfiledBytes(deps: StorageDeps): Promise<number> {
  const r = await deps.pool.query(
    `DELETE FROM output_version_bytes b
      USING output_versions v
       JOIN outputs o ON o.id = v.output_id
       LEFT JOIN stored_files f ON f.id = v.stored_file_id
      WHERE b.output_version_id = v.id AND b.kept_until <= $1 AND v.status = 'draft'
        AND v.held_case_id IS NULL AND o.held_case_id IS NULL
        AND (f.id IS NULL OR f.state = 'failed')`,
    [deps.clock()],
  );
  return r.rowCount ?? 0;
}

registerStorageHandler('file-output', (deps, versionId) => fileOutputVersion(deps, versionId));
registerStorageFinalFailure('file-output', markFilingFailed);
registerStorageDailyTask('output-bytes', async (deps) => {
  await dropUnfiledBytes(deps);
});
