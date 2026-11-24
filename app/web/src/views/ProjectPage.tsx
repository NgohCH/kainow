import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api, type Membership, type Project } from '../api.ts';
import { formatWhen } from '../format.ts';
import {
  type ClosureOutcome,
  type ProjectRole,
  OUTCOME_LABEL,
  STAGES,
  accessLabel,
  STATUS_LABEL,
  SUBSTAGES,
  type TransitionOption,
  canManage,
  formatExpiry,
  manageableRoles,
  membershipStateLabel,
  roleLabel,
  stageDuration,
  transitionsFor,
} from '../projects.ts';
import { go } from '../App.tsx';
import type { ProjectDashboard } from '../dashboard.ts';
import { BinderTabs } from '../ui/BinderTabs.tsx';
import { StatusLabel } from '../ui/StatusLabel.tsx';
import { projectMeaning } from '../ui/meanings.ts';
import { projectTabs, tabForHash } from '../ui/projectTabs.ts';
import { ProjectProposals } from './ProjectProposals.tsx';
import { Review } from './Review.tsx';
import { ProjectApprovals } from './ApprovalSettings.tsx';
import { Closing, DelegationControl, type ClosedSummary, type ClosureView } from './Closing.tsx';
import { DeadlineReview } from './DeadlineReview.tsx';
import { AskPanel } from './AskPanel.tsx';
import { AssistReview } from './AssistReview.tsx';
import { Drafts } from './Drafts.tsx';
import { Discussion, Notes } from './Discussion.tsx';
import { Work } from './Work.tsx';
import { ProjectOutputs } from './ProjectOutputs.tsx';
import { Resources } from './Resources.tsx';
import { ResourcesReport } from './ResourcesReport.tsx';
import { DeliveryHistory } from './Deliveries.tsx';
import { DigestSend, EscalationFlags } from './DigestSend.tsx';
import { Feedback } from './Feedback.tsx';
import { ProjectSettings } from './NotificationSettings.tsx';
import { ProjectAi } from './ProjectAi.tsx';
import { mayViewAiTab, mayViewAiUsage } from '../ai.ts';
import { ProjectCalendarProvider } from './ProjectCalendar.tsx';
import { DeletedItemsList } from './DeletedItems.tsx';
import { ProjectFigures } from './ProjectFigures.tsx';
import { Timeline } from './Timeline.tsx';
import type { Prefs } from '../prefs.ts';
import { DeletionDelegationPanel } from './DeleteRestore.tsx';
import { DeletionsList } from './HistoryList.tsx';
import { CopiesAwaitingList, HeldForReviewList } from './HeldReview.tsx';
import { type Act, ArchivePanel, DepartmentMove, GrantsSection, HandoverForm, HoldActions } from './ProjectAccessPanels.tsx';

/** What the address shows: a tab's key (`resources/report` sits under Resources), or `run`, one run's review under Proposals. */
export type ProjectView = 'overview' | 'resources' | 'resources/report' | 'people' | 'discussion' | 'notes' | 'proposals' | 'work' | 'drafts' | 'review' | 'settings' | 'ai' | 'feedback' | 'closing' | 'deadline-review' | 'deleted' | 'timeline' | 'outputs' | 'run';
type Tab = ProjectView;

/** What the binder tabs' badges and lifecycle tabs need. */
interface TabCounts { waiting: number; overdue: number; mayPrepare: boolean; deadlineTasks: number }
const NO_COUNTS: TabCounts = { waiting: 0, overdue: 0, mayPrepare: false, deadlineTasks: 0 };

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

