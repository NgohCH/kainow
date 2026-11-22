import { type ReactNode, useEffect, useState } from 'react';
import { ApiError, api } from '../../api.ts';
import { blockedText } from '../../ai.ts';
import {
  COLUMN_LABELS,
  COVERAGE_NOTE,
  type ChartMode,
  type ChartPoint,
  DRILL_LABELS,
  type DrillLevel,
  type DrillMeasure,
  type DrillResult,
  PROBLEM_KEYS,
  type ProblemCounts,
  type ProblemKey,
  type ProblemsPanel,
  type ProgressPanel,
  type ProgressRow,
  type Roll,
  type SortDir,
  type SystemPanel,
  TREND_KEYS,
  TREND_LABELS,
  type TrendsPanel,
  chartBars,
  chartTableEquivalent,
  drillValueText,
  onTimeSeries,
  sortRows,
  trendSeries,
} from '../../analytics.ts';
import { awaitingLabel, cancelledLabel, completionLabel, dayLabel, lateLabel, onTimeLabel, plannedEndLabel } from '../../dashboard.ts';
import { plural } from '../../format.ts';
import { STATUS_LABEL } from '../../projects.ts';
import { Bars } from '../Bars.tsx';

const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'That did not work. Try again.');

/** Where a drill-down starts or goes next: a level, its id and name, and the measure. */
export interface DrillTarget {
  level: DrillLevel;
  id: string | null;
  name: string;
  measure: DrillMeasure;
}

/** A count that opens its drill-down. The accessible name starts with the figure shown. */
export function DrillButton({ text, target, onDrill }: { text: string; target: DrillTarget; onDrill: (t: DrillTarget) => void }) {
  return (
    <button type="button" className="link-button" aria-label={`${text}: ${DRILL_LABELS[target.measure]}, ${target.name}. Show the breakdown`} onClick={() => onDrill(target)}>
      {text}
    </button>
  );
}

/** "Download CSV" for a panel's table, with the filters in force; absent (with a note) when export is turned off. */
export function CsvLink({ panel, query, allowed }: { panel: string; query: string; allowed: boolean | null }) {
  if (allowed === false) return <p className="meta">Analytics export is turned off.</p>;
  return (
    <p>
      <a href={api.url(`/admin/analytics/export?panel=${panel}&${query}`)}>Download CSV</a>
    </p>
  );
}

function ModeSwitch({ mode, label, onMode }: { mode: ChartMode; label: string; onMode: (m: ChartMode) => void }) {
  const next: ChartMode = mode === 'chart' ? 'table' : 'chart';
  const text = next === 'table' ? 'Show as table' : 'Show as chart';
  return (
    <button type="button" className="quiet" aria-label={`${text}: ${label}`} onClick={() => onMode(next)}>
      {text}
    </button>
  );
}

