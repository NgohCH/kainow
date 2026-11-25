import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api, type AdminProjectRow, type Department, type Project, type ProjectSummary } from '../api.ts';
import { go } from '../App.tsx';
import { dayLabel, type PersonalDashboard, type PersonalProject } from '../dashboard.ts';
import { bannerText } from '../golive.ts';
import { useGoLiveSummary } from './goLiveSummary.ts';
import { OUTCOME_LABEL, STATUS_LABEL, type ProjectStatus, accessLabel, roleLabel } from '../projects.ts';
import { Box } from '../ui/Box.tsx';
import { DataTable, type Column } from '../ui/DataTable.tsx';
import { PageHeader } from '../ui/PageHeader.tsx';
import { ProgressBar } from '../ui/ProgressBar.tsx';
import { StatTile } from '../ui/StatTile.tsx';
import { StatusLabel } from '../ui/StatusLabel.tsx';
import { attentionFlags, groupProjects } from '../ui/home.ts';
import { projectMeaning } from '../ui/meanings.ts';
import type { StageTemplate } from '../ui/stages.ts';
import { StageList } from './StageTemplates.tsx';

const STATES: ProjectStatus[] = ['draft', 'planned', 'active', 'deferred', 'closed'];

type Row = ProjectSummary & { measures?: PersonalProject['header']; manager: string | null };

const stageText = (p: Row) => (p.stage ? `${p.stage.stage}${p.stage.substage ? `, ${p.stage.substage}` : ''}` : 'No stage yet');

/** The state with, in History, the day it was deferred or closed. */
const stateSince = (p: Row) => p.deferred?.on ?? p.closed?.on ?? null;
const stateColumn = (header: string): Column<Row> => ({
  key: 'state', header, sortValue: (p) => stateSince(p) ?? '',
  cell: (p) => {
    const on = stateSince(p);
    return (
      <div>
        <StatusLabel meaning={projectMeaning(p.status)} /> <span className="history-day">{on ? dayLabel(on) : 'Not recorded'}</span>
      </div>
    );
  },
});
const HISTORY_COLUMNS: Record<'deferred' | 'closed', Column<Row>[]> = {
  deferred: [stateColumn('Deferred on'), { key: 'reason', header: 'Reason', wide: true, cell: (p) => <span className="history-reason">{p.deferred?.reason || 'Not recorded'}</span> }],
  closed: [
    stateColumn('Closed on'),
    { key: 'outcome', header: 'Outcome', sortValue: (p) => (p.closed?.outcome ? OUTCOME_LABEL[p.closed.outcome] : ''), cell: (p) => (p.closed?.outcome ? OUTCOME_LABEL[p.closed.outcome] : 'Not recorded') },
  ],
};

/** The columns of the current projects, or of one History table: there the state's own columns take the State column's place. */
function rowColumns(showManager: boolean, history?: 'deferred' | 'closed'): Column<Row>[] {
  const cols: Column<Row>[] = [
    {
      key: 'project', header: 'Project', sortValue: (p) => p.name.toLowerCase(),
      cell: (p) => (
        <>
          <a href={`#/projects/${p.id}`}>{p.name}</a>
          {p.archived && <span className="meta"> (archived)</span>}
          <span className="row-note"> {p.access ? accessLabel(p.access) : `You: ${p.myRoles.map(roleLabel).join(', ')}`}</span>
          {p.myOpenTasks > 0 && <span className="row-note"> · Your open tasks: {p.myOpenTasks}</span>}
        </>
      ),
    },
    { key: 'state', header: 'State', sortValue: (p) => STATES.indexOf(p.status), cell: (p) => <StatusLabel meaning={projectMeaning(p.status)} /> },
    { key: 'department', header: 'Owning department', sortValue: (p) => p.owningDepartment.toLowerCase(), cell: (p) => p.owningDepartment },
    { key: 'stage', header: 'Stage', cell: (p) => stageText(p) },
    {
      key: 'progress', header: 'Progress', sortValue: (p) => (p.measures?.completion.state === 'measurable' ? p.measures.completion.percent : -1),
      cell: (p) => (p.measures ? <ProgressBar completion={p.measures.completion} /> : <span className="row-note">Not shown</span>),
    },
    {
      key: 'attention', header: 'Needs attention', sortValue: (p) => flagsFor(p).length,
      cell: (p) => {
        const flags = flagsFor(p);
        return flags.length === 0 ? <span className="row-note">Nothing</span> : <ul className="flag-list">{flags.map((f) => <li key={f}>{f}</li>)}</ul>;
      },
    },
  ];
  if (history) cols.splice(1, 1, ...HISTORY_COLUMNS[history]);
  if (showManager) cols.push({ key: 'manager', header: 'Project Manager', sortValue: (p) => (p.manager ?? '').toLowerCase(), cell: (p) => p.manager ?? 'None yet' });
  return cols;
}

function flagsFor(p: Row): string[] {
  const flags = attentionFlags(p.measures?.flags);
  if (p.missingAccountability && !p.measures?.flags.missingRole) flags.push('Missing a required role');
  if (p.onHold) flags.push('A member is On Hold: investigation needed');
  return flags;
}