export function ProjectPage({ projectId, tab, meId, itemId, runId, prefs, prefsReady, onPrefs }: { projectId: string; tab: Tab; meId: string; itemId?: string; runId?: string; prefs: Prefs; prefsReady: boolean; onPrefs: (next: Prefs) => Promise<void> }) {
  const [project, setProject] = useState<Project | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const askButton = useRef<HTMLButtonElement>(null);
  // Focus goes back to the Ask button only after the panel has unmounted (the page behind it is inert until then).
  const wasAsking = useRef(false);
  useEffect(() => {
    if (wasAsking.current && !asking) askButton.current?.focus();
    wasAsking.current = asking;
  }, [asking]);
  const [notice, setNotice] = useState<string | null>(null);
  // Goes up each time "Add notes" is chosen in the header: the Notes tab opens its form.
  const [addNotes, setAddNotes] = useState(0);

  const load = useCallback(() => {
    api.get<{ project: Project }>(`/projects/${projectId}`).then(
      (r) => setProject(r.project),
      (e: Error) => setError(e.message),
    );
  }, [projectId]);
  useEffect(load, [load]);
  // A message about the last change belongs to the tab it was made on.
  useEffect(() => setNotice(null), [tab]);

  // Badges and the lifecycle tabs, read again on each tab change so a finished review clears its badge.
  const [counts, setCounts] = useState<TabCounts>(NO_COUNTS);
  const status = project?.status;
  const myRoles = project?.myRoles.join(',');
  useEffect(() => {
    if (!status || myRoles === undefined) return;
    let stale = false;
    const roles = myRoles ? myRoles.split(',') : [];
    const pmOrDeputy = roles.some((r) => r === 'pm' || r === 'deputy_pm');
    // The same reads the Overview makes: a 404 or refusal means nothing to show this person.
    Promise.all([
      api.get<ProjectDashboard>(`/projects/${projectId}/dashboard`).catch(() => null),
      ['planned', 'active', 'deferred'].includes(status) && roles.length > 0
        ? api.get<ClosureView>(`/projects/${projectId}/closure`).catch(() => null)
        : null,
      pmOrDeputy && ['active', 'deferred', 'closed'].includes(status)
        ? api.get<{ tasks: unknown[] }>(`/projects/${projectId}/deadline-review`).catch(() => null)
        : null,
    ]).then(([dash, closure, review]) => {
      if (stale) return;
      setCounts({
        waiting: dash?.proposals?.waiting ?? 0,
        overdue: dash?.measures.overdue ?? 0,
        mayPrepare: Boolean(closure?.mayPrepare),
        deadlineTasks: review?.tasks.length ?? 0,
      });
    });
    return () => {
      stale = true;
    };
  }, [projectId, status, myRoles, tab]);

  /** Runs one change; shows the server's reason if it is refused, otherwise reloads the project. */
  const act = useCallback(
    async (work: () => Promise<unknown>, done: string | ((result: unknown) => string)) => {
      setError(null);
      setNotice(null);
      try {
        const result = await work();
        setNotice(typeof done === 'function' ? done(result) : done);
        load();
        return true;
      } catch (e) {
        setError(errText(e, 'That did not work. Try again.'));
        return false;
      }
    },
    [load],
  );

  if (!project) {
    return (
      <main className="page narrow">
        {error ? <p role="alert" className="error">{error}</p> : <p className="loading">Loading</p>}
        <a href="#/">My Projects</a>
      </main>
    );
  }

  const roles = project.myRoles;
  // Members read the notes; so does an Audit or Oversight grant holder, read-only.
  const contentAllowed = roles.length > 0 || project.access !== null;
  // A person's proposal used to be linked as notes/<id>; it now sits on the Proposals tab.
  const view: Tab = tab === 'notes' && itemId ? 'proposals' : tab;
  const current = tabForHash(tab, itemId);
  const tabs = projectTabs({
    roles,
    isAdmin: project.isAdmin,
    contentAllowed,
    inspectDeleted: Boolean(project.inspectDeleted),
    status: project.status,
    // Closing and Deadline review are tabs while they call for action, and while the person is on them.
    closingNeeded: counts.mayPrepare || current === 'closing',
    deadlineReview: counts.deadlineTasks > 0 || current === 'deadline-review',
    deadlineTasks: counts.deadlineTasks,
    mayViewAi: mayViewAiTab(roles, project.isAdmin),
    waiting: counts.waiting,
    overdue: counts.overdue,
  });
  // The project's current people, for choosing assignees, requesters and responsible people.
  const people = [
    ...new Map(
      project.memberships
        .filter((m) => m.state === 'active' || m.state === 'scheduled')
        .map((m) => [m.userId, { userId: m.userId, displayName: m.displayName, email: m.email }]),
    ).values(),
  ];
  const open = ['draft', 'planned', 'active'].includes(project.status);
  const base = `#/projects/${project.id}`;
  // Notes are imported straight away by the managing roles; a Member submits them for one of those to publish.
  const canAddNotes = roles.some((r) => r !== 'member') && open;
  const canSubmitNotes = roles.length > 0 && !roles.some((r) => r !== 'member') && open;
  const pms = project.memberships.filter((m) => m.role === 'pm' && (m.state === 'active' || m.state === 'on_hold'));

  return (
    <ProjectCalendarProvider projectId={project.id}>
    <main className="page">
      <header className="page-header project-header">
        <nav aria-label="Breadcrumb" className="crumbs no-print">
          <ol><li><a href="#/projects">Projects</a></li></ol>
        </nav>
        <div className="page-header-row">
          <div className="project-title">
            <h1>{project.name}</h1>
            <StatusLabel meaning={projectMeaning(project.status)} word={STATUS_LABEL[project.status]} />
            {project.archived && <StatusLabel meaning="off" word="Archived" />}
          </div>
          {contentAllowed && (
            <div className="page-action decision no-print">
              <button type="button" ref={askButton} aria-expanded={asking} onClick={() => setAsking((v) => !v)}>Ask about this project</button>
              {(canAddNotes || canSubmitNotes) && (
                <button
                  type="button"
                  onClick={() => {
                    setAddNotes((n) => n + 1);
                    if (view !== 'notes') go(`${base}/notes`);
                  }}
                >
                  {canAddNotes ? 'Add notes' : 'Submit notes'}
                </button>
              )}
            </div>
          )}
        </div>
        <dl className="project-facts">
          <div><dt>Owning department</dt><dd>{project.owningDepartment.name}</dd></div>
          {project.contributingDepartments.length > 0 && (
            <div><dt>Participating departments</dt><dd>{project.contributingDepartments.map((d) => d.name).join(', ')}</dd></div>
          )}
          <div><dt>Project Manager</dt><dd>{pms.length > 0 ? pms.map((m) => m.displayName).join(', ') : 'Not appointed'}</dd></div>
          {project.stage && (
            <div><dt>Stage</dt><dd>{`${project.stage.stage}${project.stage.substage ? `: ${project.stage.substage}` : ''} (${stageDuration(project.stage.startedAt)})`}</dd></div>
          )}
          {(roles.length > 0 || project.access || project.isAdmin) && (
            <div>
              <dt>You</dt>
              <dd>
                {roles.length > 0
                  ? roles.map(roleLabel).join(', ')
                  : project.access
                    ? `${accessLabel(project.access)} (read-only)`
                    : 'You manage appointments as an administrator'}
              </dd>
            </div>
          )}
        </dl>
        {project.onHold && (
          <p className="warn" role="status">
            A member is On Hold — investigation needed. <a href={`#/projects/${project.id}/people`}>Open People</a>
          </p>
        )}
        {project.missingAccountability && (
          <p className="warn" role="status">
            This project is missing {project.missingRoles.join(' and ')}. Existing work continues, but proposals cannot be approved until the role is filled.
          </p>
        )}
        <EscalationFlags projectId={project.id} />
      </header>
      <BinderTabs
        label="Project"
        current={current}
        tabs={tabs.map((t) => ({ ...t, href: t.key === 'overview' ? base : `${base}/${t.key}` }))}
      />
      {asking && contentAllowed && (
        <AskPanel
          projectId={project.id}
          onClose={() => setAsking(false)}
        />
      )}
      {error && <p role="alert" className="error">{error}</p>}
      {notice && <p role="status" className="meta">{notice}</p>}
      {view === 'overview' && <Overview project={project} act={act} contentAllowed={contentAllowed} />}
      {view === 'timeline' && contentAllowed && <Timeline projectId={project.id} prefs={prefs} ready={prefsReady} onChange={onPrefs} />}
      {view === 'drafts' && contentAllowed && <Drafts projectId={project.id} draftId={itemId} />}
      {view === 'review' && contentAllowed && <AssistReview projectId={project.id} roles={roles} />}
      {view === 'feedback' && contentAllowed && <Feedback projectId={project.id} />}
      {view === 'settings' && <ProjectSettings projectId={project.id} showFinance={project.isAdmin || roles.some((r) => ['pm', 'deputy_pm', 'owner', 'sponsor'].includes(r))} />}
      {view === 'outputs' && contentAllowed && (
        <ProjectOutputs
          key={itemId ?? 'register'}
          projectId={project.id}
          outputId={itemId}
          roles={roles}
          status={project.status}
          people={{
            people: people.map((p) => ({ userId: p.userId, displayName: p.displayName })),
            departments: [project.owningDepartment, ...project.contributingDepartments],
          }}
        />
      )}
      {view === 'ai' && mayViewAiTab(roles, project.isAdmin) && <ProjectAi projectId={project.id} mayViewUsage={mayViewAiUsage(roles)} />}
      {view === 'deleted' && project.inspectDeleted && <DeletedItemsList projectId={project.id} />}
      {view === 'resources' && <Resources projectId={project.id} roles={roles} status={project.status} />}
      {view === 'resources/report' && <ResourcesReport projectId={project.id} />}
      {view === 'closing' && <Closing project={project} act={act} />}
      {view === 'deadline-review' && <DeadlineReview project={project} />}
      {view === 'people' && <People project={project} act={act} />}
      {view === 'discussion' && contentAllowed && (
        <Discussion
          projectId={project.id}
          canStart={roles.length > 0 && open}
          canRestrict={roles.some((r) => r !== 'member') && open}
          memberships={project.memberships}
        />
      )}
      {view === 'notes' && contentAllowed && <Notes projectId={project.id} canAdd={canAddNotes} canSubmit={canSubmitNotes} addRequest={addNotes} />}
      {view === 'proposals' && contentAllowed && (
        <ProjectProposals
          projectId={project.id}
          canPropose={roles.length > 0 && open}
          canReview={roles.some((r) => r === 'owner' || r === 'sponsor') && ['planned', 'active'].includes(project.status)}
          people={people}
          meId={meId}
          focusId={itemId}
        />
      )}
      {view === 'run' && runId && <Review key={runId} runId={runId} meId={meId} />}
      {view === 'work' && contentAllowed && (
        <Work
          projectId={project.id}
          people={people}
          canPropose={roles.length > 0}
          canClear={roles.some((r) => r === 'pm' || r === 'deputy_pm')}
          focusId={itemId}
          roles={roles}
          status={project.status}
          delegated={Boolean(project.recordDeletionDelegation)}
        />
      )}
    </main>
    </ProjectCalendarProvider>
  );
}