/** A chart (CSS bars with a hidden table) or its visible table, carrying the same rows. */
function Chart({ series, caption, mode, scale }: { series: ChartPoint[]; caption: string; mode: ChartMode; scale: 'percent' | 'count' }) {
  if (mode === 'chart') return <Bars items={chartBars(series, scale).items} caption={caption} />;
  const rows = chartTableEquivalent(series);
  return (
    <div className="table-scroll">
      <table className="table usage-table">
        <caption className="visually-hidden">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Item</th>
            <th scope="col">Figure</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${i}-${r.label}`}>
              <th scope="row">{r.label}</th>
              <td data-label="Figure">{r.text}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function About({ children }: { children: ReactNode }) {
  return (
    <details className="about-figures">
      <summary>About these figures</summary>
      {children}
      <p>
        <a href="#/admin/analytics/definitions">Definitions of every measure</a>
      </p>
    </details>
  );
}

function SortHeader({ column, sort, onSort }: { column: string; sort: { column: string; dir: SortDir }; onSort: (column: string) => void }) {
  const active = sort.column === column;
  return (
    <th scope="col" aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" className="link-button" onClick={() => onSort(column)}>
        {COLUMN_LABELS[column]}
      </button>
    </th>
  );
}

function useSort(initial: string) {
  const [sort, setSort] = useState<{ column: string; dir: SortDir }>({ column: initial, dir: 'asc' });
  const onSort = (column: string) => setSort((s) => (s.column === column ? { column, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { column, dir: 'asc' }));
  return { sort, onSort };
}

const stageText = (s: ProgressRow['stage']) => (s ? `${s.stage}${s.substage ? `, ${s.substage}` : ''}, ${plural(s.days, 'day')}` : 'None');

function rollCompletion(r: Roll): string {
  return r.completionPercent === null
    ? 'Progress not yet measurable'
    : completionLabel({ state: 'measurable', done: r.tasksDone, total: r.tasksTotal, cancelled: 0, percent: r.completionPercent });
}
function rollOnTime(r: Roll): string {
  if (r.onTimePercent === null) return 'Nothing due yet';
  return `${onTimeLabel({ state: 'measured', due: r.onTimeDue, done: r.onTimeDone, late: r.onTimeLate, percent: r.onTimePercent, awaitingReview: 0 })}, ${r.onTimeLate} late`;
}

/** Panel 1: Project progress (spec 7.2 item 1). */
export function ProgressView({
  data, columns, mode, onMode, onDrill, csv,
}: {
  data: ProgressPanel;
  columns: string[];
  mode: ChartMode;
  onMode: (m: ChartMode) => void;
  onDrill: (t: DrillTarget) => void;
  csv: ReactNode;
}) {
  const { sort, onSort } = useSort('name');
  const rows = sortRows(data.projects, sort.column, sort.dir);
  const cell = (r: ProgressRow, c: string) => {
    const target = (measure: DrillMeasure): DrillTarget => ({ level: 'project', id: r.id, name: r.name, measure });
    switch (c) {
      case 'owningDepartment':
        return r.owningDepartment;
      case 'status':
        return STATUS_LABEL[r.status] ?? r.status;
      case 'stage':
        return stageText(r.stage);
      case 'completion': {
        const cancelled = cancelledLabel(r.completion);
        return <><DrillButton text={completionLabel(r.completion)} target={target('completion')} onDrill={onDrill} />{cancelled && <span className="meta"> · {cancelled}</span>}</>;
      }
      case 'onTime': {
        const extra = [lateLabel(r.onTime), awaitingLabel(r.onTime)].filter(Boolean).join(' · ');
        return <><DrillButton text={onTimeLabel(r.onTime)} target={target('onTime')} onDrill={onDrill} />{extra && <span className="meta"> · {extra}</span>}</>;
      }
      case 'plannedEnd':
        return plannedEndLabel(r.plannedEnd);
      case 'overdue':
        return <DrillButton text={String(r.overdue)} target={target('overdue')} onDrill={onDrill} />;
      case 'blocked':
        return <DrillButton text={String(r.blocked)} target={target('blocked')} onDrill={onDrill} />;
      default:
        return null;
    }
  };
  const shownColumns = columns.filter((c) => c !== 'name');

  return (
    <>
      <h3>Departments</h3>
      {data.departments.length === 0 ? (
        <p className="empty">No projects match these filters.</p>
      ) : (
        <div className="table-scroll">
          <table className="table usage-table">
            <caption className="visually-hidden">Project progress by owning department</caption>
            <thead>
              <tr>
                <th scope="col">Department</th>
                <th scope="col">Projects</th>
                <th scope="col">Task completion</th>
                <th scope="col">On-time completion</th>
                <th scope="col">Overdue</th>
                <th scope="col">Blocked</th>
                <th scope="col">Also contributes to</th>
              </tr>
            </thead>
            <tbody>
              {data.departments.map((d) => {
                const target = (measure: DrillMeasure): DrillTarget => ({ level: 'department', id: d.id, name: d.name, measure });
                return (
                  <tr key={d.id}>
                    <th scope="row">{d.name}</th>
                    <td data-label="Projects">{d.projects}</td>
                    <td data-label="Task completion"><DrillButton text={rollCompletion(d)} target={target('completion')} onDrill={onDrill} /></td>
                    <td data-label="On-time completion"><DrillButton text={rollOnTime(d)} target={target('onTime')} onDrill={onDrill} /></td>
                    <td data-label="Overdue"><DrillButton text={String(d.overdue)} target={target('overdue')} onDrill={onDrill} /></td>
                    <td data-label="Blocked"><DrillButton text={String(d.blocked)} target={target('blocked')} onDrill={onDrill} /></td>
                    <td data-label="Also contributes to">
                      {d.alsoContributesTo.length === 0 ? 'None' : d.alsoContributesTo.map((p) => `${p.name} (${p.owningDepartment})`).join(', ')}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="row">
        <h3>On-time completion by project</h3>
        <ModeSwitch mode={mode} label="On-time completion by project" onMode={onMode} />
      </div>
      {data.projects.length > 0 && <Chart series={onTimeSeries(data.projects)} caption="On-time completion by project" mode={mode} scale="percent" />}

      <h3>Projects</h3>
      {data.projects.length === 0 ? (
        <p className="empty">No projects match these filters.</p>
      ) : (
        <div className="table-scroll">
          <table className="table usage-table">
            <caption className="visually-hidden">Project progress, one row per project</caption>
            <thead>
              <tr>
                <SortHeader column="name" sort={sort} onSort={onSort} />
                {shownColumns.map((c) => <SortHeader key={c} column={c} sort={sort} onSort={onSort} />)}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <th scope="row">{r.name}</th>
                  {shownColumns.map((c) => <td key={c} data-label={COLUMN_LABELS[c]}>{cell(r, c)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {csv}
      <About>
        <p>{COVERAGE_NOTE}</p>
        <p>These figures are as they stand now; the period does not change them. Each project counts once, under its owning department. Projects a department contributes to are listed beside it and not added to its totals.</p>
      </About>
    </>
  );
}

/** Panel 2: Project problems (spec 7.2 item 2). */
export function ProblemsView({ data, columns, onDrill, csv }: { data: ProblemsPanel; columns: string[]; onDrill: (t: DrillTarget) => void; csv: ReactNode }) {
  const { sort, onSort } = useSort('name');
  const keys = columns.filter((c): c is ProblemKey => (PROBLEM_KEYS as readonly string[]).includes(c));
  const counts = (c: ProblemCounts, level: DrillLevel, id: string | null, name: string) =>
    keys.map((k) => (
      <td key={k} data-label={COLUMN_LABELS[k]}>
        <DrillButton text={String(c[k])} target={{ level, id, name, measure: k }} onDrill={onDrill} />
      </td>
    ));
  const head = keys.map((k) => <th key={k} scope="col">{COLUMN_LABELS[k]}</th>);

  return (
    <>
      <h3>Organisation and departments</h3>
      <div className="table-scroll">
        <table className="table usage-table">
          <caption className="visually-hidden">Project problems: organisation totals and each owning department</caption>
          <thead>
            <tr>
              <th scope="col">Totals for</th>
              <th scope="col">Projects</th>
              {head}
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">All projects shown</th>
              <td data-label="Projects">{data.projects.length}</td>
              {counts(data.organisation, 'org', null, 'All projects shown')}
            </tr>
            {data.departments.map((d) => (
              <tr key={d.id}>
                <th scope="row">{d.name}</th>
                <td data-label="Projects">{d.projects}</td>
                {counts(d, 'department', d.id, d.name)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3>Projects</h3>
      {data.projects.length === 0 ? (
        <p className="empty">No projects match these filters.</p>
      ) : (
        <div className="table-scroll">
          <table className="table usage-table">
            <caption className="visually-hidden">Project problems, one row per project</caption>
            <thead>
              <tr>
                <SortHeader column="name" sort={sort} onSort={onSort} />
                {columns.filter((c) => c !== 'name').map((c) => <SortHeader key={c} column={c} sort={sort} onSort={onSort} />)}
              </tr>
            </thead>
            <tbody>
              {sortRows(data.projects, sort.column, sort.dir).map((p) => (
                <tr key={p.id}>
                  <th scope="row">{p.name}</th>
                  {columns.filter((c) => c !== 'name').map((c) =>
                    c === 'owningDepartment' ? (
                      <td key={c} data-label={COLUMN_LABELS[c]}>{p.owningDepartment}</td>
                    ) : (
                      <td key={c} data-label={COLUMN_LABELS[c]}>
                        <DrillButton text={String(p[c as ProblemKey])} target={{ level: 'project', id: p.id, name: p.name, measure: c as ProblemKey }} onDrill={onDrill} />
                      </td>
                    ),
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {csv}
      <About>
        <p>{COVERAGE_NOTE}</p>
        <p>Every figure is as it stands now, except invitations expired, which counts invitations that expired unanswered in the period. Vacant required roles and No independent escalation recipient count projects.</p>
      </About>
    </>
  );
}

/** Panel 3: System problems (spec 7.2 item 3). Organisation-wide; only the period applies. */
export function SystemView({ data, csv }: { data: SystemPanel; csv: ReactNode }) {
  const blocked = Object.entries(data.ai.blockedByReason);
  const failed = Object.entries(data.jobs.failedByQueue);
  const act = (href: string | null, text: string) => (href ? <p><a href={href}>{text}</a></p> : null);
  return (
    <>
      <div className="grid-2">
        <section aria-labelledby="sys-emails">
          <h3 id="sys-emails">Emails</h3>
          <ul className="plain">
            <li>Failed in the period: {data.emails.failed}</li>
            <li>Uncertain in the period: {data.emails.uncertain}</li>
            <li>Waiting to retry now: {data.emails.retryWaiting}</li>
          </ul>
          {act(data.links.emails, 'Open email delivery')}
        </section>
        <section aria-labelledby="sys-ai">
          <h3 id="sys-ai">AI</h3>
          <ul className="plain">
            {blocked.length === 0 ? <li>No Active project's analysis would be Blocked now.</li> : blocked.map(([code, n]) => <li key={code}>{blockedText(code)}: {plural(n, 'Active project')}</li>)}
            <li>Connections in Key rejected: {data.ai.keyRejected}</li>
          </ul>
          {act(data.links.ai, 'Open AI settings')}
        </section>
        <section aria-labelledby="sys-jobs">
          <h3 id="sys-jobs">Jobs</h3>
          <ul className="plain">
            {failed.length === 0 ? <li>No jobs failed in the period.</li> : failed.map(([queue, n]) => <li key={queue}>Failed in the period, {queue}: {n}</li>)}
            <li>Waiting longer than 15 minutes: {data.jobs.waitingOver15m}</li>
          </ul>
          {act(data.links.jobs, 'Open jobs')}
        </section>
        <section aria-labelledby="sys-security">
          <h3 id="sys-security">Security</h3>
          <ul className="plain">
            <li>Credential cases awaiting review: {data.security.casesAwaitingReview}</li>
            {!data.security.protectedKeyInstalled && <li>Protected key not installed</li>}
          </ul>
          {act(data.links.security, 'Open security review')}
        </section>
        <section aria-labelledby="sys-storage">
          <h3 id="sys-storage">Storage</h3>
          <ul className="plain">
            <li>Files that failed to store: {data.storageFailures}</li>
            <li>Files waiting to be stored: {data.storageWaiting}</li>
            <li>Held files still in storage after removal failed: {data.withholdFailures}</li>
            <li>Sharing to repair: {data.sharingToRepair}</li>
          </ul>
        </section>
      </div>
      {csv}
      <About>
        <p>Organisation-wide: the department, status, ownership and Include archived filters do not apply. The period applies to failed and uncertain emails and to failed jobs; every other line is as it stands now. Jobs count as waiting when they have waited longer than 15 minutes.</p>
      </About>
    </>
  );
}

/** Panel 4: Trends (spec 7.2 item 4), one chart or table per measure. */
export function TrendsView({ data, modes, onMode, csv }: { data: TrendsPanel; modes: Record<string, ChartMode>; onMode: (key: string, m: ChartMode) => void; csv: ReactNode }) {
  return (
    <>
      <p className="meta">Weeks start Monday 00:00 UTC+8. The status and Include archived filters do not apply to trends.</p>
      {TREND_KEYS.map((k) => {
        const key = `trends.${k}`;
        const mode = modes[key] ?? 'chart';
        return (
          <section key={k} aria-labelledby={`trend-${k}`}>
            <div className="row">
              <h3 id={`trend-${k}`}>{TREND_LABELS[k]}</h3>
              <ModeSwitch mode={mode} label={TREND_LABELS[k]} onMode={(m) => onMode(key, m)} />
            </div>
            <Chart series={trendSeries(data.weeks, data.series[k])} caption={`${TREND_LABELS[k]}, by week`} mode={mode} scale="count" />
          </section>
        );
      })}
      {csv}
      <About>
        <p>{data.note}</p>
        <p>{COVERAGE_NOTE}</p>
      </About>
    </>
  );
}

/** The drill-down under a panel: counts by level, and at project level the records for a participant only. */
export function Drill({ stack, query, onDrill, onBack, onClose }: { stack: DrillTarget[]; query: string; onDrill: (t: DrillTarget) => void; onBack: () => void; onClose: () => void }) {
  const t = stack[stack.length - 1];
  const [result, setResult] = useState<DrillResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let stale = false;
    setResult(null);
    setError(null);
    const q = new URLSearchParams({ level: t.level, measure: t.measure });
    if (t.id) q.set('id', t.id);
    api.get<DrillResult>(`/admin/analytics/drill?${q.toString()}&${query}`).then(
      (r) => !stale && setResult(r),
      (e) => !stale && setError(errText(e)),
    );
    return () => {
      stale = true;
    };
  }, [t.level, t.id, t.measure, query]);

  const next: DrillLevel | null = t.level === 'org' ? 'department' : t.level === 'department' ? 'project' : null;
  const label = DRILL_LABELS[t.measure];
  return (
    <section className="panel" aria-labelledby="drill-heading" aria-live="polite">
      <div className="row">
        <h3 id="drill-heading">{label}: {t.name}</h3>
        <span className="inline-form">
          {stack.length > 1 && <button type="button" className="quiet" onClick={onBack}>Back to {stack[stack.length - 2].name}</button>}
          <button type="button" className="quiet" onClick={onClose}>Close the breakdown</button>
        </span>
      </div>
      {error && <p role="alert" className="error">{error}</p>}
      {!result && !error && <p className="loading">Loading</p>}
      {result && (
        <>
          <p>Total: {drillValueText(result.measure, result.counts.total)}</p>
          {result.counts.breakdown && result.counts.breakdown.length > 0 && (
            <ul className="plain">
              {result.counts.breakdown.map((b) => (
                <li key={b.id}>
                  {b.name}:{' '}
                  {next ? (
                    <DrillButton text={drillValueText(result.measure, b.value)} target={{ level: next, id: b.id, name: b.name, measure: t.measure }} onDrill={onDrill} />
                  ) : (
                    drillValueText(result.measure, b.value)
                  )}
                </li>
              ))}
            </ul>
          )}
          {result.counts.breakdown && result.counts.breakdown.length === 0 && <p className="empty">Nothing to break down.</p>}
          {result.limited && <p className="meta">{result.limited}</p>}
          {result.records && (result.records.length === 0 ? (
            <p className="empty">No records.</p>
          ) : (
            <div className="table-scroll">
              <table className="table usage-table">
                <caption className="visually-hidden">{label}: the records in {t.name}</caption>
                <thead>
                  <tr>
                    <th scope="col">Record</th>
                    <th scope="col">Assignee</th>
                    <th scope="col">Date</th>
                  </tr>
                </thead>
                <tbody>
                  {result.records.map((r) => (
                    <tr key={r.id}>
                      <th scope="row"><a href={r.link}>{r.title}</a></th>
                      <td data-label="Assignee">{r.assignee ?? 'None'}</td>
                      <td data-label="Date">{r.dueOn ? dayLabel(r.dueOn) : 'None'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </>
      )}
    </section>
  );
}
