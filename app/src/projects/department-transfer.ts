import type { Pool, PoolClient } from 'pg';
import { uuidv7 } from '../common/uuid7';
import { checkFile } from '../outputs/checks';
import { recordedFolderPath, withOutputFolderLock } from '../outputs/filing';
import { MAX_NAME, RESTRICTED_SUFFIX, safeName } from '../outputs/naming';
import type { StorageConnector } from '../storage/connector';
import { type StorageDeps, registerStorageFinalFailure, registerStorageHandler } from '../storage/jobs';
import { type DestinationRef, StorageError } from '../storage/types';

/**
 * Owning department transfer (spec 10, D108): the storage side.
 *
 * With "Move the folder", the `transfer-folders` job moves the project's folder and its `(restricted)` folder, in each
 * destination that holds them, into the new department's folder (adopted or created there). Same drive, so each is one
 * provider `move`, which keeps every item id, and the Kainow grants on the folders go with them (permissions belong to
 * the items). Afterwards every stored file under them must still resolve by its item id; only then, in one transaction,
 * are the folder records re-keyed under the new department and each file's path refreshed (with a `stored_file_moves`
 * row). A failure puts back whatever it finds moved, so the records and the files stay at the old place, and the
 * transfer shows "Files not moved — still at <old path>" with Try again once the attempts run out.
 *
 * Folder keys start with the department id (filing.ts): the project's folders are found under `<dept>/<project>` and
 * everything below it (`<dept>/<project>/…`), and all of them are re-keyed together, so every reader of the keys
 * (filing, sharing, renames, withholding, the quarantine registry) keeps finding them.
 */

export const TRANSFER_MOVE_REASON = 'Department transfer';
export const MOVING_LABEL = 'Moving files';
export const notMovedLabel = (oldPath: string): string => `Files not moved — still at ${oldPath}`;
export const keptLabel = (department: string): string => `Kept at its existing location (filed under ${department})`;

/** Same names as filing's other folder clashes: ` (2)`, ` (3)` … before the attempt fails `conflict`. */
const MAX_SUFFIX = 20;

type Db = Pool | PoolClient;

/**
 * The department whose folder a project's latest transfer is still moving files from (state moving or move_failed), or
 * null. While it is, filing into a destination that still holds the project's folders under that department goes on
 * there, so the new file moves with the rest instead of starting a second project folder.
 */
export async function pendingMoveFrom(db: Db, projectId: string): Promise<string | null> {
  const r = (
    await db.query<{ from_department_id: string; folder_choice: string | null; state: string }>(
      `SELECT from_department_id, folder_choice, state FROM project_department_transfers WHERE project_id = $1 ORDER BY at DESC, id DESC LIMIT 1`,
      [projectId],
    )
  ).rows[0];
  return r && r.folder_choice === 'move' && r.state !== 'done' ? r.from_department_id : null;
}

/**
 * The department a filing into `destinationId` goes under: the owning department, or the department a pending move is
 * still moving the project's folders from while this destination still holds them there (see `pendingMoveFrom`). The
 * caller holds the destination's and project's folder lock, which the move job also holds, so the answer stays true
 * while it creates folders.
 */
export async function filingDepartment(db: Db, destinationId: string, projectId: string, owningDepartmentId: string): Promise<string> {
  const from = await pendingMoveFrom(db, projectId);
  if (!from || from === owningDepartmentId) return owningDepartmentId;
  const left = await db.query(
    `SELECT 1 FROM storage_folders WHERE destination_id = $1 AND level IN ('project', 'restricted_root') AND key IN ($2, $3)`,
    [destinationId, `${from}/${projectId}`, `${from}/${projectId}/restricted`],
  );
  return left.rowCount ? from : owningDepartmentId;
}

/** The roots of the project's folders (project folder and `(restricted)` folder) under `departmentId`. */
interface Root { id: string; destination_id: string; level: 'project' | 'restricted_root'; key: string; item_id: string; name: string }

const rootsUnder = async (db: Db, projectId: string, departmentId: string, destinationId?: string): Promise<Root[]> =>
  (
    await db.query<Root>(
      `SELECT id, destination_id, level, key, item_id, name FROM storage_folders
        WHERE level IN ('project', 'restricted_root') AND split_part(key, '/', 2) = $1::text AND split_part(key, '/', 1) = $2::text
          AND ($3::uuid IS NULL OR destination_id = $3)
        ORDER BY destination_id, level, id`,
      [projectId, departmentId, destinationId ?? null],
    )
  ).rows;

