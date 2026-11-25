import { useEffect, useState } from 'react';
import { ApiError, api } from '../api.ts';
import {
  type MyTask,
  type PersonalDashboard,
  type PersonalProject,
  awaitingLabel,
  dayLabel,
  expandAllPatch,
  homeQuery,
  onTimeLabel,
  overdueDaysLabel,
  plannedEndLabel,
  updatedLabel,
  visibleHomeSections,
} from '../dashboard.ts';
import { plural } from '../format.ts';
import { HOME_SECTION_LABELS, openChoice, type HomeSection, type Prefs } from '../prefs.ts';
import { type ProjectStatus, roleLabel } from '../projects.ts';
import { AttentionQueue } from '../ui/AttentionQueue.tsx';
import { Box } from '../ui/Box.tsx';
import { DataTable, type Column } from '../ui/DataTable.tsx';
import { PageHeader } from '../ui/PageHeader.tsx';
import { ProgressBar } from '../ui/ProgressBar.tsx';
import { StatusLabel } from '../ui/StatusLabel.tsx';
import { attentionFlags, greetingFor, homeEmptyCopy, todayLabel } from '../ui/home.ts';
import { projectMeaning } from '../ui/meanings.ts';

type Save = (next: Prefs) => Promise<void>;

function TaskRow({ t }: { t: MyTask }) {
  return (
    <li>
      <a href={`#/projects/${t.projectId}/work/${t.id}`}>{t.title}</a>
      <span className="meta">
        {' '}
        {t.projectName} · due {dayLabel(t.dueOn)}
        {t.overdueDays !== undefined && ` (${overdueDaysLabel(t.overdueDays)})`} · {t.status.replace(/_/g, ' ')}
      </span>
    </li>
  );
}

function TaskGroup({ title, tasks }: { title: string; tasks: MyTask[] | undefined }) {
  if (!tasks || tasks.length === 0) return null;
  return (
    <section aria-label={title}>
      <h3>{title} ({tasks.length})</h3>
      <ul className="plain">{tasks.map((t) => <TaskRow key={t.id} t={t} />)}</ul>
    </section>
  );
}

function ProjectCell({ p, open, onToggle }: { p: PersonalProject; open: boolean; onToggle: () => void }) {
  const panel = `project-${p.id}`;
  const x = p.expanded;
  if (p.onHold || !p.header) return <strong>{p.name}</strong>;
  return (
    <div className="home-project-cell">
      <button type="button" className="disclosure" aria-expanded={open} aria-controls={open && x ? panel : undefined} onClick={onToggle}>
        {p.name}
      </button>
      {p.archived && <span className="meta"> (archived)</span>}
      {open && x && (
        <div id={panel} className="home-project-body">
          <dl className="facts">
            <dt>Your role</dt>
            <dd>{x.grant ?? (x.roles.length > 0 ? x.roles.map((r) => roleLabel(r as Parameters<typeof roleLabel>[0])).join(', ') : 'None')}</dd>
            <dt>Owning department</dt>
            <dd>{x.owningDepartment}</dd>
            <dt>On-time completion</dt>
            <dd>
              {onTimeLabel(x.onTime)}
              {awaitingLabel(x.onTime) && <span className="meta"> · {awaitingLabel(x.onTime)}</span>}
            </dd>
            <dt>Planned end</dt>
            <dd>{plannedEndLabel(x.plannedEnd)}</dd>
            <dt>Open questions</dt>
            <dd>{x.openQuestions}</dd>
            <dt>Significant risks</dt>
            <dd>{x.significantRisks}</dd>
            <dt>Next task due</dt>
            <dd>{x.nextTaskDue ? dayLabel(x.nextTaskDue) : 'None'}</dd>
          </dl>
          <p><a href={x.link}>Open the project dashboard</a></p>
        </div>
      )}
    </div>
  );
}

const stageText = (p: PersonalProject) => {
  const s = p.header?.stage;
  return s ? `${s.stage}${s.substage ? `, ${s.substage}` : ''}, ${plural(s.days, 'day')}` : 'No stage yet';
};

function projectColumns(isOpen: (id: string) => boolean, toggle: (id: string) => void): Column<PersonalProject>[] {
  return [
    { key: 'project', header: 'Project', sortValue: (p) => p.name.toLowerCase(), cell: (p) => <ProjectCell p={p} open={isOpen(p.id)} onToggle={() => toggle(p.id)} /> },
    {
      key: 'state', header: 'State', sortValue: (p) => (p.onHold ? 'on hold' : p.header?.status ?? ''),
      cell: (p) => (p.onHold || !p.header ? <span className="warn">Your membership is on hold</span> : <StatusLabel meaning={projectMeaning(p.header.status as ProjectStatus)} />),
    },
    { key: 'stage', header: 'Stage', cell: (p) => (p.header ? stageText(p) : '–') },
    {
      key: 'progress', header: 'Progress', sortValue: (p) => (p.header?.completion.state === 'measurable' ? p.header.completion.percent : -1),
      cell: (p) => (p.header ? <ProgressBar completion={p.header.completion} /> : '–'),
    },
    {
      key: 'attention', header: 'Needs attention', sortValue: (p) => attentionFlags(p.header?.flags).length,
      cell: (p) => {
        const flags = attentionFlags(p.header?.flags);
        return flags.length === 0 ? <span className="row-note">Nothing</span> : <ul className="flag-list">{flags.map((f) => <li key={f}>{f}</li>)}</ul>;
      },
    },
  ];
}