/** The project list (spec 7.4, D138): a count by state as filters, the current projects, then History (Deferred and Closed), a new-project form, and for administrators every project's role holders. */
export function Projects({ isAdmin, history }: { isAdmin: boolean; history: { archived: boolean } | null }) {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [all, setAll] = useState<AdminProjectRow[] | null>(null);
  const [measures, setMeasures] = useState<Map<string, PersonalProject['header']>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [state, setState] = useState<ProjectStatus | null>(null);
  const [archived, setArchived] = useState(false);
  const historyBox = useRef<HTMLDivElement>(null);
  const goLive = useGoLiveSummary(isAdmin);

  useEffect(() => {
    api.get<{ projects: ProjectSummary[]; all?: AdminProjectRow[] }>('/projects').then(
      (r) => {
        setProjects(r.projects);
        setAll(r.all ?? null);
      },
      (e: Error) => setError(e.message),
    );
    // Progress and what needs attention come from the personal dashboard; the table still works without them.
    api.get<PersonalDashboard>('/dashboard/me?includeArchived=1&showCompleted=0').then(
      (d) => setMeasures(new Map(d.projects.map((p) => [p.id, p.header] as const))),
      () => undefined,
    );
  }, []);

  // A link to History shows every state, with archived projects when it counted some, and goes there once loaded.
  const toHistory = history !== null;
  const withArchived = history?.archived ?? false;
  const loaded = projects !== null;
  const historyDue = useRef(false);
  useEffect(() => {
    historyDue.current = toHistory && loaded;
    if (!historyDue.current) return;
    setState(null);
    if (withArchived) setArchived(true);
  }, [toHistory, withArchived, loaded]);
  // Only once every state is drawn: a tile pressed earlier may have hidden History.
  useEffect(() => {
    if (!historyDue.current || state !== null || (withArchived && !archived)) return;
    historyDue.current = false;
    historyBox.current?.scrollIntoView();
    historyBox.current?.focus({ preventScroll: true });
  });
  // What arrives later moves the page; whoever is still at History stays there.
  useEffect(() => {
    if (toHistory && historyBox.current && document.activeElement === historyBox.current) historyBox.current.scrollIntoView();
  }, [toHistory, measures]);

  const managers = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of all ?? []) {
      const names = p.roleHolders.filter((h) => h.role === 'pm').map((h) => h.displayName);
      if (names.length > 0) m.set(p.id, names.join(', '));
    }
    return m;
  }, [all]);

  const rows: Row[] = useMemo(() => (projects ?? []).map((p) => ({ ...p, measures: measures.get(p.id), manager: managers.get(p.id) ?? null })), [projects, measures, managers]);
  const live = rows.filter((p) => !p.archived);
  const counts = (s: ProjectStatus) => live.filter((p) => p.status === s).length;
  const shown = groupProjects(rows, state, archived);
  const archivedCount = rows.length - live.length;
  const columns = useMemo(() => {
    const showManager = isAdmin && all !== null;
    return { current: rowColumns(showManager), deferred: rowColumns(showManager, 'deferred'), closed: rowColumns(showManager, 'closed') };
  }, [isAdmin, all]);

  return (
    <main className="page">
      <PageHeader
        title="Projects"
        intro="The projects you are in, by state."
        action={
          <button className="primary" onClick={() => setCreating((c) => !c)} aria-expanded={creating}>
            {creating ? 'Close' : 'New project'}
          </button>
        }
      />
      {goLive && (
        <p className="golive-banner">
          <strong>{bannerText(goLive.done, goLive.total)}</strong> <a href="#/go-live">Open the go-live checklist</a>
        </p>
      )}
      {creating && <NewProject onCreated={(p) => go(`#/projects/${p.id}`)} />}
      {error && <p role="alert" className="error">{error}</p>}
      <div className="stat-grid" role="group" aria-label="Show projects in one state">
        {STATES.map((s) => (
          <StatTile key={s} label="Projects" value={String(counts(s))} meaning={s} pressed={state === s} onPress={() => setState(state === s ? null : s)} />
        ))}
      </div>
      <div className="table-filters">
        {state && <button type="button" className="quiet" onClick={() => setState(null)}>Show every state</button>}
        {archivedCount > 0 && (
          <label className="check">
            <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> Include archived ({archivedCount})
          </label>
        )}
      </div>
      {shown.current && (
        <DataTable
          caption={state ? `Your ${STATUS_LABEL[state].toLowerCase()} projects` : 'Current projects'}
          columns={columns.current}
          rows={shown.current}
          rowKey={(p) => p.id}
          loading={projects === null && !error}
          empty={
            rows.length === 0
              ? 'You are not in any project yet. Create one, or accept an invitation from its Project Manager, Owner or a Sponsor.'
              : state
                ? 'No projects match this filter.'
                : 'None of your projects is current.'
          }
        />
      )}
      {(shown.deferred || shown.closed) && (
        <div ref={historyBox} className="project-history" role="group" aria-label="History" tabIndex={-1}>
          <Box title="History">
            {shown.deferred && <DataTable caption="Deferred" columns={columns.deferred} rows={shown.deferred} rowKey={(p) => p.id} loading={projects === null && !error} empty="No deferred projects." />}
            {shown.closed && <DataTable caption="Closed" columns={columns.closed} rows={shown.closed} rowKey={(p) => p.id} loading={projects === null && !error} empty="No closed projects." />}
          </Box>
        </div>
      )}
      {isAdmin && all && <AllProjects all={all} />}
    </main>
  );
}

