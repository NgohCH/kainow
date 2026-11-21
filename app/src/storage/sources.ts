import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { uuidv7 } from '../common/uuid7';
import type { StorageConnector } from './connector';
import { StorageWaitingForKey } from './connector-factory';
import { type StorageDeps, registerStorageDailyTask, registerStorageFinalFailure, registerStorageHandler } from './jobs';
import { sweepMarkSql, sweptSince } from '../quarantine/sweep-lock';
import { queueStorageJob } from './outbox';
import { queueSourceBackfill } from './source-backfill';
import { quickXorHash } from './quickxor';
import { type DestinationRef, StorageError, type StoredRef } from './types';

/**
 * The managed source area (spec 9.1, A13, D104). Every source version's uploaded original (if any) and its text are
 * preserved under the approved source-area destination at
 * `projects/<project id>/sources/<source id>/v<version no>/original.<ext>` and `…/text.txt`; ids only, so renames and
 * audience changes never move evidence and paths reveal nothing. The database keeps the working text.
 */

export type VersionStorage = 'stored' | 'waiting' | 'failed';

/** The text file's name in every version folder. */
export const TEXT_FILE_NAME = 'text.txt';

/** `original.<ext>` from the uploaded name: the extension only, lower case letters and digits, else `original.bin`. */
export function originalFileName(filename: string | null): string {
  const ext = /\.([A-Za-z0-9]{1,10})$/.exec(filename ?? '')?.[1];
  return `original.${ext ? ext.toLowerCase() : 'bin'}`;
}

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

/**
 * Adds the version's stored files, `pending`, and links them to the version (the trigger lets each id be set once):
 * the original for an upload whose bytes are still held, and the text for every version. Unless `queue` is false, a
 * `store-source` job is queued through the outbox in the caller's transaction. A version that already has its files is
 * left alone.
 */
export async function addSourceVersionFiles(
  c: PoolClient, versionId: string, projectId: string, hasOriginal: boolean, opts: { queue?: boolean } = {},
): Promise<void> {
  const v = (
    await c.query<{ filename: string | null; text_id: string | null; original_id: string | null }>(
      `SELECT filename, text_stored_file_id AS text_id, original_stored_file_id AS original_id FROM source_versions WHERE id = $1`,
      [versionId],
    )
  ).rows[0];
  if (!v) throw new Error('source version not found');
  const textId = v.text_id ?? uuidv7();
  const originalId = hasOriginal ? (v.original_id ?? uuidv7()) : v.original_id;
  if (!v.text_id) {
    await c.query(
      `INSERT INTO stored_files (id, purpose, project_id, name, state, created_at) VALUES ($1, 'source_text', $2, $3, 'pending', now())`,
      [textId, projectId, TEXT_FILE_NAME],
    );
  }
  if (hasOriginal && !v.original_id) {
    await c.query(
      `INSERT INTO stored_files (id, purpose, project_id, name, state, created_at) VALUES ($1, 'source_original', $2, $3, 'pending', now())`,
      [originalId, projectId, originalFileName(v.filename)],
    );
  }
  if (!v.text_id || (hasOriginal && !v.original_id)) {
    await c.query(`UPDATE source_versions SET text_stored_file_id = $2, original_stored_file_id = $3 WHERE id = $1`, [versionId, textId, originalId]);
  }
  if (opts.queue !== false) await queueStorageJob(c, 'store-source', versionId);
}

/** The approved source-area destination, if any (at most one, spec 8.2). */
async function sourceArea(deps: StorageDeps): Promise<string | null> {
  return (
    (await deps.pool.query<{ id: string }>(`SELECT id FROM storage_destinations WHERE purpose = 'source_area' AND status = 'approved'`)).rows[0]?.id ?? null
  );
}

interface VersionRow {
  id: string; source_id: string; version_no: number; filename: string | null; origin: string;
  original_bytes: Buffer | null; quarantined_at: Date | null; text_content: string;
  original_stored_file_id: string | null; text_stored_file_id: string | null;
  original_sha256: string | null; text_sha256: string;
  project_id: string | null; held_case_id: string | null; held: boolean;
  /** The project's quarantine sweep marker, read in the same statement as the text (quarantine/sweep-lock.ts). */
  mark: string;
}

interface FileRow { id: string; purpose: 'source_original' | 'source_text'; name: string; state: string }

