import { useEffect, useState } from 'react';
import { ApiError, api } from '../api.ts';
import { BASIS_NOTE, type EntryView, type FinanceView, NOT_REQUIRED_NOTICE, adjustmentLabel, figuresLines, money, notInTotalsLines } from '../finance.ts';
import { formatWhen, plural } from '../format.ts';
import { type LineStatus, type LineView, REPORT_NOTE, type ResourcesReport as Report, overlapText } from '../resources.ts';
import { DataTable, type Column } from '../ui/DataTable.tsx';
import { StatusLabel } from '../ui/StatusLabel.tsx';
import { LineLabels, lineName, periodText, quantityText } from './Resources.tsx';

const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'That did not work. Try again.');
const ORDER: LineStatus[] = ['needed', 'arranged', 'in_use', 'finished', 'cancelled'];

const LINE_COLUMNS: Column<LineView>[] = [
  {
    key: 'resource',
    header: 'Resource',
    sortValue: (l) => lineName(l).toLowerCase(),
    cell: (l) => {
      const overlap = overlapText(l.overlap);
      return (
        <span>
          {lineName(l)}
          {overlap && <span className="warn work-parent">{overlap}</span>}
        </span>
      );
    },
  },
  { key: 'status', header: 'Status', sortValue: (l) => ORDER.indexOf(l.status), cell: (l) => <LineLabels line={l} /> },
  { key: 'quantity', header: 'Quantity', cell: quantityText },
  { key: 'period', header: 'Period', sortValue: (l) => l.startsOn ?? '', cell: periodText },
  { key: 'neededBy', header: 'Needed by', sortValue: (l) => l.neededBy ?? '', cell: (l) => l.neededBy ?? 'Not set' },
];

function ReportFinance({ f }: { f: FinanceView }) {
  const currency = f.currency;
  const spending: Column<EntryView>[] = currency
    ? [
        { key: 'spentOn', header: 'Spent on', sortValue: (e) => e.spentOn, cell: (e) => e.spentOn },
        {
          key: 'description',
          header: 'Description',
          cell: (e) => (
            <span>
              {e.description}
              {e.reference && <span className="meta"> · {e.reference}</span>}
              {e.adjustments.map((a) => <span key={a.id} className="meta work-parent">{adjustmentLabel(a, currency)}</span>)}
            </span>
          ),
        },
        { key: 'amount', header: 'Amount', cell: (e) => money(e.amount, e.currency) },
        { key: 'counted', header: 'Counted', cell: (e) => (e.counted === null ? <StatusLabel meaning="off" word="Not in totals" /> : money(e.counted, currency)) },
      ]
    : [];
  return (
    <>
      {f.tracking === 'not_required' && <p>{f.notice ?? NOT_REQUIRED_NOTICE}</p>}
      {currency && f.figures && (
        <>
          <dl className="facts">
            <dt>Reporting currency</dt>
            <dd>{currency}</dd>
            <dt>Approved budget</dt>
            <dd>{money(f.figures.budget, currency)}</dd>
            <dt>Recorded spending</dt>
            <dd>{money(f.figures.spent, currency)}</dd>
          </dl>
          <ul className="plain">
            {figuresLines(f.figures, currency).map((t) => <li key={t}>{t}</li>)}
            {notInTotalsLines(f.figures).map((t) => <li key={t}>{t}</li>)}
          </ul>
          {f.figures.budget === null && <p className="meta">{BASIS_NOTE}</p>}
        </>
      )}
      {f.budgetVersions.length > 0 && currency && (
        <>
          <h3>Budget versions</h3>
          <ul className="plain">
            {f.budgetVersions.map((b) => (
              <li key={b.id}>{money(b.amount, b.currency)} <span className="meta">approved {formatWhen(b.approvedAt)}</span></li>
            ))}
          </ul>
        </>
      )}
      {f.entries.length > 0 && currency && (
        <>
          <h3>Spending</h3>
          <DataTable caption="Recorded spending, in date order" columns={spending} rows={f.entries} rowKey={(e) => e.id} empty="No spending has been recorded." />
        </>
      )}
      {f.tracking === 'not_required' && f.entries.length === 0 && f.budgetVersions.length === 0 && <p className="meta">No earlier entries.</p>}
      {f.pending.length > 0 && <p className="meta">Awaiting approval: {plural(f.pending.length, 'request')}</p>}
    </>
  );
}

