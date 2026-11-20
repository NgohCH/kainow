import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { type AuthUser, CLOCK, type Clock } from '../auth/tokens';
import { readReason } from '../common/reason';
import { uuidv7 } from '../common/uuid7';
import { PG_POOL } from '../db/database.module';
import { StorageWaitingForKey, STORAGE_CONNECTORS, localStorageDir, type StorageConnectorFactory } from './connector-factory';
import { GraphConnector } from './connectors/graph';
import { queueStorageJob } from './outbox';
import { loadStorageSettings } from './settings';
import { StorageError, type DestinationCheck, type PermissionInfo } from './types';

export type DestinationKind = 'sharepoint_library' | 'onedrive' | 'local';
export type DestinationPurpose = 'source_area' | 'outputs';
export type DestinationStatus = 'proposed' | 'approved' | 'withdrawn';

export interface Destination {
  id: string;
  connector: 'graph' | 'local';
  kind: DestinationKind;
  purpose: DestinationPurpose;
  label: string;
  siteUrl: string | null;
  accountEmail: string | null;
  folderPath: string | null;
  status: DestinationStatus;
  lastCheck: DestinationCheck | null;
  lastCheckedAt: string | null;
  createdAt: string;
}

export interface AddDestinationInput {
  kind: DestinationKind;
  purpose: DestinationPurpose;
  label: string;
  siteUrl?: string;
  libraryName?: string;
  accountEmail?: string;
  folderPath?: string;
  reason: string;
}

export interface LibraryAllowance {
  storageAdminUserEmails: string[];
  kainowGrantPermissionIds: Set<string>;
  /** A OneDrive destination's own account: its root lists the owner as a user. */
  oneDriveAccountEmail?: string | null;
}

const OPEN_TO_OTHERS = (who: string) => `Others can open everything in this library: ${who}. Limit the library to site owners before approving it.`;
const ONLY_OWNERS = 'Only site owners and administrators can open the library';
const ONEDRIVE_NEEDS_LOOKUP = 'OneDrive destinations need directory lookup. Turn directory lookup on in the storage connection first.';
const LOCAL_REFUSED = 'The local storage folder is for development only and is not available here.';
const SECOND_SOURCE_AREA = 'Another source area is already approved. Withdraw it first.';

/**
 * What the library permission check refuses (D103): everything except the site's owners group, site collection
 * administrators, Kainow's own application and Kainow's own grants (and, for the source area, storage Administrators).
 */
export function libraryPermissionProblems(perms: PermissionInfo[], allowed: LibraryAllowance): PermissionInfo[] {
  const admins = new Set(allowed.storageAdminUserEmails.map((e) => e.trim().toLowerCase()));
  return perms.filter((p) => {
    if (p.kind === 'owner_group' || p.kind === 'site_admin' || p.kind === 'app') return false;
    if (allowed.kainowGrantPermissionIds.has(p.id)) return false;
    if (p.kind === 'user' && admins.has(p.principal.trim().toLowerCase())) return false;
    if (p.kind === 'user' && allowed.oneDriveAccountEmail && p.principal.trim().toLowerCase() === allowed.oneDriveAccountEmail.trim().toLowerCase()) return false;
    return true;
  });
}

type Db = Pool | PoolClient;
interface Row {
  id: string; connector: 'graph' | 'local'; kind: DestinationKind; purpose: DestinationPurpose; label: string;
  site_url: string | null; account_email: string | null; folder_path: string | null; status: DestinationStatus;
  last_check: DestinationCheck | null; last_checked_at: Date | null; created_at: Date;
}
const COLS = `id, connector, kind, purpose, label, site_url, account_email, folder_path, status, last_check, last_checked_at, created_at`;
const toDestination = (r: Row): Destination => ({
  id: r.id, connector: r.connector, kind: r.kind, purpose: r.purpose, label: r.label, siteUrl: r.site_url,
  accountEmail: r.account_email, folderPath: r.folder_path, status: r.status, lastCheck: r.last_check,
  lastCheckedAt: r.last_checked_at ? r.last_checked_at.toISOString() : null, createdAt: r.created_at.toISOString(),
});

const text = (v: unknown, label: string, max: number): string => {
  const t = typeof v === 'string' ? v.trim() : '';
  if (t === '' || t.length > max) throw new BadRequestException(`Give ${label} (up to ${max} characters).`);
  return t;
};
const optionalText = (v: unknown, label: string, max: number): string | undefined => {
  if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) return undefined;
  return text(v, label, max);
};

/** Reads and checks the body of POST /admin/storage/destinations. */
export function parseAddBody(body: unknown): AddDestinationInput {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException('Send the details as a JSON object.');
  const b = body as Record<string, unknown>;
  const reason = readReason(b.reason);
  if (b.kind !== 'sharepoint_library' && b.kind !== 'onedrive' && b.kind !== 'local') throw new BadRequestException('Choose a SharePoint library or a OneDrive account.');
  if (b.purpose !== 'source_area' && b.purpose !== 'outputs') throw new BadRequestException('Choose whether this is the source area or an outputs destination.');
  const input: AddDestinationInput = { kind: b.kind, purpose: b.purpose, label: text(b.label, 'a name for this destination', 100), reason };
  input.siteUrl = optionalText(b.siteUrl, 'the site address', 500);
  input.libraryName = optionalText(b.libraryName, 'the library name', 200);
  input.accountEmail = optionalText(b.accountEmail, 'the account email address', 254);
  input.folderPath = optionalText(b.folderPath, 'the folder path', 500);
  return input;
}