/** A root's key under another department: `<dept>/<project>[/restricted]` → `<to>/<project>[/restricted]`. */
const rekeyed = (key: string, to: string): string => `${to}${key.slice(key.indexOf('/'))}`;

/**
 * Whether moving the project's folders from `from` to `to` would meet a folder Kainow already keeps there for the
 * project (an earlier "Keep it where it is" and a later move back): the two cannot be merged, so the move is refused.
 */
export async function moveClashes(db: Db, projectId: string, from: string, to: string): Promise<boolean> {
  for (const r of await rootsUnder(db, projectId, from)) {
    const there = await db.query(`SELECT 1 FROM storage_folders WHERE destination_id = $1 AND level = $2 AND key = $3`, [r.destination_id, r.level, rekeyed(r.key, to)]);
    if (there.rowCount) return true;
  }
  return false;
}

/**
 * Where the project's folders still are for a transfer that has not moved them: the recorded path of each project
 * folder (or `(restricted)` folder, where there is no project folder) under the department moved from, one per
 * destination, joined with "; ".
 */
export async function oldPlaces(db: Db, projectId: string, fromDepartmentId: string): Promise<string> {
  const roots = await rootsUnder(db, projectId, fromDepartmentId);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of roots) {
    if (seen.has(r.destination_id)) continue;
    const pick = roots.find((x) => x.destination_id === r.destination_id && x.level === 'project') ?? r;
    seen.add(r.destination_id);
    const path = await recordedFolderPath(db, pick.id);
    if (path) out.push(path.join('/'));
  }
  return out.join('; ');
}

// ---------------------------------------------------------------------------------------------------------------------
// The transfer-folders job
// ---------------------------------------------------------------------------------------------------------------------

interface TransferRow { id: string; project_id: string; from_department_id: string; to_department_id: string; state: string; actor_id: string }

/** The `transfer-folders` job: every destination holding the project's folders elsewhere, then the transfer is done. */
export async function transferFolders(deps: StorageDeps, transferId: string): Promise<void> {
  const t = (
    await deps.pool.query<TransferRow>(`SELECT id, project_id, from_department_id, to_department_id, state, actor_id FROM project_department_transfers WHERE id = $1`, [transferId])
  ).rows[0];
  if (!t || t.state !== 'moving') return;
  const destinations = [...new Set((await rootsUnder(deps.pool, t.project_id, t.from_department_id)).map((r) => r.destination_id))];
  for (const d of destinations) await moveInDestination(deps, t, d);
  await deps.pool.query(`UPDATE project_department_transfers SET state = 'done' WHERE id = $1 AND state = 'moving'`, [transferId]);
}

/** After the last attempt (or a code never retried): the files stay where they are and the transfer offers Try again. */
export async function markTransferFailed(deps: StorageDeps, transferId: string): Promise<void> {
  await deps.pool.query(`UPDATE project_department_transfers SET state = 'move_failed' WHERE id = $1 AND state = 'moving'`, [transferId]);
}

interface Moved { root: Root; name: string }

async function moveInDestination(deps: StorageDeps, t: TransferRow, destinationId: string): Promise<void> {
  const { connector, dest } = await deps.connectors.forDestination(destinationId);
  await withOutputFolderLock(deps, destinationId, t.project_id, async () => {
    const roots = await rootsUnder(deps.pool, t.project_id, t.from_department_id, destinationId);
    if (roots.length === 0) return;
    for (const r of roots) {
      const there = await deps.pool.query(`SELECT 1 FROM storage_folders WHERE destination_id = $1 AND level = $2 AND key = $3`, [destinationId, r.level, rekeyed(r.key, t.to_department_id)]);
      if (there.rowCount) throw new StorageError('conflict');
    }
    // The project and (restricted) folders sit directly in the department folder they were created in.
    const oldParent = await recordedItem(deps.pool, destinationId, 'department', t.from_department_id);
    if (!oldParent) throw new StorageError('not_found');
    const target = await departmentFolder(deps, connector, dest, t.to_department_id);

    const moved: Moved[] = [];
    try {
      for (const r of roots) {
        // Where the folder is now, before any move: one moved by an earlier attempt whose answer was lost (and not put
        // back) is found where it went and never moved or made again.
        const here = await connector.getItem(dest, r.item_id);
        moved.push({ root: r, name: here.parentId === target ? here.name : await moveFolder(connector, dest, r, target) });
      }
      // The folders are where they were sent, and every file in them still resolves with its recorded content.
      for (const r of roots) if ((await connector.getItem(dest, r.item_id)).parentId !== target) throw new StorageError('server');
      await verifyFiles(deps, connector, dest, await filesUnder(deps.pool, destinationId, t));
      await switchRecords(deps, t, destinationId, moved);
    } catch (err) {
      await putBack(deps, t.id, connector, dest, roots, oldParent, target);
      throw err;
    }
  });
}

