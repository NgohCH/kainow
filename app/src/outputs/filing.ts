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
};

/** "Filing failed — <reason>" for a failed version (spec 5.4). */
export function filingFailedLabel(code: string | null): string {
  return `Filing failed — ${FILING_REASONS[code ?? 'internal'] ?? FILING_REASONS.internal}`;
}

/** How many ` (n)` suffixes are tried when other files already have the name, before the attempt fails `conflict`. */
const MAX_SUFFIX = 20;

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

// ---------------------------------------------------------------------------------------------------------------------
// Requesting (API side)
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Records that a version is to be filed in `destinationId` and queues the `file-output` job in the caller's
 * transaction. The caller holds the output (and so the version) locked and has checked the version may be filed. A
 * version whose filing failed keeps its one stored file, put back to pending ("Try again"); otherwise a new stored file
 * is added and linked to the version, so a version never has more than one.
 */
export async function requestFiling(
  c: PoolClient,
  v: { versionId: string; projectId: string; storedFileId: string | null; fileName: string },
  destinationId: string,
  at: Date,
): Promise<void> {
  if (v.storedFileId) {
    await c.query(
      `UPDATE stored_files SET state = 'pending', destination_id = $2, failure_code = NULL, attempts = 0 WHERE id = $1 AND state = 'failed'`,
      [v.storedFileId, destinationId],
    );
  } else {
    const id = uuidv7(at.getTime());
    await c.query(
      `INSERT INTO stored_files (id, purpose, project_id, destination_id, name, state, created_at) VALUES ($1, 'output', $2, $3, $4, 'pending', $5)`,
      [id, v.projectId, destinationId, v.fileName, at],
    );
    await c.query(`UPDATE output_versions SET stored_file_id = $2 WHERE id = $1 AND stored_file_id IS NULL`, [v.versionId, id]);
  }
  await queueStorageJob(c, 'file-output', v.versionId);
}

// ---------------------------------------------------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------------------------------------------------

/** A folder an output version is filed in, with the names of the folders from the destination root down to it. */
export interface OutputFolder extends FolderRef {
  path: string[];
}

interface FolderFacts {
  departmentId: string; departmentName: string; projectName: string; title: string;
  year: string; reportTypeId: string; reportTypeName: string;
}

async function folderFacts(deps: StorageDeps, projectId: string, outputId: string): Promise<FolderFacts> {
  const r = (
    await deps.pool.query<FolderFacts>(
      `SELECT p.owning_department_id AS "departmentId", d.name AS "departmentName", p.name AS "projectName", o.title,
              to_char(o.issue_date, 'YYYY') AS year, o.report_type_id AS "reportTypeId", t.name AS "reportTypeName"
         FROM outputs o JOIN projects p ON p.id = o.project_id JOIN departments d ON d.id = p.owning_department_id
         LEFT JOIN report_types t ON t.id = o.report_type_id
        WHERE o.id = $1 AND o.project_id = $2`,
      [outputId, projectId],
    )
  ).rows[0];
  if (!r) throw new Error('output not found for filing');
  return r;
}

interface Level { level: 'department' | 'project' | 'year' | 'report_type' | 'restricted_root' | 'output'; key: string; name: () => Promise<string> }

/**
 * The output's folder, created where missing and recorded in `storage_folders`; a folder already recorded is reused by
 * its item id with the name it was created with, so renaming a department, project or report type in Kainow never
 * renames or moves folders. One worker at a time per destination and project decides folder names, so two outputs with
 * the same title never share a folder.
 */
