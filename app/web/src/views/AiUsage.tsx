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
import { DataTable, type Column } from '../ui/DataTable.tsx';
import { PageHeader } from '../ui/PageHeader.tsx';

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

const num = (s: string) => Number(s) || 0;

/** The columns every grouping shares, labelled as Confirmed, Uncertain and Reserved. */
function figureColumns<T extends Figures>(): Column<T>[] {
  return [
    { key: 'requests', header: 'Requests', sortValue: (f) => f.requests, cell: (f) => f.requests },
    { key: 'attempts', header: 'Attempts', sortValue: (f) => f.attempts, cell: (f) => f.attempts },
    { key: 'confirmed', header: amountLabel('confirmed'), sortValue: (f) => num(f.confirmedMyr), cell: (f) => formatMyr(f.confirmedMyr) },
    { key: 'uncertain', header: amountLabel('uncertain'), sortValue: (f) => num(f.uncertainMyr), cell: (f) => formatMyr(f.uncertainMyr) },
    { key: 'reserved', header: amountLabel('reserved'), sortValue: (f) => num(f.reservedMyr), cell: (f) => formatMyr(f.reservedMyr) },
    { key: 'counted', header: 'Counted', sortValue: (f) => num(f.usedMyr), cell: (f) => <Total f={f} /> },
  ];
}

type GroupRow = Figures & { key: string; label: ReactNode; sortLabel: string };

function Grouped({ caption, first, rows, empty }: { caption: string; first: string; rows: GroupRow[]; empty: string }) {
  const columns: Column<GroupRow>[] = [{ key: 'label', header: first, sortValue: (r) => r.sortLabel.toLowerCase(), cell: (r) => r.label }, ...figureColumns<GroupRow>()];
  return <DataTable caption={caption} columns={columns} rows={rows} rowKey={(r) => r.key} empty={empty} />;
}

function Connections({ rows, withProject }: { rows: ConnectionFigures[]; withProject: boolean }) {
  const columns: Column<ConnectionFigures>[] = [
    { key: 'connection', header: 'Connection', sortValue: (r) => r.label.toLowerCase(), cell: (r) => <>{r.label}{withProject && r.projectName ? <span className="meta"> · {r.projectName}</span> : null}</> },
    { key: 'model', header: 'Provider and model', cell: (r) => `${PROVIDER_NAMES[r.provider] ?? r.provider} · ${r.modelId}` },
    { key: 'attempts', header: 'Attempts', sortValue: (r) => r.attempts, cell: (r) => r.attempts },
    { key: 'failures', header: 'Failures', sortValue: (r) => r.failures, cell: (r) => r.failures },
    { key: 'fallbacks', header: 'Fallbacks', sortValue: (r) => r.fallbacks, cell: (r) => r.fallbacks },
    { key: 'charged', header: 'Charged failures', sortValue: (r) => r.chargedFailures, cell: (r) => r.chargedFailures },
    { key: 'counted', header: 'Counted', sortValue: (r) => num(r.usedMyr), cell: (r) => <Total f={r} /> },
  ];
  return <DataTable caption="Attempts by connection" columns={columns} rows={rows} rowKey={(r) => r.connectionId} empty="No AI attempts this month." />;
}

function PeriodBox({ title, p, daily }: { title: string; p: PeriodFigures; daily?: boolean }) {
  const noLimit = daily && p.dailyLimitApplies === false;
  return (
    <section className="box" aria-label={title}>
      <h3 className="box-title">{title}</h3>
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
      <Grouped caption="By person this month" first="Person" empty="Nobody has used AI in this project this month." rows={data.byPerson.map((r) => ({ ...r, key: r.userId, label: r.name, sortLabel: r.name }))} />
      <Grouped caption="Started by Kainow, by kind of work" first="Kind of work" empty="Nothing was started automatically this month." rows={data.system.map((r) => ({ ...r, key: r.purpose, label: purposeLabel(r.purpose), sortLabel: purposeLabel(r.purpose) }))} />
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
      <Grouped caption="By project this month" first="Project" empty="No project has used AI this month." rows={data.byProject.map((r) => ({ ...r, key: r.projectId, label: <a href={`#/projects/${r.projectId}/ai`}>{r.name}</a>, sortLabel: r.name }))} />
      <Grouped caption="By person this month" first="Person" empty="Nobody has used AI this month." rows={data.byPerson.map((r) => ({ ...r, key: r.userId, label: r.name, sortLabel: r.name }))} />
      <Connections rows={data.byConnection} withProject />
      <section aria-label="Before projects" className="box">
        <h3 className="box-title">From before projects</h3>
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
      <Grouped caption="Your use this month, by project" first="Project" empty="" rows={data.projects.map((r) => ({ ...r, key: r.projectId, label: <a href={`#/projects/${r.projectId}`}>{r.name}</a>, sortLabel: r.name }))} />
      <section aria-label="Your personal allowance left" className="box">
        <h3 className="box-title">Your personal allowance left</h3>
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
    <main className="page">
      <PageHeader title="My AI use" intro="Only counts and amounts. No question, prompt, source title or answer is shown here." />
      <MyUsageView />
    </main>
  );
}