/**
 * What one go at a version came to: `stored` (or nothing was left to store), `not_ready` (no approved source area or
 * no usable connection: the files stay pending with no attempt counted), `skipped` (held, outside projects, gone, or
 * another worker is storing it).
 */
type Outcome = 'stored' | 'not_ready' | 'skipped';

/** The `store-source` job (spec 9.1): see storeVersion. */
export async function storeSourceVersion(deps: StorageDeps, versionId: string): Promise<void> {
  await storeVersion(deps, versionId);
}

/**
 * Uploads the version's unstored files, verifies size and QuickXorHash, then in one transaction records them `stored`
 * and clears `original_bytes` (keeping `original_sha256`). Idempotent: one worker at a time per version (an advisory
 * lock), stored files are skipped, and an upload whose outcome was lost is found by name and adopted only when its size
 * and hash match. A failed attempt puts the files back to `pending` with the attempt counted and keeps the bytes.
 */
async function storeVersion(deps: StorageDeps, versionId: string): Promise<Outcome> {
  const areaId = await sourceArea(deps);
  if (!areaId) return 'not_ready';
  const lock = await deps.pool.connect();
  // A connection whose unlock failed may still hold the lock: it is destroyed, never returned to the pool.
  let broken: Error | undefined;
  try {
    const got = (await lock.query<{ ok: boolean }>(`SELECT pg_try_advisory_lock(hashtext('store-source'), hashtext($1)) AS ok`, [versionId])).rows[0].ok;
    if (!got) return 'skipped';
    try {
      return await storeLocked(deps, areaId, versionId);
    } finally {
      try {
        await lock.query(`SELECT pg_advisory_unlock(hashtext('store-source'), hashtext($1))`, [versionId]);
      } catch (err) {
        broken = err instanceof Error ? err : new Error('unlock failed');
      }
    }
  } finally {
    lock.release(broken);
  }
}

async function loadVersion(deps: StorageDeps, versionId: string): Promise<VersionRow | undefined> {
  return (
    await deps.pool.query<VersionRow>(
      `SELECT v.id, v.source_id, v.version_no, v.filename, v.origin, v.original_bytes, v.quarantined_at, v.text_content,
              v.original_stored_file_id, v.text_stored_file_id, v.original_sha256, v.text_sha256,
              s.project_id, s.held_case_id, s.held_case_id IS NOT NULL AS held, ${sweepMarkSql('s.project_id')} AS mark
         FROM source_versions v JOIN sources s ON s.id = v.source_id WHERE v.id = $1`,
      [versionId],
    )
  ).rows[0];
}

