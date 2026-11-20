import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { writeAudit } from '../audit/audit';
import { uuidv7 } from '../common/uuid7';
import { type OutputFolder, ensureOutputFolder } from '../outputs/filing';
import { MAX_NAME } from '../outputs/naming';
import { queueFolderSharing, queueOutputPlacement } from '../outputs/sharing-queue';
import type { StorageConnector } from './connector';
import { StorageWaitingForKey } from './connector-factory';
import { type StorageDeps, registerStorageDailyTask, registerStorageFinalFailure, registerStorageHandler } from './jobs';
import { queueStorageJob } from './outbox';
import { quickXorHash } from './quickxor';
import { TEXT_FILE_NAME } from './sources';
import { type DestinationRef, StorageError, type StoredRef } from './types';

/**
 * Withholding stored files for a quarantine case (spec 8.5, D104, D80–D82). A suspected secret never stays readable in
 * storage: the file's content is kept encrypted under the protected key in `quarantine_originals` and the provider item
 * is removed permanently (no recycle bin, no version history). A false-alarm release puts it back.
 *
 * States of a stored file being withheld (`withhold_case_id` names the case; the job's subject is the file id):
 *  - `withheld`, no encrypted copy yet: queued. Nothing serves it any more (downloads, opens and checks use `stored`
 *    files only). An output file under the shared project folder is first moved into its own output folder, which has
 *    no Kainow grants, so readers lose SharePoint access even if later steps fail.
 *  - `withheld`, encrypted, `removed_at` NULL: removal pending, or failing ("Still in storage" on the case).
 *  - `withheld`, `removed_at` set: gone from storage. A source text file is then uploaded again with the cleaned text
 *    and is `stored` once more, keeping `withhold_case_id` so a false-alarm release finds its encrypted original.
 * Release (restoreOriginals in the quarantine engine) clears `withhold_case_id` of a file with an encrypted copy and
 * queues `restore-withheld`; a file not yet encrypted simply goes back to `stored` there and then.
 *
 * The encrypted content is a `quarantine_originals` row with table `stored_files`, column `content` and row key
 * `{ id }` (no associated data, as the engine's other originals). Its `cleaned_sha256` is the SHA-256 of what the file
 * holds after withholding: 'null' (removed) for originals and output files, the cleaned text for a source text file.
 * No plain copy is written anywhere else: never a name, path or hash from the provider, never content in an event,
 * notice, log or error.
 */

type Db = Pool | PoolClient;

/** The quarantine_originals table and column standing for a stored file's content. */
export const FILE_CONTENT_TABLE = 'stored_files';
export const FILE_CONTENT_COLUMN = 'content';
/** SQL condition: the quarantine_originals row (alias `q`) is a stored file's content. */
export const IS_FILE_CONTENT = (q: string) => `(${q}.table_name = '${FILE_CONTENT_TABLE}' AND ${q}.column_name = '${FILE_CONTENT_COLUMN}')`;

/** The Administrator notice raised once when removing a held file keeps failing (spec 8.5); never names the secret. */
export const HELD_FILE_NOT_REMOVED = 'held_file_not_removed';
export const HELD_FILE_NOT_REMOVED_TEXT = 'A held file could not be removed from storage';
/** Shown on a case while a file or linked document of it is still in storage (spec 4.7, 8.5). */
export const STILL_IN_STORAGE = 'Still in storage';

const MOVE_REASON = 'Withheld';
const MAX_SUFFIX = 20;
/** How long a held file still in storage rests before the daily task tries again (spec 8.5: retries continue daily). */
const RETRY_AFTER_MS = 24 * 3600_000;

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const logFixed = (deps: StorageDeps, message: string): void => (deps.log ?? ((m) => console.warn(m)))(message);

