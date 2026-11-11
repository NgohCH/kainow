import { BadRequestException, ConflictException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { writeAudit } from '../audit/audit';
import { UUID, uuidv7 } from '../common/uuid7';
import type { ProjectContext } from '../projects/access.service';
import type { ChangeHandler, Row } from './handlers';

export const NOT_A_DECIDER = 'Only an Owner or Sponsor can replace or withdraw a decision.';
export const NOT_ACTIVE = 'Only an active decision can be replaced or withdrawn.';
const REASON_NEEDED = 'A reason is required.';
const WRONG_WORK = 'Choose affected tasks, questions and risks from this project.';

type Kind = 'task' | 'question' | 'risk';
interface Ref {
  kind: Kind;
  id: string;
}

const KINDS: readonly Kind[] = ['task', 'question', 'risk'];
const TABLE: Record<Kind, { table: string; open: string }> = {
  task: { table: 'tasks', open: `status NOT IN ('completed', 'cancelled')` },
  question: { table: 'questions', open: `status IN ('open', 'answered')` },
  risk: { table: 'risks', open: `status IN ('open', 'mitigating')` },
};

const textOf = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const refsOf = (v: unknown): Ref[] => {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new BadRequestException(WRONG_WORK);
  const seen = new Set<string>();
  const out: Ref[] = [];
  for (const x of v) {
    const kind = (x as Ref | null)?.kind as Kind;
    const id = (x as Ref | null)?.id;
    if (!KINDS.includes(kind) || typeof id !== 'string' || !UUID.test(id)) throw new BadRequestException(WRONG_WORK);
    if (seen.has(`${kind}:${id}`)) continue;
    seen.add(`${kind}:${id}`);
    out.push({ kind, id });
  }
  return out;
};

function mayPropose(ctx: ProjectContext): string | null {
  return ctx.roles.some((r) => r === 'owner' || r === 'sponsor') ? null : NOT_A_DECIDER;
}

/**
 * Splits the chosen work into what is open now (kept) and what is not (dropped). Work that is not in this project is
 * refused; work that stopped being open between submitting and approving is dropped, and the terms say so.
 */
async function openWork(c: PoolClient, projectId: string, terms: Record<string, unknown>): Promise<{ affected: Ref[]; dropped: Ref[] }> {
  const affected: Ref[] = [];
  const dropped: Ref[] = refsOf(terms.dropped);
  for (const ref of refsOf(terms.affected)) {
    const { table, open } = TABLE[ref.kind];
    const row = (await c.query(`SELECT (${open}) AS open FROM ${table} WHERE id = $1 AND project_id = $2`, [ref.id, projectId])).rows[0];
    if (!row) throw new BadRequestException(WRONG_WORK);
    (row.open ? affected : dropped).push(ref);
  }
  return { affected, dropped: dropped.filter((d, i) => dropped.findIndex((x) => x.kind === d.kind && x.id === d.id) === i) };
}

async function check(c: PoolClient, ctx: ProjectContext, target: Row, terms: Record<string, unknown>) {
  const reason = textOf(terms.reason);
  if (reason === '') throw new BadRequestException(REASON_NEEDED);
  if (target.status !== 'active') throw new ConflictException(NOT_ACTIVE);
  const work = await openWork(c, ctx.project.id, terms);
  return { reason, ...work };
}

/** One review flag for each piece of affected work, raised by the approver who completed the authorisation. */
async function flag(c: PoolClient, ctx: ProjectContext, affected: Ref[], decisionId: string, by: string, at: Date) {
  for (const ref of affected) {
    await c.query(
      `INSERT INTO review_flags (id, project_id, record_kind, record_id, cause, decision_id, raised_by, raised_at) VALUES ($1, $2, $3, $4, 'decision_changed', $5, $6, $7)`,
      [uuidv7(at.getTime()), ctx.project.id, ref.kind, ref.id, decisionId, by, at],
    );
  }
}

async function event(c: PoolClient, decisionId: string, kind: string, from: string | null, to: string, note: string, by: string, at: Date, detail: object | null = null) {
  await c.query(
    `INSERT INTO record_events (id, record_kind, record_id, kind, from_status, to_status, note, actor_id, at, detail) VALUES ($1, 'decision', $2, $3, $4, $5, $6, $7, $8, $9)`,
    [uuidv7(at.getTime()), decisionId, kind, from, to, note, by, at, detail ? JSON.stringify(detail) : null],
  );
}

const withDropped = (out: Record<string, unknown>, dropped: Ref[]) => (dropped.length > 0 ? { ...out, dropped } : out);

/** Replacing a decision and withdrawing it, through authorisation (spec §5). */
export function decisionHandlers(): ChangeHandler[] {
  const supersede: ChangeHandler = {
    kind: 'supersede_decision',
    targetKind: 'decision',
    mayPropose: (ctx) => mayPropose(ctx),
    async validate(c, ctx, target, terms) {
      const { reason, affected, dropped } = await check(c, ctx, target, terms);
      const statement = textOf(terms.statement);
      if (statement === '' || statement.length > 2000) throw new BadRequestException('Write the new decision (up to 2000 characters).');
      const rationale = textOf(terms.rationale);
      return withDropped({ statement, ...(rationale ? { rationale } : {}), reason, affected }, dropped);
    },
    async apply(c, ctx, target, terms, request, at) {
      const by = request.decidedBy as string;
      const id = uuidv7(at.getTime());
      const reason = terms.reason as string;
      await c.query(`UPDATE decisions SET status = 'superseded' WHERE id = $1`, [target.id]);
      await c.query(
        `INSERT INTO decisions (id, project_id, statement, rationale, origin_request_id, replaces_id, authorised_by, authorised_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, ctx.project.id, terms.statement, (terms.rationale as string | undefined) ?? null, request.id, target.id, by, at],
      );
      await event(c, target.id, 'superseded', 'active', 'superseded', reason, by, at, { replacedBy: id });
      await event(c, id, 'replaces', null, 'active', reason, by, at, { replaces: target.id });
      await flag(c, ctx, terms.affected as Ref[], id, by, at);
      await writeAudit(c, {
        at, action: 'decision.superseded', actorUserId: by, subjectType: 'project', subjectId: ctx.project.id,
        detail: { decisionId: target.id, replacedBy: id, requestId: request.id, flagged: (terms.affected as Ref[]).length, dropped: terms.dropped ?? [] },
      });
      return { record: { kind: 'decision', id } };
    },
  };

  const withdraw: ChangeHandler = {
    kind: 'withdraw_decision',
    targetKind: 'decision',
    mayPropose: (ctx) => mayPropose(ctx),
    async validate(c, ctx, target, terms) {
      const { reason, affected, dropped } = await check(c, ctx, target, terms);
      return withDropped({ reason, affected }, dropped);
    },
    async apply(c, ctx, target, terms, request, at) {
      const by = request.decidedBy as string;
      await c.query(`UPDATE decisions SET status = 'withdrawn' WHERE id = $1`, [target.id]);
      await event(c, target.id, 'withdrawn', 'active', 'withdrawn', terms.reason as string, by, at);
      await flag(c, ctx, terms.affected as Ref[], target.id, by, at);
      await writeAudit(c, {
        at, action: 'decision.withdrawn', actorUserId: by, subjectType: 'project', subjectId: ctx.project.id,
        detail: { decisionId: target.id, requestId: request.id, flagged: (terms.affected as Ref[]).length, dropped: terms.dropped ?? [] },
      });
      return { record: { kind: 'decision', id: target.id } };
    },
  };

  return [supersede, withdraw];
}
