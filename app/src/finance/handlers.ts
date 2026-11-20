import { BadRequestException, ConflictException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { writeAudit } from '../audit/audit';
import { readReason } from '../common/reason';
import { uuidv7 } from '../common/uuid7';
import type { ChangeHandler, Row } from '../changes/handlers';
import type { ProjectContext } from '../projects/access.service';
import { decide } from '../projects/matrix';
import { type Adj, refundLimit } from './figures';
import { type Currency, formatAmount, parseAmount, parseRate, toDecimalString } from './money';
import { type ProjectFinanceSettings, loadProjectFinanceSettings } from './readers';
import { evaluateFinanceWarnings } from './warnings';

export const TRACKING_OFF_APPROVE = 'Financial tracking is not required for this project, so finance changes cannot be approved.';
export const TRACKING_OFF = 'Financial tracking is not required for this project.';
export const CONVERT_FIRST = 'Convert this entry before correcting or refunding it.';
export const ONLY_FOREIGN = 'Only an entry in another currency can be converted.';
export const refundTooLarge = (amount: string) => `A refund cannot be more than the entry's counted amount (${amount}).`;
export const NOT_ADJUSTER = 'Only the Project Manager or a Deputy can propose a correction, refund or conversion.';
const TYPE = 'Choose a correction, a refund or a conversion.';
const NEEDS_RATE = 'A conversion needs a rate and the date of the rate.';
const NEEDS_REFUND_ON = 'A refund needs the date of the refund.';
const DATE = 'Enter the date as YYYY-MM-DD.';
const REASON = 'Give a reason for the change (up to 1,000 characters).';

type AdjustmentType = Adj['kind'];
const TYPES: readonly AdjustmentType[] = ['correction', 'refund', 'conversion'];

/** numeric(16,2) as Postgres writes it ("100.00") into minor units. */
const minor = (s: string): bigint => {
  const [whole, frac = ''] = s.split('.');
  return BigInt(whole) * 100n + BigInt(frac.padEnd(2, '0').slice(0, 2));
};

const absent = (v: unknown) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

function readDate(v: unknown): string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v.trim())) throw new BadRequestException(DATE);
  const s = v.trim();
  const d = new Date(`${s}T00:00:00Z`);
  // Year 0000 parses in JavaScript but not in Postgres (no year 0): refused here, not a 500 from the insert.
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s || s.startsWith('0000')) throw new BadRequestException(DATE);
  return s;
}

/** The project's settings, refusing (409) unless Financial Tracking is Enabled with a reporting currency. */
async function enabledSettings(c: PoolClient, projectId: string): Promise<ProjectFinanceSettings & { currency: Currency }> {
  const s = await loadProjectFinanceSettings(c, projectId, true);
  if (s.tracking !== 'enabled' || s.currency === null) throw new ConflictException(TRACKING_OFF);
  return s as ProjectFinanceSettings & { currency: Currency };
}

/** Finance changes cannot be approved while Financial Tracking is not Enabled (spec 3.5, 3.6). */
async function trackingBlock(db: Pool | PoolClient, ctx: ProjectContext): Promise<string | null> {
  const s = await loadProjectFinanceSettings(db, ctx.project.id);
  return s.tracking === 'enabled' && s.currency !== null ? null : TRACKING_OFF_APPROVE;
}

/** `finance.propose`: the PM, a Deputy, the Owner or a Sponsor, in an open project. */
function mayProposeFinance(ctx: ProjectContext): string | null {
  const v = decide({ action: 'finance.propose', roles: ctx.roles, status: ctx.project.status });
  return v.allowed ? null : v.reason;
}

/**
 * `set_budget` (D92, spec 3.5, 3.6): a new budget version in the reporting currency. Proposed by the PM, a Deputy, the
 * Owner or a Sponsor; an Owner or Sponsor submitting counts as the first approval. Explicit 0 is a budget.
 */
export function setBudgetHandler(): ChangeHandler {
  return {
    kind: 'set_budget',
    targetKind: 'project_budget',
    mayPropose: (ctx) => mayProposeFinance(ctx),
    approvalBlockedBy: trackingBlock,
    async validate(c, ctx, _target, terms) {
      const amount = parseAmount(terms.amount, { allowZero: true });
      const reason = readReason(terms.reason, 'a reason', { refusal: REASON });
      // Checked at submit, revise and again when the approval that completes the count applies it.
      const s = await enabledSettings(c, ctx.project.id);
      return { amount: toDecimalString(amount), currency: s.currency, reason };
    },
    async apply(c, ctx, _target, terms, request, at) {
      const id = uuidv7(at.getTime());
      await c.query(
        `INSERT INTO budget_versions (id, project_id, amount, currency, change_request_id, approved_at) VALUES ($1, $2, $3::numeric, $4, $5, $6)`,
        [id, ctx.project.id, terms.amount, terms.currency, request.id, at],
      );
      await writeAudit(c, {
        at, action: 'finance.budget_approved', actorUserId: request.decidedBy as string, subjectType: 'project', subjectId: ctx.project.id,
        detail: { requestId: request.id, budgetVersionId: id },
      });
      await evaluateFinanceWarnings(c, ctx.project.id, at);
      return {};
    },
  };
}

