import { createHash } from 'node:crypto';
import type { StorageConnector } from './connector';
import { StorageWaitingForKey } from './connector-factory';
import { type StorageDeps, registerStorageDailyTask } from './jobs';
import { loadStorageSettings } from './settings';
import { type DestinationRef, StorageError } from './types';

/**
 * Serving and checking source originals kept in the managed source area (spec 9.2). A file that is flagged Changed or
 * Missing is never served again (until a later relink or re-store clears the flag); the working text in the database is
 * never touched here.
 */

export const CHANGED_IN_STORAGE = 'This file has changed in storage since Kainow recorded it. It has been flagged for the storage Administrators.';
export const MISSING_FROM_STORAGE = 'This file is no longer in storage. It has been flagged for the storage Administrators.';
export const STORE_UNREACHABLE = 'The file store cannot be reached right now';

/** The notice kinds a newly flagged source file raises (worded by makeStorageNotify). */
export const SOURCE_FILE_CHANGED = 'source_file_changed';
export const SOURCE_FILE_MISSING = 'source_file_missing';

/** What the download and the check need: no key, they only use connectors built by the factory. */
export type SourceFileDeps = Pick<StorageDeps, 'pool' | 'connectors' | 'clock' | 'notify'>;

export type OpenedOriginal =
  | { filename: string; mediaType: string; bytes: Buffer }
  | { refused: 'changed' | 'unreachable' | 'missing' };

type Flag = 'changed' | 'missing';

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

/**
 * Marks a stored file Changed or Missing and, only when it was not flagged before, raises one notice. The update and the
 * notice share one transaction, so a repeat check or a second download never notifies again.
 */
