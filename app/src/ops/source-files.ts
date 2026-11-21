/**
 * The protected source area in operations (sub-project 9's managed source files):
 *
 *   - the backup's source part (spec 5.4): every source file in sub-project 9's settled `stored` state is copied once per
 *     SHA-256 into the shared file store `files/<2>/<sha>.enc`, encrypted with the backup key; the manifest lists every
 *     stored source file the database refers to, copied or not;
 *   - the drill's source-file check (spec 8.1 step 6);
 *   - the `source_area` storage reading (spec 7.1);
 *   - `restore-source-files` (spec 8.2 step 6): re-uploads stored source files that are Missing at their recorded place
 *     from the file store into the approved source area, and lists those the store does not hold.
 *
 * Output and stored text are fixed: counts and ids only, never a path, a name, file content, a key or provider text.
 *
 * Key changes: a file in the store is used only when its KNBK1 header carries the current backup key's id; one made with
 * an earlier key is copied again (and replaced) by the next backup, so a set never lists a file it cannot decrypt.
 * Sets made with the earlier key then lose that file (it now needs the new key): see INSTALL.md, "Changing the backup key".
 */
import { createHash } from 'node:crypto';
import { closeSync, createReadStream, createWriteStream, existsSync, openSync, readSync, statSync } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Pool, PoolClient } from 'pg';
import { writeAudit } from '../audit/audit';
import { uuidv7 } from '../common/uuid7';
import type { StorageConnector } from '../storage/connector';
import type { StorageConnectorFactory } from '../storage/connector-factory';
import type { StorageDeps } from '../storage/jobs';
import { put, versionFolder } from '../storage/sources';
import { type DestinationRef, StorageError, type StoredRef } from '../storage/types';
import { OPS_FAILURES, withBackupLock } from './common';
import type { OpsConfig } from './config';
import { type BackupKey, decryptStream, encryptStream, loadBackupKey, sha256Stream } from './crypto';
import type {
  Manifest,
  SourceCopyOptions,
  SourceCopyResult,
  SourceFileCopier,
  SourceFileEntry,
  SourceFileRow,
  SourceListing,
} from './manifest';
import type { Check } from './sealed-checks';

type Db = Pick<Pool | PoolClient, 'query'>;

const SOURCE_PURPOSES = `('source_original', 'source_text')`;

/** R27: the copy phase ends this long after the run started; files not reached are copied by the next run. */
export const COPY_BUDGET_MS = 4 * 3_600_000;

export const SOURCE_TEXT = {
  flagged: (n: number) => `${n} source files already flagged in storage were not copied.`,
  moving: (n: number) => `${n} source files being moved in storage were not copied; the next backup copies them.`,
  notReached: (n: number) => `${n} source files were not reached within the 4-hour copy time; the next backup copies them.`,
  failed: (n: number) => `${OPS_FAILURES.source_files_failed} Not copied: ${n}.`,
} as const;

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

/** `files/ab/abcd…ef.enc`. */
export function storePath(filesDir: string, sha: string): string {
  return join(filesDir, sha.slice(0, 2), `${sha}.enc`);
}

const MAGIC = 'KNBK1';
const HEADER = MAGIC.length + 16;

/** The backup key id in a store file's header, or null when it cannot be read (missing, short, not KNBK1). */
export function storeFileKeyId(path: string): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(HEADER);
    if (readSync(fd, buf, 0, HEADER, 0) !== HEADER) return null;
    if (buf.subarray(0, MAGIC.length).toString('latin1') !== MAGIC) return null;
    return buf.subarray(MAGIC.length).toString('latin1');
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/**
 * Whether the source area is in use: a source area is approved (or being moved away from), or a source file is in it.
 * Until then uploaded originals travel in the database part and the manifest says "Source area: not in use".
 */
export async function sourceAreaInUse(db: Db): Promise<boolean> {
  const r = await db.query(
    `SELECT EXISTS (SELECT 1 FROM storage_destinations WHERE purpose = 'source_area' AND status IN ('approved', 'retiring'))
         OR EXISTS (SELECT 1 FROM stored_files WHERE purpose IN ${SOURCE_PURPOSES} AND state IN ('stored', 'relocating', 'missing')) AS used`,
  );
  return r.rows[0].used as boolean;
}

