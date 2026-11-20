import { type ReactNode, useState } from 'react';
import type { ChartMode, FinanceGroup, ResourceLineRow, ResourcesPanel, ResourcesTable } from '../../analytics.ts';
import { NOT_IN_TOTALS, NOT_PROVIDED, NOT_REQUIRED, OVER_BUDGET, money } from '../../finance.ts';
import { dayLabel } from '../../dashboard.ts';
import { plural } from '../../format.ts';
import { AI_SEPARATE_TITLE, sharePercent } from '../../resourceScreens.ts';
import { Bars } from '../Bars.tsx';

const LINE_COLUMNS: Array<[keyof ResourceLineRow, string]> = [
  ['needed', 'Needed'],
  ['arranged', 'Arranged'],
  ['inUse', 'In use'],
  ['finishedInPeriod', 'Finished in the period'],
  ['neededByPassed', 'Needed-by date passed'],
  ['overlapping', 'Lines with overlaps'],
];

function LineCells({ row }: { row: ResourceLineRow }) {
  return (
    <>
      {LINE_COLUMNS.map(([k, label]) => (
        <td key={k} data-label={label}>{row[k]}</td>
      ))}
    </>
  );
}

function budgetText(budget: string | null, currency: FinanceGroup['currency']): string {
  return budget === null ? NOT_PROVIDED : money(budget, currency);
}

function warningText(level: 0 | 1 | 2, over: boolean): string {
  if (over) return OVER_BUDGET;
  if (level === 2) return 'At or above the second warning';
  if (level === 1) return 'At or above the first warning';
  return 'No warning';
}

