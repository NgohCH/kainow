import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { writeAudit } from '../audit/audit';
import { CLOCK, type AuthUser, type Clock } from '../auth/tokens';
import { UUID, uuidv7 } from '../common/uuid7';
import { PG_POOL } from '../db/database.module';
import { type ProjectContext, ProjectAccess } from '../projects/access.service';
import { GRANT_READ_ONLY, type ProjectStatus } from '../projects/matrix';
import { membershipState } from '../projects/membership';
import type { Created } from '../records/records.service';
import { type ChangeHandler, HANDLERS, type RequestRow, type Row, type TargetKind } from './handlers';
import { PolicyService } from './policy.service';
import { type ChangeKind, approvalOutcome, kindAllowedIn } from './rules';

export const MISSING_ACCOUNTABILITY = 'The project is missing a required role, so proposals cannot be approved until it is repaired.';
export const NOT_ELIGIBLE = 'Only an Owner or Sponsor of this project can approve.';
export const STALE_VERSION = 'This change was revised; review the new version.';
export const NOT_PENDING = 'This change is no longer waiting for authorisation.';
export const NOT_EDITABLE = 'This change cannot be edited while approving.';
export const notEnough = (need: number, have: number) => `Not enough approvers: needs ${need}, the project has ${have}.`;

const KINDS: readonly ChangeKind[] = [
  'authorise_proposal', 'amend_task', 'cancel_task', 'supersede_decision', 'withdraw_decision', 'deadline_review', 'reconcile_completion', 'risk_handover',
];
const TARGET_KINDS: readonly TargetKind[] = ['extraction_item', 'human_proposal', 'task', 'decision', 'risk'];
const NOUN: Record<TargetKind, string> = { extraction_item: 'proposal', human_proposal: 'proposal', task: 'task', decision: 'decision', risk: 'risk' };
const STATUS_LABEL: Record<ProjectStatus, string> = { draft: 'Draft', planned: 'Planned', active: 'Active', deferred: 'Deferred', closed: 'Closed' };

/** How each kind of target is loaded and locked (its project in "projectId"). */
export const TARGET_SQL: Record<TargetKind, string> = {
  extraction_item: `SELECT i.id, i.run_id AS "runId", i.kind, i.review_status AS "reviewStatus", s.project_id AS "projectId"
                      FROM extraction_items i JOIN extraction_runs r ON r.id = i.run_id
                      JOIN source_versions v ON v.id = r.source_version_id JOIN sources s ON s.id = v.source_id
                     WHERE i.id = $1 FOR UPDATE OF i`,
  human_proposal: `SELECT id, project_id AS "projectId", kind, text, owner, review_status AS "reviewStatus" FROM human_proposals WHERE id = $1 FOR UPDATE`,
  task: `SELECT x.*, x.project_id AS "projectId", to_char(x.due_on, 'YYYY-MM-DD') AS "dueOn" FROM tasks x WHERE x.id = $1 FOR UPDATE`,
  decision: `SELECT x.*, x.project_id AS "projectId" FROM decisions x WHERE x.id = $1 FOR UPDATE`,
  risk: `SELECT x.*, x.project_id AS "projectId", to_char(x.review_on, 'YYYY-MM-DD') AS "reviewOn" FROM risks x WHERE x.id = $1 FOR UPDATE`,
};

const REQUEST_COLUMNS = `id, project_id AS "projectId", kind, target_kind AS "targetKind", target_id AS "targetId", batch_id AS "batchId", version,
  required_approvals AS "requiredApprovals", status, submitted_by AS "submittedBy", submitted_at AS "submittedAt",
  decided_by AS "decidedBy", decided_at AS "decidedAt", reason`;

export interface AppliedResult {
  record?: Created['record'];
  delivered?: boolean;
}

export interface RequestView {
  id: string;
  kind: ChangeKind;
  target: { kind: TargetKind; id: string };
  version: number;
  status: RequestRow['status'];
  requiredApprovals: number;
  approvals: Array<{ name: string; at: Date }>;
  terms: Record<string, unknown>;
  currentTerms?: Record<string, unknown>;
  /** The proposer's reason for the current version. */
  reason: string | null;
  /** Why it was rejected or withdrawn. */
  outcomeReason: string | null;
  submittedBy: string;
  submittedAt: Date;
  /** For a risk hand-over: where the risk comes from and what it says. */
  offer?: { fromProject: { id: string; name: string }; risk: { id: string; description: string; severity: string } };
  mayApprove: boolean;
  mayRevise: boolean;
  mayWithdraw: boolean;
  why: string | null;
  batchId: string | null;
}