// ---------------------------------------------------------------------------------------------------------------------
// Queuing (API side, in the caller's transaction)
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Marks these stored files withheld for the case and queues the `withhold` job for each, urgently. Only files in
 * storage are taken (`stored`); a file still being stored is dealt with when its upload is confirmed. The provider's
 * link is dropped (it is built from the file's name, which may hold the secret, and nothing opens a withheld file).
 * Returns the ids queued.
 */
export async function queueWithhold(c: PoolClient, fileIds: string[], caseId: string): Promise<string[]> {
  if (fileIds.length === 0) return [];
  const { rows } = await c.query<{ id: string }>(
    `UPDATE stored_files SET state = 'withheld', withhold_case_id = $2, removed_at = NULL, remove_notice_at = NULL, web_url = NULL
      WHERE id = ANY($1::uuid[]) AND state = 'stored' AND item_id IS NOT NULL
      RETURNING id`,
    [fileIds, caseId],
  );
  const ids = rows.map((r) => r.id).sort();
  for (const id of ids) await queueStorageJob(c, 'withhold', id, { priority: 'urgent' });
  return ids;
}

/** What the case shows under "Still in storage": its withheld files not yet removed, and its held outputs' links. */
export async function stillInStorage(db: Db, caseId: string): Promise<{ label: string; files: number; links: number } | null> {
  const r = (
    await db.query<{ files: number; links: number }>(
      `SELECT (SELECT count(*)::int FROM stored_files WHERE withhold_case_id = $1 AND state = 'withheld' AND removed_at IS NULL) AS files,
              (SELECT count(*)::int FROM output_versions v JOIN stored_files f ON f.id = v.stored_file_id
                 JOIN quarantine_cases qc ON qc.id = $1
                WHERE f.state = 'linked' AND (v.held_case_id = qc.id OR (qc.item_kind = 'output' AND v.output_id = qc.item_id))) AS links`,
      [caseId],
    )
  ).rows[0];
  return r.files + r.links > 0 ? { label: STILL_IN_STORAGE, files: r.files, links: r.links } : null;
}

// ---------------------------------------------------------------------------------------------------------------------
// The withhold job
// ---------------------------------------------------------------------------------------------------------------------

interface FileRow {
  id: string; purpose: 'source_original' | 'source_text' | 'output'; project_id: string; state: string;
  destination_id: string | null; item_id: string | null; drive_id: string | null; path: string | null; name: string;
  sha256: string | null; folder_id: string | null; withhold_case_id: string | null; removed_at: Date | null;
  upload_destination_id: string | null; upload_folder_id: string | null;
}

const loadFile = async (db: Db, fileId: string): Promise<FileRow | undefined> =>
  (
    await db.query<FileRow>(
      `SELECT id, purpose, project_id, state, destination_id, item_id, drive_id, path, name, sha256, folder_id, withhold_case_id, removed_at,
              upload_destination_id, upload_folder_id
         FROM stored_files WHERE id = $1`,
      [fileId],
    )
  ).rows[0];

/** The item a file's content belongs to: its output, or its source (by the version that points at it). */
async function ownerOf(db: Db, fileId: string): Promise<{ kind: 'output' | 'source'; id: string } | null> {
  const r = (
    await db.query<{ output_id: string | null; source_id: string | null }>(
      `SELECT (SELECT output_id FROM output_versions WHERE stored_file_id = $1) AS output_id,
              (SELECT source_id FROM source_versions WHERE original_stored_file_id = $1 OR text_stored_file_id = $1 LIMIT 1) AS source_id`,
      [fileId],
    )
  ).rows[0];
  if (r.output_id) return { kind: 'output', id: r.output_id };
  if (r.source_id) return { kind: 'source', id: r.source_id };
  return null;
}

const hasContent = async (db: Db, fileId: string, caseId: string): Promise<boolean> =>
  ((
    await db.query(
      `SELECT 1 FROM quarantine_originals q WHERE ${IS_FILE_CONTENT('q')} AND q.row_key->>'id' = $1::text AND q.case_id = $2 AND q.restored_at IS NULL LIMIT 1`,
      [fileId, caseId],
    )
  ).rowCount ?? 0) > 0;

/** One worker at a time per file for withholding and restoring; a second run meanwhile is tried again later. */
async function exclusively<T>(deps: StorageDeps, fileId: string, work: () => Promise<T>): Promise<T> {
  const lock = await deps.pool.connect();
  let broken: Error | undefined;
  try {
    const got = (await lock.query<{ ok: boolean }>(`SELECT pg_try_advisory_lock(hashtext('withhold-file'), hashtext($1)) AS ok`, [fileId])).rows[0].ok;
    if (!got) throw new StorageError('throttled', { retryAfterMs: 60_000 });
    try {
      return await work();
    } finally {
      try {
        await lock.query(`SELECT pg_advisory_unlock(hashtext('withhold-file'), hashtext($1))`, [fileId]);
      } catch (err) {
        broken = err instanceof Error ? err : new Error('unlock failed');
      }
    }
  } finally {
    lock.release(broken);
  }
}

async function withTx<T>(deps: StorageDeps, work: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await deps.pool.connect();
  try {
    await c.query('BEGIN');
    const out = await work(c);
    await c.query('COMMIT');
    return out;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

/**
 * The `withhold` job (spec 8.5) for one stored file and the case it is withheld for. Each step is recorded before the
 * next, so a retry carries on where the last attempt stopped:
 *  0. an output file under the shared project folder is moved into its output's own folder (no Kainow grants) first;
 *  1. the file is downloaded and its SHA-256 checked against the record (a difference is kept and flagged Changed:
 *     what is in storage is what must not be lost);
 *  2. it is encrypted into quarantine_originals, in the same transaction that records where it was;
 *  3. the provider item is removed permanently;
 *  4. for a source text file, the cleaned text is uploaded as the new `text.txt` and recorded.
 * Steps 1 and 2 need the protected key: without it the job waits (not an attempt), after step 0.
 */
export async function withholdStoredFile(deps: StorageDeps, fileId: string, caseId: string): Promise<void> {
  await exclusively(deps, fileId, async () => {
    let f = await loadFile(deps.pool, fileId);
    if (!f || f.withhold_case_id !== caseId || f.state !== 'withheld') return;
    if (!(await hasContent(deps.pool, fileId, caseId)) && f.removed_at === null) {
      if (f.purpose === 'output') {
        await moveOutOfShared(deps, f);
        f = (await loadFile(deps.pool, fileId)) as FileRow;
      }
      if (!(await encrypt(deps, f, caseId))) return;
      f = (await loadFile(deps.pool, fileId)) as FileRow;
    }
    if (f.removed_at === null) {
      await removeFromStorage(deps, f);
      f = (await loadFile(deps.pool, fileId)) as FileRow;
    }
    if (f.purpose === 'source_text' && f.state === 'withheld' && f.withhold_case_id === caseId) await uploadCleanedText(deps, f, caseId);
  });
}

/** Step 0: an output file Kainow placed outside its own output folder is moved into it, renamed to its recorded name. */
async function moveOutOfShared(deps: StorageDeps, f: FileRow): Promise<void> {
  if (!f.destination_id || !f.item_id) return;
  const o = (
    await deps.pool.query<{ output_id: string; project_id: string; project_dest: string | null; level: string | null; key: string | null }>(
      `SELECT v.output_id, o.project_id, s.destination_id AS project_dest, sf.level, sf.key
         FROM output_versions v JOIN outputs o ON o.id = v.output_id
         LEFT JOIN project_output_settings s ON s.project_id = o.project_id
         LEFT JOIN storage_folders sf ON sf.id = $2
        WHERE v.stored_file_id = $1`,
      [f.id, f.folder_id],
    )
  ).rows[0];
  if (!o) return;
  if (o.level === 'output' && o.key?.split('/')[3] === o.output_id) return;
  // A file relinked into another destination, outside Kainow's folders, stays where it is (Kainow shares nothing there).
  if (!f.folder_id && f.destination_id !== o.project_dest) return;
  const { connector, dest } = await deps.connectors.forDestination(f.destination_id);
  let item: StoredRef;
  try {
    item = await connector.getItem(dest, f.item_id);
  } catch (err) {
    if (err instanceof StorageError && err.code === 'not_found') return; // nothing there to leak; step 1 records it gone
    throw err;
  }
  const folder = await ensureOutputFolder(deps, dest, o.project_id, o.output_id, false, connector);
  if (item.parentId === folder.itemId) {
    await recordMove(deps, f, folder, item.name);
    return;
  }
  const ref = await moveNamed(connector, dest, f.item_id, folder.itemId, f.name);
  await recordMove(deps, f, folder, ref.name);
}

/** The move under the recorded (possibly cleaned) name; a name taken there gets ` (2)`, ` (3)` …. */
async function moveNamed(connector: StorageConnector, dest: DestinationRef, itemId: string, parentId: string, name: string): Promise<StoredRef> {
  for (let n = 1; n <= MAX_SUFFIX; n++) {
    try {
      return await connector.move(dest, itemId, parentId, suffixed(name, n));
    } catch (err) {
      if (!(err instanceof StorageError && err.code === 'conflict')) throw err;
    }
  }
  throw new StorageError('conflict');
}

function suffixed(name: string, n: number): string {
  if (n === 1) return name;
  const ext = /\.[^.]+$/.exec(name)?.[0] ?? '';
  const tail = ` (${n})`;
  return `${name.slice(0, name.length - ext.length).slice(0, MAX_NAME - ext.length - tail.length)}${tail}${ext}`;
}

async function recordMove(deps: StorageDeps, f: FileRow, folder: OutputFolder, name: string): Promise<void> {
  const path = [...folder.path, name].join('/');
  if (path === f.path && f.folder_id === folder.recordId) return;
  const at = deps.clock();
  await withTx(deps, async (c) => {
    await c.query(`UPDATE stored_files SET path = $2, name = $3, folder_id = $4 WHERE id = $1`, [f.id, path, name, folder.recordId]);
    await c.query(
      `INSERT INTO stored_file_moves (id, stored_file_id, reason, old_destination_id, old_drive_id, old_item_id, old_path,
                                      new_destination_id, new_drive_id, new_item_id, new_path, actor_id, at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $4, $5, $6, $8, NULL, $9)`,
      [uuidv7(at.getTime()), f.id, MOVE_REASON, f.destination_id, f.drive_id, f.item_id, f.path, path, at],
    );
    // The output folder has no Kainow grants while the output is held: anyone granted there loses it now.
    await queueFolderSharing(c, folder.recordId, 'urgent');
  });
}

/** Steps 1 and 2. Returns false when the case no longer wants the file withheld (released meanwhile). */
async function encrypt(deps: StorageDeps, f: FileRow, caseId: string): Promise<boolean> {
  if (!deps.key) throw new StorageWaitingForKey();
  const key = deps.key;
  if (!f.destination_id || !f.item_id) {
    await deps.pool.query(`UPDATE stored_files SET removed_at = $2 WHERE id = $1 AND removed_at IS NULL`, [f.id, deps.clock()]);
    return true;
  }
  const { connector, dest } = await deps.connectors.forDestination(f.destination_id);
  let item: StoredRef;
  let bytes: Buffer;
  try {
    item = await connector.getItem(dest, f.item_id);
    bytes = await connector.download(dest, f.item_id);
  } catch (err) {
    if (!(err instanceof StorageError && err.code === 'not_found')) throw err;
    // Not in storage (deleted outside Kainow): nothing to keep or remove.
    await deps.pool.query(`UPDATE stored_files SET removed_at = $2, check_status = 'missing' WHERE id = $1 AND removed_at IS NULL`, [f.id, deps.clock()]);
    return true;
  }
  const changed = f.sha256 !== null && sha256(bytes) !== f.sha256;
  const owner = await ownerOf(deps.pool, f.id);
  if (!owner) throw new Error('a withheld file belongs to no output or source');
  const after = f.purpose === 'source_text' ? await cleanedTextSha(deps.pool, f.id) : 'null';
  const sealed = key.encrypt(bytes);
  const at = deps.clock();
  return withTx(deps, async (c) => {
    const now = (
      await c.query<{ state: string; withhold_case_id: string | null; item_id: string | null; project_id: string }>(
        `SELECT state, withhold_case_id, item_id, project_id FROM stored_files WHERE id = $1 FOR UPDATE`,
        [f.id],
      )
    ).rows[0];
    if (!now || now.state !== 'withheld' || now.withhold_case_id !== caseId || now.item_id !== f.item_id) return false;
    if (await hasContent(c, f.id, caseId)) return true;
    await c.query(
      `INSERT INTO quarantine_originals (id, case_id, table_name, row_key, column_name, item_kind, item_id, sweep, ciphertext, nonce, tag, key_id, cleaned_sha256)
       VALUES ($1, $2, $3, $4, $5, $6, $7, nextval('quarantine_sweep_seq'), $8, $9, $10, $11, $12)`,
      [uuidv7(at.getTime()), caseId, FILE_CONTENT_TABLE, JSON.stringify({ id: f.id }), FILE_CONTENT_COLUMN, owner.kind, owner.id, sealed.ciphertext, sealed.nonce, sealed.tag, key.id, after],
    );
    await c.query(
      `UPDATE stored_files SET upload_destination_id = destination_id, upload_folder_id = $2,
              check_status = CASE WHEN $3 THEN 'changed' ELSE check_status END, last_checked_at = CASE WHEN $3 THEN $4 ELSE last_checked_at END
        WHERE id = $1`,
      [f.id, item.parentId, changed, at],
    );
    await writeAudit(c, {
      at, action: 'storage.file_withheld', actorUserId: null, subjectType: 'stored_file', subjectId: f.id,
      detail: { caseId, projectId: now.project_id, purpose: f.purpose, changedInStorage: changed },
    });
    return true;
  });
}

/** SHA-256 of the cleaned text a source text file will hold (its version's text, as it is now). */
async function cleanedTextSha(db: Db, fileId: string): Promise<string> {
  const v = (await db.query<{ text_sha256: string }>(`SELECT text_sha256 FROM source_versions WHERE text_stored_file_id = $1`, [fileId])).rows[0];
  return v?.text_sha256 ?? 'null';
}

/** Step 3: permanent removal (no recycle bin). An item already gone counts as removed. */
async function removeFromStorage(deps: StorageDeps, f: FileRow): Promise<void> {
  if (f.destination_id && f.item_id) {
    const { connector, dest } = await deps.connectors.forDestination(f.destination_id);
    try {
      await connector.removePermanently(dest, f.item_id);
    } catch (err) {
      if (!(err instanceof StorageError && err.code === 'not_found')) throw err;
    }
  }
  await deps.pool.query(`UPDATE stored_files SET removed_at = $2, remove_notice_at = NULL WHERE id = $1 AND removed_at IS NULL`, [f.id, deps.clock()]);
}

/** Step 4: the version's text, cleaned, uploaded again as `text.txt` where the old one was; the file is `stored` again. */
async function uploadCleanedText(deps: StorageDeps, f: FileRow, caseId: string): Promise<void> {
  const v = (await deps.pool.query<{ id: string; text_content: string; text_sha256: string }>(
    `SELECT id, text_content, text_sha256 FROM source_versions WHERE text_stored_file_id = $1`, [f.id],
  )).rows[0];
  const destinationId = f.upload_destination_id ?? f.destination_id;
  if (!v || !destinationId || !f.upload_folder_id) return;
  const bytes = Buffer.from(v.text_content, 'utf8');
  const { connector, dest } = await deps.connectors.forDestination(destinationId);
  const ref = await put(connector, dest, f.upload_folder_id, TEXT_FILE_NAME, bytes);
  const at = deps.clock();
  const recorded = await withTx(deps, async (c) => {
    const now = (await c.query<{ text_sha256: string }>(`SELECT text_sha256 FROM source_versions WHERE id = $1 FOR SHARE`, [v.id])).rows[0];
    const file = (await c.query<{ state: string; withhold_case_id: string | null }>(`SELECT state, withhold_case_id FROM stored_files WHERE id = $1 FOR UPDATE`, [f.id])).rows[0];
    if (now?.text_sha256 !== v.text_sha256 || file?.state !== 'withheld' || file.withhold_case_id !== caseId) return false;
    await c.query(
      `UPDATE stored_files SET state = 'stored', destination_id = $2, connector = $3, drive_id = $4, item_id = $5, path = $6, size_bytes = $7,
              sha256 = $8, provider_hash = $9, etag = $10, ctag = $11, web_url = $12, stored_at = $13, removed_at = NULL, check_status = 'ok',
              last_checked_at = $13, failure_code = NULL
        WHERE id = $1`,
      [f.id, dest.id, dest.connector, dest.driveId, ref.itemId, ref.path, ref.size, sha256(bytes), ref.providerHash, ref.etag, ref.ctag, ref.webUrl, at],
    );
    return true;
  });
  if (!recorded) {
    // The text or the case changed while it uploaded: this copy is nobody's; the next attempt decides again.
    await connector.removePermanently(dest, ref.itemId).catch(() => undefined);
    throw new StorageError('conflict');
  }
}

/**
 * Uploads and confirms one file (size and QuickXorHash). A name already taken by a file with exactly these bytes (an
 * earlier attempt whose answer was lost) is adopted; any other gets ` (2)`, ` (3)` … so nothing is overwritten.
 */
async function put(connector: StorageConnector, dest: DestinationRef, folderId: string, name: string, bytes: Buffer): Promise<StoredRef> {
  const hash = quickXorHash(bytes);
  const matches = (r: StoredRef) => r.size === bytes.length && r.providerHash === hash;
  for (let n = 1; n <= MAX_SUFFIX; n++) {
    const tryName = suffixed(name, n);
    let ref: StoredRef;
    try {
      ref = await connector.upload(dest, folderId, tryName, bytes, { conflict: 'fail' });
    } catch (err) {
      if (!(err instanceof StorageError && err.code === 'conflict')) throw err;
      const found = await connector.findChild(dest, folderId, tryName);
      if (found && matches(found)) return found;
      continue;
    }
    if (!matches(ref)) {
      await connector.removePermanently(dest, ref.itemId).catch(() => undefined);
      throw new StorageError('server');
    }
    return ref;
  }
  throw new StorageError('conflict');
}

/** After the last attempt: a held file still in storage raises one Administrator notice; retries continue daily. */
async function withholdFailed(deps: StorageDeps, fileId: string): Promise<void> {
  await withTx(deps, async (c) => {
    const r = await c.query(
      `UPDATE stored_files SET remove_notice_at = $2
        WHERE id = $1 AND state = 'withheld' AND withhold_case_id IS NOT NULL AND removed_at IS NULL AND remove_notice_at IS NULL
        RETURNING id`,
      [fileId, deps.clock()],
    );
    if (r.rowCount) await deps.notify(c, { kind: HELD_FILE_NOT_REMOVED, subjectId: fileId });
  });
  logFixed(deps, 'Withholding a held file did not finish; the daily task will try it again.');
}

/**
 * Once a day: every held file still in storage, or whose cleaned text is still to be uploaded again, with no withhold
 * attempt in the last 24 hours, gets a new `withhold` job.
 */
export async function dailyWithholdTask(deps: StorageDeps): Promise<void> {
  const before = new Date(deps.clock().getTime() - RETRY_AFTER_MS);
  await withTx(deps, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `SELECT f.id FROM stored_files f
        WHERE f.state = 'withheld' AND f.withhold_case_id IS NOT NULL
          AND (f.removed_at IS NULL OR (f.purpose = 'source_text' AND f.upload_folder_id IS NOT NULL))
          AND NOT EXISTS (SELECT 1 FROM storage_attempts a WHERE a.subject_id = f.id AND a.job = 'withhold' AND a.at > $1)
        ORDER BY f.created_at, f.id
        LIMIT 500`,
      [before],
    );
    for (const r of rows) await queueStorageJob(c, 'withhold', r.id, { priority: 'urgent' });
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// The restore-withheld job
// ---------------------------------------------------------------------------------------------------------------------

interface ContentRow { id: string; case_id: string; ciphertext: Buffer; nonce: Buffer; tag: Buffer; key_id: string; cleaned_sha256: string }

/**
 * The `restore-withheld` job (spec 8.5): after a false-alarm release (or a dismissed copy), the file's encrypted
 * original is decrypted and put back in the same folder under its recorded name; the reference is updated and, for an
 * output, its placement and sharing synced again. The case's encrypted originals of the file unwind newest first, as
 * the engine's do; one whose cleaned fingerprint no longer matches what the file holds now (changed since) stops the
 * unwinding and is left. A source text file goes back as its version's text, which the release has just restored in
 * the database. A file whose removal never happened is simply `stored` again.
 */
export async function restoreWithheld(deps: StorageDeps, fileId: string, caseId: string): Promise<void> {
  await exclusively(deps, fileId, async () => {
    const f = await loadFile(deps.pool, fileId);
    // Still withheld for a case: no release has asked for it back.
    if (!f || f.withhold_case_id !== null) return;
    const rows = (
      await deps.pool.query<ContentRow>(
        `SELECT q.id, q.case_id, q.ciphertext, q.nonce, q.tag, q.key_id, q.cleaned_sha256 FROM quarantine_originals q
          WHERE ${IS_FILE_CONTENT('q')} AND q.row_key->>'id' = $1::text AND q.case_id = $2 AND q.restored_at IS NULL
          ORDER BY q.sweep DESC`,
        [fileId, caseId],
      )
    ).rows;
    if (rows.length === 0) return;
    if (!deps.key) throw new StorageWaitingForKey();
    const key = deps.key;
    if (rows.some((r) => r.key_id !== key.id)) throw new Error('a withheld file was encrypted with another protected key');

    const destinationId = f.upload_destination_id ?? f.destination_id;
    if (!destinationId) throw new StorageError('invalid');
    const { connector, dest } = await deps.connectors.forDestination(destinationId);

    // Encrypted but never removed: the item is still where it was, as it was.
    if (f.state === 'withheld' && f.removed_at === null && f.item_id) {
      let there = true;
      try {
        await connector.getItem(dest, f.item_id);
      } catch (err) {
        if (!(err instanceof StorageError && err.code === 'not_found')) throw err;
        there = false;
      }
      if (there) {
        await record(deps, f, null, rows.map((r) => r.id));
        return;
      }
    }

    let target: Buffer | null = null;
    const used: string[] = [];
    if (f.purpose === 'source_text') {
      // The file is its version's text: the release has put that text back in the database, so that is what goes back.
      const v = (await deps.pool.query<{ text_content: string }>(`SELECT text_content FROM source_versions WHERE text_stored_file_id = $1`, [fileId])).rows[0];
      if (v) {
        target = Buffer.from(v.text_content, 'utf8');
        used.push(...rows.map((r) => r.id));
      }
    } else {
      let current = f.state === 'stored' ? (f.sha256 ?? '') : 'null';
      for (const r of rows) {
        if (r.cleaned_sha256 !== current) break;
        target = key.decrypt(r);
        current = sha256(target);
        used.push(r.id);
      }
    }
    if (!target) {
      logFixed(deps, 'A withheld file changed since it was withheld and was not restored.');
      return;
    }
    if (!f.upload_folder_id) throw new StorageError('invalid');
    // A source text file holds its cleaned text now: that copy goes, and the original takes its place.
    if (f.state === 'stored' && f.item_id) {
      await connector.removePermanently(dest, f.item_id).catch((err) => {
        if (!(err instanceof StorageError && err.code === 'not_found')) throw err;
      });
    }
    const ref = await put(connector, dest, f.upload_folder_id, f.name, target);
    await record(deps, f, { ref, dest, bytes: target }, used);
  });
}

/** Records a restored file `stored` (with its new item, or where it still was) and its originals restored. */
async function record(
  deps: StorageDeps, f: FileRow, placed: { ref: StoredRef; dest: DestinationRef; bytes: Buffer } | null, originals: string[],
): Promise<void> {
  const at = deps.clock();
  await withTx(deps, async (c) => {
    const now = (await c.query<{ withhold_case_id: string | null }>(`SELECT withhold_case_id FROM stored_files WHERE id = $1 FOR UPDATE`, [f.id])).rows[0];
    if (!now || now.withhold_case_id !== null) return;
    if (placed) {
      const dir = f.path && f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : null;
      await c.query(
        `UPDATE stored_files SET state = 'stored', destination_id = $2, connector = $3, drive_id = $4, item_id = $5, path = $6, name = $7, size_bytes = $8,
                sha256 = $9, provider_hash = $10, etag = $11, ctag = $12, web_url = $13, stored_at = $14, removed_at = NULL, remove_notice_at = NULL,
                check_status = 'ok', last_checked_at = $14, failure_code = NULL
          WHERE id = $1`,
        [
          f.id, placed.dest.id, placed.dest.connector, placed.dest.driveId, placed.ref.itemId, dir ? `${dir}/${placed.ref.name}` : placed.ref.path, placed.ref.name, placed.ref.size,
          sha256(placed.bytes), placed.ref.providerHash, placed.ref.etag, placed.ref.ctag, placed.ref.webUrl, at,
        ],
      );
    } else {
      await c.query(`UPDATE stored_files SET state = 'stored', remove_notice_at = NULL WHERE id = $1`, [f.id]);
    }
    await c.query(`UPDATE quarantine_originals SET restored_at = $2 WHERE id = ANY($1::uuid[])`, [originals, at]);
    if (f.purpose === 'output') {
      const o = (await c.query<{ output_id: string }>(`SELECT output_id FROM output_versions WHERE stored_file_id = $1`, [f.id])).rows[0];
      if (o) await queueOutputPlacement(c, o.output_id, 'widen');
    }
    await writeAudit(c, { at, action: 'storage.file_restored', actorUserId: null, subjectType: 'stored_file', subjectId: f.id, detail: { projectId: f.project_id, purpose: f.purpose } });
  });
}

/** The case a file's newest unrestored encrypted original belongs to (the case its restore is for). */
async function restoreCaseOf(db: Db, fileId: string): Promise<string | null> {
  return (
    (await db.query<{ case_id: string }>(
      `SELECT q.case_id FROM quarantine_originals q WHERE ${IS_FILE_CONTENT('q')} AND q.row_key->>'id' = $1::text AND q.restored_at IS NULL
        ORDER BY q.sweep DESC LIMIT 1`,
      [fileId],
    )).rows[0]?.case_id ?? null
  );
}

registerStorageHandler('withhold', async (deps, fileId) => {
  const caseId = (await loadFile(deps.pool, fileId))?.withhold_case_id;
  if (caseId) await withholdStoredFile(deps, fileId, caseId);
});
registerStorageFinalFailure('withhold', withholdFailed);
registerStorageHandler('restore-withheld', async (deps, fileId) => {
  const caseId = await restoreCaseOf(deps.pool, fileId);
  if (caseId) await restoreWithheld(deps, fileId, caseId);
});
registerStorageDailyTask('withhold', dailyWithholdTask);