export async function ensureOutputFolder(
  deps: StorageDeps, dest: DestinationRef, projectId: string, outputId: string, wholeProject: boolean, connector?: StorageConnector,
): Promise<OutputFolder> {
  const conn = connector ?? (await deps.connectors.forDestination(dest.id)).connector;
  const f = await folderFacts(deps, projectId, outputId);
  const d = f.departmentId;
  const p = `${d}/${projectId}`;
  const recorded = async (level: string, key: string) =>
    (await deps.pool.query<{ item_id: string; name: string }>(`SELECT item_id, name FROM storage_folders WHERE destination_id = $1 AND level = $2 AND key = $3`, [dest.id, level, key])).rows[0];
  const levels: Level[] = [{ level: 'department', key: d, name: async () => safeName(f.departmentName) }];
  if (wholeProject) {
    if (!f.year || !f.reportTypeId) throw new StorageError('invalid'); // a registered output always has both
    levels.push(
      { level: 'project', key: p, name: async () => safeName(f.projectName) },
      { level: 'year', key: `${p}/${f.year}`, name: async () => f.year },
      { level: 'report_type', key: `${p}/${f.year}/${f.reportTypeId}`, name: async () => safeName(f.reportTypeName) },
    );
  } else {
    levels.push(
      {
        level: 'restricted_root',
        key: `${p}/restricted`,
        // Named after the project folder as created, if there is one, so the two stay side by side after a rename.
        name: async () => `${safeName((await recorded('project', p))?.name ?? f.projectName, MAX_NAME - RESTRICTED_SUFFIX.length)}${RESTRICTED_SUFFIX}`,
      },
      { level: 'output', key: `${p}/output/${outputId}`, name: () => uniqueOutputFolderName(deps, dest.id, p, f.title) },
    );
  }

  const lock = await deps.pool.connect();
  let broken: Error | undefined;
  try {
    await lock.query(`SELECT pg_advisory_lock(hashtext('output-folders'), hashtext($1))`, [`${dest.id}/${projectId}`]);
    try {
      let parent: string | null = null;
      let name = '';
      const path: string[] = [];
      for (const l of levels) {
        const rec = await recorded(l.level, l.key);
        if (rec) {
          parent = rec.item_id;
          name = rec.name;
        } else {
          name = await l.name();
          const made: FolderRef = await conn.ensureFolder(dest, parent, name);
          await deps.pool.query(
            `INSERT INTO storage_folders (id, destination_id, level, key, item_id, name, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (destination_id, level, key) DO NOTHING`,
            [uuidv7(), dest.id, l.level, l.key, made.itemId, name, deps.clock()],
          );
          parent = made.itemId;
        }
        path.push(name);
      }
      return { itemId: parent as string, name, path };
    } finally {
      try {
        await lock.query(`SELECT pg_advisory_unlock(hashtext('output-folders'), hashtext($1))`, [`${dest.id}/${projectId}`]);
      } catch (err) {
        broken = err instanceof Error ? err : new Error('unlock failed');
      }
    }
  } finally {
    lock.release(broken);
  }
}