/**
 * The stored source files the database refers to: in storage (`stored`), being moved (`relocating`) or flagged Missing.
 * Files waiting to be stored, failed or withheld still have their content in the database (original bytes, text, or the
 * encrypted quarantine original), so the dump holds them.
 */
export async function listSourceFiles(db: Db): Promise<SourceListing> {
  if (!(await sourceAreaInUse(db))) return { inUse: false, files: [] };
  const { rows } = await db.query(
    `SELECT id, sha256, size_bytes, destination_id, item_id, state, check_status FROM stored_files
      WHERE purpose IN ${SOURCE_PURPOSES} AND state IN ('stored', 'relocating', 'missing') AND sha256 IS NOT NULL
      ORDER BY created_at, id`,
  );
  return {
    inUse: true,
    files: (rows as Array<Record<string, unknown>>).map((r) => ({
      id: r.id as string,
      sha256: r.sha256 as string,
      size: r.size_bytes === null ? null : Number(r.size_bytes),
      destinationId: r.destination_id as string | null,
      itemId: r.item_id as string | null,
      state: r.state as string,
      checkStatus: r.check_status as string,
    })),
  };
}

const isFlagged = (f: SourceFileRow): boolean => f.state === 'missing' || f.checkStatus === 'changed' || f.checkStatus === 'missing';

/** Encrypts `plain` into the store under its SHA-256: a temporary name, read back and checked, then renamed. */
async function writeStoreFile(filesDir: string, sha: string, plain: Buffer, key: BackupKey, runId: string): Promise<number> {
  const final = storePath(filesDir, sha);
  await mkdir(join(filesDir, sha.slice(0, 2)), { recursive: true });
  const tmp = `${final}.tmp-${runId}`;
  try {
    const enc = sha256Stream();
    await pipeline(Readable.from([plain]), encryptStream(key), enc, createWriteStream(tmp, { flags: 'w' }));
    // Read back (spec 5.5): the file as written decrypts to exactly the source file.
    const back = sha256Stream();
    const encBack = sha256Stream();
    await pipeline(createReadStream(tmp), encBack, decryptStream(key), back, discard());
    if (back.digest() !== sha || encBack.digest() !== enc.digest()) throw new StoreReadBackError();
    const bytes = statSync(tmp).size;
    await rename(tmp, final);
    return bytes;
  } finally {
    await rm(tmp, { force: true }).catch(() => undefined);
  }
}

class StoreReadBackError extends Error {
  constructor() {
    super('A source file did not read back as written.');
    this.name = 'StoreReadBackError';
  }
}

const discard = (): Writable =>
  new Writable({
    write(_c, _e, cb) {
      cb();
    },
  });

/** The backup's source copier: sub-project 9's connectors (built with the protected key) read each file. */
export class StoredSourceFiles implements SourceFileCopier {
  constructor(
    private readonly connectors: StorageConnectorFactory,
    readonly protectedKeyPresent: boolean,
  ) {}

  list(db: Db): Promise<SourceListing> {
    return listSourceFiles(db);
  }

