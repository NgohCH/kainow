import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Pool } from 'pg';
import { writeAudit } from '../audit/audit';
import { CLOCK, type AuthUser, type Clock } from '../auth/tokens';
import { toCsv as csvTable, utc8Minute } from '../analytics/csv';
import { PG_POOL } from '../db/database.module';
import { FinanceService } from '../finance/finance.service';
import { loadProjectFinanceSettings, mayReadFinance } from '../finance/readers';
import { ProjectAccess } from '../projects/access.service';
import { todayUtc8 } from '../projects/membership';
import { type LineView, LinesService, type PersonRow } from './lines.service';
import { KIND_LABELS, LINE_STATUSES, UNITS } from './vocabulary';

export const REPORT_NOTE = 'Usage records, not bookings';
export type FinanceView = Awaited<ReturnType<FinanceService['read']>>;

export type ResourcesReport = {
  header: { project: string; owningDepartment: string; generatedAt: string; note: typeof REPORT_NOTE };
  lines: LineView[];
  neededByPassed: LineView[];
  people: PersonRow[];
  /** Present only for the project's finance readers. */
  finance?: FinanceView;
};

const NOT_PROVIDED = 'Not provided';
const NOT_REQUIRED = 'Not required';
const NO_PERIOD = 'Period not provided';
const NOT_APPLICABLE = 'Not applicable';
const OVER_BUDGET = 'Over budget';
const NOT_IN_TOTALS = 'Not in totals';

/** The project resources report (spec 4, 13): one service, so the JSON, the CSV and later callers share one build. */
@Injectable()
export class ResourcesReportService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly now: Clock,
    private readonly access: ProjectAccess,
    private readonly lines: LinesService,
    private readonly finance: FinanceService,
  ) {}

  async build(user: AuthUser, projectId: string): Promise<ResourcesReport> {
    const ctx = await this.access.authorize(user, 'resource.view', projectId);
    const listed = await this.lines.list(user, projectId);
    const { rows } = await this.pool.query(
      `SELECT p.name, d.name AS department FROM projects p JOIN departments d ON d.id = p.owning_department_id WHERE p.id = $1`,
      [projectId],
    );
    if (rows.length === 0) throw new NotFoundException();
    const report: ResourcesReport = {
      header: { project: rows[0].name, owningDepartment: rows[0].department, generatedAt: this.now().toISOString(), note: REPORT_NOTE },
      lines: listed.lines,
      neededByPassed: listed.lines.filter((l) => l.neededByPassed),
      people: listed.people,
    };
    if (mayReadFinance(ctx, await loadProjectFinanceSettings(this.pool, projectId))) {
      const { aiSpendThisMonth: _ai, ...finance } = (await this.finance.read(user, projectId)) as FinanceView & { aiSpendThisMonth?: unknown };
      report.finance = finance;
    }
    return report;
  }

  /** The CSV text and file name; records the project and the section names only, never data. */
  async exportCsv(user: AuthUser, projectId: string): Promise<{ text: string; filename: string }> {
    const report = await this.build(user, projectId);
    const at = this.now();
    await writeAudit(this.pool, {
      at,
      action: 'resources.report_exported',
      actorUserId: user.id,
      subjectType: 'project',
      subjectId: projectId,
      detail: { projectId, sections: report.finance ? ['lines', 'people', 'finance'] : ['lines', 'people'] },
    });
    return { text: toCsv(report), filename: `resources-${projectId}-${todayUtc8(at)}.csv` };
  }
}

const orWord = (v: string | null, word = NOT_PROVIDED): string => (v === null || v === '' ? word : v);
const label = (words: Record<string, string>, key: string): string => (Object.prototype.hasOwnProperty.call(words, key) ? words[key] : key);

function lineRow(l: LineView): unknown[] {
  const name = l.item ? `${l.item.reference} ${l.item.name}` : l.description;
  const noPeriod = l.startsOn === null && l.endsOn === null;
  return [
    LINE_STATUSES[l.status] ?? l.status,
    name,
    label(KIND_LABELS, l.item ? l.item.kind : l.oneOffKind ?? ''),
    orWord(l.quantity),
    l.unit === null ? NOT_PROVIDED : label(UNITS, l.unit),
    orWord(l.startsOn, NO_PERIOD),
    orWord(l.endsOn, noPeriod ? NO_PERIOD : NOT_PROVIDED),
    orWord(l.neededBy),
    l.neededByPassed ? 'Yes' : 'No',
    l.overlap ? l.overlap.named.map((n) => n.name).join('; ') : '',
    l.overlap ? l.overlap.others : '',
    l.notes,
  ];
}

