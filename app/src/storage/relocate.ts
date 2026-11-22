import { createHash } from 'node:crypto';
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { writeAudit } from '../audit/audit';
import { type AuthUser, CLOCK, type Clock } from '../auth/tokens';
import { readReason } from '../common/reason';
import { UUID, uuidv7 } from '../common/uuid7';
import { PG_POOL } from '../db/database.module';
import { queueFolderSharing } from '../outputs/sharing-queue';
import type { StorageConnector } from './connector';
import { STORAGE_CONNECTORS, StorageWaitingForKey, type StorageConnectorFactory } from './connector-factory';
import { DestinationsService } from './destinations.service';
import { type StorageDeps, registerStorageDailyTask, registerStorageFinalFailure, registerStorageHandler } from './jobs';
import { queueStorageJob } from './outbox';
import { flagStoredFile } from './source-files';
import { ensureSourceProjectsFolder, versionFolder } from './sources';
import { type DestinationRef, StorageError, type StoredRef } from './types';

/**
 * The relocation routine (spec 9.4) and moving the source area (spec 9.3).
 *
 * Relocating one stored file: it is marked `relocating`; the provider moves it (same drive: the item id is kept) or
 * copies it to the new place; the new item's size and hash are verified against the record (SHA-256 of a download
 * when the provider gives no comparable hash); then one transaction switches the reference in place (one row per
 * provider item, never a second row) and records the old one in `stored_file_moves`; only then is the old copy removed
 * permanently. A failure before the switch leaves the old reference current and the file `stored` again. Removing the
 * old copy is tracked by `old_copy_move_id` until it succeeds, so there is never a moment with no confirmed copy and
 * never two authoritative ones (the old reference is history).
 *
 * Moving the source area: the new destination becomes the approved source area at once (new stores go there) and the
 * old one `retiring`: still read from (every download and check follows each file's own destination) until every file
 * has been relocated, when it is withdrawn and the storage Administrators' access there is removed.
 */

type Db = Pool | PoolClient;

export const SOURCE_AREA_MOVE_REASON = 'Source area moved';
const SOURCE_PURPOSES = `('source_original', 'source_text')`;
/** How long a file whose relocation failed rests before the daily task tries it again. */
const RETRY_AFTER_MS = 24 * 3600_000;
const DAILY_LIMIT = 500;

const MOVE_IN_PROGRESS = 'A source-area move is already in progress. Wait until every file has moved.';
const NO_SOURCE_AREA = 'There is no source area to move from. Approve this destination as the source area instead.';
const NOT_A_SOURCE_AREA = 'Choose a destination added for the source area.';
const ALREADY_CURRENT = 'This destination is already the source area.';
const COMPLETED_REASON = 'Every file has moved to the new source area.';

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const logFixed = (deps: Pick<StorageDeps, 'log'>, message: string): void => (deps.log ?? ((m) => console.warn(m)))(message);

export interface RelocateTarget {
  destinationId: string;
  /** The provider item id of the folder the file goes into. */
  folderId: string;
  /** The file's name there; its recorded name when absent. */
  name?: string;
}

interface FileRow {
  id: string; purpose: 'source_original' | 'source_text' | 'output'; project_id: string; state: string;
  destination_id: string | null; drive_id: string | null; item_id: string | null; path: string | null; name: string;
  size_bytes: string | null; sha256: string | null; provider_hash: string | null; check_status: string;
  old_copy_move_id: string | null;
}

const loadFile = async (db: Db, id: string): Promise<FileRow | undefined> =>
  (
    await db.query<FileRow>(
      `SELECT id, purpose, project_id, state, destination_id, drive_id, item_id, path, name, size_bytes, sha256, provider_hash, check_status,
              old_copy_move_id
         FROM stored_files WHERE id = $1`,
      [id],
    )
  ).rows[0];

const isSource = (f: Pick<FileRow, 'purpose'>): boolean => f.purpose === 'source_original' || f.purpose === 'source_text';