async function storeLocked(deps: StorageDeps, areaId: string, versionId: string): Promise<Outcome> {
  let v = await loadVersion(deps, versionId);
  // Rechecked on every attempt (A11): a held source's text may still hold the secret, so it waits for its case.
  if (!v || !v.project_id || v.held) return 'skipped';
  if (!v.text_stored_file_id) {
    // A version from before the source area (or from a writer that queued no files): its files are added now.
    await inTransaction(deps, (c) => addSourceVersionFiles(c, versionId, v!.project_id!, v!.original_bytes !== null, { queue: false }));
    v = (await loadVersion(deps, versionId))!;
  }
  const files = (
    await deps.pool.query<FileRow>(`SELECT id, purpose, name, state FROM stored_files WHERE id = ANY($1::uuid[]) ORDER BY purpose, id`, [
      [v.original_stored_file_id, v.text_stored_file_id].filter(Boolean),
    ])
  ).rows;
  const original = files.find((f) => f.id === v!.original_stored_file_id);
  const text = files.find((f) => f.id === v!.text_stored_file_id);
  // Each reference must point at a file of its own purpose (the application keeps this; the schema cannot).
  if (!text || text.purpose !== 'source_text' || (v.original_stored_file_id && original?.purpose !== 'source_original')) {
    throw new Error('source version file references are inconsistent');
  }
  const unstored = (f: FileRow | undefined): f is FileRow => !!f && ['pending', 'storing', 'failed'].includes(f.state);
  // An original withheld by a quarantine case before it was stored has no bytes to store: it stays withheld.
  const withheldOriginal = unstored(original) && v.original_bytes === null && v.quarantined_at !== null ? original : undefined;
  const todo = [original, text].filter(unstored).filter((f) => f !== withheldOriginal);
  if (todo.length === 0) {
    if (withheldOriginal) await deps.pool.query(`UPDATE stored_files SET state = 'withheld' WHERE id = $1 AND state IN ('pending', 'storing', 'failed')`, [withheldOriginal.id]);
    return 'stored';
  }
  if (original && todo.includes(original) && v.original_bytes === null) throw new Error('original bytes missing for an unstored original');

  let connector: StorageConnector;
  let dest: DestinationRef;
  try {
    ({ connector, dest } = await deps.connectors.forDestination(areaId));
  } catch (err) {
    // No usable connection: wait without counting an attempt; the backfill stores the version once there is one.
    if (err instanceof StorageError && err.code === 'invalid') return 'not_ready';
    throw err;
  }

  const ids = todo.map((f) => f.id);
  await deps.pool.query(`UPDATE stored_files SET state = 'storing' WHERE id = ANY($1::uuid[])`, [ids]);
  const done: Array<{ id: string; ref: StoredRef; sha: string }> = [];
  try {
    const folderId = await versionFolder(deps, connector, dest, v);
    for (const f of todo) {
      const bytes = f.purpose === 'source_original' ? (v.original_bytes as Buffer) : Buffer.from(v.text_content, 'utf8');
      done.push({ id: f.id, ref: await put(connector, dest, folderId, f.name, bytes), sha: sha256(bytes) });
    }
  } catch (err) {
    const counted = !(err instanceof StorageWaitingForKey);
    await deps.pool.query(
      `UPDATE stored_files SET state = 'pending', attempts = attempts + $2::int, failure_code = $3 WHERE id = ANY($1::uuid[]) AND state = 'storing'`,
      [ids, counted ? 1 : 0, err instanceof StorageError ? err.code : 'internal'],
    );
    throw err;
  }

  const at = deps.clock();
  const unchanged = await inTransaction(deps, async (c) => {
    // A report, hold or clean while the files were uploading changes what may be kept: nothing is recorded (the
    // quarantine sweep-lock pattern). The project's sweep lock is taken shared before any row lock, as every sweep
    // takes it exclusive first, then the version is read again under lock and compared with what was uploaded.
    if (await sweptSince(c, v!.project_id!, v!.mark)) return false;
    const now = (
      await c.query<{ quarantined_at: Date | null; original_sha256: string | null; text_sha256: string; held_case_id: string | null }>(
        `SELECT v.quarantined_at, v.original_sha256, v.text_sha256, s.held_case_id
           FROM source_versions v JOIN sources s ON s.id = v.source_id WHERE v.id = $1
            FOR UPDATE OF v FOR SHARE OF s`,
        [versionId],
      )
    ).rows[0];
    if (
      !now || now.held_case_id !== v!.held_case_id || now.original_sha256 !== v!.original_sha256 || now.text_sha256 !== v!.text_sha256
      || (now.quarantined_at?.getTime() ?? null) !== (v!.quarantined_at?.getTime() ?? null)
    ) {
      return false;
    }
    for (const d of done) {
      await c.query(
        `UPDATE stored_files SET state = 'stored', destination_id = $2, connector = $3, drive_id = $4, item_id = $5, path = $6,
                size_bytes = $7, sha256 = $8, provider_hash = $9, etag = $10, ctag = $11, web_url = $12, stored_at = $13, failure_code = NULL
          WHERE id = $1`,
        [d.id, dest.id, dest.connector, dest.driveId, d.ref.itemId, d.ref.path, d.ref.size, d.sha, d.ref.providerHash, d.ref.etag, d.ref.ctag, d.ref.webUrl, at],
      );
    }
    if (withheldOriginal) await c.query(`UPDATE stored_files SET state = 'withheld' WHERE id = $1`, [withheldOriginal.id]);
    // Only once the provider has confirmed the original are its bytes removed from the database; the hash stays.
    if (original && done.some((d) => d.id === original.id)) {
      await c.query(`UPDATE source_versions SET original_bytes = NULL WHERE id = $1 AND original_bytes IS NOT NULL`, [versionId]);
    }
    return true;
  });
  if (!unchanged) {
    // What was uploaded may hold what a case has since removed: it is taken away again and the next attempt decides
    // (a held source waits; a cleaned one stores its cleaned text). Not a provider failure, so no attempt is counted.
    for (const d of done) await connector.removePermanently(dest, d.ref.itemId).catch(() => undefined);
    await deps.pool.query(`UPDATE stored_files SET state = 'pending', failure_code = 'conflict' WHERE id = ANY($1::uuid[]) AND state = 'storing'`, [ids]);
    throw new StorageError('conflict');
  }
  return 'stored';
}

