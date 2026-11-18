import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { writeAudit } from '../audit/audit';
import { CLOCK, type AuthUser, type Clock } from '../auth/tokens';
import { readReason, refuseSecretsIn } from '../common/reason';
import { UUID, uuidv7 } from '../common/uuid7';
import { PG_POOL } from '../db/database.module';
import { ProjectAccess, type ProjectContext } from '../projects/access.service';
import { PROJECT_MATRIX, decide } from '../projects/matrix';
import { PROTECTED_KEY, type ProtectedKey } from '../quarantine/protected-key';
import { readSettings } from '../spend/spend.settings';
import { type KeyCheck, type SealedRow, checkKey, checkStoredKey, keyReadable } from './key-check';
import { type KeyBinding, KeyUnreadableError, type Provider, normaliseApiKey, sealApiKey } from './keys';
import { PROVIDER_NAMES, markKeyRejected } from './key-rejected';
import { ModelsService } from './models.service';

type Db = Pool | PoolClient;

export type ConnectionState = 'ready' | 'unchecked' | 'key_rejected' | 'disabled';
export type DisplayState = ConnectionState | 'model_withdrawn' | 'waiting_for_key' | 'key_unreadable';

export const STATE_LABELS: Readonly<Record<DisplayState, string>> = {
  ready: 'Ready',
  unchecked: 'Unchecked',
  key_rejected: 'Key rejected',
  disabled: 'Disabled',
  model_withdrawn: 'Model withdrawn',
  waiting_for_key: 'Waiting for the protected key',
  key_unreadable: 'Key unreadable — enter it again',
};

export const NO_PROTECTED_KEY = 'AI keys cannot be saved until the protected key is installed. See INSTALL.md.';
const NO_PROTECTED_KEY_CHECK = 'AI keys cannot be checked until the protected key is installed. See INSTALL.md.';
const NOT_DELEGATED = 'The Administrator has not allowed projects to manage their own AI connections.';
const MANAGE = 'ai.connections.manage';
const PROVIDER_NAME = PROVIDER_NAMES;

/** Checker injected by tests; the real one calls the provider's model listing. */
export type KeyChecker = (provider: Provider, apiKey: string, modelId: string) => Promise<KeyCheck>;

interface ConnectionRow {
  id: string;
  project_id: string;
  model_ref: string;
  label: string;
  position: number;
  state: ConnectionState;
  rejected_at: Date | null;
  rejected_status: number | null;
  last_used_at: Date | null;
  created_at: Date;
  provider: Provider;
  model_id: string;
  display_name: string;
  model_state: 'approved' | 'withdrawn';
  key_ciphertext: Buffer | null;
  key_nonce: Buffer | null;
  key_tag: Buffer | null;
  key_id: string | null;
}

const SELECT = `SELECT c.id, c.project_id, c.model_ref, c.label, c.position, c.state, c.rejected_at, c.rejected_status, c.last_used_at, c.created_at,
    m.provider, m.model_id, m.display_name, m.state AS model_state,
    k.ciphertext AS key_ciphertext, k.nonce AS key_nonce, k.tag AS key_tag, k.key_id
  FROM ai_connections c
  JOIN ai_models m ON m.id = c.model_ref
  LEFT JOIN ai_connection_keys k ON k.connection_id = c.id AND k.superseded_at IS NULL`;

const text = (value: unknown, label: string, max: number): string => {
  const t = typeof value === 'string' ? value.trim() : '';
  if (t === '' || t.length > max) throw new BadRequestException(`Give ${label} (1 to ${max.toLocaleString('en-US')} characters).`);
  refuseSecretsIn(t);
  return t;
};

const asObject = (body: unknown): Record<string, unknown> => {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException('Send the details as a JSON object.');
  return body as Record<string, unknown>;
};

/** {modelRef, label, apiKey, reason}. The key is checked for shape last and never appears in any message. */
export function parseAddBody(body: unknown): { modelRef: string; label: string; apiKey: string; reason: string } {
  const b = asObject(body);
  if (typeof b.modelRef !== 'string' || !UUID.test(b.modelRef)) throw new BadRequestException('Choose an approved model.');
  const label = text(b.label, 'a label', 100);
  const reason = readReason(b.reason);
  return { modelRef: b.modelRef, label, reason, apiKey: normaliseApiKey(b.apiKey) };
}