export async function flagStoredFile(deps: SourceFileDeps, fileId: string, flag: Flag, at: Date): Promise<boolean> {
  const c = await deps.pool.connect();
  try {
    await c.query('BEGIN');
    const { rowCount } = await c.query(
      `UPDATE stored_files SET check_status = $2, last_checked_at = $3
        WHERE id = $1 AND state IN ('stored', 'relocating') AND check_status NOT IN ('changed', 'missing')`,
      [fileId, flag, at],
    );
    if (rowCount) await deps.notify(c, { kind: flag === 'changed' ? SOURCE_FILE_CHANGED : SOURCE_FILE_MISSING, subjectId: fileId });
    await c.query('COMMIT');
    return (rowCount ?? 0) > 0;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

interface OriginalRow {
  filename: string; media_type: string; original_sha256: string;
  file_id: string; state: string; check_status: string; destination_id: string | null; item_id: string | null;
}

/**
 * Downloads a version's stored original, checks its SHA-256 against the recorded `original_sha256`, and only then
 * returns it. Returns null when the version has no stored original to serve (nothing in storage, or withheld). A file
 * already flagged is refused without a download.
 */
export async function openOriginal(deps: SourceFileDeps, versionId: string): Promise<OpenedOriginal | null> {
  const row = (
    await deps.pool.query<OriginalRow>(
      `SELECT v.filename, v.media_type, v.original_sha256, f.id AS file_id, f.state, f.check_status, f.destination_id, f.item_id
         FROM source_versions v JOIN stored_files f ON f.id = v.original_stored_file_id
        WHERE v.id = $1 AND v.origin = 'upload' AND v.original_bytes IS NULL`,
      [versionId],
    )
  ).rows[0];
  if (!row) return null;
  // A file being relocated is served from its current (old) copy until the new one is confirmed (spec 9.3).
  const current = row.state === 'stored' || row.state === 'relocating';
  if (current && row.check_status === 'changed') return { refused: 'changed' };
  if (current && row.check_status === 'missing') return { refused: 'missing' };
  if (!current || !row.destination_id || !row.item_id) return null;

  let bytes: Buffer;
  try {
    const { connector, dest } = await deps.connectors.forDestination(row.destination_id);
    bytes = await connector.download(dest, row.item_id);
  } catch (err) {
    if (err instanceof StorageError && err.code === 'not_found') {
      await flagStoredFile(deps, row.file_id, 'missing', deps.clock());
      return { refused: 'missing' };
    }
    // Only the store's own faults (and waiting for the key) mean "cannot be reached"; a bug must surface as a 500.
    if (err instanceof StorageError || err instanceof StorageWaitingForKey) return { refused: 'unreachable' };
    throw err;
  }
  if (sha256(bytes) !== row.original_sha256) {
    await flagStoredFile(deps, row.file_id, 'changed', deps.clock());
    return { refused: 'changed' };
  }
  return { filename: row.filename, mediaType: row.media_type, bytes };
}

interface CheckRow {
  id: string; destination_id: string; item_id: string;
  size_bytes: string | null; provider_hash: string | null; etag: string | null;
}

/**
 * The daily source-area check (spec 9.2): `getItem` for each stored source file, oldest check first (never-checked
 * first), at most `limit` per run, comparing size, QuickXorHash and eTag with what was recorded. A difference marks the
 * file Changed, a missing item Missing; each newly flagged file sends one notice. When scheduled checks are off, only
 * files never checked are looked at. A provider that cannot be reached (or refuses the connection) ends the run early:
 * the files not reached keep their place at the front of the next run.
 */
export async function checkSourceFiles(deps: SourceFileDeps, now: Date, limit = 2000): Promise<{ checked: number; flagged: number }> {
  const scheduled = (await loadStorageSettings(deps.pool)).scheduledChecks;
  // A destination whose connector cannot be obtained is left out of this run altogether, so it takes no slots.
  const connectors = new Map<string, { connector: StorageConnector; dest: DestinationRef }>();
  const dead: string[] = [];
  const dests = await deps.pool.query<{ destination_id: string }>(
    `SELECT DISTINCT destination_id FROM stored_files
      WHERE state = 'stored' AND purpose IN ('source_original', 'source_text') AND destination_id IS NOT NULL AND item_id IS NOT NULL
      ORDER BY destination_id`,
  );
  for (const d of dests.rows) {
    try {
      connectors.set(d.destination_id, await deps.connectors.forDestination(d.destination_id));
    } catch (err) {
      if (!(err instanceof StorageWaitingForKey || err instanceof StorageError)) throw err;
      dead.push(d.destination_id);
    }
  }
  const { rows } = await deps.pool.query<CheckRow>(
    `SELECT id, destination_id, item_id, size_bytes, provider_hash, etag FROM stored_files
      WHERE state = 'stored' AND purpose IN ('source_original', 'source_text')
        AND destination_id IS NOT NULL AND item_id IS NOT NULL
        AND destination_id <> ALL($3::uuid[])
        AND check_status NOT IN ('changed', 'missing')
        AND ($2::boolean OR last_checked_at IS NULL)
      ORDER BY last_checked_at NULLS FIRST, id
      LIMIT $1`,
    [limit, scheduled, dead],
  );
  let checked = 0;
  let flagged = 0;
  for (const r of rows) {
    const c = connectors.get(r.destination_id);
    if (!c) continue;
    let verdict: 'ok' | Flag | 'access_denied' | 'skipped';
    try {
      const item = await c.connector.getItem(c.dest, r.item_id);
      const differs =
        (r.size_bytes !== null && Number(r.size_bytes) !== item.size) ||
        (r.provider_hash !== null && item.providerHash !== null && r.provider_hash !== item.providerHash) ||
        (r.etag !== null && item.etag !== null && r.etag !== item.etag);
      verdict = differs ? 'changed' : 'ok';
    } catch (err) {
      if (err instanceof StorageWaitingForKey) break;
      if (!(err instanceof StorageError)) throw err;
      if (err.code === 'not_found') verdict = 'missing';
      else if (err.code === 'forbidden') verdict = 'access_denied';
      // The whole connection is failing (or being throttled): the rest would fail the same way. Stop; they keep their place.
      else if (err.code === 'unauthorised' || err.code === 'throttled' || err.code === 'unreachable') break;
      // Something about this one item (server fault, timeout, invalid): look at it again another day, behind the others.
      else verdict = 'skipped';
    }
    checked++;
    if (verdict === 'changed' || verdict === 'missing') {
      if (await flagStoredFile(deps, r.id, verdict, now)) flagged++;
    } else if (verdict === 'skipped') {
      await deps.pool.query(`UPDATE stored_files SET last_checked_at = $2 WHERE id = $1 AND state = 'stored'`, [r.id, now]);
    } else {
      await deps.pool.query(
        `UPDATE stored_files SET check_status = $2, last_checked_at = $3 WHERE id = $1 AND state = 'stored' AND check_status NOT IN ('changed', 'missing')`,
        [r.id, verdict, now],
      );
    }
  }
  return { checked, flagged };
}

registerStorageDailyTask('source-check', async (deps) => {
  await checkSourceFiles(deps, deps.clock());
});