/**
 * The `projects` folder under the source-area root, created and recorded (`source_root`) when missing. It holds every
 * stored source file, and is the folder storage Administrators are granted write on (the connector never grants on the
 * library root itself; spec 8.4).
 */
export async function ensureSourceProjectsFolder(
  deps: StorageDeps, connector: StorageConnector, dest: DestinationRef,
): Promise<{ id: string; itemId: string }> {
  const find = async () =>
    (
      await deps.pool.query<{ id: string; item_id: string }>(
        `SELECT id, item_id FROM storage_folders WHERE destination_id = $1 AND level = 'source_root' AND key = 'projects'`,
        [dest.id],
      )
    ).rows[0];
  const found = await find();
  if (found) return { id: found.id, itemId: found.item_id };
  const itemId = (await connector.ensureFolder(dest, null, 'projects')).itemId;
  await deps.pool.query(
    `INSERT INTO storage_folders (id, destination_id, level, key, item_id, name, created_at) VALUES ($1, $2, 'source_root', 'projects', $3, 'projects', $4)
     ON CONFLICT (destination_id, level, key) DO NOTHING`,
    [uuidv7(), dest.id, itemId, deps.clock()],
  );
  const row = (await find())!;
  return { id: row.id, itemId: row.item_id };
}

/** `projects/<project id>/sources/<source id>/v<n>` under the source-area root (also where relocation puts a file). */
export async function versionFolder(
  deps: StorageDeps, connector: StorageConnector, dest: DestinationRef, v: { project_id: string | null; source_id: string; version_no: number },
): Promise<string> {
  const projects = (await ensureSourceProjectsFolder(deps, connector, dest)).itemId;
  let folder = projects;
  for (const name of [v.project_id as string, 'sources', v.source_id, `v${v.version_no}`]) {
    folder = (await connector.ensureFolder(dest, folder, name)).itemId;
  }
  return folder;
}

/**
 * Uploads one file and confirms it: size and QuickXorHash must match what Kainow sent. A name already taken (an earlier
 * attempt whose answer was lost) is adopted only when it matches; otherwise the attempt fails `conflict`. A fresh
 * upload the provider reports differently is removed (best effort) and the attempt fails, to be tried again.
 */
export async function put(connector: StorageConnector, dest: DestinationRef, folderId: string, name: string, bytes: Buffer): Promise<StoredRef> {
  const hash = quickXorHash(bytes);
  const matches = (r: StoredRef) => r.size === bytes.length && r.providerHash === hash;
  let ref: StoredRef;
  try {
    ref = await connector.upload(dest, folderId, name, bytes, { conflict: 'fail' });
  } catch (err) {
    if (!(err instanceof StorageError && err.code === 'conflict')) throw err;
    const found = await connector.findChild(dest, folderId, name);
    if (found && matches(found)) return found;
    throw new StorageError('conflict');
  }
  if (!matches(ref)) {
    await connector.removePermanently(dest, ref.itemId).catch(() => undefined);
    throw new StorageError('server');
  }
  return ref;
}

