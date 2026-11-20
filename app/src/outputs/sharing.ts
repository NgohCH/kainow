import type { Pool, PoolClient } from 'pg';
import { uuidv7 } from '../common/uuid7';
import type { StorageConnector } from '../storage/connector';
import { type StorageDeps, registerStorageDailyTask, registerStorageFinalFailure, registerStorageHandler } from '../storage/jobs';
import { type DestinationRef, type PermissionInfo, StorageError, type StoredRef } from '../storage/types';
import { type OutputFolder, ensureOutputFolder, moveNamed } from './filing';
import { contentReaderContexts, isWholeProject, outputReaders } from './readers';
import { queueFolderSharing, queueOutputPlacement } from './sharing-queue';

export { queueFolderSharing, queueOutputPlacement, queueProjectSharing, queueUserSharing } from './sharing-queue';

/**
 * SharePoint sharing kept in step with Kainow (spec 5.5, D103). Kainow shares folders only, read-only: the project
 * folder (`<dept>/<project>`) with everyone who may read the project's content, and each output folder
 * (`<dept>/<project>/output/<output>`) with that output's readers, in output destinations only.
 *
 * The same machinery keeps storage Administrators' `write` on the source area's `projects` folder (spec 8.4, D104).
 *
 * Kainow never alters access it did not create. Before it first invites a person to a folder it reads the folder's
 * permissions: a person who already has one (given by someone else) is recorded `external`, counted as shared, and that
 * permission is never invited over, changed or removed. Before any removal the folder's permissions are read again, and
 * only a permission whose id Kainow recorded and whose roles are exactly the role Kainow granted (read; write on the source area) is deleted; anything else stays listed to
 * repair. Revoking never invites.
 *
 * Order matters. A sync removes before it adds. An output whose readers narrow has its files moved out of the project
 * folder first (urgent `place-output`), then its own folder is synced; if the move fails, the output folder's
 * revocations still run. One whose readers widen is moved back first, and nothing is revoked before the move. Kainow's
 * own check (`readsOutput`) hides an output at once, whatever SharePoint still allows.
 *
 * Debouncing: the spec suggests a 30-second debounce per folder. It is not done: the storage queue already keeps one
 * queued job per folder (a burst of changes refreshes it rather than adding more), and delaying a sync would delay the
 * revocations it carries, which must go at once.
 */

type Db = Pool | PoolClient;

/** Shown to the PM, Deputies, Owner and Sponsors next to a person Kainow could not share with (spec 5.5). */
export const notSharedLabel = (email: string): string => `Not shared in SharePoint — no Microsoft account found for ${email}`;

/** The Administrator notice raised once per revocation that keeps failing (spec 5.5). */
export const SHARING_REVOKE_FAILED = 'sharing_revoke_failed';
export const revokeFailedNotice = (projectName: string): string =>
  `Kainow could not remove SharePoint access for a person who has left ${projectName}`;
/** The same notice for the source area's direct (write) access. */
export const SOURCE_REVOKE_FAILED_TEXT = 'Kainow could not remove direct access to the source area for a former storage Administrator';
/** The Administrator notice raised once when moving an output's files keeps failing. */
export const SHARING_PLACE_FAILED = 'sharing_place_failed';
export const placeFailedNotice = (projectName: string): string =>
  `Kainow could not move the files of an output in ${projectName} to where only its readers can open them`;

/**
 * The stored output files Kainow places (`f` the stored file, `o` its output): every one in a Kainow folder, and every
 * one in the project's own output destination wherever it sits there (a relinked file still under the shared project
 * folder must move when the readers narrow). Only a file relinked into another destination, outside Kainow's folders,
 * is left where it is.
 */
const KAINOW_PLACED = `(f.folder_id IS NOT NULL OR f.destination_id IS NOT DISTINCT FROM
  (SELECT s.destination_id FROM project_output_settings s WHERE s.project_id = o.project_id))`;

/** What a stored file's move is recorded with in `stored_file_moves`. */
const MOVE_REASON = 'Readers changed';
/** Logged (fixed text) when revocations after a failed narrowing move fail too; the rows stay listed to repair. */
const REVOKE_AFTER_MOVE_FAILED = 'Removing access after a failed output move failed too; it stays listed under Sharing to repair.';

interface FolderRow { id: string; destination_id: string; level: string; key: string; item_id: string }
type GrantState = 'pending' | 'granted' | 'not_found' | 'revoking' | 'failed' | 'external';
interface GrantRow { id: string; user_id: string; state: GrantState; permission_id: string | null; none_created: boolean }