const recordedItem = async (db: Db, destinationId: string, level: string, key: string): Promise<string | null> =>
  (await db.query<{ item_id: string }>(`SELECT item_id FROM storage_folders WHERE destination_id = $1 AND level = $2 AND key = $3`, [destinationId, level, key])).rows[0]?.item_id ?? null;

/** The new department's folder: the one recorded, else adopted or created by name and recorded (as filing does). */
async function departmentFolder(deps: StorageDeps, connector: StorageConnector, dest: DestinationRef, departmentId: string): Promise<string> {
  const known = await recordedItem(deps.pool, dest.id, 'department', departmentId);
  if (known) return known;
  const name = (await deps.pool.query<{ name: string }>(`SELECT name FROM departments WHERE id = $1`, [departmentId])).rows[0]?.name;
  if (!name) throw new Error('department not found');
  const made = await connector.ensureFolder(dest, null, safeName(name));
  await deps.pool.query(
    `INSERT INTO storage_folders (id, destination_id, level, key, item_id, name, created_at) VALUES ($1, $2, 'department', $3, $4, $5, $6)
     ON CONFLICT (destination_id, level, key) DO NOTHING`,
    [uuidv7(), dest.id, departmentId, made.itemId, made.name, deps.clock()],
  );
  return (await recordedItem(deps.pool, dest.id, 'department', departmentId)) as string;
}

/** The name a moved root takes when its own is taken in the new department's folder: ` (2)`, ` (3)` …, as filing names them. */
function clashName(r: Root, n: number): string {
  if (n === 1) return r.name;
  const tail = ` (${n})`;
  if (r.level === 'restricted_root') {
    const base = r.name.endsWith(RESTRICTED_SUFFIX) ? r.name.slice(0, -RESTRICTED_SUFFIX.length) : r.name;
    return `${safeName(base, MAX_NAME - RESTRICTED_SUFFIX.length - tail.length)}${tail}${RESTRICTED_SUFFIX}`;
  }
  return `${safeName(r.name, MAX_NAME - tail.length)}${tail}`;
}

/** One provider move into the new department's folder; a name taken there gets ` (2)`, ` (3)` …. Returns the name given. */
async function moveFolder(connector: StorageConnector, dest: DestinationRef, r: Root, target: string): Promise<string> {
  for (let n = 1; n <= MAX_SUFFIX; n++) {
    const name = clashName(r, n);
    try {
      await connector.move(dest, r.item_id, target, name);
      return name;
    } catch (err) {
      if (!(err instanceof StorageError && err.code === 'conflict')) throw err;
    }
  }
  throw new StorageError('conflict');
}

/**
 * After a failed attempt, best effort: any of the roots found in the new department's folder (moved by this attempt,
 * or by a move whose answer was lost) goes back where the records say it is, under its recorded name, so nothing is
 * anywhere but its old path while the transfer is not done. One that cannot be put back is found by the next attempt.
 */
async function putBack(
  deps: StorageDeps, transferId: string, connector: StorageConnector, dest: DestinationRef, roots: Root[], oldParent: string, target: string,
): Promise<void> {
  for (const r of [...roots].reverse()) {
    try {
      const here = await connector.getItem(dest, r.item_id);
      if (here.parentId === target) await connector.move(dest, r.item_id, oldParent, r.name);
    } catch {
      (deps.log ?? ((x) => console.warn(x)))(
        `A project folder moved for department transfer ${transferId}, which did not complete, could not be put back; the next attempt finds it.`,
      );
    }
  }
}