export function parseReplaceBody(body: unknown): { apiKey: string; reason: string } {
  const b = asObject(body);
  const reason = readReason(b.reason);
  return { reason, apiKey: normaliseApiKey(b.apiKey) };
}

export function parseReasonBody(body: unknown): string {
  return readReason((body as { reason?: unknown } | null | undefined)?.reason);
}

export function parseOrderBody(body: unknown): { ids: string[]; reason: string } {
  const b = asObject(body);
  if (!Array.isArray(b.ids) || b.ids.some((i) => typeof i !== 'string' || !UUID.test(i))) {
    throw new BadRequestException("Send ids: the project's connections in the order you want.");
  }
  return { ids: b.ids as string[], reason: readReason(b.reason) };
}

const checkMessage = (c: KeyCheck, provider: Provider, modelId: string): string => {
  switch (c.outcome) {
    case 'ok':
      return 'Key works and can use this model';
    case 'refused':
      return 'The provider refused this key';
    case 'no_model':
      return `This key cannot use ${modelId}`;
    case 'unreachable':
      return `Could not reach ${PROVIDER_NAME[provider]} to check the key. It will be checked on first use.`;
  }
};

@Injectable()
export class ConnectionsService {
  /** Replaced in tests. Not part of any request. */
  keyChecker: KeyChecker = (provider, apiKey, modelId) => checkKey(provider, apiKey, modelId);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PROTECTED_KEY) private readonly protectedKey: ProtectedKey | null,
    private readonly access: ProjectAccess,
    private readonly models: ModelsService,
  ) {}

  /** Connections in order with their display states, and the approved models a manager may pick. Never a key or ciphertext. */
  async list(projectId: string, user: AuthUser) {
    const ctx = await this.viewContext(user, projectId);
    const { rows } = await this.pool.query<ConnectionRow>(`${SELECT} WHERE c.project_id = $1 ORDER BY c.position`, [projectId]);
    const approved = (await this.models.list()).filter((m) => m.state === 'approved');
    return {
      connections: rows.map((r) => this.view(r)),
      editable: await this.canEdit(ctx),
      // Disable is a protective action, open in every project state to whoever may manage connections.
      mayDisable: await this.canDisable(ctx),
      models: approved.map((m) => ({ id: m.id, provider: m.provider, modelId: m.modelId, displayName: m.displayName, purposes: m.purposes, restrictedOk: m.restrictedOk })),
      protectedKeyLoaded: this.protectedKey !== null,
    };
  }

  async add(projectId: string, input: { modelRef: string; label: string; apiKey: string; reason: string }, user: AuthUser) {
    await this.authorizeManage(user, projectId, this.pool, false, false);
    const key = this.requireKey(NO_PROTECTED_KEY);
    const model = await this.models.get(input.modelRef);
    if (!model || model.state !== 'approved') throw new BadRequestException('Choose an approved model.');
    const check = await this.keyChecker(model.provider, input.apiKey, model.modelId);
    this.refuseIfFailed(check, model.modelId);
    const state: ConnectionState = check.outcome === 'ok' ? 'ready' : 'unchecked';
    const at = this.clock();
    const id = uuidv7(at.getTime());
    const sealed = sealApiKey(key, input.apiKey, { connectionId: id, projectId, provider: model.provider });
    await this.inTransaction(async (c) => {
      await this.authorizeManage(user, projectId, c, true, false);
      const { rows } = await c.query<{ next: number }>(`SELECT COALESCE(MAX(position), 0) + 1 AS next FROM ai_connections WHERE project_id = $1`, [projectId]);
      const position = rows[0].next;
      await c.query(
        `INSERT INTO ai_connections (id, project_id, model_ref, label, position, state, created_at, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, projectId, model.id, input.label, position, state, at, user.id],
      );
      await this.insertKey(c, id, sealed, at, user.id);
      const detail = { label: input.label, provider: model.provider, modelId: model.modelId, position, state, check: check.outcome };
      await this.record(c, at, projectId, id, 'added', user.id, input.reason, detail);
      await this.record(c, at, projectId, id, 'key_saved', user.id, input.reason, { provider: model.provider });
    });
    return { connection: await this.one(projectId, id), check: this.checkView(check, model.provider, model.modelId) };
  }

  async replaceKey(projectId: string, connectionId: string, input: { apiKey: string; reason: string }, user: AuthUser) {
    await this.authorizeManage(user, projectId, this.pool, false, false);
    const key = this.requireKey(NO_PROTECTED_KEY);
    const before = await this.load(this.pool, projectId, connectionId);
    const check = await this.keyChecker(before.provider, input.apiKey, before.model_id);
    this.refuseIfFailed(check, before.model_id);
    const at = this.clock();
    const sealed = sealApiKey(key, input.apiKey, { connectionId, projectId, provider: before.provider });
    await this.inTransaction(async (c) => {
      await this.authorizeManage(user, projectId, c, true, false);
      const current = await this.load(c, projectId, connectionId, true);
      await c.query(`UPDATE ai_connection_keys SET superseded_at = $2 WHERE connection_id = $1 AND superseded_at IS NULL`, [connectionId, at]);
      await this.insertKey(c, connectionId, sealed, at, user.id);
      // A passing check on the new key clears a rejection. A disabled connection stays disabled.
      const next: ConnectionState = current.state === 'disabled' ? 'disabled' : check.outcome === 'ok' ? 'ready' : 'unchecked';
      await c.query(`UPDATE ai_connections SET state = $2, rejected_at = NULL, rejected_status = NULL, rejection_notified_at = NULL WHERE id = $1`, [connectionId, next]);
      await this.record(c, at, projectId, connectionId, 'key_replaced', user.id, input.reason, { previousState: current.state, state: next, check: check.outcome });
    });
    return { connection: await this.one(projectId, connectionId), check: this.checkView(check, before.provider, before.model_id) };
  }

  /** Free check of the stored key. A key rejected on a real call stays rejected until the key is replaced. */
  async check(projectId: string, connectionId: string, reason: string, user: AuthUser) {
    await this.authorizeManage(user, projectId, this.pool, false, false);
    const key = this.requireKey(NO_PROTECTED_KEY_CHECK);
    const before = await this.load(this.pool, projectId, connectionId);
    const sealed = this.sealedOf(before);
    if (!sealed) throw new ConflictException(STATE_LABELS.key_unreadable);
    let result: KeyCheck;
    try {
      const binding: KeyBinding = { connectionId, projectId, provider: before.provider };
      result = await checkStoredKey(key, sealed, binding, before.model_id, this.keyChecker);
    } catch (err) {
      if (err instanceof KeyUnreadableError) throw new ConflictException(STATE_LABELS.key_unreadable);
      throw err;
    }
    const at = this.clock();
    await this.inTransaction(async (c) => {
      await this.authorizeManage(user, projectId, c, true, false);
      const current = await this.load(c, projectId, connectionId, true);
      let next = current.state;
      if (result.outcome === 'ok' && current.state === 'unchecked') {
        next = 'ready';
        await c.query(`UPDATE ai_connections SET state = 'ready' WHERE id = $1`, [connectionId]);
      }
      if (result.outcome === 'refused' && (current.state === 'ready' || current.state === 'unchecked')) {
        // The same rejected-key behaviour as a real call (spec 5.4): state, event, History line and notices, once.
        next = 'key_rejected';
        await markKeyRejected(c, { connectionId, status: result.status, at });
      }
      const detail: Record<string, unknown> = { outcome: result.outcome, previousState: current.state, state: next };
      if (result.outcome === 'refused') detail.status = result.status;
      await this.record(c, at, projectId, connectionId, 'checked', user.id, reason, detail);
    });
    return { connection: await this.one(projectId, connectionId), check: this.checkView(result, before.provider, before.model_id) };
  }

  /** Allowed in every project state: a protective action. */
  async disable(projectId: string, connectionId: string, reason: string, user: AuthUser) {
    await this.authorizeManage(user, projectId, this.pool, false, true);
    const at = this.clock();
    await this.inTransaction(async (c) => {
      await this.authorizeManage(user, projectId, c, true, true);
      const current = await this.load(c, projectId, connectionId, true);
      if (current.state === 'disabled') throw new ConflictException('This connection is already disabled.');
      await c.query(`UPDATE ai_connections SET state = 'disabled' WHERE id = $1`, [connectionId]);
      await this.record(c, at, projectId, connectionId, 'disabled', user.id, reason, { previousState: current.state });
    });
    return { connection: await this.one(projectId, connectionId) };
  }

  /** Back to what it was before it was disabled: a rejected key stays rejected; ready returns ready; anything else is unchecked. */
  async enable(projectId: string, connectionId: string, reason: string, user: AuthUser) {
    await this.authorizeManage(user, projectId, this.pool, false, false);
    const at = this.clock();
    await this.inTransaction(async (c) => {
      await this.authorizeManage(user, projectId, c, true, false);
      const current = await this.load(c, projectId, connectionId, true);
      if (current.state !== 'disabled') throw new ConflictException('This connection is not disabled.');
      const { rows } = await c.query<{ previous: string | null }>(
        `SELECT detail->>'previousState' AS previous FROM ai_connection_events WHERE connection_id = $1 AND action = 'disabled' ORDER BY at DESC, id DESC LIMIT 1`,
        [connectionId],
      );
      const next: ConnectionState = current.rejected_at !== null ? 'key_rejected' : rows[0]?.previous === 'ready' ? 'ready' : 'unchecked';
      await c.query(`UPDATE ai_connections SET state = $2 WHERE id = $1`, [connectionId, next]);
      await this.record(c, at, projectId, connectionId, 'enabled', user.id, reason, { state: next });
    });
    return { connection: await this.one(projectId, connectionId) };
  }

  /** `ids` must be every connection of the project once; positions become 1..n in one transaction (the unique is deferred). */
  async reorder(projectId: string, ids: string[], reason: string, user: AuthUser) {
    await this.authorizeManage(user, projectId, this.pool, false, false);
    const at = this.clock();
    await this.inTransaction(async (c) => {
      await this.authorizeManage(user, projectId, c, true, false);
      const { rows } = await c.query<{ id: string; position: number }>(`SELECT id, position FROM ai_connections WHERE project_id = $1 ORDER BY position FOR UPDATE`, [projectId]);
      const have = new Set(rows.map((r) => r.id));
      if (ids.length !== have.size || new Set(ids).size !== ids.length || ids.some((i) => !have.has(i))) {
        throw new BadRequestException('List every connection of this project exactly once.');
      }
      const was = new Map(rows.map((r) => [r.id, r.position]));
      for (const [i, id] of ids.entries()) {
        const position = i + 1;
        if (was.get(id) === position) continue;
        await c.query(`UPDATE ai_connections SET position = $2 WHERE id = $1`, [id, position]);
        await this.record(c, at, projectId, id, 'reordered', user.id, reason, { previousPosition: was.get(id), position });
      }
    });
    return this.list(projectId, user);
  }

  // ---- access ----

  private async viewContext(user: AuthUser, projectId: string): Promise<ProjectContext> {
    return user.role === 'enterprise_administrator' ? this.access.context(user, projectId) : this.access.authorize(user, 'ai.connections.view', projectId);
  }

  private async canEdit(ctx: ProjectContext): Promise<boolean> {
    if (!PROJECT_MATRIX[MANAGE].states.includes(ctx.project.status)) return false;
    if (ctx.isAdmin) return true;
    const settings = await readSettings(this.pool);
    return decide({ action: MANAGE, roles: ctx.roles, status: ctx.project.status }).allowed && (settings?.projectsMayManageConnections ?? false);
  }

  private async canDisable(ctx: ProjectContext): Promise<boolean> {
    if (ctx.isAdmin) return true;
    const settings = await readSettings(this.pool);
    return decide({ action: MANAGE, roles: ctx.roles, status: 'active' }).allowed && (settings?.projectsMayManageConnections ?? false);
  }

  /**
   * 404 for a non-participant; 403 for a project state that is closed to the change (disable is open in every state) or a person who
   * may not manage connections (a delegate only while the Administrator allows it).
   */
  private async authorizeManage(user: AuthUser, projectId: string, db: Db, lock: boolean, protective: boolean): Promise<ProjectContext> {
    const ctx = await this.access.context(user, projectId, db, lock);
    const row = PROJECT_MATRIX[MANAGE];
    if (!protective && !row.states.includes(ctx.project.status)) throw new ForbiddenException(row.refusal);
    if (!ctx.isAdmin) {
      const verdict = decide({ action: MANAGE, roles: ctx.roles, status: protective ? 'active' : ctx.project.status });
      if (!verdict.allowed) throw new ForbiddenException(verdict.reason);
      const settings = await readSettings(db);
      if (!settings?.projectsMayManageConnections) throw new ForbiddenException(NOT_DELEGATED);
    }
    return ctx;
  }

  // ---- helpers ----

  private requireKey(message: string): ProtectedKey {
    if (!this.protectedKey) throw new ConflictException(message);
    return this.protectedKey;
  }

  private refuseIfFailed(check: KeyCheck, modelId: string): void {
    if (check.outcome === 'refused') throw new BadRequestException('The provider refused this key');
    if (check.outcome === 'no_model') throw new BadRequestException(`This key cannot use ${modelId}`);
  }

  private checkView(check: KeyCheck, provider: Provider, modelId: string) {
    return { outcome: check.outcome, message: checkMessage(check, provider, modelId) };
  }

  private sealedOf(r: ConnectionRow): SealedRow | null {
    return r.key_ciphertext && r.key_nonce && r.key_tag && r.key_id ? { ciphertext: r.key_ciphertext, nonce: r.key_nonce, tag: r.key_tag, keyId: r.key_id } : null;
  }

  /** Precedence: no protected key, unreadable key, withdrawn model, then the stored state. Reading tries a decrypt and keeps nothing. */
  private displayState(r: ConnectionRow): DisplayState {
    if (!this.protectedKey) return 'waiting_for_key';
    const sealed = this.sealedOf(r);
    if (!sealed || !keyReadable(this.protectedKey, sealed, { connectionId: r.id, projectId: r.project_id, provider: r.provider })) return 'key_unreadable';
    if (r.model_state === 'withdrawn') return 'model_withdrawn';
    return r.state;
  }

  private view(r: ConnectionRow) {
    const state = this.displayState(r);
    return {
      id: r.id,
      label: r.label,
      position: r.position,
      provider: r.provider,
      modelRef: r.model_ref,
      modelId: r.model_id,
      displayName: r.display_name,
      state,
      stateLabel: STATE_LABELS[state],
      storedState: r.state,
      rejectedAt: r.rejected_at,
      rejectedStatus: r.rejected_status,
      lastUsedAt: r.last_used_at,
      createdAt: r.created_at,
    };
  }

  private async one(projectId: string, id: string) {
    return this.view(await this.load(this.pool, projectId, id));
  }

  private async load(db: Db, projectId: string, id: string, lock = false): Promise<ConnectionRow> {
    if (!UUID.test(id)) throw new NotFoundException('Connection not found');
    const { rows } = await db.query<ConnectionRow>(`${SELECT} WHERE c.id = $1 AND c.project_id = $2${lock ? ' FOR UPDATE OF c' : ''}`, [id, projectId]);
    if (!rows[0]) throw new NotFoundException('Connection not found');
    return rows[0];
  }

  private async insertKey(c: PoolClient, connectionId: string, sealed: ReturnType<typeof sealApiKey>, at: Date, userId: string): Promise<void> {
    await c.query(
      `INSERT INTO ai_connection_keys (id, connection_id, ciphertext, nonce, tag, key_id, saved_at, saved_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [uuidv7(at.getTime()), connectionId, sealed.ciphertext, sealed.nonce, sealed.tag, sealed.keyId, at, userId],
    );
  }

  /** The event row and the audit row carry only non-secret values. */
  private async record(c: PoolClient, at: Date, projectId: string, connectionId: string, action: string, actorId: string, reason: string, detail: Record<string, unknown>): Promise<void> {
    await c.query(`INSERT INTO ai_connection_events (id, connection_id, action, actor_id, reason, detail, at) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [
      uuidv7(at.getTime()),
      connectionId,
      action,
      actorId,
      reason,
      JSON.stringify(detail),
      at,
    ]);
    await writeAudit(c, { at, action: `ai.connection_${action}`, actorUserId: actorId, subjectType: 'ai_connection', subjectId: connectionId, detail: { projectId, ...detail } });
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