const allColumns: Column<AdminProjectRow>[] = [
  { key: 'project', header: 'Project', sortValue: (p) => p.name.toLowerCase(), cell: (p) => <a href={`#/projects/${p.id}/people`}>{p.name}</a> },
  { key: 'state', header: 'State', sortValue: (p) => p.status, cell: (p) => <StatusLabel meaning={projectMeaning(p.status)} /> },
  { key: 'department', header: 'Department', sortValue: (p) => p.owningDepartment.toLowerCase(), cell: (p) => p.owningDepartment },
  { key: 'holders', header: 'Role holders', cell: (p) => (p.roleHolders.length === 0 ? 'None yet' : p.roleHolders.map((h) => `${h.displayName} (${roleLabel(h.role)})`).join(', ')) },
];

function AllProjects({ all }: { all: AdminProjectRow[] }) {
  return (
    <Box title="All projects">
      <p className="meta">As an administrator you manage Owner, Sponsor and Project Manager appointments. You see a project&apos;s notes only if you hold a role in it.</p>
      <DataTable caption="Every project and its role holders" columns={allColumns} rows={all} rowKey={(p) => p.id} empty="No projects yet. Add a department and an eligible email domain, then create the first project." />
    </Box>
  );
}

function NewProject({ onCreated }: { onCreated: (p: Project) => void }) {
  const [departments, setDepartments] = useState<Department[]>([]);
  const [name, setName] = useState('');
  const [purpose, setPurpose] = useState('');
  const [owning, setOwning] = useState('');
  const [contributing, setContributing] = useState<string[]>([]);
  const [plannedEnd, setPlannedEnd] = useState('');
  const [templates, setTemplates] = useState<StageTemplate[]>([]);
  const [templateId, setTemplateId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<{ departments: Department[] }>('/departments').then((r) => setDepartments(r.departments), () => setDepartments([]));
    api.get<{ templates: StageTemplate[] }>('/stage-templates').then(
      (r) => {
        setTemplates(r.templates);
        setTemplateId((cur) => cur || (r.templates.find((t) => t.name === 'General') ?? r.templates[0])?.id || '');
      },
      () => setTemplates([]),
    );
  }, []);
  const chosen = templates.find((t) => t.id === templateId);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ project: Project }>('/projects', {
        name,
        purpose,
        owningDepartmentId: owning,
        contributingDepartmentIds: contributing,
        plannedEnd: plannedEnd || null,
        ...(templateId ? { stageTemplateId: templateId } : {}),
      });
      onCreated(r.project);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The project was not created. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel" aria-label="New project">
      <form className="stack" onSubmit={submit}>
        <label>
          Name
          <input required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          Purpose
          <textarea required rows={3} maxLength={4000} value={purpose} onChange={(e) => setPurpose(e.target.value)} />
        </label>
        <label>
          Owning department
          <select required value={owning} onChange={(e) => setOwning(e.target.value)}>
            <option value="">Choose a department</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
        {departments.length > 1 && (
          <fieldset>
            <legend>Contributing departments (optional)</legend>
            {departments
              .filter((d) => d.id !== owning)
              .map((d) => (
                <label key={d.id} className="check">
                  <input
                    type="checkbox"
                    checked={contributing.includes(d.id)}
                    onChange={(e) => setContributing((c) => (e.target.checked ? [...c, d.id] : c.filter((x) => x !== d.id)))}
                  />{' '}
                  {d.name}
                </label>
              ))}
          </fieldset>
        )}
        {templates.length > 0 && (
          <div>
            <label>
              Type of project
              <select required value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </label>
            {chosen && (
              <div className="template-preview" aria-live="polite">
                <p className="meta">{chosen.description ? `${chosen.description} ` : ''}It starts in {chosen.stages[0]?.name}. Stages, in order:</p>
                <StageList stages={chosen.stages} />
              </div>
            )}
          </div>
        )}
        <label>
          Planned end (optional)
          <input type="date" value={plannedEnd} onChange={(e) => setPlannedEnd(e.target.value)} />
        </label>
        {departments.length === 0 && <p className="warn">No departments yet. An administrator adds them under Departments.</p>}
        {error && <p role="alert" className="error">{error}</p>}
        <button className="primary" disabled={busy}>Create project</button>
        <p className="meta">You become its Project Manager. It starts as a Draft; appoint an Owner or Sponsor and a Member before making it Planned.</p>
      </form>
    </section>
  );
}
