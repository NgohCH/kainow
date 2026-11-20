import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { writeAudit } from '../audit/audit';
import { CLOCK, type AuthUser, type Clock } from '../auth/tokens';
import { readReason } from '../common/reason';
import { uuidv7 } from '../common/uuid7';
import { PG_POOL } from '../db/database.module';
import { M365TokenSource, TokenError } from '../email/m365-token';
import { PROTECTED_KEY, type ProtectedKey } from '../quarantine/protected-key';
import { GraphConnector } from './connectors/graph';
import { INPUT_FORMATS, OUTPUT_FORMATS, type InputFormat, type OutputFormat, type StorageSettings, loadStorageSettings } from './settings';
import { queueSourceBackfill } from './source-backfill';
import { STORAGE_CONNECTION_ID, StorageSecretUnreadable, normaliseClientSecret, openStorageSecret, sealStorageSecret } from './secret';

export const NO_PROTECTED_KEY = 'Storage credentials cannot be saved until the protected key is installed. See INSTALL.md.';
const NO_PROTECTED_KEY_FOR_LOOKUP = 'Directory lookup cannot be checked until the protected key is installed. See INSTALL.md.';
const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const NOT_CONFIGURED_FOR_LOOKUP = 'Save the tenant ID, application ID and client secret before turning directory lookup on.';
const LOOKUP_FAILED =
  'Your own address could not be looked up, so directory lookup was not turned on. The permission User.ReadBasic.All may not be granted to the application yet.';
const LOOKUP_OFF_REFUSED = 'Directory lookup cannot be turned off while a OneDrive destination is approved. Withdraw that destination first.';
const NO_INPUT_FORMAT = 'Keep at least one approved input format.';

export type CheckState = 'connected' | 'refused' | 'unreachable' | 'not_configured' | 'protected_key_missing';

type Db = Pool | PoolClient;
type SecretRow = { ciphertext: Buffer; nonce: Buffer; tag: Buffer; key_id: string };

const CURRENT_SECRET = `SELECT ciphertext, nonce, tag, key_id FROM storage_connection_secrets WHERE superseded_at IS NULL`;

/**
 * The token source for the storage connection, or null when the tenant, application id or secret is missing or the
 * protected key is missing or cannot open the secret. Database errors propagate. `fetchFn` is for tests.
 */
export async function storageTokenSource(
  db: Db,
  key: ProtectedKey | null,
  fetchFn: typeof fetch = fetch,
  clock?: Clock,
  override: { tenantId?: string | null; clientId?: string | null } = {},
): Promise<M365TokenSource | null> {
  if (!key) return null;
  const s = (await db.query<{ tenant_id: string | null; client_id: string | null }>(`SELECT tenant_id, client_id FROM storage_settings`)).rows[0];
  const tenantId = override.tenantId !== undefined ? override.tenantId : s?.tenant_id;
  const clientId = override.clientId !== undefined ? override.clientId : s?.client_id;
  if (!tenantId || !clientId) return null;
  const row = (await db.query<SecretRow>(CURRENT_SECRET)).rows[0];
  if (!row) return null;
  let clientSecret: string;
  try {
    clientSecret = openSecretRow(key, row);
  } catch (e) {
    // Only an unreadable secret means "no credentials"; a database error is not hidden.
    if (e instanceof StorageSecretUnreadable) return null;
    throw e;
  }
  return new M365TokenSource({ tenantId, clientId, clientSecret }, fetchFn, clock, undefined, GRAPH_SCOPE);
}

const openSecretRow = (key: ProtectedKey, row: SecretRow): string =>
  openStorageSecret(key, { ciphertext: row.ciphertext, nonce: row.nonce, tag: row.tag, keyId: row.key_id }, STORAGE_CONNECTION_ID);

const asObject = (body: unknown): Record<string, unknown> => {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException('Send the details as a JSON object.');
  return body as Record<string, unknown>;
};

export interface SettingsPatch {
  tenantId?: string | null;
  clientId?: string | null;
  approvedInputFormats?: InputFormat[];
  approvedOutputFormats?: OutputFormat[];
  projectsMayChangeFormats?: boolean;
  projectsMayChooseDestination?: boolean;
  projectsMaySetExportRoles?: boolean;
  directoryLookup?: boolean;
  scheduledChecks?: boolean;
}

const identifier = (v: unknown, label: string): string | null => {
  if (v === null) return null;
  const t = typeof v === 'string' ? v.trim() : '';
  if (t === '') return null;
  if (t.length > 100 || !/^[A-Za-z0-9._-]+$/.test(t)) throw new BadRequestException(`This does not look like ${label}.`);
  return t;
};