  async copyAll(listing: SourceListing, key: BackupKey, filesDir: string, opts: SourceCopyOptions): Promise<SourceCopyResult> {
    const result: SourceCopyResult = { files: [], newFiles: 0, newBytes: 0, failed: 0, flagged: 0, moving: 0, notReached: 0 };
    /** Per SHA-256, whether the store now holds it under the current key (true) or this run failed to copy it (false). */
    const held = new Map<string, boolean>();
    const connectors = new Map<string, Promise<{ connector: StorageConnector; dest: DestinationRef }>>();
    const connectorFor = (id: string) => {
      let c = connectors.get(id);
      if (!c) {
        c = this.connectors.forDestination(id);
        c.catch(() => undefined); // read (and counted) by each file that needs it
        connectors.set(id, c);
      }
      return c;
    };
    const entry = (f: SourceFileRow, copied: boolean, reason?: SourceFileEntry['reason']): SourceFileEntry => ({
      sha256: f.sha256 as string,
      size: f.size ?? 0,
      storedFileId: f.id,
      copied,
      ...(reason ? { reason } : {}),
    });

    for (const f of listing.files) {
      const sha = f.sha256 as string;
      if (!held.has(sha) && storeFileKeyId(storePath(filesDir, sha)) === key.id) held.set(sha, true);
      if (held.get(sha) === true) {
        result.files.push(entry(f, true));
        continue;
      }
      if (isFlagged(f)) {
        result.flagged++;
        result.files.push(entry(f, false, 'flagged'));
        continue;
      }
      if (f.state !== 'stored') {
        result.moving++;
        result.files.push(entry(f, false, 'moving'));
        continue;
      }
      if (held.get(sha) === false) {
        result.failed++;
        result.files.push(entry(f, false, 'failed'));
        continue;
      }
      if (opts.now().getTime() >= opts.deadline.getTime()) {
        result.notReached++;
        result.files.push(entry(f, false, 'not_reached'));
        continue;
      }
      // Download through sub-project 9's connector and check the content against the record.
      let plain: Buffer | null = null;
      try {
        if (!f.destinationId || !f.itemId) throw new StorageError('invalid');
        const { connector, dest } = await connectorFor(f.destinationId);
        const bytes = await connector.download(dest, f.itemId);
        if (sha256(bytes) === sha && (f.size === null || bytes.length === f.size)) plain = bytes;
      } catch {
        plain = null; // Missing, changed, access denied, unreachable, or the connection cannot be opened
      }
      if (!plain) {
        held.set(sha, false);
        result.failed++;
        result.files.push(entry(f, false, 'failed'));
        continue;
      }
      opts.beforeWrite?.();
      try {
        result.newBytes += await writeStoreFile(filesDir, sha, plain, key, opts.runId);
      } catch (err) {
        if (err instanceof StoreReadBackError) throw new SourceReadBackError();
        throw err;
      } finally {
        plain.fill(0);
      }
      result.newFiles++;
      held.set(sha, true);
      result.files.push(entry(f, true));
    }
    return result;
  }
}

/** A newly written store file did not read back as written: the backup fails verify_failed. */
export class SourceReadBackError extends Error {
  constructor() {
    super(OPS_FAILURES.verify_failed);
    this.name = 'SourceReadBackError';
  }
}

/** The output lines for a successful run's files not copied (never a failure). */
export function notCopiedNotes(r: Pick<SourceCopyResult, 'flagged' | 'moving' | 'notReached'>): string[] {
  const lines: string[] = [];
  if (r.flagged > 0) lines.push(SOURCE_TEXT.flagged(r.flagged));
  if (r.moving > 0) lines.push(SOURCE_TEXT.moving(r.moving));
  if (r.notReached > 0) lines.push(SOURCE_TEXT.notReached(r.notReached));
  return lines;
}

// ---------------------------------------------------------------------------------------------------------------------
// The drill (spec 8.1 step 6)
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Decrypts each copied file the manifest lists from the store and checks its SHA-256 (each SHA-256 once). All of them,
 * unless `sample` is given ("Sampled n of m"; a sampled drill does not count for go-live). Files the backup itself listed
 * as not copied are named in the detail; they do not fail the drill (the backup already reported them).
 */
export async function checkSourceFiles(manifest: Manifest, filesDir: string, key: BackupKey, sample?: number): Promise<Check> {
  const copied = [...new Set(manifest.sourceFiles.filter((f) => f.copied).map((f) => f.sha256))];
  const notCopied = manifest.sourceFiles.filter((f) => !f.copied).length;
  let pick = copied;
  if (sample !== undefined && sample < copied.length) pick = [...copied].sort(() => Math.random() - 0.5).slice(0, sample);
  let bad = 0;
  for (const sha of pick) {
    const plain = sha256Stream();
    try {
      await pipeline(createReadStream(storePath(filesDir, sha)), decryptStream(key), plain, discard());
      if (plain.digest() !== sha) bad++;
    } catch {
      bad++; // missing, damaged, or made with another key: the file does not count
    }
  }
  const scope = sample !== undefined ? `Sampled ${pick.length} of ${copied.length} files.` : `${pick.length} files checked.`;
  const listed = notCopied > 0 ? ` ${notCopied} listed files were not copied by the backup.` : '';
  if (bad > 0) return { name: 'source_files', result: 'failed', detail: `${scope} ${bad} did not match.${listed}` };
  return { name: 'source_files', result: 'passed', detail: `${scope}${listed}` };
}