async function withTx<T>(pool: Pool, work: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
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

/** One relocation at a time per file; a second run meanwhile is tried again later. */
async function exclusively<T>(deps: StorageDeps, fileId: string, work: () => Promise<T>): Promise<T> {
  const lock = await deps.pool.connect();
  let broken: Error | undefined;
  try {
    const got = (await lock.query<{ ok: boolean }>(`SELECT pg_try_advisory_lock(hashtext('relocate-file'), hashtext($1)) AS ok`, [fileId])).rows[0].ok;
    if (!got) throw new StorageError('throttled', { retryAfterMs: 60_000 });
    try {
      return await work();
    } finally {
      try {
        await lock.query(`SELECT pg_advisory_unlock(hashtext('relocate-file'), hashtext($1))`, [fileId]);
      } catch (err) {
        broken = err instanceof Error ? err : new Error('unlock failed');
      }
    }
  } finally {
    lock.release(broken);
  }
}

/** Whether a stored file other than `fileId` stands for the provider item (Kainow never adopts or removes another's). */
async function referencedElsewhere(db: Db, fileId: string, driveId: string, itemId: string): Promise<boolean> {
  return ((await db.query(`SELECT 1 FROM stored_files WHERE drive_id = $1 AND item_id = $2 AND id <> $3`, [driveId, itemId, fileId])).rowCount ?? 0) > 0;
}

/**
 * Whether an item holds exactly what the file's record says: the same size, and the same provider hash when both
 * places use the same kind of provider and it gives one; otherwise the SHA-256 of a download.
 */
async function holdsRecorded(f: FileRow, connector: StorageConnector, dest: DestinationRef, ref: StoredRef, sameKind: boolean): Promise<boolean> {
  if (f.size_bytes === null || Number(f.size_bytes) !== ref.size) return false;
  if (sameKind && f.provider_hash && ref.providerHash) return f.provider_hash === ref.providerHash;
  if (!f.sha256) return false;
  return sha256(await connector.download(dest, ref.itemId)) === f.sha256;
}

/**
 * Removes the old copy left by an earlier relocation of the file, if one is still to go (permanently; an item already
 * gone counts as removed; an item another stored file now stands for is left alone). A failure is thrown and tried again.
 */
async function removeOldCopy(deps: StorageDeps, fileId: string): Promise<void> {
  const m = (
    await deps.pool.query<{ move_id: string; destination_id: string | null; drive_id: string | null; item_id: string | null }>(
      `SELECT m.id AS move_id, m.old_destination_id AS destination_id, m.old_drive_id AS drive_id, m.old_item_id AS item_id
         FROM stored_files f JOIN stored_file_moves m ON m.id = f.old_copy_move_id WHERE f.id = $1`,
      [fileId],
    )
  ).rows[0];
  if (!m) return;
  if (m.destination_id && m.drive_id && m.item_id && !(await referencedElsewhere(deps.pool, fileId, m.drive_id, m.item_id))) {
    const { connector, dest } = await deps.connectors.forDestination(m.destination_id);
    try {
      await connector.removePermanently(dest, m.item_id);
    } catch (err) {
      if (!(err instanceof StorageError && err.code === 'not_found')) throw err;
    }
  }
  await deps.pool.query(`UPDATE stored_files SET old_copy_move_id = NULL WHERE id = $1 AND old_copy_move_id = $2`, [fileId, m.move_id]);
}

/**
 * Relocates one stored file (spec 9.4), see the header. Files not in storage (withheld, waiting, failed, linked) and
 * files already at the target are left as they are. A file flagged Changed or Missing cannot be verified and is
 * refused (`invalid`). Throws on any failure before the switch (the old reference stays current) and on a failed
 * removal of the old copy after it (the new reference is current; the removal is tried again).
 */
export async function relocateStoredFile(
  deps: StorageDeps, storedFileId: string, target: RelocateTarget, reason: string, actorId: string | null,
): Promise<void> {
  await exclusively(deps, storedFileId, () => relocateLocked(deps, storedFileId, target, reason, actorId));
  const f = await loadFile(deps.pool, storedFileId);
  if (f && isSource(f)) await completeSourceAreaMoves(deps);
}

async function relocateLocked(deps: StorageDeps, fileId: string, target: RelocateTarget, reason: string, actorId: string | null): Promise<void> {
  await removeOldCopy(deps, fileId);
  const f = await loadFile(deps.pool, fileId);
  if (!f || (f.state !== 'stored' && f.state !== 'relocating') || !f.destination_id || !f.item_id || !f.drive_id) return;
  if (f.check_status === 'changed' || f.check_status === 'missing') throw new StorageError('invalid');
  const src = await deps.connectors.forDestination(f.destination_id);
  const dst = await deps.connectors.forDestination(target.destinationId);
  const name = target.name ?? f.name;
  const sameKind = src.dest.connector === dst.dest.connector;
  const sameDrive = sameKind && src.dest.driveId === dst.dest.driveId;

  const here = sameDrive ? await src.connector.getItem(src.dest, f.item_id) : null;
  /** The item is already where it should go: an earlier move whose answer was lost, or nothing to do. */
  const atTarget = !!here && here.parentId === target.folderId && here.name === name;
  if (atTarget && f.destination_id === target.destinationId && f.path === here!.path) {
    // The record already says so: nothing to switch.
    if (f.state === 'relocating') await deps.pool.query(`UPDATE stored_files SET state = 'stored' WHERE id = $1 AND state = 'relocating'`, [f.id]);
    return;
  }

  await deps.pool.query(`UPDATE stored_files SET state = 'relocating' WHERE id = $1 AND state IN ('stored', 'relocating')`, [f.id]);
  let ref: StoredRef;
  /** A new item this attempt made or adopted: removed again if the attempt goes no further. */
  let fresh: StoredRef | null = null;
  /** Where a same-drive move took the item from, to put it back if it then fails verification. */
  let movedFrom: StoredRef | null = null;
  try {
    if (here) {
      // Verified before the move too: a file changed in storage is never moved as if it were the recorded one; it is
      // flagged Changed (one notice) and not tried again.
      if (!(await holdsRecorded(f, src.connector, src.dest, here, true))) {
        await flagStoredFile(deps, f.id, 'changed', deps.clock());
        throw new StorageError('invalid');
      }
      if (atTarget) {
        // Moved by an earlier attempt whose answer was lost: only the switch is left (nothing to move back).
        ref = here;
      } else {
        ref = await moveWithin(src.connector, src.dest, f.item_id, target.folderId, name);
        movedFrom = here;
      }
    } else {
      ref = await copyAcross(deps, f, src, dst, target.folderId, name);
      fresh = ref;
    }
    if (!(await holdsRecorded(f, dst.connector, dst.dest, ref, sameKind))) throw new StorageError('server');
    // A same-drive answer is read against the old destination; its path is read again from the new one's root, which
    // may be another folder of the drive, so the record and the move hold the path within the new destination.
    if (here) ref = await dst.connector.getItem(dst.dest, ref.itemId);
  } catch (err) {
    await undo(deps, f, src, dst, fresh, movedFrom);
    throw err;
  }

  const at = deps.clock();
  const moveId = uuidv7(at.getTime());
  const switched = await withTx(deps.pool, async (c) => {
    const now = (
      await c.query<{ state: string; destination_id: string | null; item_id: string | null }>(
        `SELECT state, destination_id, item_id FROM stored_files WHERE id = $1 FOR UPDATE`,
        [f.id],
      )
    ).rows[0];
    // Withheld, flagged (or otherwise changed) while it was copied: the old reference stays and this copy is abandoned.
    if (!now || now.state !== 'relocating' || now.destination_id !== f.destination_id || now.item_id !== f.item_id) return false;
    const folder = (
      await c.query<{ id: string }>(
        `SELECT id FROM storage_folders WHERE destination_id = $1 AND item_id = $2 ORDER BY created_at, id LIMIT 1`,
        [target.destinationId, target.folderId],
      )
    ).rows[0];
    await c.query(
      `INSERT INTO stored_file_moves (id, stored_file_id, reason, old_destination_id, old_drive_id, old_item_id, old_path,
                                      new_destination_id, new_drive_id, new_item_id, new_path, actor_id, at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [moveId, f.id, reason, f.destination_id, f.drive_id, f.item_id, f.path, dst.dest.id, dst.dest.driveId, ref.itemId, ref.path, actorId, at],
    );
    await c.query(
      // check_status 'ok': the new item was verified against the record just now (size and hash, or SHA-256).
      `UPDATE stored_files SET state = 'stored', destination_id = $2, connector = $3, drive_id = $4, item_id = $5, path = $6, name = $7,
              provider_hash = $8, etag = $9, ctag = $10, web_url = $11, check_status = 'ok', last_checked_at = $12, failure_code = NULL,
              folder_id = $13, upload_destination_id = $2, upload_folder_id = $14, upload_name = $7, old_copy_move_id = $15
        WHERE id = $1`,
      [
        f.id, dst.dest.id, dst.dest.connector, dst.dest.driveId, ref.itemId, ref.path, ref.name, ref.providerHash, ref.etag, ref.ctag,
        ref.webUrl, at, folder?.id ?? null, target.folderId, ref.itemId === f.item_id && sameDrive ? null : moveId,
      ],
    );
    return true;
  });
  if (!switched) {
    if (fresh) await removeQuietly(deps, f.id, dst, fresh);
    return;
  }
  await removeOldCopy(deps, f.id);
}

/** Same drive: one provider move (the item id is kept). An answer lost after the move is found by the item itself. */
async function moveWithin(connector: StorageConnector, dest: DestinationRef, itemId: string, folderId: string, name: string): Promise<StoredRef> {
  try {
    return await connector.move(dest, itemId, folderId, name);
  } catch (err) {
    if (!(err instanceof StorageError && err.code === 'conflict')) throw err;
    const it = await connector.getItem(dest, itemId);
    if (it.parentId === folderId && it.name === name) return it;
    throw err;
  }
}

/**
 * Across drives: the provider copies the item. A name already taken at the target (an earlier attempt whose answer was
 * lost) is adopted only when it holds exactly the recorded content and no other stored file stands for it; anything
 * else fails `conflict` and is left alone.
 */
async function copyAcross(
  deps: StorageDeps, f: FileRow,
  src: { connector: StorageConnector; dest: DestinationRef }, dst: { connector: StorageConnector; dest: DestinationRef },
  folderId: string, name: string,
): Promise<StoredRef> {
  try {
    return await src.connector.copyTo(src.dest, f.item_id as string, dst.dest, folderId, name);
  } catch (err) {
    if (!(err instanceof StorageError && err.code === 'conflict')) throw err;
    const found = await dst.connector.findChild(dst.dest, folderId, name);
    if (
      found && !(await referencedElsewhere(deps.pool, f.id, dst.dest.driveId, found.itemId))
      && (await holdsRecorded(f, dst.connector, dst.dest, found, src.dest.connector === dst.dest.connector))
    ) {
      return found;
    }
    throw new StorageError('conflict');
  }
}

/** A failed attempt: its new copy is removed (or a moved item put back), and the file is `stored` at its old place. */
async function undo(
  deps: StorageDeps, f: FileRow, src: { connector: StorageConnector; dest: DestinationRef }, dst: { connector: StorageConnector; dest: DestinationRef },
  fresh: StoredRef | null, movedFrom: StoredRef | null,
): Promise<void> {
  if (fresh) await removeQuietly(deps, f.id, dst, fresh);
  if (movedFrom) {
    // Put back through the old destination, whose root holds the place it came from.
    await src.connector.move(src.dest, f.item_id as string, movedFrom.parentId, movedFrom.name).catch(() => {
      logFixed(deps, 'A stored file that failed verification after a move could not be put back; its record keeps the old path.');
    });
  }
  await deps.pool.query(`UPDATE stored_files SET state = 'stored' WHERE id = $1 AND state = 'relocating'`, [f.id]);
}

/** Best effort: a copy this relocation made is removed, never an item another stored file stands for. */
async function removeQuietly(deps: StorageDeps, fileId: string, dst: { connector: StorageConnector; dest: DestinationRef }, ref: StoredRef): Promise<void> {
  try {
    if (await referencedElsewhere(deps.pool, fileId, dst.dest.driveId, ref.itemId)) return;
    await dst.connector.removePermanently(dst.dest, ref.itemId);
  } catch {
    logFixed(deps, 'A copy made by a relocation that did not complete could not be removed.');
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The relocate job: moving source files into the approved source area
// ---------------------------------------------------------------------------------------------------------------------

const approvedSourceArea = async (db: Db): Promise<string | null> =>
  (await db.query<{ id: string }>(`SELECT id FROM storage_destinations WHERE purpose = 'source_area' AND status = 'approved'`)).rows[0]?.id ?? null;

/**
 * The `relocate` job (subject: a stored file id). A source file not in the approved source area is relocated into it, to
 * the same `projects/<project>/sources/<source>/v<n>` place. For any file, an old copy still to be removed is removed.
 */
export async function relocateSourceFile(deps: StorageDeps, fileId: string): Promise<void> {
  const f = await loadFile(deps.pool, fileId);
  if (!f) return;
  const area = isSource(f) ? await approvedSourceArea(deps.pool) : null;
  if (!area || f.destination_id === area || (f.state !== 'stored' && f.state !== 'relocating') || !f.destination_id) {
    await exclusively(deps, fileId, async () => {
      await removeOldCopy(deps, fileId);
      await deps.pool.query(`UPDATE stored_files SET state = 'stored' WHERE id = $1 AND state = 'relocating'`, [fileId]);
    });
    if (isSource(f)) await completeSourceAreaMoves(deps);
    return;
  }
  const v = (
    await deps.pool.query<{ source_id: string; version_no: number }>(
      `SELECT source_id, version_no FROM source_versions WHERE original_stored_file_id = $1 OR text_stored_file_id = $1 LIMIT 1`,
      [fileId],
    )
  ).rows[0];
  if (!v) return;
  const { connector, dest } = await deps.connectors.forDestination(area);
  const folderId = await versionFolder(deps, connector, dest, { project_id: f.project_id, source_id: v.source_id, version_no: v.version_no });
  const actor = (
    await deps.pool.query<{ actor_id: string | null }>(
      `SELECT actor_id FROM storage_destination_events WHERE destination_id = $1 AND kind = 'retiring' ORDER BY at DESC, id DESC LIMIT 1`,
      [f.destination_id],
    )
  ).rows[0]?.actor_id ?? null;
  await relocateStoredFile(deps, fileId, { destinationId: area, folderId, name: f.name }, SOURCE_AREA_MOVE_REASON, actor);
}

/**
 * Called in the transaction that puts a source file back in storage (a withheld file restored, its cleaned text
 * uploaded again): a file that landed outside the approved source area is queued to be relocated into it.
 */
export async function queueRelocationIfAway(c: PoolClient, fileId: string): Promise<void> {
  const away = await c.query(
    `SELECT 1 FROM stored_files f
      WHERE f.id = $1 AND f.purpose IN ${SOURCE_PURPOSES} AND f.state = 'stored'
        AND EXISTS (SELECT 1 FROM storage_destinations a WHERE a.purpose = 'source_area' AND a.status = 'approved' AND a.id IS DISTINCT FROM f.destination_id)`,
    [fileId],
  );
  if (away.rowCount) await queueStorageJob(c, 'relocate', fileId);
}

/**
 * A source area being moved away from (retiring) whose every stored source file has moved is withdrawn: its storage
 * Administrators' access there is removed (share-sync, urgent). Withheld files keep their references; one put back
 * later is relocated (queueRelocationIfAway, and the daily task).
 */
export async function completeSourceAreaMoves(deps: Pick<StorageDeps, 'pool' | 'clock'>): Promise<number> {
  return withTx(deps.pool, async (c) => {
    const retiring = (
      await c.query<{ id: string }>(`SELECT id FROM storage_destinations WHERE purpose = 'source_area' AND status = 'retiring' ORDER BY id FOR UPDATE`)
    ).rows;
    let done = 0;
    for (const d of retiring) {
      const left = await c.query(
        `SELECT 1 FROM stored_files WHERE destination_id = $1 AND purpose IN ${SOURCE_PURPOSES} AND state IN ('stored', 'relocating') LIMIT 1`,
        [d.id],
      );
      if (left.rowCount) continue;
      const at = deps.clock();
      await c.query(`UPDATE storage_destinations SET status = 'withdrawn' WHERE id = $1`, [d.id]);
      await c.query(
        `INSERT INTO storage_destination_events (id, destination_id, kind, actor_id, at, reason, detail) VALUES ($1, $2, 'withdrawn', NULL, $3, $4, '{"moveCompleted":true}')`,
        [uuidv7(at.getTime()), d.id, at, COMPLETED_REASON],
      );
      const folders = (await c.query<{ id: string }>(`SELECT id FROM storage_folders WHERE destination_id = $1 AND level = 'source_root' ORDER BY id`, [d.id])).rows;
      for (const f of folders) await queueFolderSharing(c, f.id, 'urgent');
      done++;
    }
    return done;
  });
}

/** After the last attempt: the file stays at its old place, `stored`, and counts as failed until a later attempt succeeds. */
async function relocateFailed(deps: StorageDeps, fileId: string, code: string): Promise<void> {
  await deps.pool.query(`UPDATE stored_files SET state = 'stored' WHERE id = $1 AND state = 'relocating'`, [fileId]);
  await deps.pool.query(
    `UPDATE stored_files f SET failure_code = $2
      WHERE f.id = $1 AND f.state = 'stored' AND f.purpose IN ${SOURCE_PURPOSES}
        AND f.destination_id IS DISTINCT FROM (SELECT id FROM storage_destinations WHERE purpose = 'source_area' AND status = 'approved')`,
    [fileId, code],
  );
  logFixed(deps, 'Relocating a stored file did not finish; it stays at its old place and the daily task will try it again.');
}

/**
 * Once a day: every source file still in a source area being (or having been) moved away from, and every file whose
 * old copy is still to be removed, with no relocate attempt in the last 24 hours, gets a new `relocate` job; then any
 * finished move is completed.
 */
export async function dailyRelocateTask(deps: StorageDeps): Promise<void> {
  const before = new Date(deps.clock().getTime() - RETRY_AFTER_MS);
  await withTx(deps.pool, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `SELECT f.id FROM stored_files f
         LEFT JOIN storage_destinations d ON d.id = f.destination_id
        WHERE (f.old_copy_move_id IS NOT NULL
               OR (f.purpose IN ${SOURCE_PURPOSES} AND f.state IN ('stored', 'relocating') AND d.purpose = 'source_area'
                   AND (d.status = 'retiring'
                        OR (d.status = 'withdrawn' AND EXISTS (SELECT 1 FROM storage_destination_events e WHERE e.destination_id = d.id AND e.kind = 'retiring')))
                   AND EXISTS (SELECT 1 FROM storage_destinations a WHERE a.purpose = 'source_area' AND a.status = 'approved')))
          AND NOT EXISTS (SELECT 1 FROM storage_attempts a WHERE a.subject_id = f.id AND a.job = 'relocate' AND a.at > $1)
        ORDER BY f.created_at, f.id
        LIMIT $2`,
      [before, DAILY_LIMIT],
    );
    for (const r of rows) await queueStorageJob(c, 'relocate', r.id);
  });
  await completeSourceAreaMoves(deps);
}

registerStorageHandler('relocate', (deps, fileId) => relocateSourceFile(deps, fileId));
registerStorageFinalFailure('relocate', relocateFailed);
registerStorageDailyTask('relocate', dailyRelocateTask);

// ---------------------------------------------------------------------------------------------------------------------
// Moving the source area (API side)
// ---------------------------------------------------------------------------------------------------------------------

export interface SourceAreaFiles { files: number; bytes: number }

export interface SourceAreaMoveProgress {
  from: { id: string; label: string };
  to: { id: string; label: string } | null;
  startedAt: string;
  reason: string | null;
  /** What the confirmation stated when the move started. */
  files: number;
  bytes: number;
  /** Stored source files still at the old place (including failed ones). */
  toMove: number;
  /** Files relocated from the old place to the new one since the move started. */
  moved: number;
  /** Files still at the old place whose last relocation failed after all its attempts. */
  failed: number;
}

/** Stored source files (in storage, not withheld) at a destination, and their total size. */
async function filesAt(db: Db, destinationId: string): Promise<SourceAreaFiles> {
  const r = (
    await db.query<{ files: number; bytes: string }>(
      `SELECT count(*)::int AS files, COALESCE(sum(size_bytes), 0)::bigint AS bytes FROM stored_files
        WHERE destination_id = $1 AND purpose IN ${SOURCE_PURPOSES} AND state IN ('stored', 'relocating')`,
      [destinationId],
    )
  ).rows[0];
  return { files: r.files, bytes: Number(r.bytes) };
}

/** The move in progress, with its counts for the Storage page; null when none is. */
export async function sourceAreaMoveProgress(db: Db): Promise<SourceAreaMoveProgress | null> {
  const from = (
    await db.query<{ id: string; label: string; at: Date; reason: string | null; detail: { files?: number; bytes?: number } }>(
      `SELECT d.id, d.label, e.at, e.reason, e.detail FROM storage_destinations d
         JOIN LATERAL (SELECT at, reason, detail FROM storage_destination_events WHERE destination_id = d.id AND kind = 'retiring' ORDER BY at DESC, id DESC LIMIT 1) e ON true
        WHERE d.purpose = 'source_area' AND d.status = 'retiring'`,
    )
  ).rows[0];
  if (!from) return null;
  const to = (await db.query<{ id: string; label: string }>(`SELECT id, label FROM storage_destinations WHERE purpose = 'source_area' AND status = 'approved'`)).rows[0] ?? null;
  const counts = (
    await db.query<{ to_move: number; failed: number; moved: number }>(
      `SELECT (SELECT count(*)::int FROM stored_files WHERE destination_id = $1 AND purpose IN ${SOURCE_PURPOSES} AND state IN ('stored', 'relocating')) AS to_move,
              (SELECT count(*)::int FROM stored_files WHERE destination_id = $1 AND purpose IN ${SOURCE_PURPOSES} AND state IN ('stored', 'relocating')
                                                        AND failure_code IS NOT NULL) AS failed,
              (SELECT count(DISTINCT stored_file_id)::int FROM stored_file_moves WHERE old_destination_id = $1 AND new_destination_id = $2 AND at >= $3) AS moved`,
      [from.id, to?.id ?? null, from.at],
    )
  ).rows[0];
  return {
    from: { id: from.id, label: from.label }, to, startedAt: from.at.toISOString(), reason: from.reason,
    files: from.detail.files ?? 0, bytes: from.detail.bytes ?? 0, toMove: counts.to_move, moved: counts.moved, failed: counts.failed,
  };
}

/** "1 file", "12 files"; sizes in B, KB, MB, GB (1,024 steps, one decimal above bytes). */
export function describeFiles(n: SourceAreaFiles): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = n.bytes;
  let u = 0;
  while (size >= 1024 && u < units.length - 1) {
    size /= 1024;
    u++;
  }
  return `${n.files.toLocaleString('en-US')} file${n.files === 1 ? '' : 's'} (${u === 0 ? size : size.toFixed(1)} ${units[u]})`;
}

const confirmMessage = (n: SourceAreaFiles, label: string) =>
  `Moving the source area relocates ${describeFiles(n)} to ${label}. Confirm with this file count and size to go ahead.`;

@Injectable()
export class SourceAreaMoveService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(STORAGE_CONNECTORS) private readonly connectors: StorageConnectorFactory,
    private readonly destinations: DestinationsService,
  ) {}

  /** The current source area with its file count and size (for the confirmation), and the move in progress. */
  async view(): Promise<{ current: ({ id: string; label: string } & SourceAreaFiles) | null; move: SourceAreaMoveProgress | null }> {
    const cur = (await this.pool.query<{ id: string; label: string }>(`SELECT id, label FROM storage_destinations WHERE purpose = 'source_area' AND status = 'approved'`)).rows[0];
    return { current: cur ? { ...cur, ...(await filesAt(this.pool, cur.id)) } : null, move: await sourceAreaMoveProgress(this.pool) };
  }

  /**
   * An Enterprise Administrator moves the source area to a destination added for it (spec 9.3), with a reason and a
   * confirmation stating the file count and size (`confirm: { files, bytes }`, as `view` gives them). The destination
   * must pass its check. It becomes the approved source area at once; the old one is `retiring` until every file has
   * been relocated (one `relocate` job per file).
   */
  async moveSourceArea(user: AuthUser, newDestinationId: unknown, reasonInput: unknown, confirm: unknown) {
    const reason = readReason(reasonInput);
    if (typeof newDestinationId !== 'string' || !UUID.test(newDestinationId)) throw new BadRequestException(NOT_A_SOURCE_AREA);
    const target = (await this.pool.query<{ purpose: string; status: string; label: string }>(`SELECT purpose, status, label FROM storage_destinations WHERE id = $1`, [newDestinationId])).rows[0];
    if (!target) throw new NotFoundException();
    if (target.purpose !== 'source_area') throw new BadRequestException(NOT_A_SOURCE_AREA);
    if (target.status === 'approved') throw new ConflictException(ALREADY_CURRENT);
    if ((await this.pool.query(`SELECT 1 FROM storage_destinations WHERE purpose = 'source_area' AND status = 'retiring'`)).rowCount) throw new ConflictException(MOVE_IN_PROGRESS);
    const current = await approvedSourceArea(this.pool);
    if (!current) throw new ConflictException(NO_SOURCE_AREA);
    const counts = await filesAt(this.pool, current);
    const c = (confirm ?? null) as { files?: unknown; bytes?: unknown } | null;
    if (!c || typeof c !== 'object' || c.files !== counts.files || c.bytes !== counts.bytes) {
      throw new ConflictException({ statusCode: 409, message: confirmMessage(counts, target.label), files: counts.files, bytes: counts.bytes });
    }
    await this.destinations.checkOrConflict(user, newDestinationId);
    const at = this.clock();
    try {
      await withTx(this.pool, async (tx) => {
        // The settings row first, as approving takes it; then the old area, which must still be the approved one.
        await tx.query(`SELECT 1 FROM storage_settings FOR UPDATE`);
        const old = (await tx.query<{ status: string }>(`SELECT status FROM storage_destinations WHERE id = $1 FOR UPDATE`, [current])).rows[0];
        if (!old || old.status !== 'approved') throw new ConflictException(MOVE_IN_PROGRESS);
        // Retiring first: only one source area may be approved at a time.
        await tx.query(`UPDATE storage_destinations SET status = 'retiring' WHERE id = $1`, [current]);
        await this.destinations.recordEvent(tx, current, 'retiring', user.id, at, reason, { movedTo: newDestinationId, files: counts.files, bytes: counts.bytes });
        // Approved as approving does: OneDrive rule, versions still waiting stored straight into it, admin folder sharing.
        await this.destinations.approveIn(tx, newDestinationId, user, at, reason, { replaces: current });
        await writeAudit(tx, {
          at, action: 'storage.source_area_move_started', actorUserId: user.id, subjectType: 'storage_destination', subjectId: newDestinationId,
          detail: { from: current, to: newDestinationId, files: counts.files, bytes: counts.bytes },
        });
        const files = (
          await tx.query<{ id: string }>(
            `SELECT id FROM stored_files WHERE destination_id = $1 AND purpose IN ${SOURCE_PURPOSES} AND state IN ('stored', 'relocating') ORDER BY created_at, id`,
            [current],
          )
        ).rows;
        for (const f of files) await queueStorageJob(tx, 'relocate', f.id);
      });
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new ConflictException(MOVE_IN_PROGRESS);
      throw e;
    }
    await this.ensureAdminFolder(newDestinationId);
    // An empty source area has nothing to move: it is withdrawn at once.
    await completeSourceAreaMoves({ pool: this.pool, clock: this.clock });
    return this.view();
  }

  /**
   * The storage Administrators' access follows to the new area: its folder is made now when anyone is designated (a
   * provider failure is left to the daily source-area access task).
   */
  private async ensureAdminFolder(destinationId: string): Promise<void> {
    if (!(await this.pool.query(`SELECT 1 FROM storage_admins WHERE ended_at IS NULL LIMIT 1`)).rowCount) return;
    try {
      const { connector, dest } = await this.connectors.forDestination(destinationId);
      const folder = await ensureSourceProjectsFolder({ pool: this.pool, clock: this.clock } as StorageDeps, connector, dest);
      await withTx(this.pool, (c) => queueFolderSharing(c, folder.id, 'normal'));
    } catch (e) {
      if (!(e instanceof StorageError) && !(e instanceof StorageWaitingForKey)) throw e;
    }
  }
}