async function inTransaction<T>(deps: StorageDeps, work: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await deps.pool.connect();
  try {
    await c.query('BEGIN');
    const r = await work(c);
    await c.query('COMMIT');
    return r;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

/**
 * Versions the backfill stores: in a project, not held, and either without stored files (from before 0031) or with a
 * file still pending that no attempt has failed on yet (a failed attempt's retries belong to its own store-source job).
 */
const BACKFILL_SQL = `
  SELECT v.id FROM source_versions v
    JOIN sources s ON s.id = v.source_id
    LEFT JOIN stored_files t ON t.id = v.text_stored_file_id
    LEFT JOIN stored_files o ON o.id = v.original_stored_file_id
   WHERE s.project_id IS NOT NULL AND s.held_case_id IS NULL
     AND (v.text_stored_file_id IS NULL
          OR (t.state IN ('pending', 'storing') AND t.attempts = 0)
          OR (o.state IN ('pending', 'storing') AND o.attempts = 0))
   ORDER BY v.created_at, v.id
   LIMIT $1`;

/**
 * The `backfill-sources` job (spec 9.1): stores up to `limit` waiting versions, oldest first, and queues itself again
 * while more remain. A version that fails here gets its own `store-source` job and its retries. Without an approved
 * source area or a usable connection it stops; approval (and the daily tick) queue it again. Returns how many
 * versions it worked on.
 */
export async function backfillSources(deps: StorageDeps, limit = 100): Promise<number> {
  const areaId = await sourceArea(deps);
  if (!areaId) return 0;
  const ids = (await deps.pool.query<{ id: string }>(BACKFILL_SQL, [limit + 1])).rows.map((r) => r.id);
  let worked = 0;
  for (const id of ids.slice(0, limit)) {
    let outcome: Outcome;
    try {
      outcome = await storeVersion(deps, id);
    } catch (err) {
      if (err instanceof StorageWaitingForKey) throw err;
      await inTransaction(deps, (c) => queueStorageJob(c, 'store-source', id));
      worked++;
      continue;
    }
    if (outcome === 'not_ready') return worked;
    worked++;
  }
  if (ids.length > limit) await inTransaction(deps, (c) => queueStorageJob(c, 'backfill-sources', areaId));
  return worked;
}

/** Storage state per version, for the PM, Deputies, Owner and Sponsors (spec 9.1). Versions outside projects get none. */
export async function versionStorage(db: { query: PoolClient['query'] }, versionIds: string[]): Promise<Map<string, VersionStorage>> {
  const { rows } = await db.query<{ id: string; storage: VersionStorage }>(
    `SELECT v.id,
            CASE WHEN bool_or(f.state IN ('failed', 'missing')) THEN 'failed'
                 WHEN count(f.id) > 0 AND bool_and(f.state IN ('stored', 'relocating', 'withheld')) THEN 'stored'
                 ELSE 'waiting' END AS storage
       FROM source_versions v
       JOIN sources s ON s.id = v.source_id AND s.project_id IS NOT NULL
       LEFT JOIN stored_files f ON f.id IN (v.original_stored_file_id, v.text_stored_file_id)
      WHERE v.id = ANY($1::uuid[])
      GROUP BY v.id`,
    [versionIds],
  );
  return new Map(rows.map((r) => [r.id, r.storage]));
}

registerStorageHandler('store-source', (deps, versionId) => storeSourceVersion(deps, versionId));
registerStorageHandler('backfill-sources', async (deps) => {
  await backfillSources(deps);
});
/** After the last attempt the version's unstored files show Storage failed, with the reason category. */
registerStorageFinalFailure('store-source', async (deps, versionId, code) => {
  await deps.pool.query(
    `UPDATE stored_files SET state = 'failed', failure_code = $2
      WHERE id IN (SELECT unnest(ARRAY[original_stored_file_id, text_stored_file_id]) FROM source_versions WHERE id = $1)
        AND state IN ('pending', 'storing')`,
    [versionId, code],
  );
});
/** How long a version whose storing failed rests before the daily tick tries it again. */
export const FAILED_RETRY_AFTER_MS = 24 * 3600_000;
/** At most this many failed versions are tried again per day. */
const FAILED_RETRY_LIMIT = 500;

/**
 * Once a day: the backfill runs again (for versions left waiting: no connection then, or a held source since released),
 * and each version with a failed file (or a file an attempt failed on and no job is carrying) whose last store-source
 * attempt is more than 24 hours old gets a new store-source job, oldest version first.
 */
export async function dailySourceTask(deps: StorageDeps): Promise<void> {
  if (!(await sourceArea(deps))) return;
  const before = new Date(deps.clock().getTime() - FAILED_RETRY_AFTER_MS);
  await inTransaction(deps, async (c) => {
    await queueSourceBackfill(c);
    const { rows } = await c.query<{ id: string }>(
      `SELECT v.id FROM source_versions v
         JOIN stored_files f ON f.id IN (v.original_stored_file_id, v.text_stored_file_id)
        WHERE (f.state = 'failed' OR (f.state = 'pending' AND f.attempts > 0))
          AND NOT EXISTS (SELECT 1 FROM storage_attempts a WHERE a.subject_id = v.id AND a.job = 'store-source' AND a.at > $1)
        GROUP BY v.id, v.created_at
        ORDER BY v.created_at, v.id
        LIMIT $2`,
      [before, FAILED_RETRY_LIMIT],
    );
    for (const r of rows) await queueStorageJob(c, 'store-source', r.id);
  });
}
registerStorageDailyTask('source-area', dailySourceTask);
