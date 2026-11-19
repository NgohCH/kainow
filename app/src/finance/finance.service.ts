import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { projectMonthUsage } from '../ai/usage.service';
import { writeAudit } from '../audit/audit';
import { CLOCK, type AuthUser, type Clock } from '../auth/tokens';
import { refuseSecretsIn } from '../common/reason';
import { uuidv7 } from '../common/uuid7';
import { PG_POOL } from '../db/database.module';
import { ProjectAccess } from '../projects/access.service';
import { decide } from '../projects/matrix';
import { loadResourceSettings } from '../resources/settings.service';
import { type Adj, type Figures, countedAmount, figures } from './figures';
import { CURRENCIES, type Currency, parseAmount, toDecimalString } from './money';
import { effectiveThresholds, loadProjectFinanceSettings, mayReadFinance } from './readers';
import { evaluateFinanceWarnings } from './warnings';

type Db = Pool | PoolClient;

export const NOT_READER = "Only the project's finance readers can see financial detail.";
export const NOT_REQUIRED = 'Financial tracking is not required for this project.';
export const HISTORY_NOTICE = 'Financial tracking is not required for this project. Earlier entries are kept here for reference.';
const DATE = 'Enter the date the money was spent as YYYY-MM-DD.';
const DESCRIPTION = 'Enter a description of 1 to 500 characters.';
const REFERENCE = 'A reference can be up to 100 characters.';
const FINANCE_KINDS = `('set_budget', 'finance_adjustment')`;

const isCurrency = (v: unknown): v is Currency => typeof v === 'string' && Object.prototype.hasOwnProperty.call(CURRENCIES, v);
/** numeric(16,2) as Postgres writes it ("100.00") into minor units. */
const minor = (s: string): bigint => {
  const [whole, frac = ''] = s.split('.');
  return BigInt(whole) * 100n + BigInt(frac.padEnd(2, '0').slice(0, 2));
};

type Person = { id: string; name: string };

export type FiguresView = {
  budget: string | null;
  spent: string;
  balance: string | null;
  percentUsed: number | null;
  overBudget: boolean;
  level: 0 | 1 | 2;
  notInTotals: { currency: Currency; amount: string }[];
  warnThresholds: [number, number];
};

export type PendingView = { id: string; kind: 'set_budget' | 'finance_adjustment'; targetId: string; submittedAt: Date; submittedBy: Person; terms: unknown };

export type AdjView = {
  id: string;
  kind: Adj['kind'];
  amount: string;
  rate: string | null;
  rateOn: string | null;
  refundOn: string | null;
  reason: string;
  changeRequestId: string;
  approvedAt: Date;
};

export type EntryView = {
  id: string;
  spentOn: string;
  amount: string;
  currency: Currency;
  description: string;
  reference: string;
  recordedBy: Person;
  recordedAt: Date;
  /** In the reporting currency; null for a foreign entry not yet converted (or with no reporting currency at all). */
  counted: string | null;
  adjustments: AdjView[];
  pending: PendingView | null;
};

type EntryRow = Omit<EntryView, 'counted' | 'adjustments' | 'pending'> & { adjustments: (AdjView & { minor: bigint })[] };

/** Entries in date order (spent on, then recorded at) with their approved adjustments in approval order. */
async function loadEntries(db: Db, projectId: string, entryId: string | null = null): Promise<EntryRow[]> {
  const { rows } = await db.query(
    `SELECT e.id, to_char(e.spent_on, 'YYYY-MM-DD') AS "spentOn", e.amount::text AS amount, e.currency, e.description, e.reference,
            e.recorded_by AS "recordedById", u.display_name AS "recordedByName", e.recorded_at AS "recordedAt"
       FROM expenditures e JOIN users u ON u.id = e.recorded_by
      WHERE e.project_id = $1 AND ($2::uuid IS NULL OR e.id = $2::uuid)
      ORDER BY e.spent_on, e.recorded_at, e.id`,
    [projectId, entryId],
  );
  const { rows: adjs } = await db.query(
    `SELECT a.id, a.expenditure_id AS "entryId", a.kind, a.amount::text AS amount, a.rate::text AS rate,
            to_char(a.rate_on, 'YYYY-MM-DD') AS "rateOn", to_char(a.refund_on, 'YYYY-MM-DD') AS "refundOn", a.reason,
            a.change_request_id AS "changeRequestId", a.approved_at AS "approvedAt"
       FROM expenditure_adjustments a JOIN expenditures e ON e.id = a.expenditure_id
      WHERE e.project_id = $1 AND ($2::uuid IS NULL OR e.id = $2::uuid)
      ORDER BY a.approved_at, a.id`,
    [projectId, entryId],
  );
  const byEntry = new Map<string, (AdjView & { minor: bigint })[]>();
  for (const { entryId: eid, ...a } of adjs) {
    const list = byEntry.get(eid) ?? [];
    list.push({ ...a, minor: minor(a.amount) });
    byEntry.set(eid, list);
  }
  return rows.map((r) => ({
    id: r.id,
    spentOn: r.spentOn,
    amount: r.amount,
    currency: r.currency,
    description: r.description,
    reference: r.reference,
    recordedBy: { id: r.recordedById, name: r.recordedByName },
    recordedAt: r.recordedAt,
    adjustments: byEntry.get(r.id) ?? [],
  }));
}

