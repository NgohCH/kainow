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
import { LINE_STATUSES } from './vocabulary';

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

function lineRow(l: LineView): unknown[] {
  const name = l.item ? `${l.item.reference} ${l.item.name}` : l.description;
  const noPeriod = l.startsOn === null && l.endsOn === null;
  return [
    LINE_STATUSES[l.status] ?? l.status,
    name,
    l.item ? l.item.kind : l.oneOffKind ?? '',
    orWord(l.quantity),
    orWord(l.unit),
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
type EntryRow = { spentOn: string; amount: string; currency: string; description: string; reference: string; counted: string | null; adjustments: { kind: string; amount: string }[]; pending: unknown };

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
    rows.push(['Summary', 'Percent used', '', '', '', '', '', figures.percentUsed === null ? NOT_PROVIDED : `${figures.percentUsed}${figures.overBudget ? ' (Over budget)' : ''}`]);
    for (const n of figures.notInTotals) rows.push(['Summary', 'Not in totals', '', n.amount, n.currency, '', '', '']);
  } else rows.push(['Summary', 'Reporting currency', '', '', '', '', '', NOT_PROVIDED]);
  for (const v of f.budgetVersions as { amount: string; currency: string; approvedAt: Date }[]) {
    rows.push(['Budget version', 'Approved budget', new Date(v.approvedAt).toISOString().slice(0, 10), v.amount, v.currency, '', '', '']);
  }
  for (const e of f.entries as EntryRow[]) {
    const adj = e.adjustments.map((a) => `${a.kind} ${a.amount} ${e.currency}`).join('; ');
    const details = [e.reference && `Reference ${e.reference}`, adj, e.pending ? 'Adjustment pending' : ''].filter(Boolean).join('; ');
    rows.push(['Entry', e.description, e.spentOn, e.amount, e.currency, orWord(e.counted), currency, details]);
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
