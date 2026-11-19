import { type ReactNode, useEffect, useState } from 'react';
import { ApiError, api } from '../api.ts';
import {
  type ConnectionFigures,
  type Figures,
  type MyUsage,
  type OrganisationUsage,
  type PeriodFigures,
  type ProjectUsage,
  PROVIDER_NAMES,
  amountLabel,
  formatMyr,
  includesUncertain,
  purposeLabel,
} from '../ai.ts';
import { formatWhen } from '../format.ts';

const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'Could not load AI usage.');

/** Loads one usage view. A refusal is shown in words; nothing is cached. */
function useUsage<T>(path: string): { data: T | null; error: string | null } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let stale = false;
    setData(null);
    setError(null);
    api.get<T>(path).then(
      (d) => !stale && setData(d),
      (e: unknown) => !stale && setError(errText(e)),
    );
    return () => {
      stale = true;
    };
  }, [path]);
  return { data, error };
}

/** What counts against a limit, never presented as actual spend: the uncertain part is named. */
function Total({ f }: { f: Figures }) {
  const inc = includesUncertain(f);
  return (
    <>
      {formatMyr(f.usedMyr)}
      {inc ? <span className="meta"> ({inc})</span> : null}
    </>
  );
}

/** The columns every grouping shares, labelled as Confirmed, Uncertain and Reserved. */
function FigureCells({ f }: { f: Figures }) {
  return (
    <>
      <td data-label="Requests">{f.requests}</td>
      <td data-label="Attempts">{f.attempts}</td>
      <td data-label={amountLabel('confirmed')}>{formatMyr(f.confirmedMyr)}</td>
      <td data-label={amountLabel('uncertain')}>{formatMyr(f.uncertainMyr)}</td>
      <td data-label={amountLabel('reserved')}>{formatMyr(f.reservedMyr)}</td>
      <td data-label="Counted"><Total f={f} /></td>
    </>
  );
}

function FigureHead({ first }: { first: string }) {
  return (
    <thead>
      <tr>
        <th scope="col">{first}</th>
        <th scope="col">Requests</th>
        <th scope="col">Attempts</th>
        <th scope="col">{amountLabel('confirmed')}</th>
        <th scope="col">{amountLabel('uncertain')}</th>
        <th scope="col">{amountLabel('reserved')}</th>
        <th scope="col">Counted</th>
      </tr>
    </thead>
  );
}