const formats = <T extends string>(v: unknown, allowed: readonly T[], label: string): T[] => {
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !(allowed as readonly string[]).includes(x))) {
    throw new BadRequestException(`Choose ${label} from: ${allowed.join(', ')}.`);
  }
  return allowed.filter((a) => v.includes(a));
};

const bool = (v: unknown, label: string): boolean => {
  if (typeof v !== 'boolean') throw new BadRequestException(`${label} must be on or off.`);
  return v;
};

/** { reason, ...non-secret fields }. Fields left out stay as they are. */
export function parseSettingsBody(body: unknown): { reason: string; patch: SettingsPatch } {
  const b = asObject(body);
  const reason = readReason(b.reason);
  const patch: SettingsPatch = {};
  if ('tenantId' in b) patch.tenantId = identifier(b.tenantId, 'a tenant ID');
  if ('clientId' in b) patch.clientId = identifier(b.clientId, 'an application (client) ID');
  if ('approvedInputFormats' in b) patch.approvedInputFormats = formats(b.approvedInputFormats, INPUT_FORMATS, 'input formats');
  if ('approvedOutputFormats' in b) patch.approvedOutputFormats = formats(b.approvedOutputFormats, OUTPUT_FORMATS, 'output formats');
  if ('projectsMayChangeFormats' in b) patch.projectsMayChangeFormats = bool(b.projectsMayChangeFormats, 'Projects may change formats');
  if ('projectsMayChooseDestination' in b) patch.projectsMayChooseDestination = bool(b.projectsMayChooseDestination, 'Projects may choose a destination');
  if ('projectsMaySetExportRoles' in b) patch.projectsMaySetExportRoles = bool(b.projectsMaySetExportRoles, 'Projects may set export roles');
  if ('directoryLookup' in b) patch.directoryLookup = bool(b.directoryLookup, 'Directory lookup');
  if ('scheduledChecks' in b) patch.scheduledChecks = bool(b.scheduledChecks, 'Scheduled checks');
  return { reason, patch };
}

/** { reason, clientSecret }. The secret is checked for shape last and never appears in any message. */
export function parseSecretBody(body: unknown): { reason: string; clientSecret: string } {
  const b = asObject(body);
  const reason = readReason(b.reason);
  return { reason, clientSecret: normaliseClientSecret(b.clientSecret) };
}

const COLUMNS: Record<keyof SettingsPatch, string> = {
  tenantId: 'tenant_id',
  clientId: 'client_id',
  approvedInputFormats: 'approved_input_formats',
  approvedOutputFormats: 'approved_output_formats',
  projectsMayChangeFormats: 'projects_may_change_formats',
  projectsMayChooseDestination: 'projects_may_choose_destination',
  projectsMaySetExportRoles: 'projects_may_set_export_roles',
  directoryLookup: 'directory_lookup',
  scheduledChecks: 'scheduled_checks',
};