export type Deliver = () => Promise<boolean>;

/** A project's closure batch is identified by the project's own id (one batch per project). */
export const isClosureBatch = (batchId: string | null | undefined, projectId: string) => !!batchId && batchId === projectId;

/** Text in a body field, trimmed; '' when absent. */
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const objectOf = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** Terms as a client wrote them, without what only the server works out (the work dropped since it was chosen). */
const clientTerms = (terms: Record<string, unknown>): Record<string, unknown> => {
  const { dropped: _serverOnly, ...rest } = terms;
  return rest;
};

/** People holding an Active Owner or Sponsor membership today: the ones who may approve (each counts once). */
export const eligibleApprovers = (ctx: ProjectContext): string[] => [
  ...new Set(ctx.rows.filter((m) => (m.role === 'owner' || m.role === 'sponsor') && membershipState(m, ctx.today) === 'active').map((m) => m.userId)),
];

/**
 * Change requests: anything that needs Owner/Sponsor authorisation is submitted as a request, approved by a
 * configurable number of distinct approvers in any order, and applied by the approval that completes the count, in
 * that approval's transaction (spec §3).
 */
/** Terms are equal when they hold the same values, whatever order the keys come in (jsonb returns them in its own order). */
function sameTerms(a: unknown, b: unknown): boolean {
  const canonical = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([x], [y]) => (x < y ? -1 : 1)).map(([k, x]) => [k, canonical(x)])) : v;
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