// ---------------------------------------------------------------------------------------------------------------------
// The storage reading (spec 7.1)
// ---------------------------------------------------------------------------------------------------------------------

export interface SourceAreaReading {
  /** The total size of the stored source files (sub-project 9's `stored_files`). */
  storedBytes: number;
  files: number;
  /** As the Storage page gets them: from the source area's last destination check; null is "Unavailable". */
  usedBytes: number | null;
  quotaBytes: number | null;
}

/** The approved source area's reading, or null when the source area is not in use. Database only; no provider call. */
export async function sourceAreaReading(db: Db): Promise<SourceAreaReading | null> {
  if (!(await sourceAreaInUse(db))) return null;
  const area = (
    await db.query(`SELECT id, last_check FROM storage_destinations WHERE purpose = 'source_area' AND status = 'approved' ORDER BY created_at, id LIMIT 1`)
  ).rows[0] as { id: string; last_check: { quotaBytes?: unknown; usedBytes?: unknown } | null } | undefined;
  const totals = (
    await db.query(
      `SELECT count(*)::int AS files, COALESCE(sum(size_bytes), 0)::text AS bytes FROM stored_files
        WHERE purpose IN ${SOURCE_PURPOSES} AND state IN ('stored', 'relocating')`,
    )
  ).rows[0] as { files: number; bytes: string };
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
  const quota = num(area?.last_check?.quotaBytes);
  return {
    storedBytes: Number(totals.bytes),
    files: totals.files,
    // Never zero for "not known" (A17): a quota of 0 or none reads as Unavailable.
    quotaBytes: quota && quota > 0 ? quota : null,
    usedBytes: num(area?.last_check?.usedBytes),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// restore-source-files (spec 8.2 step 6)
// ---------------------------------------------------------------------------------------------------------------------

export interface RestoreSourceFilesDeps {
  pool: Pool;
  config: OpsConfig;
  /** Sub-project 9's storage dependencies (connectors built with the protected key). */
  storage: StorageDeps;
  now(): Date;
  out(line: string): void;
  err(line: string): void;
}

export const RESTORE_SOURCE_TEXT = {
  usage: 'Usage: npm run restore-source-files',
  busy: 'Another backup, drill or restore is running',
  noArea: 'There is no approved source area to put the files back into. Approve one on the Storage page first.',
  areaUnreachable: 'The source area cannot be reached right now, so nothing was put back.',
  notInStore: (id: string) => `Not in the backup folder: stored file ${id}`,
  notPut: (id: string) => `Could not be put back: stored file ${id}`,
  unchecked: (n: number) => `${n} stored source files could not be checked this time; run the command again later.`,
  summary: (checked: number, missing: number, restored: number) =>
    `Checked ${checked} stored source files: ${missing} missing, ${restored} put back from the backup folder.`,
  noneMissing: 'No stored source file is missing.',
} as const;

const RESTORED_REASON = 'Restored from backup';

interface RestoreRow {
  id: string; project_id: string; destination_id: string | null; drive_id: string | null; item_id: string | null; path: string | null;
  name: string; size_bytes: string | null; sha256: string | null; state: string; check_status: string;
}

/**
 * Re-uploads every stored source file that is Missing at its recorded place (flagged Missing, or its item is gone) from
 * the file store into the approved source area, at its `projects/<project>/sources/<source>/v<n>` place (as the
 * relocation routine places a file), checks it, and switches the reference with the old one recorded in
 * `stored_file_moves`, as the relocation routine does. Files the store does not hold (or holds under another backup key,
 * or damaged) are listed by stored-file id. Exit 0 when every missing file was put back, 1 otherwise, 2 usage.
 */
export async function runRestoreSourceFiles(argv: string[], deps: RestoreSourceFilesDeps): Promise<number> {
  if (argv.length > 0) {
    deps.err(RESTORE_SOURCE_TEXT.usage);
    return 2;
  }
  const loaded = loadBackupKey(deps.config.backupKeyFile);
  if ('error' in loaded) {
    deps.err(OPS_FAILURES[loaded.error]);
    return 1;
  }
  try {
    const result = await withBackupLock(deps.pool, () => restoreLocked(deps, loaded));
    if (result === 'busy') {
      deps.err(RESTORE_SOURCE_TEXT.busy);
      return 1;
    }
    return result;
  } catch {
    deps.err(OPS_FAILURES.database_unreachable);
    return 1;
  }
}

async function restoreLocked(deps: RestoreSourceFilesDeps, key: BackupKey): Promise<number> {
  const { pool } = deps;
  const filesDir = join(deps.config.backupDir, 'kainow', 'files');
  const area = (
    await pool.query(`SELECT id FROM storage_destinations WHERE purpose = 'source_area' AND status = 'approved'`)
  ).rows[0] as { id: string } | undefined;
  if (!area) {
    deps.err(RESTORE_SOURCE_TEXT.noArea);
    return 1;
  }
  let target: { connector: StorageConnector; dest: DestinationRef };
  try {
    target = await deps.storage.connectors.forDestination(area.id);
  } catch {
    deps.err(RESTORE_SOURCE_TEXT.areaUnreachable);
    return 1;
  }
  const { rows } = await pool.query(
    `SELECT id, project_id, destination_id, drive_id, item_id, path, name, size_bytes, sha256, state, check_status FROM stored_files
      WHERE purpose IN ${SOURCE_PURPOSES} AND (state IN ('stored', 'missing')) AND check_status <> 'changed'
      ORDER BY created_at, id`,
  );
  const connectors = new Map<string, Promise<{ connector: StorageConnector; dest: DestinationRef }>>();
  let checked = 0;
  let missing = 0;
  let restored = 0;
  let unchecked = 0;
  const notInStore: string[] = [];
  const notPut: string[] = [];
  for (const f of rows as RestoreRow[]) {
    // Missing at its recorded place: flagged so, or its item is gone (a lost source area is not flagged yet).
    let gone = f.state === 'missing' || f.check_status === 'missing' || !f.destination_id || !f.item_id;
    if (!gone) {
      try {
        let c = connectors.get(f.destination_id as string);
        if (!c) {
          c = deps.storage.connectors.forDestination(f.destination_id as string);
          connectors.set(f.destination_id as string, c);
        }
        const { connector, dest } = await c;
        await connector.getItem(dest, f.item_id as string);
      } catch (err) {
        if (err instanceof StorageError && err.code === 'not_found') gone = true;
        else {
          unchecked++;
          continue;
        }
      }
    }
    checked++;
    if (!gone) continue;
    missing++;
    const sha = f.sha256;
    const plain = sha ? await readStoreFile(filesDir, sha, key) : null;
    if (!plain) {
      notInStore.push(f.id);
      continue;
    }
    try {
      await putBack(deps, f, plain, target);
      restored++;
    } catch {
      notPut.push(f.id);
    } finally {
      plain.fill(0);
    }
  }
  for (const id of notInStore) deps.out(RESTORE_SOURCE_TEXT.notInStore(id));
  for (const id of notPut) deps.out(RESTORE_SOURCE_TEXT.notPut(id));
  if (unchecked > 0) deps.err(RESTORE_SOURCE_TEXT.unchecked(unchecked));
  deps.out(missing === 0 ? RESTORE_SOURCE_TEXT.noneMissing : RESTORE_SOURCE_TEXT.summary(checked, missing, restored));
  try {
    await writeAudit(pool, {
      at: deps.now(),
      action: 'ops.source_files_restored',
      subjectType: 'storage_destination',
      subjectId: area.id,
      detail: { checked, missing, restored, notInStore: notInStore.length, notPut: notPut.length, unchecked },
    });
  } catch {
    deps.err('The result could not be recorded in the database.');
  }
  return notInStore.length + notPut.length + unchecked === 0 ? 0 : 1;
}

/** The decrypted store file, only when it is there under this key and its content has the recorded SHA-256. */
async function readStoreFile(filesDir: string, sha: string, key: BackupKey): Promise<Buffer | null> {
  const path = storePath(filesDir, sha);
  if (!existsSync(path) || storeFileKeyId(path) !== key.id) return null;
  const parts: Buffer[] = [];
  try {
    await pipeline(
      createReadStream(path),
      decryptStream(key),
      new Writable({
        write(chunk: Buffer, _e, cb) {
          parts.push(chunk);
          cb();
        },
      }),
    );
  } catch {
    return null;
  }
  const plain = Buffer.concat(parts);
  for (const p of parts) p.fill(0);
  if (sha256(plain) !== sha) {
    plain.fill(0);
    return null;
  }
  return plain;
}

/** Uploads the file to its version's place in the approved source area (verified), then switches the reference. */
async function putBack(
  deps: RestoreSourceFilesDeps, f: RestoreRow, plain: Buffer, target: { connector: StorageConnector; dest: DestinationRef },
): Promise<void> {
  const v = (
    await deps.pool.query(
      `SELECT source_id, version_no FROM source_versions WHERE original_stored_file_id = $1 OR text_stored_file_id = $1 ORDER BY version_no, id LIMIT 1`,
      [f.id],
    )
  ).rows[0] as { source_id: string; version_no: number } | undefined;
  if (!v) throw new StorageError('invalid');
  const folderId = await versionFolder(deps.storage, target.connector, target.dest, { project_id: f.project_id, source_id: v.source_id, version_no: v.version_no });
  const ref: StoredRef = await put(target.connector, target.dest, folderId, f.name, plain);
  const at = deps.now();
  const c = await deps.pool.connect();
  try {
    await c.query('BEGIN');
    const now = (
      await c.query(`SELECT state, item_id, destination_id FROM stored_files WHERE id = $1 FOR UPDATE`, [f.id])
    ).rows[0] as { state: string; item_id: string | null; destination_id: string | null } | undefined;
    // Changed meanwhile (withheld, relocated, re-stored): the new copy is not adopted.
    if (!now || now.state !== f.state || now.item_id !== f.item_id || now.destination_id !== f.destination_id) {
      throw new StorageError('conflict');
    }
    const moveId = uuidv7(at.getTime());
    await c.query(
      `INSERT INTO stored_file_moves (id, stored_file_id, reason, old_destination_id, old_drive_id, old_item_id, old_path,
                                      new_destination_id, new_drive_id, new_item_id, new_path, actor_id, at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NULL, $12)`,
      [moveId, f.id, RESTORED_REASON, f.destination_id, f.drive_id, f.item_id, f.path, target.dest.id, target.dest.driveId, ref.itemId, ref.path, at],
    );
    // check_status 'ok': the new item was verified against the bytes just now (size and QuickXorHash), whose SHA-256 is
    // the recorded one. The old copy is gone, so there is nothing to remove (old_copy_move_id stays empty).
    await c.query(
      `UPDATE stored_files SET state = 'stored', destination_id = $2, connector = $3, drive_id = $4, item_id = $5, path = $6, name = $7,
              provider_hash = $8, etag = $9, ctag = $10, web_url = $11, check_status = 'ok', last_checked_at = $12, failure_code = NULL,
              folder_id = NULL, upload_destination_id = $2, upload_folder_id = $13, upload_name = $7, size_bytes = $14
        WHERE id = $1`,
      [f.id, target.dest.id, target.dest.connector, target.dest.driveId, ref.itemId, ref.path, ref.name, ref.providerHash, ref.etag, ref.ctag, ref.webUrl, at, folderId, ref.size],
    );
    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    // The uploaded copy stands for nothing: removed again (best effort), so there are never two authoritative copies.
    await target.connector.removePermanently(target.dest, ref.itemId).catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}
