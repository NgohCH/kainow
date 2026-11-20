import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { writeAudit } from '../audit/audit';
import { type AuthUser, CLOCK, type Clock } from '../auth/tokens';
import { readReason } from '../common/reason';
import { uuidv7 } from '../common/uuid7';
import { PG_POOL } from '../db/database.module';
import { queueFolderSharing } from '../outputs/sharing-queue';
import { STORAGE_CONNECTORS, StorageWaitingForKey, type StorageConnectorFactory } from './connector-factory';
import { libraryPermissionProblems } from './destinations.service';
import { type StorageDeps, registerStorageDailyTask } from './jobs';
import { ensureSourceProjectsFolder } from './sources';
import { type PermissionInfo, StorageError } from './types';

/**
 * Storage Administrators (spec 8.4, A14, D104): people an Enterprise Administrator designates for direct access to the
 * managed source area. Kainow grants each one `write` on the source area's `projects` folder (the recorded
 * `source_root` folder holding every stored source file: the connector never grants on a library root, so this is the
 * root container Kainow itself uses) through the same share-sync machinery as output sharing, and revokes it when the
 * designation ends or the account is disabled. Being an Enterprise Administrator gives nothing.
 */

type Db = Pool | PoolClient;
const UUID = /^[0-9a-f-]{36}$/i;
const SHARING_LINK = 'a sharing link';

/** The warning shown on the Storage page (exact copy, spec 8.4). */
export const sourceAreaOpenWarning = (names: string): string => `The source area is also open to: ${names}`;

/** Who a list of unexpected permissions names: people and groups by name, any link as "a sharing link". */
export function openToNames(others: PermissionInfo[]): string {
  const names = new Set<string>();
  for (const p of others) names.add(p.kind === 'link' ? SHARING_LINK : p.principal);
  return [...names].sort((a, b) => a.localeCompare(b)).join(', ');
}

const approvedSourceArea = async (db: Db): Promise<{ id: string } | undefined> =>
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
  const admins = (
    await deps.pool.query<{ email: string }>(`SELECT u.email FROM storage_admins a JOIN users u ON u.id = a.user_id WHERE a.ended_at IS NULL`)
  ).rows.map((r) => r.email);
  const ours = (
    await deps.pool.query<{ permission_id: string }>(
      `SELECT g.permission_id FROM storage_grants g JOIN storage_folders f ON f.id = g.folder_id
        WHERE f.destination_id = $1 AND g.permission_id IS NOT NULL AND g.state IN ('pending', 'granted', 'revoking', 'failed')`,
      [src.id],
    )
  ).rows.map((r) => r.permission_id);
  const d = (await deps.pool.query<{ kind: string; account_email: string | null }>(`SELECT kind, account_email FROM storage_destinations WHERE id = $1`, [src.id])).rows[0];
  return libraryPermissionProblems([...perms.values()], {
    storageAdminUserEmails: admins,
    kainowGrantPermissionIds: new Set(ours),
    oneDriveAccountEmail: d?.kind === 'onedrive' ? d.account_email : null,
  }).sort((a, b) => a.principal.localeCompare(b.principal) || a.id.localeCompare(b.id));
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
  if (anyAdmin) {
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
  }
  const others = await sourceAreaOthers(deps);
  await deps.pool.query(
    `UPDATE storage_destinations
        SET last_check = CASE WHEN $2::text IS NULL THEN last_check - 'sourceAreaWarning'
                              ELSE jsonb_set(last_check, '{sourceAreaWarning}', to_jsonb($2::text)) END
      WHERE id = $1 AND last_check IS NOT NULL`,
    [src.id, others.length ? sourceAreaOpenWarning(openToNames(others)) : null],
  );
}
registerStorageDailyTask('source-area-access', dailySourceAreaAccess);