const loadFolder = async (db: Db, folderId: string): Promise<FolderRow | undefined> =>
  (await db.query<FolderRow>(`SELECT id, destination_id, level, key, item_id FROM storage_folders WHERE id = $1`, [folderId])).rows[0];

/**
 * Only project folders and output folders (read, in output destinations) and the source area's `projects` folder
 * (write, for storage Administrators, spec 8.4) are ever shared; every other level (and the restricted root) never is.
 * The connector never grants on a library root, so the source-area grant sits on the recorded `projects` folder, which
 * holds every stored source file.
 */
const SHARED_LEVELS: ReadonlySet<string> = new Set(['project', 'output', 'source_root']);
type Role = 'read' | 'write';
const roleOf = (level: string): Role => (level === 'source_root' ? 'write' : 'read');
const sharesRole = (p: PermissionInfo, role: Role): boolean => p.roles.length === 1 && p.roles[0] === role;
const projectOfKey = (key: string): string => key.split('/')[1];
const outputOfKey = (key: string): string => key.split('/')[3];
const sameEmail = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();
/** A provider's definite refusal (a 4xx answer): the invitation created nothing. Anything else may have. */
const definite = (err: unknown): boolean => err instanceof StorageError && err.status !== undefined && err.status >= 400 && err.status < 500;