type Figures = { budget: string | null; spent: string; balance: string | null; percentUsed: number | null; overBudget: boolean; notInTotals: { currency: string; amount: string }[] };
type AdjRow = { kind: string; amount: string; rate: string | null; rateOn: string | null; refundOn: string | null };
type EntryRow = { spentOn: string; amount: string; currency: string; description: string; reference: string; counted: string | null; adjustments: AdjRow[]; pending: unknown };

/** One approved adjustment, worded as the finance view words it; its amount is in the reporting currency (spec 3.5). */
function adjustmentText(a: AdjRow, reporting: string): string {
  const amount = `${a.amount} ${reporting}`.trim();
  if (a.kind === 'correction') return `Correction: counted amount set to ${amount}`;
  if (a.kind === 'refund') return `Refund of ${amount}${a.refundOn ? ` on ${a.refundOn}` : ''}`;
  return `Conversion: ${amount}${a.rate ? ` at rate ${a.rate}` : ''}${a.rateOn ? ` on ${a.rateOn}` : ''}`;
}

/** Columns: row, name, date, amount, amount currency, counted amount, counted currency, details. */
function financeRows(f: FinanceView): unknown[][] {
  const currency = (f.currency as string | null) ?? '';
  const figures = f.figures as Figures | null;
  const rows: unknown[][] = [['Summary', 'Financial tracking', '', '', '', '', '', f.tracking === 'enabled' ? 'On' : NOT_REQUIRED]];
  if (f.historyOnly) rows.push(['Summary', 'Notice', '', '', '', '', '', f.notice as string]);
  if (figures) {
    rows.push(['Summary', 'Approved budget', '', orWord(figures.budget), currency, '', '', '']);
    rows.push(['Summary', 'Spent', '', figures.spent, currency, '', '', 'Based on recorded entries.']);
    rows.push(['Summary', 'Balance', '', orWord(figures.balance), currency, '', '', 'Balance based on recorded expenditure']);
    // No budget: Not provided; a 0.00 budget has no percentage: Not applicable (spec 3.5).
    const percent = figures.percentUsed !== null ? String(figures.percentUsed) : figures.budget === null ? NOT_PROVIDED : NOT_APPLICABLE;
    rows.push(['Summary', 'Percent used', '', '', '', '', '', percent]);
    if (figures.overBudget) rows.push(['Summary', OVER_BUDGET, '', '', '', '', '', 'Yes']);
    for (const n of figures.notInTotals) rows.push(['Summary', NOT_IN_TOTALS, '', n.amount, n.currency, '', '', '']);
  } else rows.push(['Summary', 'Reporting currency', '', '', '', '', '', NOT_PROVIDED]);
  for (const v of f.budgetVersions as { amount: string; currency: string; approvedAt: Date }[]) {
    rows.push(['Budget version', 'Approved budget', new Date(v.approvedAt).toISOString().slice(0, 10), v.amount, v.currency, '', '', '']);
  }
  for (const e of f.entries as EntryRow[]) {
    const adj = e.adjustments.map((a) => adjustmentText(a, currency)).join('; ');
    const details = [e.reference && `Reference ${e.reference}`, adj, e.pending ? 'Adjustment pending' : ''].filter(Boolean).join('; ');
    // A foreign entry awaiting conversion has no counted amount: it is not in the totals.
    const counted = e.counted === null ? [NOT_IN_TOTALS, ''] : [e.counted, currency];
    rows.push(['Entry', e.description, e.spentOn, e.amount, e.currency, ...counted, details]);
  }
  return rows;
}

/** CSV: a `#` block, then the table, for each of `lines`, `people` and (readers only) `finance`. */
export function toCsv(report: ResourcesReport): string {
  const h = report.header;
  const head = { Report: 'Project resources', Project: h.project, 'Owning department': h.owningDepartment, 'Generated at': utc8Minute(h.generatedAt), Note: h.note };
  const parts = [
    csvTable(
      { ...head, Section: 'lines' },
      ['Status', 'Item or description', 'Kind', 'Quantity', 'Unit', 'Period start', 'Period end', 'Needed by', 'Needed-by passed', 'Overlapping projects (named)', 'Other overlapping projects (not named)', 'Notes'],
      report.lines.map(lineRow),
    ),
    csvTable({ ...head, Section: 'people' }, ['Name', 'Roles', 'Open tasks', 'Overdue'], report.people.map((p) => [p.name, p.roles.join('; '), p.openTasks, p.overdue])),
  ];
  if (report.finance) {
    parts.push(
      csvTable(
        { ...head, Section: 'finance' },
        ['Row', 'Name', 'Date', 'Amount', 'Amount currency', 'Counted amount', 'Counted currency', 'Details'],
        financeRows(report.finance),
      ),
    );
  }
  return parts.join('\r\n');
}