/** The entry's approved adjustments in approval order (the order `countedAmount` applies them). */
async function loadAdjustments(c: PoolClient, entryId: string): Promise<Adj[]> {
  const { rows } = await c.query(
    `SELECT kind, amount::text AS amount, approved_at AS "approvedAt" FROM expenditure_adjustments WHERE expenditure_id = $1 ORDER BY approved_at, id`,
    [entryId],
  );
  return rows.map((r) => ({ kind: r.kind, amount: minor(r.amount), approvedAt: new Date(r.approvedAt) }));
}

/**
 * The §3.5 rules for an adjustment to `entry` (locked), in the reporting currency as it is now: before conversion only
 * a conversion; a conversion only for an entry in another currency, with a rate and its date; a refund with its date and
 * not above the entry's counted amount. Returns the terms normalised.
 */
async function checkAdjustment(c: PoolClient, ctx: ProjectContext, entry: Row, terms: Record<string, unknown>): Promise<Record<string, unknown>> {
  const type = terms.type as AdjustmentType;
  if (!TYPES.includes(type)) throw new BadRequestException(TYPE);
  const s = await enabledSettings(c, ctx.project.id);
  const reporting = s.currency;
  const counted = refundLimit({ amount: minor(entry.amount), currency: entry.currency }, reporting, await loadAdjustments(c, entry.id));

  if (type === 'conversion') {
    if (entry.currency === reporting) throw new ConflictException(ONLY_FOREIGN);
    if (absent(terms.rate) || absent(terms.rateOn)) throw new BadRequestException(NEEDS_RATE);
    const rate = parseRate(terms.rate);
    const rateOn = readDate(terms.rateOn);
    const amount = parseAmount(terms.amount, { allowZero: false });
    const reason = readReason(terms.reason, 'a reason', { refusal: REASON });
    return { type, amount: toDecimalString(amount), rate, rateOn, reason };
  }
  if (counted === null) throw new ConflictException(CONVERT_FIRST);
  if (type === 'correction') {
    const amount = parseAmount(terms.amount, { allowZero: true });
    const reason = readReason(terms.reason, 'a reason', { refusal: REASON });
    return { type, amount: toDecimalString(amount), reason };
  }
  const amount = parseAmount(terms.amount, { allowZero: false });
  if (absent(terms.refundOn)) throw new BadRequestException(NEEDS_REFUND_ON);
  const refundOn = readDate(terms.refundOn);
  const reason = readReason(terms.reason, 'a reason', { refusal: REASON });
  if (amount > counted) throw new ConflictException(refundTooLarge(formatAmount(counted, reporting)));
  return { type, amount: toDecimalString(amount), refundOn, reason };
}

/**
 * `finance_adjustment` (D92, spec 3.5, 3.6): a correction, refund or conversion of a spending entry, proposed by the PM
 * or a Deputy and approved by an Owner or Sponsor; the entry itself is never altered. `validate` runs at submit, on
 * revise and again in the transaction of the approval that applies it, with the entry locked, so a refund can never
 * take more than the counted amount at the moment it is applied.
 */
export function financeAdjustmentHandler(): ChangeHandler {
  return {
    kind: 'finance_adjustment',
    targetKind: 'expenditure',
    mayPropose(ctx) {
      const refusal = mayProposeFinance(ctx);
      if (refusal) return refusal;
      return ctx.roles.some((r) => r === 'pm' || r === 'deputy_pm') ? null : NOT_ADJUSTER;
    },
    approvalBlockedBy: trackingBlock,
    validate: (c, ctx, target, terms) => checkAdjustment(c, ctx, target, terms),
    async apply(c, ctx, target, terms, request, at) {
      const id = uuidv7(at.getTime());
      await c.query(
        `INSERT INTO expenditure_adjustments (id, expenditure_id, kind, amount, rate, rate_on, refund_on, reason, change_request_id, approved_at)
         VALUES ($1, $2, $3, $4::numeric, $5::numeric, $6::date, $7::date, $8, $9, $10)`,
        [id, target.id, terms.type, terms.amount, terms.rate ?? null, terms.rateOn ?? null, terms.refundOn ?? null, terms.reason, request.id, at],
      );
      await writeAudit(c, {
        at, action: 'finance.adjustment_approved', actorUserId: request.decidedBy as string, subjectType: 'project', subjectId: ctx.project.id,
        detail: { requestId: request.id, entryId: target.id, adjustmentId: id, type: terms.type },
      });
      await evaluateFinanceWarnings(c, ctx.project.id, at);
      return {};
    },
  };
}