/** `#/projects/:id/resources/report` (spec 4): a printable page of the project's resource records. */
export function ResourcesReport({ projectId }: { projectId: string }) {
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stale = false;
    setReport(null);
    setError(null);
    api.get<Report>(`/projects/${projectId}/resources/report`).then(
      (r) => !stale && setReport(r),
      (e: unknown) => !stale && setError(errText(e)),
    );
    return () => {
      stale = true;
    };
  }, [projectId]);

  if (!report) return error ? <p role="alert" className="error">{error}</p> : <p className="loading">Loading report</p>;
  const h = report.header;
  const csv = api.url(`/projects/${projectId}/resources/report?format=csv`);

  return (
    <article className="report" aria-labelledby="report-title">
      <div className="row no-print">
        <p><a href={`#/projects/${projectId}/resources`}>Back to Resources</a></p>
        <span className="decision">
          <button type="button" onClick={() => window.print()}>Print</button>
          <a className="button" href={csv} download>Download CSV</a>
        </span>
      </div>
      <header>
        <h2 id="report-title">Project resources report</h2>
        <dl className="facts">
          <dt>Project</dt>
          <dd>{h.project}</dd>
          <dt>Owning department</dt>
          <dd>{h.owningDepartment}</dd>
          <dt>Generated</dt>
          <dd>{formatWhen(h.generatedAt)} (UTC+8)</dd>
        </dl>
        <p><strong>{REPORT_NOTE}</strong></p>
      </header>

      <section aria-labelledby="report-lines" className="box">
        <h3 id="report-lines" className="box-title">Resources</h3>
        <DataTable caption="Resource lines by status" columns={LINE_COLUMNS} rows={report.lines} rowKey={(l) => l.id} empty="No resources have been recorded for this project." initialSort={{ key: 'status', dir: 'asc' }} />
      </section>

      <section aria-labelledby="report-passed" className="box">
        <h3 id="report-passed" className="box-title">Needed-by date passed</h3>
        {report.neededByPassed.length > 0 && <p><StatusLabel meaning="overdue" word={`Resources past needed-by date: ${report.neededByPassed.length}`} /></p>}
        <DataTable caption="Resources past their needed-by date" columns={LINE_COLUMNS} rows={report.neededByPassed} rowKey={(l) => l.id} empty="None." />
      </section>

      <section aria-labelledby="report-people" className="box">
        <h3 id="report-people" className="box-title">People</h3>
        <DataTable
          caption="People on the project and their open tasks"
          columns={[
            { key: 'name', header: 'Person', sortValue: (p) => p.name.toLowerCase(), cell: (p) => p.name },
            { key: 'roles', header: 'Roles', cell: (p) => p.roles.join(', ') },
            { key: 'department', header: 'Department', cell: (p) => p.department ?? 'Not recorded' },
            { key: 'tasks', header: 'Open tasks', sortValue: (p) => p.openTasks, cell: (p) => `${plural(p.openTasks, 'open task')}${p.overdue > 0 ? ` (${p.overdue} overdue)` : ''}` },
          ]}
          rows={report.people}
          rowKey={(p) => p.userId}
          empty="No one is on the project right now."
        />
      </section>

      {report.finance && (
        <section aria-labelledby="report-finance" className="box">
          <h3 id="report-finance" className="box-title">Finance</h3>
          <ReportFinance f={report.finance} />
        </section>
      )}
      <p className="meta">{REPORT_NOTE}</p>
    </article>
  );
}