/**
 * `#/runs/<id>` (email links point at it): the run's review inside its project, under the Proposals tab. The run says
 * which project it belongs to; a run the person may not see shows the server's reason.
 */
export function RunInProject({ runId, meId, prefs, prefsReady, onPrefs }: { runId: string; meId: string; prefs: Prefs; prefsReady: boolean; onPrefs: (next: Prefs) => Promise<void> }) {
  const [projectId, setProjectId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let stale = false;
    api.get<{ projectId: string }>(`/extractions/${runId}`).then(
      (r) => !stale && setProjectId(r.projectId),
      (e: Error) => !stale && setError(e.message),
    );
    return () => {
      stale = true;
    };
  }, [runId]);
  if (!projectId) {
    return (
      <main className="page narrow">
        {error ? <p role="alert" className="error">{error}</p> : <p className="loading">Loading</p>}
        <a href="#/projects">Projects</a>
      </main>
    );
  }
  return <ProjectPage key={projectId} projectId={projectId} tab="run" runId={runId} meId={meId} prefs={prefs} prefsReady={prefsReady} onPrefs={onPrefs} />;
}

function Overview({ project, act, contentAllowed }: { project: Project; act: Act; contentAllowed: boolean }) {
  const options = transitionsFor(project.status, project.myRoles, project.isAdmin);
  const [chosen, setChosen] = useState<TransitionOption | null>(null);
  const canEdit = project.myRoles.some((r) => r === 'pm' || r === 'owner' || r === 'sponsor') && ['draft', 'planned', 'active'].includes(project.status);
  const canStage = project.myRoles.includes('pm') && project.status === 'active';
  const [editing, setEditing] = useState(false);
  const [staging, setStaging] = useState(false);
  const [closure, setClosure] = useState<ClosureView | null>(null);
  const [markedTasks, setMarkedTasks] = useState(0);
  const [atClosure, setAtClosure] = useState<ClosedSummary | null>(null);
  const [tick, setTick] = useState(0);
  // Shared by the action-item email and the Email delivery list: a sent digest shows up in the list at once.
  const [deliveriesKey, setDeliveriesKey] = useState(0);
  const closable = ['planned', 'active', 'deferred'].includes(project.status);
  const isOS = project.myRoles.some((r) => r === 'owner' || r === 'sponsor');
  const isPmOrDeputy = project.myRoles.some((r) => r === 'pm' || r === 'deputy_pm');
  const isEmailManager = project.myRoles.some((r) => r === 'pm' || r === 'owner' || r === 'sponsor');
  useEffect(() => {
    if (!closable || project.myRoles.length === 0) return setClosure(null);
    api.get<ClosureView>(`/projects/${project.id}/closure`).then(setClosure, () => setClosure(null));
  }, [project.id, project.status, project.myRoles.length, closable, tick]);
  useEffect(() => {
    if (project.status !== 'closed') return setAtClosure(null);
    api.get<ClosureView>(`/projects/${project.id}/closure`).then((v) => setAtClosure(v.closedSummary ?? null), () => setAtClosure(null));
  }, [project.id, project.status]);
  useEffect(() => {
    if (!isPmOrDeputy || !['active', 'deferred', 'closed'].includes(project.status)) return setMarkedTasks(0);
    api.get<{ tasks: unknown[] }>(`/projects/${project.id}/deadline-review`).then((r) => setMarkedTasks(r.tasks.length), () => setMarkedTasks(0));
  }, [project.id, project.status, isPmOrDeputy]);
  const flags = project.openReviewFlags ?? 0;

  return (
    <>
      <section aria-labelledby="about-heading">
        <div className="row">
          <h2 id="about-heading">About</h2>
          {canEdit && (
            <button className="quiet" onClick={() => setEditing((e) => !e)} aria-expanded={editing}>
              {editing ? 'Close' : 'Edit details'}
            </button>
          )}
        </div>
        {editing ? (
          <EditDetails project={project} act={act} onDone={() => setEditing(false)} />
        ) : (
          <dl className="facts">
            <dt>Purpose</dt>
            <dd>{project.purpose}</dd>
            <dt>Owning department</dt>
            <dd>{project.owningDepartment.name}</dd>
            {project.contributingDepartments.length > 0 && (
              <>
                <dt>Contributing departments</dt>
                <dd>{project.contributingDepartments.map((d) => d.name).join(', ')}</dd>
              </>
            )}
            <dt>Planned end</dt>
            <dd>{project.plannedEnd ?? 'Not set'}</dd>
            {project.closureOutcome && (
              <>
                <dt>Closure outcome</dt>
                <dd>{OUTCOME_LABEL[project.closureOutcome]}</dd>
              </>
            )}
          </dl>
        )}
      </section>
      {contentAllowed && <ProjectFigures projectId={project.id} canReadWork={contentAllowed} />}

      {atClosure && (atClosure.kept.length > 0 || atClosure.unresolved.length > 0) && (
        <section aria-labelledby="at-closure-heading">
          <h2 id="at-closure-heading">At closure</h2>
          {atClosure.kept.length > 0 && (
            <>
              <h3>Tasks kept outstanding</h3>
              <ul className="plain">
                {atClosure.kept.map((k) => (
                  <li key={k.id}><strong>{k.title}</strong>: {k.reason}</li>
                ))}
              </ul>
            </>
          )}
          {atClosure.unresolved.length > 0 && (
            <>
              <h3>Questions left unresolved</h3>
              <ul className="plain">
                {atClosure.unresolved.map((q) => (
                  <li key={q.id}>
                    <strong>{q.text}</strong>: {q.reason}
                    {q.affectsDelivery ? ' (affects delivery acceptance)' : ''}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      {(options.length > 0 || canStage) && (
        <section aria-labelledby="change-heading">
          <h2 id="change-heading">Change the project</h2>
          <div className="decision">
            {options.map((o) =>
              o.to === 'closed' ? (
                <a key={`${o.to}-${o.label}`} className="button" href={`#/projects/${project.id}/closing`}>
                  {o.label}
                </a>
              ) : (
                <button key={`${o.to}-${o.label}`} onClick={() => setChosen(o)} aria-expanded={chosen === o}>
                  {o.label}
                </button>
              ),
            )}
            {canStage && (
              <button onClick={() => setStaging((s) => !s)} aria-expanded={staging}>
                Change stage
              </button>
            )}
          </div>
          {chosen && <TransitionForm project={project} option={chosen} act={act} onDone={() => setChosen(null)} />}
          {staging && <StageForm project={project} act={act} onDone={() => setStaging(false)} />}
        </section>
      )}

      {(closure?.mayPrepare || markedTasks > 0 || flags > 0 || (isOS && closable)) && (
        <section aria-labelledby="records-heading">
          <h2 id="records-heading">Closing and reviews</h2>
          {flags > 0 && (
            <p className="review-flags">
              {flags} {flags === 1 ? 'item is' : 'items are'} flagged for review after a decision changed. <a href={`#/projects/${project.id}/work`}>Open Work</a>
            </p>
          )}
          {markedTasks > 0 && (
            <p>
              {markedTasks} {markedTasks === 1 ? 'task needs' : 'tasks need'} a new authorised due date. <a href={`#/projects/${project.id}/deadline-review`}>Deadline review</a>
            </p>
          )}
          {closure?.mayPrepare && <a className="button" href={`#/projects/${project.id}/closing`}>Prepare closure</a>}
          {isOS && closable && closure && (
            <DelegationControl
              project={project}
              view={closure}
              run={async (work, done) => {
                const ok = await act(work, done);
                setTick((n) => n + 1);
                return ok;
              }}
            />
          )}
          {closure?.delegation && <p className="meta">{closure.delegation.pm} may close this project. Allowed by {closure.delegation.by}: {closure.delegation.reason}</p>}
        </section>
      )}

      <DeletionDelegationPanel project={project} act={act} />

      {project.myRoles.some((r) => r === 'pm' || r === 'owner' || r === 'sponsor') && <HeldForReviewList projectId={project.id} />}

      {project.myRoles.some((r) => r === 'pm' || r === 'deputy_pm') && <CopiesAwaitingList projectId={project.id} />}

      <ProjectApprovals projectId={project.id} />

      {isEmailManager && project.status === 'active' && <DigestSend projectId={project.id} onSent={() => setDeliveriesKey((n) => n + 1)} />}
      {isEmailManager && (
        <section aria-labelledby="deliveries-heading">
          <h2 id="deliveries-heading">Email delivery</h2>
          <DeliveryHistory path={`/projects/${project.id}/deliveries`} reloadKey={deliveriesKey} />
        </section>
      )}

      <ArchivePanel project={project} act={act} />
      <DepartmentMove project={project} act={act} />

      <section aria-labelledby="history-heading">
        <h2 id="history-heading">History</h2>
        <h3>Stages</h3>
        <ul className="plain">
          {project.stagePeriods.map((s, i) => (
            <li key={i}>
              {s.stage}
              {s.substage ? `: ${s.substage}` : ''} — from {formatWhen(s.startedAt)}
              {s.endedAt ? ` to ${formatWhen(s.endedAt)}` : ' (current)'}
              {s.reason ? ` — ${s.reason}` : ''}
            </li>
          ))}
        </ul>
        <DeletionsList projectId={project.id} />
        <h3>Status changes</h3>
        {project.transitions.length === 0 ? (
          <p className="meta">None yet. The project was created as a Draft.</p>
        ) : (
          <ul className="plain">
            {project.transitions.map((t, i) => (
              <li key={i}>
                {formatWhen(t.at)}: {STATUS_LABEL[t.from]} → {STATUS_LABEL[t.to]}
                {t.fastTrack ? ' (fast track)' : ''}
                {t.outcome ? `, ${OUTCOME_LABEL[t.outcome]}` : ''} by {t.actor}
                {t.reason ? ` — ${t.reason}` : ''}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function TransitionForm({ project, option, act, onDone }: { project: Project; option: TransitionOption; act: Act; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [outcome, setOutcome] = useState<ClosureOutcome | ''>(option.outcomes?.length === 1 ? option.outcomes[0] : '');
  const [stage, setStage] = useState(project.stage?.stage ?? 'Execution');

  async function submit(e: FormEvent) {
    e.preventDefault();
    const ok = await act(
      () =>
        api.post(`/projects/${project.id}/transition`, {
          to: option.to,
          reason: reason || null,
          outcome: option.needs.outcome ? outcome || null : null,
          objectivesMet: false,
          stage: option.needs.stage ? stage : null,
        }),
      `${option.label}: done.`,
    );
    if (ok) onDone();
  }

  return (
    <form className="panel stack" onSubmit={submit} aria-label={option.label}>
      {option.needs.outcome && (
        <label>
          Closure outcome
          <select required value={outcome} onChange={(e) => setOutcome(e.target.value as ClosureOutcome)}>
            <option value="">Choose an outcome</option>
            {(option.outcomes ?? []).map((o) => (
              <option key={o} value={o}>
                {OUTCOME_LABEL[o]}
              </option>
            ))}
          </select>
        </label>
      )}
      {option.needs.stage && (
        <label>
          Stage to continue in
          <select value={stage} onChange={(e) => setStage(e.target.value)}>
            {STAGES.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
      )}
      <label>
        Reason{option.needs.reason ? '' : ' (optional)'}
        <textarea rows={2} required={option.needs.reason} value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      <div className="decision">
        <button className="primary">{option.label}</button>
        <button type="button" onClick={onDone}>Cancel</button>
      </div>
    </form>
  );
}

function StageForm({ project, act, onDone }: { project: Project; act: Act; onDone: () => void }) {
  const [stage, setStage] = useState(project.stage?.stage ?? 'Initiation');
  const [substage, setSubstage] = useState('');
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (await act(() => api.post(`/projects/${project.id}/stage`, { stage, substage: substage || null }), 'Stage changed.')) onDone();
  }
  return (
    <form className="panel stack" onSubmit={submit} aria-label="Change stage">
      <label>
        Stage
        <select value={stage} onChange={(e) => { setStage(e.target.value); setSubstage(''); }}>
          {STAGES.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
      </label>
      <label>
        Substage (optional)
        <select value={substage} onChange={(e) => setSubstage(e.target.value)}>
          <option value="">None</option>
          {SUBSTAGES[stage].map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
      </label>
      <div className="decision">
        <button className="primary">Change stage</button>
        <button type="button" onClick={onDone}>Cancel</button>
      </div>
    </form>
  );
}

function EditDetails({ project, act, onDone }: { project: Project; act: Act; onDone: () => void }) {
  const [name, setName] = useState(project.name);
  const [purpose, setPurpose] = useState(project.purpose);
  const [plannedEnd, setPlannedEnd] = useState(project.plannedEnd ?? '');
  async function submit(e: FormEvent) {
    e.preventDefault();
    const ok = await act(
      () => api.post(`/projects/${project.id}/edit`, { name, purpose, plannedEnd: plannedEnd || null }),
      'Details saved.',
    );
    if (ok) onDone();
  }
  return (
    <form className="panel stack" onSubmit={submit} aria-label="Edit details">
      <label>
        Name
        <input required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        Purpose
        <textarea required rows={3} value={purpose} onChange={(e) => setPurpose(e.target.value)} />
      </label>
      <p className="meta">
        Owning department: {project.owningDepartment.name}. Only an Enterprise Administrator can move a project to another department.
      </p>
      <label>
        Planned end (optional)
        <input type="date" value={plannedEnd} onChange={(e) => setPlannedEnd(e.target.value)} />
      </label>
      <div className="decision">
        <button className="primary">Save</button>
        <button type="button" onClick={onDone}>Cancel</button>
      </div>
    </form>
  );
}

function People({ project, act }: { project: Project; act: Act }) {
  const invitable = manageableRoles(project.myRoles, project.isAdmin, project.status);
  const current = project.memberships.filter((m) => m.state !== 'revoked');
  const past = project.memberships.filter((m) => m.state === 'revoked');
  return (
    <>
      <section aria-labelledby="members-heading">
        <h2 id="members-heading">People</h2>
        {current.length === 0 ? (
          <p className="empty">No one holds a role yet.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Person</th>
                <th scope="col">Role</th>
                <th scope="col">Dates</th>
                <th scope="col">State</th>
                <th scope="col"><span className="visually-hidden">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {current.map((m) => (
                <MemberRow key={m.id} m={m} project={project} act={act} />
              ))}
            </tbody>
          </table>
        )}
        {past.length > 0 && (
          <details>
            <summary>Earlier appointments ({past.length})</summary>
            <ul className="plain">
              {past.map((m) => (
                <li key={m.id}>
                  {m.displayName}, {roleLabel(m.role)}, from {m.startsOn} (revoked)
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      <HandoverForm project={project} act={act} />
      <GrantsSection project={project} act={act} />

      <section aria-labelledby="invitations-heading">
        <h2 id="invitations-heading">Invitations</h2>
        {invitable.length > 0 && <InviteForm project={project} roles={invitable} act={act} />}
        {project.invitations.length === 0 ? (
          <p className="meta">No invitations yet.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Email</th>
                <th scope="col">Role</th>
                <th scope="col">Status</th>
                <th scope="col"><span className="visually-hidden">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {project.invitations.map((i) => {
                const manage = canManage(i.role, project.myRoles, project.isAdmin, project.status, 'invitation');
                // Withdrawing is cleanup, allowed in any status; the PM may withdraw their own handover.
                const withdraw = canManage(i.role, project.myRoles, project.isAdmin, project.status, 'appointment') || (i.kind === 'handover' && project.myRoles.includes('pm'));
                return (
                  <tr key={i.id}>
                    <td>{i.email}</td>
                    <td>{i.kind === 'handover' ? 'Project Manager (handover)' : roleLabel(i.role)}</td>
                    <td>
                      {i.status === 'invited' ? `Waiting · ${formatExpiry(i.expiresAt)}` : i.status[0].toUpperCase() + i.status.slice(1)}
                    </td>
                    <td>
                      {manage && (i.status === 'invited' || i.status === 'expired') && (
                        <button
                          className="link-button"
                          onClick={() =>
                            void act(
                              () => api.post(`/invitations/${i.id}/resend`),
                              (r) => ((r as { delivered?: boolean }).delivered === false ? 'The email was not sent. Send again.' : `A new invitation was sent to ${i.email}.`),
                            )
                          }
                        >
                          Send again
                        </button>
                      )}{' '}
                      {withdraw && i.status === 'invited' && (
                        <button className="link-button" onClick={() => void act(() => api.post(`/invitations/${i.id}/revoke`), 'Invitation withdrawn.')}>
                          Withdraw
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}

function MemberRow({ m, project, act }: { m: Membership; project: Project; act: Act }) {
  const manage = canManage(m.role, project.myRoles, project.isAdmin, project.status, 'appointment');
  const [mode, setMode] = useState<'none' | 'extend' | 'revoke'>('none');
  const [date, setDate] = useState(m.expiresOn ?? '');
  const [reason, setReason] = useState('');
  return (
    <tr>
      <td>
        {m.displayName}
        <span className="meta"> {m.email}</span>
      </td>
      <td>{roleLabel(m.role)}</td>
      <td>
        from {m.startsOn}
        {m.expiresOn ? ` to ${m.expiresOn}` : ''}
      </td>
      <td>
        {m.state === 'on_hold' ? <span className="badge badge-rejected">{membershipStateLabel(m.state)}</span> : membershipStateLabel(m.state)}
        {m.holdReason ? <span className="meta"> {m.holdReason}</span> : null}
      </td>
      <td>
        {m.state === 'on_hold' && <HoldActions m={m} project={project} act={act} canRestore={manage} />}
        {manage && mode === 'none' && (
          <>
            <button className="link-button" onClick={() => setMode('extend')}>Change expiry</button>{' '}
            <button className="link-button" onClick={() => setMode('revoke')}>Remove</button>
          </>
        )}
        {mode === 'extend' && (
          <form
            className="inline-form"
            onSubmit={async (e) => {
              e.preventDefault();
              if (await act(() => api.post(`/memberships/${m.id}/extend`, { expiresOn: date }), 'Expiry changed.')) setMode('none');
            }}
          >
            <label>
              New expiry <input type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
            </label>
            <button className="primary">Save</button>
            <button type="button" onClick={() => setMode('none')}>Cancel</button>
          </form>
        )}
        {mode === 'revoke' && (
          <form
            className="inline-form"
            onSubmit={async (e) => {
              e.preventDefault();
              if (await act(() => api.post(`/memberships/${m.id}/revoke`, { reason }), `${m.displayName} no longer holds the ${roleLabel(m.role)} role.`)) setMode('none');
            }}
          >
            <label>
              Reason <input required value={reason} onChange={(e) => setReason(e.target.value)} />
            </label>
            <button className="reject">Remove</button>
            <button type="button" onClick={() => setMode('none')}>Cancel</button>
          </form>
        )}
      </td>
    </tr>
  );
}

function InviteForm({ project, roles, act }: { project: Project; roles: ProjectRole[]; act: Act }) {
  const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<ProjectRole>(roles.includes('member') ? 'member' : roles[0]);
  const [startsOn, setStartsOn] = useState(today);
  const [expiresOn, setExpiresOn] = useState('');
  async function submit(e: FormEvent) {
    e.preventDefault();
    const ok = await act(
      () => api.post(`/projects/${project.id}/invitations`, { email, displayName: displayName || null, role, startsOn, expiresOn: expiresOn || null }),
      (r) => ((r as { delivered?: boolean }).delivered === false ? 'The email was not sent. Send again.' : `Invitation sent to ${email}. It expires in seven days.`),
    );
    if (ok) {
      setEmail('');
      setDisplayName('');
    }
  }
  return (
    <form className="panel stack" onSubmit={submit} aria-label="Invite someone">
      <div className="grid-2">
        <label>
          Work email
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label>
          Name (optional)
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </label>
        <label>
          Role
          <select value={role} onChange={(e) => setRole(e.target.value as ProjectRole)}>
            {roles.map((r) => (
              <option key={r} value={r}>
                {roleLabel(r)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Starts on
          <input type="date" required value={startsOn} onChange={(e) => setStartsOn(e.target.value)} />
        </label>
        <label>
          Expires on (optional)
          <input type="date" value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)} />
        </label>
      </div>
      <button className="primary">Send invitation</button>
      <p className="meta">The person signs in with a code sent to that address, then accepts. Only addresses in an eligible organisation domain can be invited.</p>
    </form>
  );
}