/** One currency group: totals, then a chart (CSS bars of spending against the largest figure) or the table with the same rows. */
function FinanceGroupView({ g, mode, onMode }: { g: FinanceGroup; mode: ChartMode; onMode: (m: ChartMode) => void }) {
  const max = g.projects.reduce((m, p) => Math.max(m, Number(p.spent), Number(p.budget ?? 0)), 0).toFixed(2);
  const next: ChartMode = mode === 'chart' ? 'table' : 'chart';
  return (
    <section aria-labelledby={`fin-${g.currency}`}>
      <div className="row">
        <h4 id={`fin-${g.currency}`}>{g.currency}</h4>
        <button type="button" className="quiet" aria-label={`${next === 'table' ? 'Show as table' : 'Show as chart'}: finance in ${g.currency}`} onClick={() => onMode(next)}>
          {next === 'table' ? 'Show as table' : 'Show as chart'}
        </button>
      </div>
      <ul className="plain">
        <li>Projects tracking: {g.projectsTracking}</li>
        <li>Budget {NOT_PROVIDED}: {plural(g.budgetNotProvided, 'project')}</li>
        <li>Total approved budget: {money(g.totalBudget, g.currency)}</li>
        <li>Total recorded spending: {money(g.totalSpent, g.currency)}</li>
        <li>At or above the first warning: {g.atFirst}</li>
        <li>At or above the second warning: {g.atSecond}</li>
      </ul>
      {mode === 'chart' ? (
        <Bars
          caption={`Recorded spending by project, ${g.currency}`}
          items={g.projects.map((p) => ({
            label: p.name,
            value: sharePercent(p.spent, max),
            max: 100,
            text: `Spent ${money(p.spent, g.currency)} · budget ${budgetText(p.budget, g.currency)}${p.percentUsed !== null ? ` · ${p.percentUsed}% used` : ''}${p.overBudget ? ` · ${OVER_BUDGET}` : ''}`,
          }))}
        />
      ) : (
        <div className="table-scroll">
          <table className="table usage-table">
            <caption className="visually-hidden">Finance by project, {g.currency}</caption>
            <thead>
              <tr>
                <th scope="col">Project</th>
                <th scope="col">Owning department</th>
                <th scope="col">Budget</th>
                <th scope="col">Spent</th>
                <th scope="col">Used</th>
                <th scope="col">Warning</th>
                <th scope="col">{NOT_IN_TOTALS}</th>
              </tr>
            </thead>
            <tbody>
              {g.projects.map((p) => (
                <tr key={p.id}>
                  <th scope="row" data-label="Project">{p.name}</th>
                  <td data-label="Owning department">{p.owningDepartment}</td>
                  <td data-label="Budget">{budgetText(p.budget, g.currency)}</td>
                  <td data-label="Spent">{money(p.spent, g.currency)}</td>
                  <td data-label="Used">{p.percentUsed === null ? '' : `${p.percentUsed}%`}</td>
                  <td data-label="Warning">{warningText(p.level, p.overBudget)}</td>
                  <td data-label={NOT_IN_TOTALS}>{p.notInTotals.length === 0 ? 'None' : p.notInTotals.map((n) => money(n.amount, n.currency)).join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** Panel 5: Resources and finance (spec 7). Counts, item references and summary figures only; never entries. */
export function ResourcesView({ data, csv }: { data: ResourcesPanel; csv: (table: ResourcesTable) => ReactNode }) {
  const [modes, setModes] = useState<Record<string, ChartMode>>({});
  const o = data.lines.organisation;
  return (
    <>
      <section aria-labelledby="res-lines">
        <h3 id="res-lines">Resource lines</h3>
        <div className="table-scroll">
          <table className="table usage-table">
            <caption className="visually-hidden">Resource lines by status, for the organisation, each department and each project</caption>
            <thead>
              <tr>
                <th scope="col">Organisation, department or project</th>
                {LINE_COLUMNS.map(([k, label]) => <th key={k} scope="col">{label}</th>)}
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row" data-label="Level">Organisation</th>
                <LineCells row={o} />
              </tr>
              {data.lines.departments.map((d) => (
                <tr key={d.id}>
                  <th scope="row" data-label="Department">{d.name} <span className="meta">({plural(d.projects, 'project')})</span></th>
                  <LineCells row={d} />
                </tr>
              ))}
              {data.lines.projects.map((p) => (
                <tr key={p.id}>
                  <th scope="row" data-label="Project"><a href={`#/projects/${p.id}`}>{p.name}</a> <span className="meta">{p.owningDepartment}</span></th>
                  <LineCells row={p} />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="meta">The period applies to Finished in the period only. Every other count is as it stands now.</p>
        {csv('lines')}
      </section>

      <section aria-labelledby="res-shared">
        <h3 id="res-shared">Shared items in overlap</h3>
        {data.sharedItems.length === 0 ? (
          <p className="empty">No catalogue item is recorded by more than one project in overlapping periods.</p>
        ) : (
          <div className="table-scroll">
            <table className="table usage-table">
              <caption className="visually-hidden">Catalogue items recorded by more than one project in overlapping periods</caption>
              <thead>
                <tr>
                  <th scope="col">Item</th>
                  <th scope="col">Projects</th>
                  <th scope="col">Earliest overlapping date</th>
                </tr>
              </thead>
              <tbody>
                {data.sharedItems.map((i) => (
                  <tr key={i.itemId}>
                    <th scope="row" data-label="Item">{i.reference} · {i.name}</th>
                    <td data-label="Projects">{i.projects}</td>
                    <td data-label="Earliest overlapping date">{dayLabel(i.earliestOverlap)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="meta">Usage records, not bookings.</p>
        {csv('sharedItems')}
      </section>

      <section aria-labelledby="res-finance">
        <h3 id="res-finance">Finance, by currency</h3>
        {data.finance.length === 0 ? (
          <p className="empty">No project in scope is tracking finance.</p>
        ) : (
          data.finance.map((g) => (
            <FinanceGroupView key={g.currency} g={g} mode={modes[g.currency] ?? 'chart'} onMode={(m) => setModes((c) => ({ ...c, [g.currency]: m }))} />
          ))
        )}
        <p>{NOT_REQUIRED}: {plural(data.notRequired, 'project')}. These are counted apart and are not zero.</p>
        <p className="meta">Based on recorded entries. Summary figures only; no entries are shown here.</p>
        {csv('finance')}
      </section>

      <p>
        <a href="#/ai/usage">{AI_SEPARATE_TITLE}</a> <span className="meta">Open the organisation AI usage. AI spending is never added to project finance.</span>
      </p>
    </>
  );
}