@Injectable()
export class StorageSettingsService {
  /** Replaced in tests (the fake Graph's fetch). Not part of any request. */
  fetchFn: typeof fetch = fetch;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PROTECTED_KEY) private readonly protectedKey: ProtectedKey | null,
  ) {}

  async view() {
    const settings = await loadStorageSettings(this.pool);
    let secret: 'none' | 'saved' | 'unreadable' = settings.hasSecret ? 'saved' : 'none';
    if (settings.hasSecret) {
      const row = (await this.pool.query<SecretRow>(CURRENT_SECRET)).rows[0];
      if (!this.protectedKey || !row) secret = 'unreadable';
      else {
        try {
          openSecretRow(this.protectedKey, row);
        } catch (e) {
          if (!(e instanceof StorageSecretUnreadable)) throw e;
          secret = 'unreadable';
        }
      }
    }
    return {
      settings,
      protectedKeyLoaded: this.protectedKey !== null,
      secret,
      requestedPermissions: [
        { name: 'Sites.Selected', kind: 'application', needed: true },
        { name: 'User.ReadBasic.All', kind: 'application', needed: settings.directoryLookup },
      ],
    };
  }

  async change(patch: SettingsPatch, reason: string, user: AuthUser) {
    const current = await loadStorageSettings(this.pool);
    const next: StorageSettings = { ...current, ...patch };
    if (next.approvedInputFormats.length === 0) throw new BadRequestException(NO_INPUT_FORMAT);
    if (patch.directoryLookup === true && !current.directoryLookup) await this.proveLookup(user, next);
    const at = this.clock();
    await this.inTransaction(async (c) => {
      await c.query(`SELECT 1 FROM storage_settings FOR UPDATE`);
      const before = await loadStorageSettings(c);
      const after: StorageSettings = { ...before, ...patch };
      if (after.approvedInputFormats.length === 0) throw new BadRequestException(NO_INPUT_FORMAT);
      if (patch.directoryLookup === false && before.directoryLookup) {
        const od = await c.query(`SELECT 1 FROM storage_destinations WHERE kind = 'onedrive' AND status IN ('approved', 'retiring') LIMIT 1`);
        if (od.rowCount) throw new ConflictException(LOOKUP_OFF_REFUSED);
      }
      const fields = (Object.keys(patch) as Array<keyof SettingsPatch>).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
      if (fields.length === 0) return;
      const sets = fields.map((k, i) => `${COLUMNS[k]} = $${i + 1}`);
      await c.query(`UPDATE storage_settings SET ${sets.join(', ')}`, fields.map((k) => after[k]));
      await this.record(c, at, user.id, reason, before, after, fields);
      // A changed connection may now reach the source area: versions left waiting are stored (spec 9.1).
      if (fields.some((k) => k === 'tenantId' || k === 'clientId')) await queueSourceBackfill(c);
    });
    return this.view();
  }

  async saveSecret(clientSecret: string, reason: string, user: AuthUser) {
    if (!this.protectedKey) throw new ConflictException(NO_PROTECTED_KEY);
    const sealed = sealStorageSecret(this.protectedKey, clientSecret, STORAGE_CONNECTION_ID);
    const at = this.clock();
    await this.inTransaction(async (c) => {
      await c.query(`SELECT 1 FROM storage_settings FOR UPDATE`);
      const before = await loadStorageSettings(c);
      await c.query(`UPDATE storage_connection_secrets SET superseded_at = $1 WHERE superseded_at IS NULL`, [at]);
      await c.query(
        `INSERT INTO storage_connection_secrets (id, ciphertext, nonce, tag, key_id, saved_by, saved_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [uuidv7(at.getTime()), sealed.ciphertext, sealed.nonce, sealed.tag, sealed.keyId, user.id, at],
      );
      await this.record(c, at, user.id, reason, before, { ...before, hasSecret: true }, ['clientSecret']);
      await queueSourceBackfill(c);
    });
    return this.view();
  }

  async check(): Promise<{ state: CheckState }> {
    const s = await loadStorageSettings(this.pool);
    if (!s.tenantId || !s.clientId || !s.hasSecret) return { state: 'not_configured' };
    if (!this.protectedKey) return { state: 'protected_key_missing' };
    const tokens = await storageTokenSource(this.pool, this.protectedKey, this.fetchFn, this.clock);
    if (!tokens) return { state: 'refused' }; // saved with another protected key: the secret cannot be opened
    let token: string;
    try {
      token = await tokens.token();
    } catch (e) {
      const status = e instanceof TokenError ? e.status : 0;
      return { state: status === 400 || status === 401 || status === 403 ? 'refused' : 'unreachable' };
    }
    try {
      // Sites.Selected without a grant on the root site answers 403: that is the expected, healthy answer.
      const res = await this.fetchFn(`${GRAPH_BASE}/sites/root?$select=id`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
      await res.body?.cancel().catch(() => undefined);
      if (res.status === 401) return { state: 'refused' };
    } catch {
      // the token was issued: the credentials are accepted
    }
    return { state: 'connected' };
  }

  /** Runs a lookup of the Administrator's own address with the merged settings; refuses (saves nothing) when it fails. */
  private async proveLookup(user: AuthUser, next: StorageSettings): Promise<void> {
    if (!this.protectedKey && next.hasSecret) throw new ConflictException(NO_PROTECTED_KEY_FOR_LOOKUP);
    const tokens = await storageTokenSource(this.pool, this.protectedKey, this.fetchFn, this.clock, { tenantId: next.tenantId, clientId: next.clientId });
    if (!tokens || !next.clientId) throw new BadRequestException(NOT_CONFIGURED_FOR_LOOKUP);
    const graph = new GraphConnector(tokens, { appClientId: next.clientId, lookup: true, allowedDomains: async () => [], fetchFn: this.fetchFn });
    let found: 'account' | 'not_found' | 'unknown';
    try {
      found = await graph.lookupPerson(user.email);
    } catch {
      throw new BadRequestException(LOOKUP_FAILED);
    }
    if (found !== 'account') throw new BadRequestException(LOOKUP_FAILED);
  }

  private async record(c: PoolClient, at: Date, actorId: string, reason: string, previous: StorageSettings, next: StorageSettings, fields: string[]): Promise<void> {
    await c.query(`INSERT INTO storage_settings_changes (id, actor_id, at, reason, previous, next) VALUES ($1, $2, $3, $4, $5, $6)`, [
      uuidv7(at.getTime()),
      actorId,
      at,
      reason,
      JSON.stringify(previous),
      JSON.stringify(next),
    ]);
    await writeAudit(c, { at, action: 'storage.connection_changed', actorUserId: actorId, subjectType: 'storage_settings', detail: { fields } });
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
