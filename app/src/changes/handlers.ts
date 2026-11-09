import { ConflictException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { AuthUser } from '../auth/tokens';
import type { ExtractionService } from '../extraction/extraction.service';
import { AUTHORISED_MESSAGE } from '../extraction/extraction.service';
import { type ProjectContext } from '../projects/access.service';
import { decide } from '../projects/matrix';
import type { Created, RecordsService } from '../records/records.service';
import type { ChangeKind } from './rules';

export type TargetKind = 'extraction_item' | 'human_proposal' | 'task' | 'decision' | 'risk';

/** The target of a request as loaded (and locked) by ChangesService: its columns, camel-cased where named, plus projectId. */
export type Row = Record<string, any>;

/** One change_requests row. */
export interface RequestRow {
  id: string;
  projectId: string;
  kind: ChangeKind;
  targetKind: TargetKind;
  targetId: string;
  batchId: string | null;
  version: number;
  requiredApprovals: number;
  status: 'pending' | 'authorised' | 'rejected' | 'withdrawn' | 'superseded';
  submittedBy: string;
  submittedAt: Date;
  decidedBy: string | null;
  decidedAt: Date | null;
  reason: string | null;
}

/**
 * One kind of change. `validate` checks the terms against the target as it is now and returns them normalised (it
 * changes nothing); `apply` makes the change, in the transaction of the approval that completes the count, with the
 * request already marked authorised (`request.decidedBy` is that approver). `mayPropose` returns null when this
 * person may propose it, else the refusal.
 */
export interface ChangeHandler {
  kind: ChangeKind;
  targetKind: TargetKind;
  validate(c: PoolClient, ctx: ProjectContext, target: Row, terms: Record<string, unknown>, user: AuthUser, at: Date): Promise<Record<string, unknown>>;
  apply(
    c: PoolClient,
    ctx: ProjectContext,
    target: Row,
    terms: Record<string, unknown>,
    request: RequestRow,
    at: Date,
  ): Promise<{ record?: Created['record']; deliver?: () => Promise<boolean> }>;
  mayPropose(ctx: ProjectContext, target: Row, user: AuthUser): string | null;
  /** True when an approver may change the terms while approving (risk hand-over only). */
  editableOnApproval?: boolean;
  /** Which target kinds this handler accepts, when more than its `targetKind`. */
  targetKinds?: readonly TargetKind[];
  /** True when the target belongs to another project than the request (risk hand-over: the closing project's risk). */
  targetInOtherProject?: boolean;
  /** The refusal (400) when the terms are not complete enough to approve, else null. Checked on every approval. */
  readyToApprove?(terms: Record<string, unknown>): string | null;
}

/**
 * Handlers that need nothing but the transaction. Handlers that need application services are registered on
 * ChangesService by the module that owns those services (see RecordsService), so each running application uses
 * its own services.
 */
export const HANDLERS = {} as Record<ChangeKind, ChangeHandler>;

/** The proposal already has its record (a repeated click): 2a answers 200 with it. */
export class AlreadyAuthorised extends ConflictException {
  constructor(readonly record: Created['record']) {
    super(AUTHORISED_MESSAGE);
  }
}

/** 2a's authorise body: what the authoriser chose. */
const AUTHORISE_TERMS = [
  'assigneeId', 'inviteEmail', 'dueOn', 'subtasks', 'responsibleId', 'severity', 'reviewOn', 'requesterId', 'rationale', 'sourceVersionId', 'occurrence',
] as const;

/** Runs `work` and undoes whatever it wrote, keeping its refusal. */
export async function dryRun<T>(c: PoolClient, work: () => Promise<T>): Promise<T> {
  await c.query('SAVEPOINT change_validate');
  try {
    return await work();
  } finally {
    await c.query('ROLLBACK TO SAVEPOINT change_validate');
    await c.query('RELEASE SAVEPOINT change_validate');
  }
}

/** Authorising an AI proposal (extraction_item) or a people's proposal (human_proposal) into its record (spec §3.3). */
export function authoriseProposalHandler(deps: { records: RecordsService; extraction: ExtractionService }): ChangeHandler {
  const origin = (target: Row) => (target.targetKind === 'extraction_item' ? { itemId: target.id as string } : { proposalId: target.id as string });

  const make = async (c: PoolClient, ctx: ProjectContext, target: Row, terms: Record<string, unknown>, by: AuthUser, at: Date) => {
    if (target.targetKind === 'extraction_item') {
      const approved = await deps.extraction.approveInTx(c, target.runId, target.id, { sourceVersionId: terms.sourceVersionId, occurrence: terms.occurrence }, by.id, at);
      return deps.records.createFrom(c, ctx, { itemId: target.id }, approved, terms, by, at);
    }
    const made = await deps.records.createFrom(c, ctx, { proposalId: target.id }, { kind: target.kind, text: target.text, owner: target.owner }, terms, by, at);
    await c.query(`UPDATE human_proposals SET review_status = 'approved', reviewed_by = $2, reviewed_at = $3 WHERE id = $1`, [target.id, by.id, at]);
    return made;
  };

  return {
    kind: 'authorise_proposal',
    targetKind: 'extraction_item',
    targetKinds: ['extraction_item', 'human_proposal'],
    mayPropose(ctx) {
      const v = decide({ action: 'proposal.review', roles: ctx.roles, status: ctx.project.status });
      return v.allowed ? null : v.reason;
    },
    async validate(c, ctx, target, terms, user, at) {
      const existing = await deps.records.existingRecord(c, origin(target));
      if (existing) throw new AlreadyAuthorised(existing);
      // A people's proposal stays rejected; an Owner may change their mind on a rejected AI proposal (2a).
      if (target.targetKind === 'human_proposal' && target.reviewStatus === 'rejected') throw new ConflictException('This proposal was rejected.');
      const out: Record<string, unknown> = {};
      for (const k of AUTHORISE_TERMS) if (terms[k] !== undefined) out[k] = terms[k];
      // The same checks as creating the record, with nothing kept: the refusal and its wording are exactly 2a's.
      await dryRun(c, () => make(c, ctx, target, out, user, at));
      return out;
    },
    async apply(c, ctx, target, terms, request, at) {
      const by = { id: request.decidedBy as string } as AuthUser;
      const made = await make(c, ctx, target, terms, by, at);
      return { record: made.record, ...(made.deliver ? { deliver: made.deliver } : {}) };
    },
  };
}