/** The output's title made safe, with ` (2)`, ` (3)` … when another output folder of the project already has it. */
async function uniqueOutputFolderName(deps: StorageDeps, destinationId: string, projectKey: string, title: string): Promise<string> {
  const taken = new Set(
    (
      await deps.pool.query<{ name: string }>(
        `SELECT name FROM storage_folders WHERE destination_id = $1 AND level = 'output' AND key LIKE $2`,
        [destinationId, `${projectKey}/output/%`],
      )
    ).rows.map((r) => r.name.toLowerCase()),
  );
  for (let n = 1; ; n++) {
    const tail = n > 1 ? ` (${n})` : '';
    const name = `${safeName(title, MAX_NAME - tail.length)}${tail}`;
    if (!taken.has(name.toLowerCase())) return name;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The file-output job
// ---------------------------------------------------------------------------------------------------------------------

interface JobRow {
  version_id: string; output_id: string; version_no: number; format: string; stored_file_id: string | null;
  version_held: boolean; title: string; project_id: string; status: string; deleted: boolean; output_held: boolean;
  file_state: string | null; destination_id: string | null; bytes: Buffer | null;
}

async function loadJob(deps: StorageDeps, versionId: string): Promise<JobRow | undefined> {
  return (
    await deps.pool.query<JobRow>(
      `SELECT v.id AS version_id, v.output_id, v.version_no, v.format, v.stored_file_id, v.held_case_id IS NOT NULL AS version_held,
              o.title, o.project_id, o.status, o.deleted_at IS NOT NULL AS deleted, o.held_case_id IS NOT NULL AS output_held,
              f.state AS file_state, f.destination_id, b.bytes
         FROM output_versions v JOIN outputs o ON o.id = v.output_id
         LEFT JOIN stored_files f ON f.id = v.stored_file_id
         LEFT JOIN output_version_bytes b ON b.output_version_id = v.id
        WHERE v.id = $1`,
      [versionId],
    )
  ).rows[0];
}

/**
 * The `file-output` job (spec 5.4, 5.6). Idempotent: one worker at a time per version (an advisory lock), a version
 * already filed is left alone, and an upload whose answer was lost is found by name on the next attempt and adopted
 * only when its size and hash match, so a version never gets a second copy. Every attempt rechecks the output: a
 * held, withdrawn or deleted output is not filed (it waits). A failed attempt puts the file back to pending with the
 * attempt counted and keeps the bytes.
 */
export async function fileOutputVersion(deps: StorageDeps, versionId: string): Promise<void> {
  const lock = await deps.pool.connect();
  let broken: Error | undefined;
  try {
    const got = (await lock.query<{ ok: boolean }>(`SELECT pg_try_advisory_lock(hashtext('file-output'), hashtext($1)) AS ok`, [versionId])).rows[0].ok;
    if (!got) return;
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
  if (v.status !== 'registered' || v.deleted || v.output_held || v.version_held) return;
  const fileId = v.stored_file_id;
  if (!v.bytes) {
    await deps.pool.query(`UPDATE stored_files SET state = 'failed', failure_code = $2 WHERE id = $1 AND state IN ('pending', 'storing')`, [fileId, BYTES_GONE]);
    return;
  }
  const approved = (await deps.pool.query(`SELECT 1 FROM storage_destinations WHERE id = $1 AND purpose = 'outputs' AND status = 'approved'`, [v.destination_id])).rowCount;
  if (!approved) throw new StorageError('invalid');
  const { connector, dest } = await deps.connectors.forDestination(v.destination_id);
  const bytes = v.bytes;

  await deps.pool.query(`UPDATE stored_files SET state = 'storing' WHERE id = $1 AND state = 'pending'`, [fileId]);
  let placed: { ref: StoredRef; parts: string[] };
  try {
    const wholeProject = await isWholeProject(deps.pool, v.output_id, deps.clock());
    const folder = await ensureOutputFolder(deps, dest, v.project_id, v.output_id, wholeProject, connector);
    placed = await put(connector, dest, folder, v.title, v.version_no, v.format, bytes);
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
  const { ref, parts } = placed;
  const c = await deps.pool.connect();
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
      // Only once the provider has confirmed the file do its bytes leave the database.
      await c.query(`DELETE FROM output_version_bytes WHERE output_version_id = $1`, [versionId]);
      await c.query(`INSERT INTO output_events (id, output_id, version_id, kind, actor_id, at, detail) VALUES ($1, $2, $3, 'filed', NULL, $4, $5)`, [
        uuidv7(at.getTime()), v.output_id, versionId, at, JSON.stringify({ versionNo: v.version_no }),
      ]);
      await afterFiled(c, { projectId: v.project_id, outputId: v.output_id, versionId, storedFileId: fileId });
    }
    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

/**
 * Uploads the version as `<Title> v<n>.<ext>` and confirms it: size and QuickXorHash must match what Kainow sent. A
 * name already taken by a matching file is adopted (an earlier attempt whose answer was lost); by a different file, the
 * next name ` (2)`, ` (3)` … is tried, so nothing is ever overwritten and the version's own earlier upload is always
 * found again before a new name is used. A fresh upload the provider reports differently is removed (best effort) and
 * the attempt fails.
 */
async function put(
  connector: StorageConnector, dest: DestinationRef, folder: OutputFolder, title: string, versionNo: number, ext: string, bytes: Buffer,
): Promise<{ ref: StoredRef; parts: string[] }> {
  const hash = quickXorHash(bytes);
  const matches = (r: StoredRef) => r.size === bytes.length && r.providerHash === hash;
  for (let suffix = 1; suffix <= MAX_SUFFIX; suffix++) {
    const parts = fitPath(folder.path, outputFileName(title, versionNo, ext, suffix));
    // Folders already exist: only the file name may be shortened.
    if (parts.slice(0, -1).some((p, i) => p !== folder.path[i])) throw new PathTooLong();
    const name = parts[parts.length - 1];
    let ref: StoredRef;
    try {
      ref = await connector.upload(dest, folder.itemId, name, bytes, { conflict: 'fail' });
    } catch (err) {
      if (!(err instanceof StorageError && err.code === 'conflict')) throw err;
      const found = await connector.findChild(dest, folder.itemId, name);
      if (found && matches(found)) return { ref: found, parts };
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

/**
 * Runs in the transaction that records a version filed. Sharing (Task 13) hooks in here to queue `share-sync` for the
 * project folder or the output's folder; until then it does nothing.
 */
export async function afterFiled(
  _c: PoolClient, _filed: { projectId: string; outputId: string; versionId: string; storedFileId: string },
): Promise<void> {
  // Filled in by sharing.
}

/** After the last attempt the version shows "Filing failed — <reason>" with Try again. */
export async function markFilingFailed(deps: StorageDeps, versionId: string, code: StorageFailureCode): Promise<void> {
  const c = await deps.pool.connect();
  try {
    await c.query('BEGIN');
    const r = (
      await c.query<{ output_id: string; version_no: number }>(
        `UPDATE stored_files f SET state = 'failed', failure_code = CASE WHEN f.failure_code = $2 THEN f.failure_code ELSE $3 END
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
