import { useEffect, useState } from 'react';
import { ApiError, api } from '../api.ts';
import {
  type MyTask,
  type PersonalDashboard,
  type PersonalProject,
  awaitingLabel,
  cancelledLabel,
  completionLabel,
  dayLabel,
  expandAllPatch,
  homeQuery,
  onTimeLabel,
  overdueDaysLabel,
  plannedEndLabel,
  updatedLabel,
  visibleHomeSections,
} from '../dashboard.ts';
import { formatWhen, plural } from '../format.ts';
import { HOME_SECTION_LABELS, openChoice, type HomeSection, type Prefs } from '../prefs.ts';
import { STATUS_LABEL, roleLabel } from '../projects.ts';

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

function flagsOf(p: PersonalProject): string[] {
  const f = p.header?.flags;
  if (!f) return [];
  return [
    f.overdue > 0 ? `${f.overdue} overdue` : '',
    f.blocked > 0 ? `${f.blocked} blocked` : '',
    f.missingRole ? 'Missing a required role' : '',
    f.noIndependentEscalation ? 'No independent escalation recipient' : '',
    f.deadlineReview ? 'Deadline review required' : '',
  ].filter(Boolean);
}

function ProjectSection({ p, open, onToggle }: { p: PersonalProject; open: boolean; onToggle: () => void }) {
  if (p.onHold || !p.header) {
    return (
      <li className="home-project">
        <strong>{p.name}</strong>
        <p className="warn">Your membership is on hold</p>
      </li>
    );
  }
  const h = p.header;
  const x = p.expanded;
  const panel = `project-${p.id}`;
  const flags = flagsOf(p);
  const cancelled = cancelledLabel(h.completion);
  return (
    <li className="home-project">
      <h3>
        <button type="button" className="disclosure" aria-expanded={open} aria-controls={open && x ? panel : undefined} onClick={onToggle}>
          {p.name}
        </button>
        {p.archived && <span className="meta"> (archived)</span>}
      </h3>
      <p className="meta">
        {STATUS_LABEL[h.status as keyof typeof STATUS_LABEL] ?? h.status}
        {h.stage && ` · ${h.stage.stage}${h.stage.substage ? `, ${h.stage.substage}` : ''}, ${plural(h.stage.days, 'day')}`}
        {` · ${completionLabel(h.completion)}`}
        {cancelled && ` · ${cancelled}`}
      </p>
      {flags.length > 0 && (
        <ul className="chips-list">
          {flags.map((f) => <li key={f} className="chip-quiet">{f}</li>)}
        </ul>
      )}
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
    </li>
  );
}

/** The personal dashboard (spec section 4): Needs you, My tasks and My projects, in the saved order. */
export function Home({ prefs, ready, failed, onChange }: { prefs: Prefs; ready: boolean; failed: boolean; onChange: Save }) {
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

  const render: Record<HomeSection, () => React.ReactNode> = {
    needsYou: () => (
      <section aria-labelledby="needs-heading">
        <h2 id="needs-heading">{HOME_SECTION_LABELS.needsYou}</h2>
        {d && d.needsYou.length === 0 && <p>Nothing needs you right now.</p>}
        <ul className="plain">
          {d?.needsYou.map((n, i) => (
            <li key={`${n.kind}-${n.link}-${i}`}>
              <a href={n.link}>{n.label}</a>
              <span className="meta"> {n.projectName}{n.since ? ` · since ${formatWhen(n.since)}` : ''}</span>
            </li>
          ))}
        </ul>
      </section>
    ),
    myTasks: () => (
      <section aria-labelledby="tasks-heading">
        <h2 id="tasks-heading">{HOME_SECTION_LABELS.myTasks}</h2>
        <label className="check">
          <input type="checkbox" checked={showCompleted} disabled={!ready} onChange={(e) => save({ ...prefs, home: { ...prefs.home, showCompleted: e.target.checked } })} />
          Show completed (last 30 days)
        </label>
        {d && (
          <>
            <TaskGroup title="Overdue" tasks={d.myTasks.overdue} />
            <TaskGroup title="Due in the next 7 days" tasks={d.myTasks.dueSoon} />
            <TaskGroup title="Later" tasks={d.myTasks.later} />
            <TaskGroup title="Awaiting deadline review" tasks={d.myTasks.awaitingReview} />
            {showCompleted && <TaskGroup title="Completed" tasks={d.myTasks.completed} />}
            {[d.myTasks.overdue, d.myTasks.dueSoon, d.myTasks.later, d.myTasks.awaitingReview, ...(showCompleted ? [d.myTasks.completed ?? []] : [])].every((g) => g.length === 0) && (
              <p className="meta">No tasks are assigned to you.</p>
            )}
          </>
        )}
      </section>
    ),
    myProjects: () => (
      <section aria-labelledby="projects-heading">
        <div className="row">
          <h2 id="projects-heading">{HOME_SECTION_LABELS.myProjects}</h2>
          <a href="#/projects">All projects and new project</a>
        </div>
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
        </div>
        {d && projects.length === 0 && <p className="empty">You are not in any project yet. Create one, or accept an invitation from its Project Manager, Owner or a Sponsor.</p>}
        <ul className="plain home-projects">
          {projects.map((p) => (
            <ProjectSection key={p.id} p={p} open={isOpen(p.id)} onToggle={() => choose({ [p.id]: !isOpen(p.id) })} />
          ))}
        </ul>
      </section>
    ),
  };

  return (
    <main className="page narrow home">
      <div className="row">
        <h1>My Projects</h1>
        {d && <span className="meta">{updatedLabel(d.computedAt)}</span>}
      </div>
      {error && <p role="alert" className="error">{error}</p>}
      {saveError && <p role="alert" className="error">{saveError}</p>}
      {failed && !ready && <p role="alert" className="error">Your saved display choices could not be loaded, so the defaults are shown and the toggles are off until they load.</p>}
      {!d && !error && <p className="loading">Loading</p>}
      {sections.map((s) => (
        <div key={s}>{render[s]()}</div>
      ))}
    </main>
  );
}