/** One worker at a time per subject; a second run meanwhile fails retryably and finds the work done when it runs. */
async function exclusively<T>(deps: StorageDeps, ns: string, id: string, work: () => Promise<T>): Promise<T> {
  const lock = await deps.pool.connect();
  let broken: Error | undefined;
  try {
    const got = (await lock.query<{ ok: boolean }>(`SELECT pg_try_advisory_lock(hashtext($1), hashtext($2)) AS ok`, [ns, id])).rows[0].ok;
    if (!got) throw new StorageError('throttled', { retryAfterMs: 60_000 });
    try {
      return await work();
    } finally {
      try {
        await lock.query(`SELECT pg_advisory_unlock(hashtext($1), hashtext($2))`, [ns, id]);
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

// ---------------------------------------------------------------------------------------------------------------------
// Desired grants
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The people a shared folder should be granted read to on the UTC+8 day of `at`, by user id with their Kainow email.
 * Project folder: everyone who may read the project's content (Active roles, Active Audit/Oversight grants; never
 * Leadership). Output folder: the output's readers (spec 4.6, including the review rule), and nobody when the output
 * is Withdrawn, Deleted or held, or when it is back in the project tree (its folder then holds nothing). Any other
 * folder: nobody. Disabled accounts never.
 */
export async function desiredFolderGrants(db: Db, folderId: string, at: Date): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const f = await loadFolder(db, folderId);
  if (!f) return out;
  let ids: string[];
  if (f.level === 'project') {
    ids = (await contentReaderContexts(db, projectOfKey(f.key), at)).map((c) => c.viewerId);
  } else if (f.level === 'output') {
    const outputId = outputOfKey(f.key);
    const o = (
      await db.query<{ status: string; deleted: boolean; held: boolean; placement: string | null }>(
        `SELECT status, deleted_at IS NOT NULL AS deleted, held_case_id IS NOT NULL AS held, placement_folder_id AS placement FROM outputs WHERE id = $1`,
        [outputId],
      )
    ).rows[0];
    if (!o || o.status === 'withdrawn' || o.deleted || o.held) return out;
    if ((await isWholeProject(db, outputId, at)) && o.placement !== f.id) return out;
    ids = [...(await outputReaders(db, outputId, at))];
  } else if (f.level === 'source_root') {
    // Only designated storage Administrators; being an Enterprise Administrator gives nothing here.
    ids = (
      await db.query<{ user_id: string }>(
        `SELECT a.user_id FROM storage_admins a JOIN storage_folders f ON f.id = $1
           JOIN storage_destinations d ON d.id = f.destination_id AND d.purpose = 'source_area' AND d.status = 'approved'
          WHERE a.ended_at IS NULL ORDER BY a.user_id`,
        [folderId],
      )
    ).rows.map((r) => r.user_id);
  } else {
    return out;
  }
  if (ids.length === 0) return out;
  const { rows } = await db.query<{ id: string; email: string }>(
    `SELECT id, email FROM users WHERE id = ANY($1::uuid[]) AND status = 'active' ORDER BY id`,
    [ids],
  );
  for (const r of rows) out.set(r.id, r.email);
  return out;
}

const liveGrants = async (db: Db, folderId: string, role: Role): Promise<GrantRow[]> =>
  (
    await db.query<GrantRow>(
      `SELECT id, user_id, state, permission_id, none_created FROM storage_grants
        WHERE folder_id = $1 AND role = $2 AND state <> 'revoked' ORDER BY id`,
      [folderId, role],
    )
  ).rows;

/** Output folders are shared only in output destinations; the source area's folder only in the source area. */
const isSharingDestination = async (db: Db, destinationId: string, level: string): Promise<boolean> =>
  ((await db.query(`SELECT 1 FROM storage_destinations WHERE id = $1 AND purpose = $2`, [destinationId, level === 'source_root' ? 'source_area' : 'outputs'])).rowCount ?? 0) > 0;

// ---------------------------------------------------------------------------------------------------------------------
// The share-sync job
// ---------------------------------------------------------------------------------------------------------------------

export interface SyncOptions {
  /** Try people not found again, and check `external` permissions still stand (the daily reconciliation). */
  retryNotFound?: boolean;
  /** Only remove access (after a failed narrowing move); grant nothing. */
  revokeOnly?: boolean;
}

/**
 * The `share-sync` job: brings one shared folder's Kainow grants in line with `desiredFolderGrants`. Revocations
 * first, then grants. Every operation is tried even when one fails; the first failure is then thrown so the job is
 * tried again.
 */
export async function syncFolderGrants(deps: StorageDeps, folderId: string, opts: SyncOptions = {}): Promise<void> {
  await exclusively(deps, 'share-sync', folderId, () => syncLocked(deps, folderId, opts));
}

interface SyncCtx { deps: StorageDeps; connector: StorageConnector; dest: DestinationRef; f: FolderRow; role: Role }

async function syncLocked(deps: StorageDeps, folderId: string, opts: SyncOptions): Promise<void> {
  const f = await loadFolder(deps.pool, folderId);
  if (!f || !SHARED_LEVELS.has(f.level) || !(await isSharingDestination(deps.pool, f.destination_id, f.level))) return;
  const role = roleOf(f.level);
  const desired = await desiredFolderGrants(deps.pool, folderId, deps.clock());
  const live = await liveGrants(deps.pool, folderId, role);

  // Removals that need no provider call are settled at once: nobody was shared with (not found), a permission that was
  // never Kainow's (external, left as it is), or a grant the provider definitely refused. Every other removal is
  // marked revoking before anything can fail, so it is listed to repair until the provider confirms it.
  const leaving: GrantRow[] = [];
  for (const g of live.filter((x) => !desired.has(x.user_id))) {
    if (g.state === 'not_found' || g.state === 'external' || (g.state === 'failed' && g.none_created)) {
      // No permission id is kept: an external one was never Kainow's and must never later be taken for Kainow's.
      await setGrant(deps, g.id, 'revoked', null);
      continue;
    }
    if (g.state !== 'revoking') await setGrant(deps, g.id, 'revoking', g.permission_id);
    leaving.push({ ...g, state: 'revoking' });
  }
  const byUser = new Map(live.map((g) => [g.user_id, g]));
  const joining = opts.revokeOnly
    ? []
    : [...desired].filter(([userId]) => {
        const g = byUser.get(userId);
        if (!g) return true;
        if (g.state === 'granted') return false;
        if (g.state === 'not_found' || g.state === 'external') return !!opts.retryNotFound;
        return true;
      });
  if (leaving.length === 0 && joining.length === 0) return;

  const { connector, dest } = await deps.connectors.forDestination(f.destination_id);
  const ctx: SyncCtx = { deps, connector, dest, f, role };
  let failure: unknown;
  const emails = await emailsOf(deps.pool, leaving.map((g) => g.user_id));
  for (const g of leaving) {
    try {
      await revokeOne(ctx, g, emails.get(g.user_id) ?? null);
    } catch (err) {
      failure ??= err;
    }
  }
  let perms: PermissionInfo[] | null = null;
  for (const [userId, email] of joining) {
    try {
      perms ??= await connector.listPermissions(dest, f.item_id);
      await grantOne(ctx, perms, userId, email, byUser.get(userId));
    } catch (err) {
      failure ??= err;
    }
  }
  if (failure) throw failure;
}

async function emailsOf(db: Db, userIds: string[]): Promise<Map<string, string>> {
  if (userIds.length === 0) return new Map();
  const { rows } = await db.query<{ id: string; email: string }>(`SELECT id, email FROM users WHERE id = ANY($1::uuid[])`, [userIds]);
  return new Map(rows.map((r) => [r.id, r.email]));
}

async function setGrant(deps: StorageDeps, id: string, state: GrantState | 'revoked', permissionId: string | null, noneCreated = false): Promise<void> {
  await deps.pool.query(
    `UPDATE storage_grants SET state = $2, permission_id = $3, none_created = $4, updated_at = $5 WHERE id = $1`,
    [id, state, permissionId, noneCreated, deps.clock()],
  );
}

/** Permission ids of Kainow's own live grants on the folder (never an external one, never a settled row). */
async function kainowPermissionIds(db: Db, folderId: string): Promise<Set<string>> {
  const { rows } = await db.query<{ permission_id: string }>(
    `SELECT permission_id FROM storage_grants
      WHERE folder_id = $1 AND permission_id IS NOT NULL AND state IN ('pending', 'granted', 'revoking', 'failed')`,
    [folderId],
  );
  return new Set(rows.map((r) => r.permission_id));
}

/** Permission ids recorded as someone else's on the folder. */
async function externalPermissionIds(db: Db, folderId: string): Promise<Set<string>> {
  const { rows } = await db.query<{ permission_id: string }>(
    `SELECT permission_id FROM storage_grants WHERE folder_id = $1 AND permission_id IS NOT NULL AND state = 'external'`,
    [folderId],
  );
  return new Set(rows.map((r) => r.permission_id));
}

/**
 * Grants read on the folder to a person who should have it. The folder's permissions (read once per sync) decide:
 * - a row still holding its permission (back before a revocation went through, or an external one) keeps it;
 * - a person with a permission Kainow did not create is recorded `external` and nothing is sent, except that a single
 *   read-only permission is taken as Kainow's own when its last invitation's outcome was unknown (the answer was lost);
 * - otherwise the row is recorded pending and the invitation sent. A definite refusal (4xx) records that nothing was
 *   created; any other failure leaves the outcome unknown.
 * Never on the destination's root, never on a file (the connector checks the item is a folder too).
 */
async function grantOne(ctx: SyncCtx, perms: PermissionInfo[], userId: string, email: string, g: GrantRow | undefined): Promise<void> {
  const { deps, connector, dest, f, role } = ctx;
  if (f.item_id === dest.rootItemId) throw new StorageError('invalid');
  if (g?.permission_id && (g.state === 'revoking' || g.state === 'external' || g.state === 'granted')) {
    if (perms.some((p) => p.id === g.permission_id)) {
      await setGrant(deps, g.id, g.state === 'external' ? 'external' : 'granted', g.permission_id);
      return;
    }
    // Gone: the person is shared with afresh below.
  }
  const ours = await kainowPermissionIds(deps.pool, f.id);
  const others = perms.filter((p) => p.kind === 'user' && sameEmail(p.principal, email) && !ours.has(p.id));
  const unknownOutcome = !!g && !g.permission_id && (g.state === 'pending' || g.state === 'revoking' || (g.state === 'failed' && !g.none_created));
  if (others.length > 0) {
    const state = unknownOutcome && others.length === 1 && sharesRole(others[0], role) ? 'granted' : 'external';
    await upsertGrant(deps, f.id, userId, g, state, others[0].id, role);
    return;
  }
  const id = await upsertGrant(deps, f.id, userId, g, 'pending', null, role);
  let result;
  try {
    result = await connector.grant(dest, f.item_id, email, role);
  } catch (err) {
    await setGrant(deps, id, 'failed', null, definite(err));
    throw err;
  }
  if ('notFound' in result) await setGrant(deps, id, 'not_found', null);
  else await setGrant(deps, id, 'granted', result.permissionId);
}

async function upsertGrant(
  deps: StorageDeps, folderId: string, userId: string, g: GrantRow | undefined, state: GrantState, permissionId: string | null, role: Role,
): Promise<string> {
  if (g) {
    await setGrant(deps, g.id, state, permissionId);
    return g.id;
  }
  const id = uuidv7();
  await deps.pool.query(
    `INSERT INTO storage_grants (id, folder_id, user_id, role, state, permission_id, updated_at) VALUES ($1, $2, $3, $7, $4, $5, $6)`,
    [id, folderId, userId, state, permissionId, deps.clock(), role],
  );
  return id;
}

/**
 * Removes a Kainow grant (the row is already `revoking`). The folder's permissions are read first, and never is anyone
 * invited. With a recorded permission id: gone means done; it is deleted only if its roles are exactly read. Without
 * one (the invitation's outcome was unknown): no permission of the person's that is not someone else's means nothing
 * landed; exactly one read-only permission is the lost invitation's and is deleted. Anything else is refused and
 * stays `revoking`, listed to repair.
 */
async function revokeOne(ctx: SyncCtx, g: GrantRow, email: string | null): Promise<void> {
  const { deps, connector, dest, f, role } = ctx;
  const perms = await connector.listPermissions(dest, f.item_id);
  let target: PermissionInfo | undefined;
  if (g.permission_id) {
    target = perms.find((p) => p.id === g.permission_id);
    if (!target) {
      await setGrant(deps, g.id, 'revoked', g.permission_id);
      return;
    }
  } else {
    const external = await externalPermissionIds(deps.pool, f.id);
    const ours = await kainowPermissionIds(deps.pool, f.id);
    const matches = email ? perms.filter((p) => p.kind === 'user' && sameEmail(p.principal, email) && !external.has(p.id) && !ours.has(p.id)) : [];
    if (matches.length === 0) {
      await setGrant(deps, g.id, 'revoked', null);
      return;
    }
    if (matches.length > 1) throw new StorageError('conflict');
    target = matches[0];
    await setGrant(deps, g.id, 'revoking', target.id);
  }
  if (!sharesRole(target, role)) throw new StorageError('conflict');
  try {
    await connector.revoke(dest, f.item_id, target.id);
  } catch (err) {
    if (!(err instanceof StorageError && err.code === 'not_found')) throw err;
  }
  await setGrant(deps, g.id, 'revoked', target.id);
}

/**
 * Raises the Administrator notice for each revocation of the folder still not done, once per revocation (spec 5.5):
 * after a folder's sync has used all its attempts, and when the daily reconciliation's retry fails too. It stays
 * listed under "Sharing to repair" and the daily reconciliation keeps trying.
 */
export async function noticeStuckRevocations(deps: StorageDeps, folderId: string): Promise<void> {
  await withTx(deps, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `UPDATE storage_grants SET revoke_notice_at = $2 WHERE folder_id = $1 AND state = 'revoking' AND revoke_notice_at IS NULL RETURNING id`,
      [folderId, deps.clock()],
    );
    for (const r of rows.sort((a, b) => a.id.localeCompare(b.id))) await deps.notify(c, { kind: SHARING_REVOKE_FAILED, subjectId: r.id });
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// The place-output job
// ---------------------------------------------------------------------------------------------------------------------

interface PlacedFile {
  id: string; destination_id: string; item_id: string; drive_id: string; path: string | null; name: string; folder_id: string | null;
}

/**
 * The `place-output` job (spec 5.5): moves every stored file of the output (same drive, item ids kept) into the place
 * its readers dictate (`isWholeProject`: `Year / Report Type` in the project tree, otherwise its own output folder),
 * records the output's placement, and only then syncs its output folders. If a move fails the output is marked to
 * repair (`place_failed_at`), nothing is granted, but when its readers narrowed its output folders' revocations still
 * run; then the failure is thrown so the job is tried again. Registered links are never moved (Kainow did not create
 * them), nor is a filed file relinked into another destination outside Kainow's folders (D107: its sharing stays as
 * it is there). A file relinked anywhere in the project's own output destination is placed like any other.
 */
export async function placeOutput(deps: StorageDeps, outputId: string): Promise<void> {
  await exclusively(deps, 'place-output', outputId, () => placeLocked(deps, outputId));
}

const outputFolderIds = async (db: Db, outputId: string): Promise<string[]> =>
  (await db.query<{ id: string }>(`SELECT id FROM storage_folders WHERE level = 'output' AND split_part(key, '/', 4) = $1::text ORDER BY id`, [outputId])).rows.map(
    (r) => r.id,
  );

async function placeLocked(deps: StorageDeps, outputId: string): Promise<void> {
  const o = (
    await deps.pool.query<{ project_id: string; placement_dest: string | null }>(
      `SELECT o.project_id, f.destination_id AS placement_dest FROM outputs o LEFT JOIN storage_folders f ON f.id = o.placement_folder_id WHERE o.id = $1`,
      [outputId],
    )
  ).rows[0];
  if (!o) return;
  const at = deps.clock();
  const whole = await isWholeProject(deps.pool, outputId, at);
  const files = (
    await deps.pool.query<PlacedFile>(
      `SELECT f.id, f.destination_id, f.item_id, f.drive_id, f.path, f.name, f.folder_id
         FROM output_versions v JOIN outputs o ON o.id = v.output_id JOIN stored_files f ON f.id = v.stored_file_id
        WHERE v.output_id = $1 AND f.state = 'stored' AND f.destination_id IS NOT NULL AND f.item_id IS NOT NULL
          AND ${KAINOW_PLACED}
        ORDER BY v.version_no`,
      [outputId],
    )
  ).rows;
  const destinations = [...new Set(files.map((f) => f.destination_id))];

  try {
    let placement: string | null = null;
    for (const destinationId of destinations) {
      const { connector, dest } = await deps.connectors.forDestination(destinationId);
      const folder = await ensureOutputFolder(deps, dest, o.project_id, outputId, whole, connector);
      for (const file of files.filter((f) => f.destination_id === destinationId)) await moveInto(deps, connector, dest, folder, file);
      if (!placement || destinationId === o.placement_dest) placement = folder.recordId;
    }
    // The output row is locked as filing and audience changes lock it, so neither decides on a placement half made.
    await withTx(deps, async (c) => {
      await c.query(`SELECT 1 FROM outputs WHERE id = $1 FOR UPDATE`, [outputId]);
      await c.query(
        `UPDATE outputs SET placement_folder_id = COALESCE($2, placement_folder_id), place_failed_at = NULL, place_notice_at = NULL WHERE id = $1`,
        [outputId, placement],
      );
    });
  } catch (err) {
    await deps.pool.query(`UPDATE outputs SET place_failed_at = $2 WHERE id = $1`, [outputId, deps.clock()]);
    // Narrowed: whoever lost access through the output's own folder loses it now, move or no move.
    if (!whole) {
      for (const id of await outputFolderIds(deps.pool, outputId)) {
        await syncFolderGrants(deps, id, { revokeOnly: true }).catch(() =>
          (deps.log ?? ((m: string) => console.warn(m)))(REVOKE_AFTER_MOVE_FAILED),
        );
      }
    }
    throw err;
  }

  // Then sharing: its own folders (shared with its readers, or with nobody once it is back in the project tree), and
  // the project folder it may have just moved into (created by this move when no output was filed there before).
  const folders = (
    await deps.pool.query<{ id: string }>(
      `SELECT id FROM storage_folders
        WHERE (level = 'output' AND split_part(key, '/', 4) = $1::text)
           OR ($2 AND level = 'project' AND split_part(key, '/', 2) = $3::text AND destination_id = ANY($4::uuid[]))
        ORDER BY level DESC, id`,
      [outputId, whole, o.project_id, destinations],
    )
  ).rows;
  for (const f of folders) await syncFolderGrants(deps, f.id);
}

/** After a placement has used all its attempts: one Administrator notice until a move next completes. */
export async function noticePlaceFailed(deps: StorageDeps, outputId: string): Promise<void> {
  await withTx(deps, async (c) => {
    const r = await c.query(
      `UPDATE outputs SET place_notice_at = $2 WHERE id = $1 AND place_failed_at IS NOT NULL AND place_notice_at IS NULL RETURNING id`,
      [outputId, deps.clock()],
    );
    if (r.rowCount) await deps.notify(c, { kind: SHARING_PLACE_FAILED, subjectId: outputId });
  });
}

/**
 * Moves one stored file into the folder unless it is already there (a move whose answer was lost is found done), under
 * its recorded name. A name already taken there gets ` (2)`, ` (3)` …; nothing is overwritten. What is recorded is the
 * name Kainow gave and the recorded folder names, never the provider's (which could still hold a cleaned title, spec
 * 4.7). A file no longer in storage is left to the file checks (it is in no folder to leak from).
 */
async function moveInto(deps: StorageDeps, connector: StorageConnector, dest: DestinationRef, folder: OutputFolder, file: PlacedFile): Promise<void> {
  let item: StoredRef;
  try {
    item = await connector.getItem(dest, file.item_id);
  } catch (err) {
    if (err instanceof StorageError && err.code === 'not_found') return;
    throw err;
  }
  let ref = item;
  let name = file.name;
  if (item.parentId !== folder.itemId) {
    ({ ref, name } = await moveNamed(connector, dest, file.item_id, folder.itemId, file.name));
  }
  const path = [...folder.path, name].join('/');
  if (path === file.path && name === file.name && file.folder_id === folder.recordId) return;
  const at = deps.clock();
  await withTx(deps, async (c) => {
    await c.query(`UPDATE stored_files SET path = $2, name = $3, etag = $4, ctag = $5, web_url = $6, folder_id = $7 WHERE id = $1`, [
      file.id, path, name, ref.etag, ref.ctag, ref.webUrl, folder.recordId,
    ]);
    if (path !== file.path) {
      await c.query(
        `INSERT INTO stored_file_moves (id, stored_file_id, reason, old_destination_id, old_drive_id, old_item_id, old_path,
                                        new_destination_id, new_drive_id, new_item_id, new_path, actor_id, at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $4, $5, $6, $8, NULL, $9)`,
        [uuidv7(at.getTime()), file.id, MOVE_REASON, file.destination_id, file.drive_id, file.item_id, file.path, path, at],
      );
    }
  });
}


// ---------------------------------------------------------------------------------------------------------------------
// After filing
// ---------------------------------------------------------------------------------------------------------------------

/**
 * In the transaction that records a version filed (with the output row locked): shares the folder it went to (the
 * project folder for an output read by the whole project, otherwise its own folder). If the output's readers changed
 * kind while it uploaded, the output is placed again (urgent when it narrowed).
 */
export async function sharingAfterFiled(c: PoolClient, outputId: string, at: Date): Promise<void> {
  const p = (
    await c.query<{ id: string; level: string; key: string; destination_id: string }>(
      `SELECT f.id, f.level, f.key, f.destination_id FROM outputs o JOIN storage_folders f ON f.id = o.placement_folder_id WHERE o.id = $1`,
      [outputId],
    )
  ).rows[0];
  if (!p) return;
  const whole = await isWholeProject(c, outputId, at);
  if (p.level === 'output') {
    if (whole) await queueOutputPlacement(c, outputId, 'widen');
    await queueFolderSharing(c, p.id, 'normal');
    return;
  }
  if (!whole) {
    await queueOutputPlacement(c, outputId, 'narrow');
    return;
  }
  const [d, proj] = p.key.split('/');
  const project = (
    await c.query<{ id: string }>(`SELECT id FROM storage_folders WHERE destination_id = $1 AND level = 'project' AND key = $2`, [p.destination_id, `${d}/${proj}`])
  ).rows[0];
  if (project) await queueFolderSharing(c, project.id, 'normal');
}

// ---------------------------------------------------------------------------------------------------------------------
// Daily reconciliation
// ---------------------------------------------------------------------------------------------------------------------

/** Whether a folder's grants differ from what they should be, or any is unfinished, failed, not found or external (to recheck). */
async function needsSync(db: Db, folderId: string, level: string, at: Date): Promise<boolean> {
  const desired = await desiredFolderGrants(db, folderId, at);
  const live = await liveGrants(db, folderId, roleOf(level));
  if (live.some((g) => g.state !== 'granted' || !desired.has(g.user_id))) return true;
  const have = new Set(live.map((g) => g.user_id));
  return [...desired.keys()].some((id) => !have.has(id));
}

/**
 * The daily reconciliation (02:30 UTC+8, spec 5.5): memberships and grants that start or end by date have no event, and
 * drift is repaired.
 * - Every shared folder of an output destination whose grants differ from its readers, or with grants unfinished,
 *   failed, not found or external, is synced (not found tried again, external rechecked). One that fails is queued
 *   urgent, and any revocation in it still not done raises its notice (once).
 * - Every output with a stored file not in the folder its readers need (its own output folder, or a report type
 *   folder of its project) is queued to be placed.
 * Returns the counts.
 */
export async function reconcileSharing(deps: StorageDeps, at: Date = deps.clock()): Promise<{ synced: number; queued: number; placed: number }> {
  const out = { synced: 0, queued: 0, placed: 0 };
  const folders = (
    await deps.pool.query<{ id: string; level: string }>(
      `SELECT f.id, f.level FROM storage_folders f JOIN storage_destinations d ON d.id = f.destination_id
        WHERE (f.level IN ('project', 'output') AND d.purpose = 'outputs')
           OR (f.level = 'source_root' AND d.purpose = 'source_area' AND d.status = 'approved')
        ORDER BY f.id`,
    )
  ).rows;
  for (const f of folders) {
    if (!(await needsSync(deps.pool, f.id, f.level, at))) continue;
    try {
      await syncFolderGrants(deps, f.id, { retryNotFound: true });
      out.synced += 1;
    } catch (err) {
      await withTx(deps, (c) => queueFolderSharing(c, f.id, 'urgent'));
      // Busy (another worker holds the folder) is no failure: the job's own attempts decide.
      if (!(err instanceof StorageError && err.code === 'throttled')) await noticeStuckRevocations(deps, f.id);
      out.queued += 1;
    }
  }
  const files = (
    await deps.pool.query<{ output_id: string; project_id: string; level: string | null; key: string | null }>(
      `SELECT v.output_id, o.project_id, sf.level, sf.key
         FROM output_versions v JOIN outputs o ON o.id = v.output_id
         JOIN stored_files f ON f.id = v.stored_file_id AND f.state = 'stored' AND ${KAINOW_PLACED}
         LEFT JOIN storage_folders sf ON sf.id = f.folder_id
        ORDER BY v.output_id, v.version_no`,
    )
  ).rows;
  const outputs = [...new Set(files.map((r) => r.output_id))];
  for (const id of outputs) {
    const whole = await isWholeProject(deps.pool, id, at);
    const misplaced = files
      .filter((r) => r.output_id === id)
      .some((r) =>
        whole
          ? r.level !== 'report_type' || r.key?.split('/')[1] !== r.project_id
          : r.level !== 'output' || r.key?.split('/')[3] !== id,
      );
    if (!misplaced) continue;
    await withTx(deps, (c) => queueOutputPlacement(c, id, whole ? 'widen' : 'narrow'));
    out.placed += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// What people see
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The people Kainow could not share an output's files with (`not_found` on the folder its files are in), for the PM,
 * Deputies, Owner and Sponsors. They can still read the output in Kainow.
 */
export async function notSharedFor(db: Db, outputId: string): Promise<Array<{ person: { id: string; displayName: string }; message: string }>> {
  const { rows } = await db.query<{ id: string; displayName: string; email: string }>(
    `SELECT u.id, u.display_name AS "displayName", u.email
       FROM outputs o
       JOIN storage_folders pf ON pf.id = o.placement_folder_id
       JOIN storage_folders sf ON sf.destination_id = pf.destination_id
        AND ((pf.level = 'output' AND sf.id = pf.id)
          OR (pf.level = 'report_type' AND sf.level = 'project' AND sf.key = split_part(pf.key, '/', 1) || '/' || split_part(pf.key, '/', 2)))
       JOIN storage_grants g ON g.folder_id = sf.id AND g.state = 'not_found'
       JOIN users u ON u.id = g.user_id
      WHERE o.id = $1
      ORDER BY u.display_name, u.id`,
    [outputId],
  );
  return rows.map((r) => ({ person: { id: r.id, displayName: r.displayName }, message: notSharedLabel(r.email) }));
}

export interface SharingRepair {
  /** Grants that failed, and revocations not yet done (including any refused because the permission is not plainly Kainow's). */
  grants: Array<{ grantId: string; folderId: string; projectId: string | null; projectName: string | null; area: 'source' | null; userId: string; displayName: string; state: 'failed' | 'revoking'; since: Date }>;
  /** Outputs whose files could not be moved to where their readers need them (titles are left out: they may be restricted). */
  outputs: Array<{ outputId: string; projectId: string; projectName: string; since: Date }>;
}

/** The Storage page's "Sharing to repair" list (spec 5.5, 8.6). */
export async function sharingToRepair(db: Db): Promise<SharingRepair> {
  const grants = (
    await db.query(
      `SELECT g.id AS "grantId", g.folder_id AS "folderId", p.id AS "projectId", p.name AS "projectName", u.id AS "userId",
              u.display_name AS "displayName", g.state, g.updated_at AS since,
              CASE WHEN f.level = 'source_root' THEN 'source' END AS area
         FROM storage_grants g
         JOIN storage_folders f ON f.id = g.folder_id
         LEFT JOIN projects p ON p.id::text = split_part(f.key, '/', 2) AND f.level IN ('project', 'output')
         JOIN users u ON u.id = g.user_id
        WHERE g.state IN ('failed', 'revoking')
          AND ((f.level IN ('project', 'output') AND p.id IS NOT NULL) OR f.level = 'source_root')
        ORDER BY (f.level = 'source_root'), p.name, u.display_name, g.updated_at, g.id`,
    )
  ).rows;
  const outputs = (
    await db.query(
      `SELECT o.id AS "outputId", p.id AS "projectId", p.name AS "projectName", o.place_failed_at AS since
         FROM outputs o JOIN projects p ON p.id = o.project_id
        WHERE o.place_failed_at IS NOT NULL
        ORDER BY p.name, o.place_failed_at, o.id`,
    )
  ).rows;
  return { grants, outputs } as SharingRepair;
}

registerStorageHandler('share-sync', (deps, folderId) => syncFolderGrants(deps, folderId));
registerStorageFinalFailure('share-sync', (deps, folderId) => noticeStuckRevocations(deps, folderId));
registerStorageHandler('place-output', (deps, outputId) => placeOutput(deps, outputId));
registerStorageFinalFailure('place-output', (deps, outputId) => noticePlaceFailed(deps, outputId));
registerStorageDailyTask('sharing', async (deps) => {
  await reconcileSharing(deps);
});