const toAdj = (a: AdjView & { minor: bigint }): Adj => ({ kind: a.kind, amount: a.minor, approvedAt: new Date(a.approvedAt) });

async function loadBudgetVersions(db: Db, projectId: string) {
  const { rows } = await db.query(
    `SELECT id, amount::text AS amount, currency, change_request_id AS "changeRequestId", approved_at AS "approvedAt"
       FROM budget_versions WHERE project_id = $1 ORDER BY approved_at, id`,
    [projectId],
  );
  return rows as { id: string; amount: string; currency: Currency; changeRequestId: string; approvedAt: Date }[];
}

/** Works out the figures (spec 3.5): the current budget is the latest approved version. */
async function computeFigures(db: Db, projectId: string, currency: Currency, warn: [number, number], entries?: EntryRow[]): Promise<Figures> {
  const versions = await loadBudgetVersions(db, projectId);
  const latest = versions[versions.length - 1];
  const list = entries ?? (await loadEntries(db, projectId));
  return figures({
    budget: latest ? minor(latest.amount) : null,
    entries: list.map((e) => ({ amount: minor(e.amount), currency: e.currency, adjustments: e.adjustments.map(toAdj) })),
    reporting: currency,
    warn,
  });
}

export function figuresView(f: Figures, warn: [number, number]): FiguresView {
  return {
    budget: f.budget === null ? null : toDecimalString(f.budget),
    spent: toDecimalString(f.spent),
    balance: f.balance === null ? null : toDecimalString(f.balance),
    percentUsed: f.percentUsed,
    overBudget: f.overBudget,
    level: f.level,
    notInTotals: f.notInTotals.map((n) => ({ currency: n.currency, amount: toDecimalString(n.amount) })),
    warnThresholds: warn,
  };
}

/**
 * The project's figures in its reporting currency, or null when tracking is not Enabled. For the dashboard, leadership,
 * analytics and the report (spec 5–7); callers decide who may see them.
 */
export async function loadFigures(db: Db, projectId: string): Promise<(Figures & { currency: Currency; warnThresholds: [number, number] }) | null> {
  const s = await loadProjectFinanceSettings(db, projectId);
  if (s.tracking !== 'enabled' || s.currency === null) return null;
  const warn = effectiveThresholds(s, await loadResourceSettings(db));
  return { ...(await computeFigures(db, projectId, s.currency, warn)), currency: s.currency, warnThresholds: warn };
}

/** Pending budget and adjustment requests, each with the terms of its latest version. */
async function loadPending(db: Db, projectId: string): Promise<PendingView[]> {
  const { rows } = await db.query(
    `SELECT r.id, r.kind, r.target_id AS "targetId", r.submitted_at AS "submittedAt", r.submitted_by AS "submittedById",
            u.display_name AS "submittedByName", v.terms
       FROM change_requests r
       JOIN users u ON u.id = r.submitted_by
       LEFT JOIN LATERAL (SELECT terms FROM change_request_versions WHERE request_id = r.id ORDER BY version DESC LIMIT 1) v ON true
      WHERE r.project_id = $1 AND r.kind IN ${FINANCE_KINDS} AND r.status = 'pending'
      ORDER BY r.submitted_at, r.id`,
    [projectId],
  );
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    targetId: r.targetId,
    submittedAt: r.submittedAt,
    submittedBy: { id: r.submittedById, name: r.submittedByName },
    terms: r.terms ?? null,
  }));
}