function Grouped({ caption, first, rows, empty }: { caption: string; first: string; rows: Array<{ key: string; label: ReactNode; f: Figures }>; empty: string }) {
  if (rows.length === 0) return <section aria-label={caption}><h3>{caption}</h3><p className="meta">{empty}</p></section>;
  return (
    <section aria-label={caption}>
      <h3>{caption}</h3>
      <div className="table-scroll">
        <table className="table usage-table">
          <FigureHead first={first} />
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <th scope="row" data-label={first}>{r.label}</th>
                <FigureCells f={r.f} />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Connections({ rows, withProject }: { rows: ConnectionFigures[]; withProject: boolean }) {
  if (rows.length === 0) return <section aria-label="Attempts by connection"><h3>Attempts by connection</h3><p className="meta">No AI attempts this month.</p></section>;
  return (
    <section aria-label="Attempts by connection">
      <h3>Attempts by connection</h3>
      <div className="table-scroll">
        <table className="table usage-table">
          <thead>
            <tr>
              <th scope="col">Connection</th>
              <th scope="col">Provider and model</th>
              <th scope="col">Attempts</th>
              <th scope="col">Failures</th>
              <th scope="col">Fallbacks</th>
              <th scope="col">Charged failures</th>
              <th scope="col">Counted</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.connectionId}>
                <th scope="row" data-label="Connection">{r.label}{withProject && r.projectName ? <span className="meta"> · {r.projectName}</span> : null}</th>
                <td data-label="Provider and model">{PROVIDER_NAMES[r.provider] ?? r.provider} · {r.modelId}</td>
                <td data-label="Attempts">{r.attempts}</td>
                <td data-label="Failures">{r.failures}</td>
                <td data-label="Fallbacks">{r.fallbacks}</td>
                <td data-label="Charged failures">{r.chargedFailures}</td>
                <td data-label="Counted"><Total f={r} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function PeriodBox({ title, p, daily }: { title: string; p: PeriodFigures; daily?: boolean }) {
  const noLimit = daily && p.dailyLimitApplies === false;
  return (
    <section className="panel" aria-label={title}>
      <h3>{title}</h3>
      <dl className="figures">
        <div><dt>Limit</dt><dd>{noLimit ? 'No daily limit applied' : p.limitMyr === null ? 'No allowance' : formatMyr(p.limitMyr)}</dd></div>
        <div><dt>{amountLabel('confirmed')}</dt><dd>{formatMyr(p.confirmedMyr)}</dd></div>
        <div><dt>{amountLabel('uncertain')}</dt><dd>{formatMyr(p.uncertainMyr)}</dd></div>
        <div><dt>{amountLabel('reserved')}</dt><dd>{formatMyr(p.reservedMyr)}</dd></div>
        <div><dt>Counted against the limit</dt><dd><Total f={p} /></dd></div>
        {!noLimit && <div><dt>Left</dt><dd><strong>{p.remainingMyr === null ? '—' : formatMyr(p.remainingMyr)}</strong></dd></div>}
      </dl>
      <p className="meta">From {formatWhen(p.period.start)} to {formatWhen(p.period.end)}. Confirmed is from the provider’s reported use. Uncertain is an estimate kept because the outcome is unknown. Reserved is an estimate for a running request.</p>
    </section>
  );
}

const Wait = ({ error }: { error: string | null }) => (error ? <p role="alert" className="error">{error}</p> : <p className="loading" role="status">Loading</p>);

/** Project Manager, Owner and Sponsor: the project against its limits, by person, by kind of work and by connection. */
export function ProjectUsageView({ projectId }: { projectId: string }) {
  const { data, error } = useUsage<ProjectUsage>(`/projects/${projectId}/ai/usage`);
  if (!data) return <Wait error={error} />;
  return (
    <div>
      <PeriodBox title="This month" p={data.month} />
      <PeriodBox title="Today" p={data.day} daily />
      <Grouped caption="By person this month" first="Person" empty="Nobody has used AI in this project this month." rows={data.byPerson.map((r) => ({ key: r.userId, label: r.name, f: r }))} />
      <Grouped caption="Started by Kainow, by kind of work" first="Kind of work" empty="Nothing was started automatically this month." rows={data.system.map((r) => ({ key: r.purpose, label: purposeLabel(r.purpose), f: r }))} />
      <Connections rows={data.byConnection} withProject={false} />
    </div>
  );
}

/** The Enterprise Administrator: the organisation against its limits, with a breakdown by project and by person. */
export function OrganisationUsageView() {
  const { data, error } = useUsage<OrganisationUsage>('/ai/usage');
  if (!data) return <Wait error={error} />;
  return (
    <div>
      {!data.configured && <p className="warn">No AI limits are saved yet, so every AI request is refused.</p>}
      <PeriodBox title="This month" p={data.month} />
      <PeriodBox title="Today" p={data.day} daily />
      <Grouped caption="By project this month" first="Project" empty="No project has used AI this month." rows={data.byProject.map((r) => ({ key: r.projectId, label: <a href={`#/projects/${r.projectId}/ai`}>{r.name}</a>, f: r }))} />
      <Grouped caption="By person this month" first="Person" empty="Nobody has used AI this month." rows={data.byPerson.map((r) => ({ key: r.userId, label: r.name, f: r }))} />
      <Connections rows={data.byConnection} withProject />
      <section aria-label="Before projects">
        <h3>From before projects</h3>
        <p className="meta">Entries from before AI was set up per project count in the organisation totals above and in no project’s figures. This month: <Total f={data.beforeProjects} />.</p>
      </section>
    </div>
  );
}

/** Any person: their own use by project this month, and what is left of their personal allowance. */
export function MyUsageView() {
  const { data, error } = useUsage<MyUsage>('/ai/usage/mine');
  if (!data) return <Wait error={error} />;
  if (data.projects.length === 0) return <p className="empty">You have not used AI this month.</p>;
  return (
    <div>
      <Grouped caption="Your use this month, by project" first="Project" empty="" rows={data.projects.map((r) => ({ key: r.projectId, label: <a href={`#/projects/${r.projectId}`}>{r.name}</a>, f: r }))} />
      <section aria-label="Your personal allowance left">
        <h3>Your personal allowance left</h3>
        <ul className="plain">
          {data.projects.map((r) => (
            <li key={r.projectId}>
              <strong>{r.name}</strong>:{' '}
              {r.remaining.projectPersonal === undefined && r.remaining.organisationPersonal === undefined
                ? 'no personal limit applies'
                : [
                    r.remaining.projectPersonal !== undefined ? `${formatMyr(r.remaining.projectPersonal)} left at project level` : null,
                    r.remaining.organisationPersonal !== undefined ? `${formatMyr(r.remaining.organisationPersonal)} left at organisation level` : null,
                  ]
                    .filter(Boolean)
                    .join(', ')}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

export function MyAiUsage() {
  return (
    <main className="page narrow">
      <h1>My AI use</h1>
      <p className="meta">Only counts and amounts. No question, prompt, source title or answer is shown here.</p>
      <MyUsageView />
    </main>
  );
}