/** The personal dashboard (spec section 4): Needs you, My tasks and My projects, in the saved order. */
export function Home({ userName, prefs, ready, failed, onChange }: { userName: string; prefs: Prefs; ready: boolean; failed: boolean; onChange: Save }) {
  const [d, setD] = useState<PersonalDashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [local, setLocal] = useState<Record<string, boolean>>({});
  const { includeArchived, showCompleted } = prefs.home;

  useEffect(() => {
    // The dashboard loads with the default toggles when preferences could not be loaded, and again with the saved ones.
    if (!ready && !failed) return;
    let stale = false;
    setError(null);
    api.get<PersonalDashboard>(`/dashboard/me?${homeQuery(prefs.home, ready)}`).then(
      (r) => !stale && setD(r),
      (e: Error) => !stale && setError(e.message),
    );
    return () => {
      stale = true;
    };
  }, [ready, failed, includeArchived, showCompleted]);

  async function save(next: Prefs) {
    setSaveError(null);
    try {
      await onChange(next);
    } catch (e) {
      setSaveError(e instanceof ApiError ? e.message : 'Could not save that choice. Try again.');
    }
  }

  const sections = visibleHomeSections(prefs.home.order, prefs.home.hidden);
  const projects = d?.projects ?? [];
  const shownIds = projects.map((p) => p.id);
  const isOpen = (id: string) => openChoice(local, prefs.expanded, projects.length, id);
  // Open and closed always work on the page; they are saved only once the saved preferences have loaded.
  const choose = (patch: Record<string, boolean>) => {
    setLocal((l) => ({ ...l, ...patch }));
    if (ready) void save({ ...prefs, expanded: { ...prefs.expanded, ...patch } });
  };

  const empty = d ? homeEmptyCopy(d) : null;
  const columns = projectColumns(isOpen, (id) => choose({ [id]: !isOpen(id) }));

  const render: Record<HomeSection, () => React.ReactNode> = {
    needsYou: () => (
      <Box title={HOME_SECTION_LABELS.needsYou}>
        {d && <AttentionQueue items={d.needsYou} empty={empty?.needsYou ?? ''} />}
      </Box>
    ),
    myTasks: () => (
      <Box title={HOME_SECTION_LABELS.myTasks}>
        <p><a href="#/my-tasks">All your tasks in one table</a></p>
        <label className="check">
          <input type="checkbox" checked={showCompleted} disabled={!ready} onChange={(e) => save({ ...prefs, home: { ...prefs.home, showCompleted: e.target.checked } })} />
          Show completed (last 30 days)
        </label>
        {d && (
          <>
            <TaskGroup title="Overdue" tasks={d.myTasks.overdue} />
            <TaskGroup title="Due soon" tasks={d.myTasks.dueSoon} />
            <TaskGroup title="Later" tasks={d.myTasks.later} />
            <TaskGroup title="Awaiting deadline review" tasks={d.myTasks.awaitingReview} />
            {showCompleted && <TaskGroup title="Completed" tasks={d.myTasks.completed} />}
            {[d.myTasks.overdue, d.myTasks.dueSoon, d.myTasks.later, d.myTasks.awaitingReview, ...(showCompleted ? [d.myTasks.completed ?? []] : [])].every((g) => g.length === 0) && (
              <p className="meta">No tasks are assigned to you.</p>
            )}
          </>
        )}
      </Box>
    ),
    myProjects: () => (
      <Box title={HOME_SECTION_LABELS.myProjects}>
        <div className="inline-form">
          <label className="check">
            <input type="checkbox" checked={includeArchived} disabled={!ready} onChange={(e) => save({ ...prefs, home: { ...prefs.home, includeArchived: e.target.checked } })} />
            Include archived
          </label>
          <button type="button" className="quiet" disabled={shownIds.length === 0} onClick={() => choose(expandAllPatch({}, shownIds, true))}>
            Expand all
          </button>
          <button type="button" className="quiet" disabled={shownIds.length === 0} onClick={() => choose(expandAllPatch({}, shownIds, false))}>
            Collapse all
          </button>
          <a href="#/projects">All projects and new project</a>
        </div>
        <DataTable caption="Your projects" columns={columns} rows={projects} rowKey={(p) => p.id} loading={!d} empty={empty?.projects ?? ''} />
      </Box>
    ),
  };

  return (
    <main className="page home">
      <PageHeader title={greetingFor(userName, new Date())} intro={`${todayLabel(new Date())}${d ? ` · ${updatedLabel(d.computedAt)}` : ''}`} />
      {error && <p role="alert" className="error">{error}</p>}
      {saveError && <p role="alert" className="error">{saveError}</p>}
      {failed && !ready && <p role="alert" className="error">Your saved display choices could not be loaded, so the defaults are shown and the toggles are off. Reload the page to try again.</p>}
      {!d && !error && <p className="loading">Loading</p>}
      {sections.map((s) => (
        <div key={s}>{render[s]()}</div>
      ))}
    </main>
  );
}