interface FileRow {
  id: string; item_id: string; drive_id: string; name: string; path: string | null; folder_id: string;
  size_bytes: string | null; provider_hash: string | null; skip: boolean;
}

/** Every stored output file recorded in a folder of the project's tree under the department moved from (`<dept>/<project>/…`). */
async function filesUnder(db: Db, destinationId: string, t: TransferRow): Promise<FileRow[]> {
  return (
    await db.query<FileRow>(
      `SELECT f.id, f.item_id, f.drive_id, f.name, f.path, f.folder_id, f.size_bytes, f.provider_hash,
              (f.state = 'missing' OR f.check_status = 'missing') AS skip
         FROM stored_files f JOIN storage_folders sf ON sf.id = f.folder_id
        WHERE f.purpose = 'output' AND f.destination_id = $1 AND sf.destination_id = $1 AND f.item_id IS NOT NULL AND f.removed_at IS NULL
          AND f.state IN ('stored', 'relocating', 'withheld', 'missing')
          AND starts_with(sf.key, $2 || '/')
        ORDER BY f.id`,
      [destinationId, `${t.from_department_id}/${t.project_id}`],
    )
  ).rows;
}

/**
 * Every file still resolves by its item id after the move, with its recorded size and provider hash (when both are
 * known), as a relocation verifies (spec 9.4: verified before the reference changes). A file that no longer resolves
 * was gone before the move (a folder move takes everything in it): it is flagged Missing as the check routine flags it
 * (check status, time, output event and notice) and does not hold the move up; its path is refreshed all the same. A
 * file already known to be Missing is not looked up.
 */
async function verifyFiles(deps: StorageDeps, connector: StorageConnector, dest: DestinationRef, files: FileRow[]): Promise<void> {
  for (const f of files) {
    if (f.skip) continue;
    let it;
    try {
      it = await connector.getItem(dest, f.item_id);
    } catch (err) {
      if (!(err instanceof StorageError && err.code === 'not_found')) throw err;
      await checkFile(deps, f.id);
      continue;
    }
    const sizeDiffers = f.size_bytes !== null && it.size !== Number(f.size_bytes);
    const hashDiffers = !!f.provider_hash && !!it.providerHash && it.providerHash !== f.provider_hash;
    if (it.itemId !== f.item_id || sizeDiffers || hashDiffers) throw new StorageError('server');
  }
}

/** One transaction: the folder records are re-keyed under the new department, and every file's path refreshed with a move row. */
async function switchRecords(deps: StorageDeps, t: TransferRow, destinationId: string, moved: Moved[]): Promise<void> {
  const c = await deps.pool.connect();
  try {
    await c.query('BEGIN');
    const files = await filesUnder(c, destinationId, t);
    const before = new Map(files.map((f) => [f.id, f.path]));
    for (const m of moved) if (m.name !== m.root.name) await c.query(`UPDATE storage_folders SET name = $2 WHERE id = $1`, [m.root.id, m.name]);
    const p = `${t.from_department_id}/${t.project_id}`;
    await c.query(
      `UPDATE storage_folders SET key = $3 || substr(key, $4)
        WHERE destination_id = $1 AND level <> 'department' AND (key = $2 OR starts_with(key, $2 || '/'))`,
      [destinationId, p, t.to_department_id, t.from_department_id.length + 1],
    );
    const at = deps.clock();
    for (const f of files) {
      const folderPath = await recordedFolderPath(c, f.folder_id);
      if (!folderPath) throw new Error('folder record missing');
      const path = [...folderPath, f.name].join('/');
      if (path === before.get(f.id)) continue;
      await c.query(`UPDATE stored_files SET path = $2 WHERE id = $1`, [f.id, path]);
      await c.query(
        `INSERT INTO stored_file_moves (id, stored_file_id, reason, old_destination_id, old_drive_id, old_item_id, old_path,
                                        new_destination_id, new_drive_id, new_item_id, new_path, actor_id, at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $4, $5, $6, $8, $9, $10)`,
        [uuidv7(at.getTime()), f.id, TRANSFER_MOVE_REASON, destinationId, f.drive_id, f.item_id, before.get(f.id), path, t.actor_id, at],
      );
    }
    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

registerStorageHandler('transfer-folders', (deps, transferId) => transferFolders(deps, transferId));
registerStorageFinalFailure('transfer-folders', (deps, transferId) => markTransferFailed(deps, transferId));