/** Count of pending adjustments, for the Resources tab and the dashboard. */
export async function countPendingAdjustments(db: Db, projectId: string): Promise<number> {
  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM change_requests WHERE project_id = $1 AND kind = 'finance_adjustment' AND status = 'pending'`,
    [projectId],
  );
  return rows[0].n;
}

function entryViews(entries: EntryRow[], reporting: Currency | null, pending: PendingView[]): EntryView[] {
  return entries.map(({ adjustments, ...e }) => {
    const counted = reporting === null ? null : countedAmount({ amount: minor(e.amount), currency: e.currency }, reporting, adjustments.map(toAdj));
    return {
      ...e,
      counted: counted === null ? null : toDecimalString(counted),
      adjustments: adjustments.map(({ minor: _m, ...a }) => a),
      pending: pending.find((p) => p.kind === 'finance_adjustment' && p.targetId === e.id) ?? null,
    };
  });
}

type RecordInput = { spentOn: string; amount: bigint; currency: Currency; description: string; reference: string };

function readSpentOn(v: unknown): string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v.trim())) throw new BadRequestException(DATE);
  const s = v.trim();
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) throw new BadRequestException(DATE);
  return s;
}

/** Checks a new spending entry against spec 3.5 and the global text limits. */
export function readSpending(body: unknown, enabled: Currency[]): RecordInput {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const spentOn = readSpentOn(b.spentOn);
  const amount = parseAmount(b.amount, { allowZero: false });
  if (!isCurrency(b.currency) || !enabled.includes(b.currency)) {
    throw new BadRequestException(`The currency must be one of the enabled currencies: ${enabled.join(', ')}.`);
  }
  if (typeof b.description !== 'string') throw new BadRequestException(DESCRIPTION);
  const description = b.description.trim();
  if (description.length < 1 || description.length > 500) throw new BadRequestException(DESCRIPTION);
  if (b.reference !== undefined && b.reference !== null && typeof b.reference !== 'string') throw new BadRequestException(REFERENCE);
  const reference = typeof b.reference === 'string' ? b.reference.trim() : '';
  if (reference.length > 100) throw new BadRequestException(REFERENCE);
  refuseSecretsIn([description, reference]);
  return { spentOn, amount, currency: b.currency, description, reference };
}

@Injectable()
export class FinanceService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly now: Clock,
    private readonly access: ProjectAccess,
  ) {}

  /**
   * The finance view (spec 3.5, 4): financial-detail readers only. An outsider, including a non-participant Administrator,
   * gets 404; any other participant or grant holder 403. With tracking Not Required it is the history view.
   */
  async read(user: AuthUser, projectId: string) {
    const ctx = await this.access.authorize(user, 'project.view', projectId);
    const s = await loadProjectFinanceSettings(this.pool, projectId);
    if (!mayReadFinance(ctx, s)) throw new ForbiddenException(NOT_READER);
    const warn = effectiveThresholds(s, await loadResourceSettings(this.pool));
    const entries = await loadEntries(this.pool, projectId);
    const pending = await loadPending(this.pool, projectId);
    const figs = s.currency === null ? null : figuresView(await computeFigures(this.pool, projectId, s.currency, warn, entries), warn);
    const historyOnly = s.tracking !== 'enabled';
    const out: Record<string, unknown> = {
      tracking: s.tracking,
      currency: s.currency,
      figures: figs,
      budgetVersions: await loadBudgetVersions(this.pool, projectId),
      entries: entryViews(entries, s.currency, pending),
      pending,
      historyOnly,
      ...(historyOnly ? { notice: HISTORY_NOTICE } : {}),
    };
    // Shown beside the finance section to those who may view project AI usage; never added in (spec 3.5).
    if (decide({ action: 'ai.usage.view', roles: ctx.roles, status: ctx.project.status }).allowed) {
      out.aiSpendThisMonth = await projectMonthUsage(this.pool, projectId, this.now());
    }
    return out;
  }

  /** Records a spending entry: the PM or a Deputy, in an open project with tracking Enabled, in an enabled currency. */
  async record(user: AuthUser, projectId: string, body: unknown): Promise<EntryView> {
    const at = this.now();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.access.authorize(user, 'finance.record', projectId, client, true);
      const s = await loadProjectFinanceSettings(client, projectId, true);
      if (s.tracking !== 'enabled' || s.currency === null) throw new ConflictException(NOT_REQUIRED);
      const input = readSpending(body, (await loadResourceSettings(client)).enabledCurrencies);
      const id = uuidv7(at.getTime());
      await client.query(
        `INSERT INTO expenditures (id, project_id, spent_on, amount, currency, description, reference, recorded_by, recorded_at)
         VALUES ($1, $2, $3, $4::numeric / 100, $5, $6, $7, $8, $9)`,
        [id, projectId, input.spentOn, input.amount.toString(), input.currency, input.description, input.reference, user.id, at],
      );
      await writeAudit(client, { at, action: 'finance.spending_recorded', actorUserId: user.id, subjectType: 'project', subjectId: projectId, detail: { entryId: id } });
      await evaluateFinanceWarnings(client, projectId, at);
      const [entry] = entryViews(await loadEntries(client, projectId, id), s.currency, []);
      await client.query('COMMIT');
      return entry;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}