@Injectable()
export class DestinationsService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(STORAGE_CONNECTORS) private readonly connectors: StorageConnectorFactory,
  ) {}

  async list(): Promise<Destination[]> {
    const rows = (await this.pool.query<Row>(`SELECT ${COLS} FROM storage_destinations ORDER BY purpose, lower(label), id`)).rows;
    return rows.map(toDestination);
  }

  async add(user: AuthUser, input: AddDestinationInput): Promise<Destination> {
    const id = uuidv7(this.clock().getTime());
    let connector: 'graph' | 'local' = 'graph';
    let siteUrl: string | null = null;
    let accountEmail: string | null = null;
    let folderPath: string | null = null;
    let ids: { siteId: string | null; driveId: string; rootItemId: string };
    try {
      if (input.kind === 'local') {
        if (!localStorageDir()) throw new BadRequestException(LOCAL_REFUSED);
        connector = 'local';
        await this.connectors.forNew('local'); // proves the folder can be used
        ids = { siteId: null, driveId: `local-${id}`, rootItemId: `root-${id}` };
      } else if (input.kind === 'sharepoint_library') {
        if (!input.siteUrl || !input.libraryName) throw new BadRequestException('Give the site address and the library name.');
        siteUrl = input.siteUrl;
        const graph = await this.graphFor('sharepoint_library');
        ids = await graph.resolveSharePointLibrary(input.siteUrl, input.libraryName);
      } else {
        if (!input.accountEmail || !/^[^\s@]+@[^\s@]+$/.test(input.accountEmail)) throw new BadRequestException("Give the account's email address.");
        if (!(await loadStorageSettings(this.pool)).directoryLookup) throw new ConflictException(ONEDRIVE_NEEDS_LOOKUP);
        accountEmail = input.accountEmail;
        folderPath = input.folderPath ?? null;
        const graph = await this.graphFor('onedrive');
        ids = { siteId: null, ...(await graph.resolveOneDrive(input.accountEmail, input.folderPath)) };
      }
    } catch (e) {
      throw this.translate(e);
    }
    const at = this.clock();
    await this.inTransaction(async (c) => {
      await c.query(
        `INSERT INTO storage_destinations (id, connector, kind, purpose, label, site_url, account_email, folder_path, site_id, drive_id, root_item_id, status, created_by, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'proposed', $12, $13)`,
        [id, connector, input.kind, input.purpose, input.label, siteUrl, accountEmail, folderPath, ids.siteId, ids.driveId, ids.rootItemId, user.id, at],
      );
      await this.event(c, id, 'proposed', user.id, at, input.reason, { kind: input.kind, purpose: input.purpose });
    });
    await this.runCheck(user, id);
    return this.get(id);
  }

  /** Runs the check, records and returns it. A provider failure is the result, not an error. */
  async check(user: AuthUser, id: string): Promise<DestinationCheck> {
    await this.load(this.pool, id);
    return this.runCheck(user, id);
  }

  async approve(user: AuthUser, id: string, reason: string): Promise<Destination> {
    const why = readReason(reason);
    const before = await this.load(this.pool, id);
    if (before.status === 'approved') throw new ConflictException('This destination is already approved.');
    if (before.purpose === 'source_area' && (await this.approvedSourceArea())) throw new ConflictException(SECOND_SOURCE_AREA);
    const result = await this.runCheck(user, id);
    if (!result.ok) {
      const bad = result.lines.find((l) => !l.ok && l.key === 'library_permissions') ?? result.lines.find((l) => !l.ok);
      throw new ConflictException(bad ? bad.detail : 'The check did not pass.');
    }
    const at = this.clock();
    try {
      await this.inTransaction(async (c) => {
        // Turning directory lookup off locks this row too, so the two cannot pass each other.
        await c.query(`SELECT 1 FROM storage_settings FOR UPDATE`);
        const row = await this.load(c, id, true);
        if (row.status === 'approved') throw new ConflictException('This destination is already approved.');
        if (row.kind === 'onedrive' && !(await loadStorageSettings(c)).directoryLookup) throw new ConflictException(ONEDRIVE_NEEDS_LOOKUP);
        await c.query(`UPDATE storage_destinations SET status = 'approved' WHERE id = $1`, [id]);
        await this.event(c, id, 'approved', user.id, at, why, {});
        // A new source area stores every version still waiting, oldest first (spec 9.1).
        if (row.purpose === 'source_area') await queueStorageJob(c, 'backfill-sources', id);
      });
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new ConflictException(SECOND_SOURCE_AREA);
      throw e;
    }
    return this.get(id);
  }

  /** Stored files keep their references and checks: only the destination's status changes. */
  async withdraw(user: AuthUser, id: string, reason: string): Promise<Destination> {
    const why = readReason(reason);
    const at = this.clock();
    await this.inTransaction(async (c) => {
      const row = await this.load(c, id, true);
      if (row.status === 'withdrawn') throw new ConflictException('This destination is already withdrawn.');
      await c.query(`UPDATE storage_destinations SET status = 'withdrawn' WHERE id = $1`, [id]);
      await this.event(c, id, 'withdrawn', user.id, at, why, {});
    });
    return this.get(id);
  }

  // ---- internals ----

  private async runCheck(user: AuthUser, id: string): Promise<DestinationCheck> {
    const row = await this.load(this.pool, id);
    let result: DestinationCheck;
    try {
      const { connector, dest } = await this.connectors.forDestination(id);
      const raw = await connector.checkDestination(dest, { testPerson: user.email });
      result = await this.applyLibraryRule(raw, row);
    } catch (e) {
      if (e instanceof StorageWaitingForKey) throw this.translate(e);
      if (!(e instanceof StorageError)) throw e;
      const detail = e.message;
      result = { ok: false, lines: [{ key: 'reachable', ok: false, detail }], quotaBytes: null, usedBytes: null, others: [] };
    }
    const at = this.clock();
    await this.inTransaction(async (c) => {
      await c.query(`UPDATE storage_destinations SET last_check = $2, last_checked_at = $3 WHERE id = $1`, [id, JSON.stringify(result), at]);
      await this.event(c, id, 'checked', user.id, at, null, { ok: result.ok, failed: result.lines.filter((l) => !l.ok).map((l) => l.key) });
    });
    return result;
  }

  /** Re-judges the connector's library line with the allowed list (Kainow's grants; storage Administrators on the source area). */
  private async applyLibraryRule(raw: DestinationCheck, row: Row): Promise<DestinationCheck> {
    const line = raw.lines.find((l) => l.key === 'library_permissions');
    if (!line || (!line.ok && raw.others.length === 0)) return raw; // not evaluated, or the listing failed
    const allowed: LibraryAllowance = {
      oneDriveAccountEmail: row.kind === 'onedrive' ? row.account_email : null,
      storageAdminUserEmails: row.purpose === 'source_area'
        ? (await this.pool.query<{ email: string }>(
            `SELECT u.email FROM storage_admins a JOIN users u ON u.id = a.user_id WHERE a.ended_at IS NULL ORDER BY u.email`,
          )).rows.map((r) => r.email)
        : [],
      kainowGrantPermissionIds: new Set(
        (await this.pool.query<{ permission_id: string }>(
          `SELECT g.permission_id FROM storage_grants g JOIN storage_folders f ON f.id = g.folder_id
            WHERE f.destination_id = $1 AND g.permission_id IS NOT NULL AND g.state <> 'revoked'`,
          [row.id],
        )).rows.map((r) => r.permission_id),
      ),
    };
    const problems = libraryPermissionProblems(raw.others, allowed);
    const lines = raw.lines.map((l) =>
      l.key === 'library_permissions'
        ? { ...l, ok: problems.length === 0, detail: problems.length ? OPEN_TO_OTHERS(problems.map((p) => p.principal).join(', ')) : ONLY_OWNERS }
        : l,
    );
    return { ...raw, lines, ok: lines.every((l) => l.ok), others: problems };
  }

  private async graphFor(kind: 'sharepoint_library' | 'onedrive'): Promise<GraphConnector> {
    const connector = await this.connectors.forNew(kind);
    if (!(connector instanceof GraphConnector)) throw new StorageError('invalid');
    return connector;
  }

  private translate(e: unknown): Error {
    if (e instanceof StorageWaitingForKey) return new ConflictException(e.message);
    if (e instanceof StorageError) {
      if (e.code === 'invalid') return new BadRequestException('Storage is not set up yet, or the details given are not valid. Check the storage connection and the details, then try again.');
      if (e.code === 'not_found') return new BadRequestException('That site or library was not found. Check the address and name, and that the application has been granted access to the site.');
      return new BadRequestException(e.message);
    }
    return e instanceof Error ? e : new Error('Unexpected error');
  }

  private async approvedSourceArea(): Promise<boolean> {
    return ((await this.pool.query(`SELECT 1 FROM storage_destinations WHERE purpose = 'source_area' AND status = 'approved'`)).rowCount ?? 0) > 0;
  }

  private async get(id: string): Promise<Destination> {
    return toDestination(await this.load(this.pool, id));
  }

  private async load(db: Db, id: string, lock = false): Promise<Row> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new NotFoundException();
    const r = (await db.query<Row>(`SELECT ${COLS} FROM storage_destinations WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id])).rows[0];
    if (!r) throw new NotFoundException();
    return r;
  }

  private async event(c: PoolClient, destinationId: string, kind: string, actorId: string | null, at: Date, reason: string | null, detail: unknown): Promise<void> {
    await c.query(
      `INSERT INTO storage_destination_events (id, destination_id, kind, actor_id, at, reason, detail) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [uuidv7(at.getTime()), destinationId, kind, actorId, at, reason, JSON.stringify(detail)],
    );
  }

  private async inTransaction<T>(work: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}