@Injectable()
export class ChangesService {
  private readonly registered = new Map<ChangeKind, ChangeHandler>();

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly now: Clock,
    private readonly access: ProjectAccess,
    private readonly policy: PolicyService,
  ) {}

  /** Adds a handler that needs this application's services (overrides HANDLERS for its kind). */
  register(handler: ChangeHandler): void {
    this.registered.set(handler.kind, handler);
  }

  private handler(kind: ChangeKind): ChangeHandler | undefined {
    return this.registered.get(kind) ?? HANDLERS[kind];
  }

  private async tx<T>(work: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const out = await work(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** Runs a write and then, after it commits, delivers any email it prepared. */
  private async withDelivery(work: (c: PoolClient, later: (d: Deliver) => void) => Promise<{ request: RequestView; applied?: AppliedResult }>) {
    let deliver: Deliver | null = null;
    const out = await this.tx((c) => work(c, (d) => (deliver = d)));
    if (deliver && out.applied) out.applied.delivered = await (deliver as Deliver)();
    return out;
  }

  /** A refused rule: 400 (missing input), 403 (not this person's) or 409 (state). */
  private static refuse(reason: string): never {
    if (reason.startsWith('Write ') || reason === 'A reason is required.') throw new BadRequestException(reason);
    if (reason.startsWith('Only ') || reason === GRANT_READ_ONLY) throw new ForbiddenException(reason);
    throw new ConflictException(reason);
  }

  /** The project, locked, for someone with a role in it (a grant holder reads but never changes: 403). */
  private async actor(c: PoolClient, user: AuthUser, projectId: string): Promise<ProjectContext> {
    const ctx = await this.access.load(projectId, user, c, true);
    if (!ctx) throw new NotFoundException();
    if (ctx.roles.length === 0) {
      if (ctx.grantKinds.length === 0) throw new NotFoundException();
      throw new ForbiddenException(GRANT_READ_ONLY);
    }
    return ctx;
  }

  /** The target, locked. It belongs to `projectId`, unless the kind of change is made in another project (risk hand-over). */
  private async lockTarget(c: PoolClient, targetKind: TargetKind, targetId: string, projectId: string, otherProject = false): Promise<Row> {
    const row = UUID.test(targetId) ? (await c.query(TARGET_SQL[targetKind], [targetId])).rows[0] : undefined;
    if (!row || (!otherProject && row.projectId !== projectId)) throw new NotFoundException();
    return { ...row, targetKind };
  }

  private async lockRequest(c: PoolClient, id: string): Promise<RequestRow> {
    const r = (await c.query(`SELECT ${REQUEST_COLUMNS} FROM change_requests WHERE id = $1 FOR UPDATE`, [id])).rows[0];
    if (!r) throw new NotFoundException();
    return r as RequestRow;
  }

  private async termsOf(c: PoolClient | Pool, requestId: string, version: number): Promise<Record<string, unknown>> {
    return (await c.query(`SELECT terms FROM change_request_versions WHERE request_id = $1 AND version = $2`, [requestId, version])).rows[0].terms;
  }

  private async approverIds(c: PoolClient, request: RequestRow): Promise<string[]> {
    const { rows } = await c.query(`SELECT approver_id FROM approvals WHERE request_id = $1 AND version = $2`, [request.id, request.version]);
    return rows.map((r) => r.approver_id as string);
  }

  /** Why nobody can approve this request now (null when they can, subject to who is asking). */
  private static blocked(ctx: ProjectContext, request: RequestRow): string | null {
    if (request.status !== 'pending') return null;
    if (ctx.missingAccountability) return MISSING_ACCOUNTABILITY;
    if (!kindAllowedIn(request.kind, ctx.project.status, 'approve', { closureBatch: isClosureBatch(request.batchId, request.projectId) })) {
      return `This change cannot be approved while the project is ${STATUS_LABEL[ctx.project.status]}.`;
    }
    const eligible = eligibleApprovers(ctx).length;
    if (eligible < request.requiredApprovals) return notEnough(request.requiredApprovals, eligible);
    return null;
  }

  private async audit(c: PoolClient, at: Date, action: string, actor: string, request: { id: string; projectId: string }, detail: Record<string, unknown> = {}) {
    await writeAudit(c, { at, action: `change.${action}`, actorUserId: actor, subjectType: 'change_request', subjectId: request.id, detail: { projectId: request.projectId, ...detail } });
  }

  /**
   * Sets the request authorised by `by` and applies it: the terms are checked again against the target as it is
   * now, so a change that no longer fits is refused (and the caller's approval rolled back with it).
   */
  private async complete(c: PoolClient, ctx: ProjectContext, request: RequestRow, target: Row, handler: ChangeHandler, user: AuthUser, at: Date, later: (d: Deliver) => void) {
    const terms = await handler.validate(c, ctx, target, await this.termsOf(c, request.id, request.version), user, at);
    await c.query(`UPDATE change_requests SET status = 'authorised', decided_by = $2, decided_at = $3 WHERE id = $1`, [request.id, user.id, at]);
    const done: RequestRow = { ...request, status: 'authorised', decidedBy: user.id, decidedAt: at };
    const out = await handler.apply(c, ctx, target, terms, done, at);
    if (out.deliver) later(out.deliver);
    await this.audit(c, at, 'applied', user.id, request, { kind: request.kind, version: request.version, ...(out.record ? { record: out.record } : {}) });
    return out.record ? { record: out.record } : {};
  }

  /**
   * Proposes a change. With `approveNow` and an eligible submitter, the submission is also their approval, and it
   * applies the change when that completes the count (2a's one-click authorise when the count is 1).
   */
  async submit(
    user: AuthUser,
    projectId: string,
    input: { kind: ChangeKind; targetKind: TargetKind; targetId: string; terms: Record<string, unknown>; batchId?: string | null; reason?: string | null },
    opts: { approveNow?: boolean } = {},
  ): Promise<{ request: RequestView; applied?: AppliedResult }> {
    return this.withDelivery((c, later) => this.submitWithin(c, user, projectId, input, opts, later));
  }

  /**
   * submit() inside the caller's transaction (closure prepares a disposition and its cancellation together). Any
   * email the applied change prepares is handed to `later`, to be delivered after the caller commits.
   */
  async submitWithin(
    c: PoolClient,
    user: AuthUser,
    projectId: string,
    input: { kind: ChangeKind; targetKind: TargetKind; targetId: string; terms: Record<string, unknown>; batchId?: string | null; reason?: string | null },
    opts: { approveNow?: boolean },
    later: (d: Deliver) => void,
  ): Promise<{ request: RequestView; applied?: AppliedResult }> {
    if (!KINDS.includes(input.kind)) throw new BadRequestException('Choose a kind of change.');
    if (!TARGET_KINDS.includes(input.targetKind)) throw new BadRequestException('Choose what the change is for.');
    const handler = this.handler(input.kind);
    if (!handler || !(handler.targetKinds ?? [handler.targetKind]).includes(input.targetKind)) throw new BadRequestException('This kind of change cannot be proposed here.');
    const terms = clientTerms(objectOf(input.terms) ?? {});
    const at = this.now();
    const ctx = await this.actor(c, user, projectId);
    const target = await this.lockTarget(c, input.targetKind, input.targetId, projectId);
    const refusal = handler.mayPropose(ctx, target, user);
    if (refusal) ChangesService.refuse(refusal);
    if (!kindAllowedIn(input.kind, ctx.project.status, 'submit', { closureBatch: isClosureBatch(input.batchId, projectId) })) {
      throw new ConflictException(`This change cannot be proposed while the project is ${STATUS_LABEL[ctx.project.status]}.`);
    }
    const approving = !!opts.approveNow && eligibleApprovers(ctx).includes(user.id);
    if (approving && ctx.missingAccountability) throw new ConflictException(MISSING_ACCOUNTABILITY);
    const open = await c.query(`SELECT 1 FROM change_requests WHERE target_kind = $1 AND target_id = $2 AND status = 'pending'`, [input.targetKind, target.id]);
    if (open.rowCount) throw new ConflictException(`This ${NOUN[input.targetKind]} already has a change waiting for authorisation.`);
    const normalised = await handler.validate(c, ctx, target, terms, user, at);
    const required = await this.policy.effectiveFor(c, projectId);
    const id = uuidv7(at.getTime());
    await c.query(
      `INSERT INTO change_requests (id, project_id, kind, target_kind, target_id, batch_id, version, required_approvals, status, submitted_by, submitted_at)
       VALUES ($1, $2, $3, $4, $5, $6, 1, $7, 'pending', $8, $9)`,
      [id, projectId, input.kind, input.targetKind, target.id, input.batchId ?? null, required, user.id, at],
    );
    await c.query(`INSERT INTO change_request_versions (request_id, version, terms, reason, author_id, at) VALUES ($1, 1, $2, $3, $4, $5)`, [
      id, JSON.stringify(normalised), text(input.reason) || null, user.id, at,
    ]);
    const request = await this.lockRequest(c, id);
    await this.audit(c, at, 'submitted', user.id, request, { kind: input.kind, targetKind: input.targetKind, targetId: target.id, required });
    let applied: AppliedResult | undefined;
    if (approving) applied = await this.recordApproval(c, ctx, request, target, handler, user, at, later);
    return { request: await this.view(c, ctx, user, await this.lockRequest(c, id)), ...(applied ? { applied } : {}) };
  }

  /** Records one approval on the current version and applies the change when it completes the count. */
  private async recordApproval(c: PoolClient, ctx: ProjectContext, request: RequestRow, target: Row, handler: ChangeHandler, user: AuthUser, at: Date, later: (d: Deliver) => void) {
    const ins = await c.query(
      `INSERT INTO approvals (id, request_id, version, approver_id, at) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT ON CONSTRAINT approvals_once_per_version DO NOTHING`,
      [uuidv7(at.getTime()), request.id, request.version, user.id, at],
    );
    if (!ins.rowCount) return undefined;
    await this.audit(c, at, 'approved', user.id, request, { version: request.version });
    const outcome = approvalOutcome({ required: request.requiredApprovals, approverIds: await this.approverIds(c, request), eligibleIds: eligibleApprovers(ctx) });
    if (outcome.state !== 'authorised') return undefined;
    return this.complete(c, ctx, request, target, handler, user, at, later);
  }

  /** The request's project, locked, then the request itself, locked. */
  private async load(c: PoolClient, user: AuthUser, requestId: string, needRole: boolean) {
    if (!UUID.test(requestId)) throw new NotFoundException();
    const peek = (await c.query(`SELECT project_id FROM change_requests WHERE id = $1`, [requestId])).rows[0];
    if (!peek) throw new NotFoundException();
    const ctx = needRole ? await this.actor(c, user, peek.project_id) : await this.access.context(user, peek.project_id, c, true);
    const request = await this.lockRequest(c, requestId);
    return { ctx, request };
  }

  /** { version, terms? } by an Owner or Sponsor. Approving an already authorised request changes nothing. */
  async approve(user: AuthUser, requestId: string, input: { version?: unknown; terms?: unknown }): Promise<{ request: RequestView; applied?: AppliedResult }> {
    const at = this.now();
    return this.withDelivery(async (c, later) => {
      const { ctx, request } = await this.load(c, user, requestId, false);
      if (!eligibleApprovers(ctx).includes(user.id)) throw new ForbiddenException(NOT_ELIGIBLE);
      if (request.status === 'authorised') return { request: await this.view(c, ctx, user, request) };
      if (request.status !== 'pending') throw new ConflictException(NOT_PENDING);
      if (input.version !== request.version) throw new ConflictException(STALE_VERSION);
      const handler = this.handler(request.kind);
      if (!handler) throw new ConflictException('This kind of change cannot be approved yet.');
      if (input.terms !== undefined && !handler.editableOnApproval) throw new BadRequestException(NOT_EDITABLE);
      const why = ChangesService.blocked(ctx, request);
      if (why) throw new ConflictException(why);
      const target = await this.lockTarget(c, request.targetKind, request.targetId, request.projectId, handler.targetInOtherProject);
      let current = request;
      if (input.terms !== undefined) current = await this.reviseOnApproval(c, ctx, request, target, handler, user, input.terms, at);
      if (handler.readyToApprove) {
        const refusal = handler.readyToApprove(await this.termsOf(c, current.id, current.version));
        if (refusal) throw new BadRequestException(refusal);
      }
      const applied = await this.recordApproval(c, ctx, current, target, handler, user, at, later);
      return { request: await this.view(c, ctx, user, await this.lockRequest(c, requestId)), ...(applied ? { applied } : {}) };
    });
  }

  /**
   * The approver's own terms (the responsible person and review date of an accepted hand-over) change the request
   * as a new version, written by the approver and approved in the same step; the proposer's reason carries over.
   */
  private async reviseOnApproval(c: PoolClient, ctx: ProjectContext, request: RequestRow, target: Row, handler: ChangeHandler, user: AuthUser, supplied: unknown, at: Date): Promise<RequestRow> {
    const given = objectOf(supplied);
    if (!given) throw new BadRequestException('Write the revised terms.');
    const before = await this.termsOf(c, request.id, request.version);
    const normalised = await handler.validate(c, ctx, target, { ...before, ...given }, user, at);
    if (sameTerms(normalised, before)) return request;
    const reason = (await c.query(`SELECT reason FROM change_request_versions WHERE request_id = $1 AND version = $2`, [request.id, request.version])).rows[0].reason as string | null;
    const next = request.version + 1;
    await c.query(`INSERT INTO change_request_versions (request_id, version, terms, reason, author_id, at) VALUES ($1, $2, $3, $4, $5, $6)`, [
      request.id, next, JSON.stringify(normalised), reason, user.id, at,
    ]);
    await c.query(`UPDATE change_requests SET version = $2 WHERE id = $1`, [request.id, next]);
    await this.audit(c, at, 'revised', user.id, request, { version: next, byApprover: true });
    return { ...request, version: next };
  }

  /**
   * Offers a risk of a closing project to another project (called by closure in its transaction, with the closing
   * project and the risk already locked): a pending risk_handover request in the receiving project.
   */
  async offerHandover(c: PoolClient, user: AuthUser, input: { riskId: string; fromProjectId: string; toProjectId: string; reason: string }, at: Date) {
    const required = await this.policy.effectiveFor(c, input.toProjectId);
    const id = uuidv7(at.getTime());
    await c.query(
      `INSERT INTO change_requests (id, project_id, kind, target_kind, target_id, batch_id, version, required_approvals, status, submitted_by, submitted_at)
       VALUES ($1, $2, 'risk_handover', 'risk', $3, NULL, 1, $4, 'pending', $5, $6)`,
      [id, input.toProjectId, input.riskId, required, user.id, at],
    );
    await c.query(`INSERT INTO change_request_versions (request_id, version, terms, reason, author_id, at) VALUES ($1, 1, $2, $3, $4, $5)`, [
      id, JSON.stringify({ fromProjectId: input.fromProjectId }), input.reason, user.id, at,
    ]);
    await this.audit(c, at, 'submitted', user.id, { id, projectId: input.toProjectId }, {
      kind: 'risk_handover', targetKind: 'risk', targetId: input.riskId, required, fromProjectId: input.fromProjectId,
    });
    return { id, kind: 'risk_handover' as const, status: 'pending' as const, projectId: input.toProjectId };
  }

  /** Withdraws the waiting hand-over offers for a risk (the closer chose something else). Returns how many. */
  async withdrawHandovers(c: PoolClient, user: AuthUser, riskId: string, reason: string, at: Date): Promise<number> {
    const { rows } = await c.query(
      `UPDATE change_requests SET status = 'withdrawn', decided_by = $2, decided_at = $3, reason = $4
        WHERE kind = 'risk_handover' AND target_id = $1 AND status = 'pending' RETURNING id, project_id AS "projectId", version`,
      [riskId, user.id, at, reason],
    );
    for (const r of rows) await this.audit(c, at, 'withdrawn', user.id, r, { version: r.version, cause: 'disposition_changed' });
    return rows.length;
  }

  /** { reason } by an Owner or Sponsor: ends the request. */
  async reject(user: AuthUser, requestId: string, input: { reason?: unknown }) {
    const reason = text(input.reason);
    if (reason === '') throw new BadRequestException('A reason is required.');
    const at = this.now();
    return this.tx(async (c) => {
      const { ctx, request } = await this.load(c, user, requestId, false);
      if (!eligibleApprovers(ctx).includes(user.id)) throw new ForbiddenException('Only an Owner or Sponsor of this project can reject.');
      if (request.status !== 'pending') throw new ConflictException(NOT_PENDING);
      await c.query(`UPDATE change_requests SET status = 'rejected', decided_by = $2, decided_at = $3, reason = $4 WHERE id = $1`, [request.id, user.id, at, reason]);
      await this.audit(c, at, 'rejected', user.id, request, { version: request.version });
      return { request: await this.view(c, ctx, user, await this.lockRequest(c, requestId)) };
    });
  }

  /** { reason } by the submitter or the project's PM while pending. */
  async withdraw(user: AuthUser, requestId: string, input: { reason?: unknown }) {
    const reason = text(input.reason);
    if (reason === '') throw new BadRequestException('A reason is required.');
    const at = this.now();
    return this.tx(async (c) => {
      const { ctx, request } = await this.load(c, user, requestId, true);
      if (request.submittedBy !== user.id && !ctx.roles.includes('pm')) {
        throw new ForbiddenException('Only the person who proposed this change or the Project Manager can withdraw it.');
      }
      if (request.status !== 'pending') throw new ConflictException(NOT_PENDING);
      await c.query(`UPDATE change_requests SET status = 'withdrawn', decided_by = $2, decided_at = $3, reason = $4 WHERE id = $1`, [request.id, user.id, at, reason]);
      await this.audit(c, at, 'withdrawn', user.id, request, { version: request.version });
      return { request: await this.view(c, ctx, user, await this.lockRequest(c, requestId)) };
    });
  }

  /** { terms, reason } by the submitter while pending: a new version; earlier approvals no longer count. */
  async revise(user: AuthUser, requestId: string, input: { terms?: unknown; reason?: unknown }) {
    const given = objectOf(input.terms);
    if (!given) throw new BadRequestException('Write the revised terms.');
    const terms = clientTerms(given);
    const reason = text(input.reason);
    if (reason === '') throw new BadRequestException('Write a reason for the change.');
    const at = this.now();
    return this.tx(async (c) => {
      const { ctx, request } = await this.load(c, user, requestId, true);
      if (request.submittedBy !== user.id) throw new ForbiddenException('Only the person who proposed this change can revise it.');
      if (request.status !== 'pending') throw new ConflictException(NOT_PENDING);
      if (!kindAllowedIn(request.kind, ctx.project.status, 'submit', { closureBatch: isClosureBatch(request.batchId, request.projectId) })) {
        throw new ConflictException(`This change cannot be proposed while the project is ${STATUS_LABEL[ctx.project.status]}.`);
      }
      const handler = this.handler(request.kind);
      if (!handler) throw new ConflictException('This kind of change cannot be revised yet.');
      const target = await this.lockTarget(c, request.targetKind, request.targetId, request.projectId, handler.targetInOtherProject);
      const normalised = await handler.validate(c, ctx, target, terms, user, at);
      const next = request.version + 1;
      await c.query(`INSERT INTO change_request_versions (request_id, version, terms, reason, author_id, at) VALUES ($1, $2, $3, $4, $5, $6)`, [
        request.id, next, JSON.stringify(normalised), reason, user.id, at,
      ]);
      await c.query(`UPDATE change_requests SET version = $2 WHERE id = $1`, [request.id, next]);
      await this.audit(c, at, 'revised', user.id, request, { version: next });
      return { request: await this.view(c, ctx, user, await this.lockRequest(c, requestId)) };
    });
  }

  /** Every request in the project, most recent first, with what the viewer may do. */
  async list(user: AuthUser, projectId: string): Promise<RequestView[]> {
    const ctx = await this.access.authorize(user, 'project.view', projectId);
    const { rows } = await this.pool.query(`SELECT ${REQUEST_COLUMNS} FROM change_requests WHERE project_id = $1 ORDER BY submitted_at DESC, id DESC`, [projectId]);
    const out: RequestView[] = [];
    for (const r of rows as RequestRow[]) out.push(await this.view(this.pool, ctx, user, r));
    return out;
  }

  /** One request as the viewer sees it. */
  async view(db: Pool | PoolClient, ctx: ProjectContext, user: AuthUser, r: RequestRow): Promise<RequestView> {
    const version = (
      await db.query(`SELECT terms, reason FROM change_request_versions WHERE request_id = $1 AND version = $2`, [r.id, r.version])
    ).rows[0] as { terms: Record<string, unknown>; reason: string | null };
    const approvals = (
      await db.query(
        `SELECT a.approver_id AS "userId", u.display_name AS name, a.at FROM approvals a JOIN users u ON u.id = a.approver_id
          WHERE a.request_id = $1 AND a.version = $2 ORDER BY a.at, a.id`,
        [r.id, r.version],
      )
    ).rows as Array<{ userId: string; name: string; at: Date }>;
    const submitter = (await db.query(`SELECT display_name FROM users WHERE id = $1`, [r.submittedBy])).rows[0].display_name as string;
    const pending = r.status === 'pending';
    const why = ChangesService.blocked(ctx, r);
    const eligible = eligibleApprovers(ctx).includes(user.id);
    let offer: RequestView['offer'];
    if (r.kind === 'risk_handover') {
      const o = (
        await db.query(
          `SELECT p.id AS "projectId", p.name, k.id AS "riskId", k.description, k.severity FROM risks k JOIN projects p ON p.id = k.project_id WHERE k.id = $1`,
          [r.targetId],
        )
      ).rows[0];
      if (o) offer = { fromProject: { id: o.projectId, name: o.name }, risk: { id: o.riskId, description: o.description, severity: o.severity } };
    }
    return {
      id: r.id,
      kind: r.kind,
      target: { kind: r.targetKind, id: r.targetId },
      version: r.version,
      status: r.status,
      requiredApprovals: r.requiredApprovals,
      approvals: approvals.map((a) => ({ name: a.name, at: a.at })),
      terms: version.terms,
      reason: version.reason,
      outcomeReason: r.reason,
      submittedBy: submitter,
      submittedAt: r.submittedAt,
      ...(offer ? { offer } : {}),
      mayApprove: pending && eligible && why === null && !approvals.some((a) => a.userId === user.id),
      mayRevise: pending && r.submittedBy === user.id,
      mayWithdraw: pending && (r.submittedBy === user.id || ctx.roles.includes('pm')),
      why,
      batchId: r.batchId,
    };
  }
}
