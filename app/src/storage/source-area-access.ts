import type { Pool, PoolClient } from 'pg';
import { queueFolderSharing } from '../outputs/sharing-queue';
import { type StorageDeps, registerStorageDailyTask } from './jobs';
import { libraryAllowance, libraryPermissionProblems } from './library-permissions';
import { ensureSourceProjectsFolder } from './sources';
import type { PermissionInfo } from './types';

/**
 * Who can open the source area (spec 8.4): the daily check behind the Storage page's "The source area is also open to"
 * warning, which also makes sure the folder storage Administrators are granted on exists and their grant is queued.
 * Kept out of the Nest services so the worker, which runs the daily tasks, registers it.
 */

type Db = Pool | PoolClient;
const SHARING_LINK = 'a sharing link';

/** The warning shown on the Storage page (exact copy, spec 8.4). */
export const sourceAreaOpenWarning = (names: string): string => `The source area is also open to: ${names}`;

/** Who a list of unexpected permissions names: people and groups by name, any link as "a sharing link". */
export function openToNames(others: PermissionInfo[]): string {
  const names = new Set<string>();
  for (const p of others) names.add(p.kind === 'link' ? SHARING_LINK : p.principal);
  return [...names].sort((a, b) => a.localeCompare(b)).join(', ');
}

export const approvedSourceArea = async (db: Db): Promise<{ id: string } | undefined> =>
  (await db.query<{ id: string }>(`SELECT id FROM storage_destinations WHERE purpose = 'source_area' AND status = 'approved' ORDER BY created_at, id LIMIT 1`)).rows[0];

/**
 * Permissions on the source area beyond the designated people, the connection (Kainow's application), the site's owners
 * and Kainow's own grants. Reads the library root and the folder admins are granted on. Never removes anything.
 * Empty when there is no approved source area.
 */
export async function sourceAreaOthers(deps: StorageDeps): Promise<PermissionInfo[]> {
  const src = await approvedSourceArea(deps.pool);
  if (!src) return [];
  const { connector, dest } = await deps.connectors.forDestination(src.id);
  const perms = new Map<string, PermissionInfo>();
  for (const p of await connector.listPermissions(dest, dest.rootItemId)) perms.set(p.id, p);
  const folder = (
    await deps.pool.query<{ item_id: string }>(
      `SELECT item_id FROM storage_folders WHERE destination_id = $1 AND level = 'source_root' AND key = 'projects'`,
      [src.id],
    )
  ).rows[0];
  if (folder) for (const p of await connector.listPermissions(dest, folder.item_id)) perms.set(p.id, p);
  const d = (
    await deps.pool.query<{ id: string; kind: string; purpose: string; account_email: string | null }>(
      `SELECT id, kind, purpose, account_email FROM storage_destinations WHERE id = $1`,
      [src.id],
    )
  ).rows[0];
  return libraryPermissionProblems([...perms.values()], await libraryAllowance(deps.pool, d)).sort((a, b) => a.principal.localeCompare(b.principal) || a.id.localeCompare(b.id));
}

/**
 * Once a day: makes sure the source area's folder exists when someone is designated (and queues their grant), then
 * lists who else can open the source area and records the warning on the destination's last check, or clears it. A
 * listing that fails leaves the last warning as it was. Nothing is ever removed from the provider here.
 */
export async function dailySourceAreaAccess(deps: StorageDeps): Promise<void> {
  const src = await approvedSourceArea(deps.pool);
  if (!src) return;
  const anyAdmin = ((await deps.pool.query(`SELECT 1 FROM storage_admins WHERE ended_at IS NULL LIMIT 1`)).rowCount ?? 0) > 0;
  let folderFailure: unknown;
  if (anyAdmin) {
    // The warning below is still worked out when this step fails; the failure is then thrown.
    try {
      const { connector, dest } = await deps.connectors.forDestination(src.id);
      const folder = await ensureSourceProjectsFolder(deps, connector, dest);
      const c = await deps.pool.connect();
      try {
        await c.query('BEGIN');
        await queueFolderSharing(c, folder.id, 'normal');
        await c.query('COMMIT');
      } catch (err) {
        await c.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        c.release();
      }
    } catch (err) {
      folderFailure = err;
    }
  }
  const others = await sourceAreaOthers(deps);
  await deps.pool.query(
    `UPDATE storage_destinations
        SET last_check = CASE WHEN $2::text IS NULL THEN COALESCE(last_check, '{}'::jsonb) - 'sourceAreaWarning'
                              ELSE jsonb_set(COALESCE(last_check, '{}'::jsonb), '{sourceAreaWarning}', to_jsonb($2::text)) END
      WHERE id = $1`,
    [src.id, others.length ? sourceAreaOpenWarning(openToNames(others)) : null],
  );
  if (folderFailure) throw folderFailure;
}
registerStorageDailyTask('source-area-access', dailySourceAreaAccess);
