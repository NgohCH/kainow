import { useEffect, useState } from 'react';
import { ApiError, api } from '../api.ts';
import { BASIS_NOTE, type FinanceView, NOT_REQUIRED, adjustmentLabel, figuresLines, money, notInTotalsLines } from '../finance.ts';
import { formatWhen, plural } from '../format.ts';
import { LINE_STATUSES, type LineStatus, type LineView, REPORT_NOTE, type ResourcesReport as Report, overlapText, unitLabel } from '../resources.ts';
import { lineName, periodText } from './Resources.tsx';

const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'That did not work. Try again.');
const ORDER: LineStatus[] = ['needed', 'arranged', 'in_use', 'finished', 'cancelled'];

function quantityText(l: LineView): string {
  return l.quantity === null ? 'Not provided' : `${l.quantity} ${unitLabel(l.unit)}`.trim();
}

function ReportFinance({ f }: { f: FinanceView }) {
  if (f.tracking === 'not_required') {
    return <p>Financial tracking: {NOT_REQUIRED}. Earlier entries are kept here for reference.</p>;
  }
  const currency = f.currency;
  return (
    <>
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
          <div className="table-scroll">
            <table className="table">
              <caption className="visually-hidden">Recorded spending, in date order</caption>
              <thead>
                <tr>
                  <th scope="col">Spent on</th>
                  <th scope="col">Description</th>
                  <th scope="col">Amount</th>
                  <th scope="col">Counted</th>
                </tr>
              </thead>
              <tbody>
                {f.entries.map((e) => (
                  <tr key={e.id}>
                    <td>{e.spentOn}</td>
                    <td>
                      {e.description}
                      {e.reference && <span className="meta"> · {e.reference}</span>}
                      {e.adjustments.map((a) => <div key={a.id} className="meta">{adjustmentLabel(a, currency)}</div>)}
                    </td>
                    <td>{money(e.amount, e.currency)}</td>
                    <td>{e.counted === null ? 'Not in totals' : money(e.counted, currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
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

      <section aria-labelledby="report-lines">
        <h3 id="report-lines">Resources</h3>
        {report.lines.length === 0 ? (
          <p className="meta">No resources have been recorded for this project.</p>
        ) : (
          ORDER.map((s) => {
            const rows = report.lines.filter((l) => l.status === s);
            if (rows.length === 0) return null;
            return (
              <div key={s}>
                <h4>{LINE_STATUSES[s]} ({rows.length})</h4>
                <ul className="plain">
                  {rows.map((l) => {
                    const overlap = overlapText(l.overlap);
                    return (
                      <li key={l.id}>
                        <strong>{lineName(l)}</strong>
                        <span className="meta"> · {quantityText(l)} · {periodText(l)}{l.neededBy ? ` · needed by ${l.neededBy}` : ''}</span>
                        {overlap && <div className="warn">{overlap}</div>}
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })
        )}
      </section>

      <section aria-labelledby="report-passed">
        <h3 id="report-passed">Needed-by date passed</h3>
        {report.neededByPassed.length === 0 ? (
          <p className="meta">None.</p>
        ) : (
          <>
            <p className="warn">Resources past needed-by date: {report.neededByPassed.length}</p>
            <ul className="plain">
              {report.neededByPassed.map((l) => (
                <li key={l.id}>{lineName(l)} <span className="meta">· needed by {l.neededBy} · {LINE_STATUSES[l.status]}</span></li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section aria-labelledby="report-people">
        <h3 id="report-people">People</h3>
        {report.people.length === 0 ? (
          <p className="meta">No one is on the project right now.</p>
        ) : (
          <ul className="plain">
            {report.people.map((p) => (
              <li key={p.userId}>
                {p.name} · {p.roles.join(', ')}{p.department ? ` · ${p.department}` : ''} · {plural(p.openTasks, 'open task')}
                {p.overdue > 0 ? ` (${p.overdue} overdue)` : ''}
              </li>
            ))}
          </ul>
        )}
      </section>

      {report.finance && (
        <section aria-labelledby="report-finance">
          <h3 id="report-finance">Finance</h3>
          <ReportFinance f={report.finance} />
        </section>
      )}
      <p className="meta">{REPORT_NOTE}</p>
    </article>
  );
}