export interface StorageAdminRow {
  id: string; userId: string; displayName: string; email: string; designatedBy: string; designatedByName: string;
  designatedAt: string; reason: string; accountActive: boolean;
  /** The state of Kainow's grant on the source area: none yet, or the grant's own state. */
  access: 'none' | 'pending' | 'granted' | 'not_found' | 'revoking' | 'failed' | 'external';
}
export interface EndedAdminRow {
  id: string; userId: string; displayName: string; email: string; designatedBy: string; designatedByName: string;
  designatedAt: string; reason: string; endedAt: string; endedBy: string; endedByName: string; endReason: string;
}
export interface StorageAdminEvent { id: string; adminId: string; kind: 'designated' | 'ended'; displayName: string; actorName: string; at: string; reason: string }

@Injectable()
export class StorageAdminsService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(STORAGE_CONNECTORS) private readonly connectors: StorageConnectorFactory,
  ) {}

  /** Current and ended designations and their events, ordered by name, then time, then id; with the source-area warning. */
  async list(): Promise<{ admins: StorageAdminRow[]; ended: EndedAdminRow[]; events: StorageAdminEvent[]; warning: string | null }> {
    const base = `a.id, a.user_id AS "userId", u.display_name AS "displayName", u.email, a.designated_by AS "designatedBy",
        d.display_name AS "designatedByName", a.designated_at AS "designatedAt", a.reason`;
    const admins = (
      await this.pool.query(
        `SELECT ${base}, (u.status = 'active') AS "accountActive",
                COALESCE((SELECT g.state FROM storage_grants g JOIN storage_folders f ON f.id = g.folder_id
                           WHERE f.level = 'source_root' AND g.user_id = a.user_id AND g.state <> 'revoked' LIMIT 1), 'none') AS access
           FROM storage_admins a JOIN users u ON u.id = a.user_id JOIN users d ON d.id = a.designated_by
          WHERE a.ended_at IS NULL ORDER BY lower(u.display_name), u.email, a.id`,
      )
    ).rows;
    const ended = (
      await this.pool.query(
        `SELECT ${base}, a.ended_at AS "endedAt", a.ended_by AS "endedBy", e.display_name AS "endedByName", a.end_reason AS "endReason"
           FROM storage_admins a JOIN users u ON u.id = a.user_id JOIN users d ON d.id = a.designated_by JOIN users e ON e.id = a.ended_by
          WHERE a.ended_at IS NOT NULL ORDER BY lower(u.display_name), u.email, a.ended_at, a.id`,
      )
    ).rows;
    const events = (
      await this.pool.query(
        `SELECT v.id, v.admin_id AS "adminId", v.kind, u.display_name AS "displayName", x.display_name AS "actorName", v.at, v.reason
           FROM storage_admin_events v JOIN storage_admins a ON a.id = v.admin_id JOIN users u ON u.id = a.user_id JOIN users x ON x.id = v.actor_id
          ORDER BY lower(u.display_name), u.email, v.at, CASE v.kind WHEN 'designated' THEN 1 ELSE 2 END, v.id`,
      )
    ).rows;
    const warning =
      (
        await this.pool.query<{ w: string | null }>(
          `SELECT last_check->>'sourceAreaWarning' AS w FROM storage_destinations WHERE purpose = 'source_area' AND status = 'approved' ORDER BY created_at, id LIMIT 1`,
        )
      ).rows[0]?.w ?? null;
    const iso = (r: Record<string, unknown>, keys: string[]) => {
      for (const k of keys) r[k] = (r[k] as Date).toISOString();
      return r;
    };
    return {
      admins: admins.map((r) => iso(r, ['designatedAt'])) as unknown as StorageAdminRow[],
      ended: ended.map((r) => iso(r, ['designatedAt', 'endedAt'])) as unknown as EndedAdminRow[],
      events: events.map((r) => iso(r, ['at'])) as unknown as StorageAdminEvent[],
      warning,
    };
  }

  /** An Enterprise Administrator designates another Active person, with a reason (never themselves, D104). */
  async designate(user: AuthUser, userId: unknown, reasonInput: unknown): Promise<{ id: string }> {
    const reason = readReason(reasonInput);
    if (typeof userId !== 'string' || !UUID.test(userId)) throw new BadRequestException('Choose the person to make a storage Administrator.');
    if (userId === user.id) throw new BadRequestException('You cannot make yourself a storage Administrator. Another Enterprise Administrator must do it.');
    const at = this.clock();
    const id = uuidv7(at.getTime());
    const folderId = await this.tx(async (c) => {
      const person = (await c.query<{ status: string }>(`SELECT status FROM users WHERE id = $1 FOR UPDATE`, [userId])).rows[0];
      if (!person) throw new NotFoundException('That person was not found.');
      if (person.status !== 'active') throw new BadRequestException('Only a person with an active account can be made a storage Administrator.');
      try {
        await c.query(`INSERT INTO storage_admins (id, user_id, designated_by, designated_at, reason) VALUES ($1, $2, $3, $4, $5)`, [id, userId, user.id, at, reason]);
      } catch (e) {
        if ((e as { code?: string }).code === '23505') throw new ConflictException('That person is already a storage Administrator.');
        throw e;
      }
      await c.query(`INSERT INTO storage_admin_events (id, admin_id, kind, actor_id, at, reason) VALUES ($1, $2, 'designated', $3, $4, $5)`, [uuidv7(at.getTime()), id, user.id, at, reason]);
      await writeAudit(c, { at, action: 'storage.admin_designated', actorUserId: user.id, subjectType: 'storage_admin', subjectId: id, detail: { userId } });
      return this.queueSync(c, 'normal');
    });
    if (!folderId) await this.ensureFolderAndQueue();
    return { id };
  }

  /** Ends a designation, with a reason; the person's write access is revoked. */
  async end(user: AuthUser, designationId: string, reasonInput: unknown): Promise<{ id: string }> {
    const reason = readReason(reasonInput);
    if (!UUID.test(designationId)) throw new NotFoundException();
    const at = this.clock();
    await this.tx(async (c) => {
      const a = (await c.query<{ user_id: string; ended_at: Date | null }>(`SELECT user_id, ended_at FROM storage_admins WHERE id = $1 FOR UPDATE`, [designationId])).rows[0];
      if (!a) throw new NotFoundException();
      if (a.ended_at) throw new ConflictException('That designation has already ended.');
      await c.query(`UPDATE storage_admins SET ended_at = $2, ended_by = $3, end_reason = $4 WHERE id = $1`, [designationId, at, user.id, reason]);
      await c.query(`INSERT INTO storage_admin_events (id, admin_id, kind, actor_id, at, reason) VALUES ($1, $2, 'ended', $3, $4, $5)`, [uuidv7(at.getTime()), designationId, user.id, at, reason]);
      await writeAudit(c, { at, action: 'storage.admin_ended', actorUserId: user.id, subjectType: 'storage_admin', subjectId: designationId, detail: { userId: a.user_id } });
      await this.queueSync(c, 'urgent');
    });
    return { id: designationId };
  }

  /** Queues a sync of the source area's folder when it is recorded. Returns its id, or null when there is none yet. */
  private async queueSync(c: PoolClient, priority: 'urgent' | 'normal'): Promise<string | null> {
    const f = (
      await c.query<{ id: string }>(
        `SELECT f.id FROM storage_folders f JOIN storage_destinations d ON d.id = f.destination_id
          WHERE f.level = 'source_root' AND f.key = 'projects' AND d.purpose = 'source_area' ORDER BY f.created_at, f.id LIMIT 1`,
      )
    ).rows[0];
    if (!f) return null;
    await queueFolderSharing(c, f.id, priority);
    return f.id;
  }

  /**
   * The source area's folder is recorded when its first file is stored; designating before that makes it now. A
   * provider failure is not the designation's: the daily check makes the folder and the grants later.
   */
  private async ensureFolderAndQueue(): Promise<void> {
    try {
      const src = await approvedSourceArea(this.pool);
      if (!src) return;
      const { connector, dest } = await this.connectors.forDestination(src.id);
      const folder = await ensureSourceProjectsFolder({ pool: this.pool, clock: this.clock } as StorageDeps, connector, dest);
      await this.tx((c) => queueFolderSharing(c, folder.id, 'normal'));
    } catch (e) {
      if (!(e instanceof StorageError) && !(e instanceof StorageWaitingForKey)) throw e;
    }
  }

  private async tx<T>(work: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
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
}
