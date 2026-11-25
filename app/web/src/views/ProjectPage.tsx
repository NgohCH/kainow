import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api, type InvitationRow, type Membership, type Project } from '../api.ts';
import { formatWhen, plural } from '../format.ts';
import {
  type ClosureOutcome,
  type ProjectRole,
  OUTCOME_LABEL,
  accessLabel,
  STATUS_LABEL,
  type TransitionOption,
  canManage,
  formatExpiry,
  manageableRoles,
  INVITATION_MEANING,
  MEMBERSHIP_MEANING,
  membershipStateLabel,
  roleLabel,
  stageDuration,
  transitionsFor,
} from '../projects.ts';
import { go } from '../App.tsx';
import { type NeedsYouItem, type PersonalDashboard, type ProjectDashboard, dayLabel, plannedEndLabel } from '../dashboard.ts';
import { todayUtc8 } from '../changes.ts';
import { taskHref } from '../taskPage.ts';
import { TASK_STATUS_LABEL, TASK_STATUS_MEANING, type TaskStatus } from '../records.ts';
import { addDays, dueWithin, projectAttention, taskStatusParts } from '../overview.ts';
import { stageFlowFrom, type ProjectStage } from '../ui/stages.ts';
import { AttentionQueue } from '../ui/AttentionQueue.tsx';
import { BinderTabs } from '../ui/BinderTabs.tsx';
import { Box } from '../ui/Box.tsx';
import { DataTable, type Column } from '../ui/DataTable.tsx';
import { StackedBar } from '../ui/StackedBar.tsx';
import { StageFlow } from '../ui/StageFlow.tsx';
import { StatTile } from '../ui/StatTile.tsx';
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
import { TaskPage } from './TaskPage.tsx';
import { Work } from './Work.tsx';
import { ProjectOutputs } from './ProjectOutputs.tsx';
import { Resources } from './Resources.tsx';
import { ResourcesReport } from './ResourcesReport.tsx';
import { DeliveryHistory } from './Deliveries.tsx';
import { DigestSend, EscalationFlags } from './DigestSend.tsx';
import { Feedback } from './Feedback.tsx';
import { ProjectSettings } from './ProjectSettings.tsx';
import { ProjectAi } from './ProjectAi.tsx';
import { mayViewAiTab, mayViewAiUsage } from '../ai.ts';
import { ProjectCalendarProvider } from './ProjectCalendar.tsx';
import { DeletedItemsList } from './DeletedItems.tsx';
import { ProjectFigures, type DashboardState, useProjectDashboard } from './ProjectFigures.tsx';
import { Timeline } from './Timeline.tsx';
import type { Prefs } from '../prefs.ts';
import { DeletionDelegationPanel } from './DeleteRestore.tsx';
import { DeletionsList } from './HistoryList.tsx';
import { CopiesAwaitingList, HeldForReviewList } from './HeldReview.tsx';
import { type Act, ArchivePanel, DepartmentMove, GrantsSection, HandoverForm, HoldActions } from './ProjectAccessPanels.tsx';

/** What the address shows: a tab's key (`resources/report` sits under Resources), `run`, one run's review under Proposals, or `task`, one task's page under Work. */
export type ProjectView = 'overview' | 'resources' | 'resources/report' | 'people' | 'discussion' | 'notes' | 'proposals' | 'work' | 'drafts' | 'review' | 'settings' | 'ai' | 'feedback' | 'closing' | 'deadline-review' | 'deleted' | 'timeline' | 'outputs' | 'run' | 'task';

/** What the binder tabs' badges and lifecycle tabs need. */
interface TabCounts { waiting: number; overdue: number; mayPrepare: boolean; deadlineTasks: number }
const NO_COUNTS: TabCounts = { waiting: 0, overdue: 0, mayPrepare: false, deadlineTasks: 0 };

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

export function ProjectPage({ projectId, tab, meId, itemId, runId, prefs, prefsReady, onPrefs }: { projectId: string; tab: ProjectView; meId: string; itemId?: string; runId?: string; prefs: Prefs; prefsReady: boolean; onPrefs: (next: Prefs) => Promise<void> }) {
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
  const view: ProjectView = tab === 'notes' && itemId ? 'proposals' : tab;
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
          {project.stageTemplate && <div><dt>Stages</dt><dd>{project.stageTemplate.name}</dd></div>}
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
      {view === 'settings' && <ProjectSettings project={project} reload={load} showFinance={project.isAdmin || roles.some((r) => ['pm', 'deputy_pm', 'owner', 'sponsor'].includes(r))} />}
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
      {view === 'notes' && contentAllowed && <Notes projectId={project.id} canAdd={canAddNotes} canSubmit={canSubmitNotes} addRequest={addNotes} onAddHandled={() => setAddNotes(0)} />}
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
      {view === 'task' && itemId && (
        <TaskPage
          key={itemId}
          projectId={project.id}
          taskId={itemId}
          people={people}
          canPropose={roles.length > 0}
          canClear={roles.some((r) => r === 'pm' || r === 'deputy_pm')}
          roles={roles}
          status={project.status}
          delegated={Boolean(project.recordDeletionDelegation)}
        />
      )}
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
  const dashboard = useProjectDashboard(project.id, contentAllowed);

  return (
    <>
      <OverviewGlance project={project} contentAllowed={contentAllowed} dashboard={dashboard} />
      <section aria-labelledby="about-heading" className="box">
        <div className="settings-box-head">
          <h2 id="about-heading" className="box-title">About</h2>
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
      {contentAllowed && <ProjectFigures projectId={project.id} canReadWork={contentAllowed} state={dashboard} />}

      {atClosure && (atClosure.kept.length > 0 || atClosure.unresolved.length > 0) && (
        <section aria-labelledby="at-closure-heading" className="box">
          <h2 id="at-closure-heading" className="box-title">At closure</h2>
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
        <section aria-labelledby="change-heading" className="box">
          <h2 id="change-heading" className="box-title">Change the project</h2>
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
        <section aria-labelledby="records-heading" className="box">
          <h2 id="records-heading" className="box-title">Closing and reviews</h2>
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
        <section aria-labelledby="deliveries-heading" className="box">
          <h2 id="deliveries-heading" className="box-title">Email delivery</h2>
          <DeliveryHistory path={`/projects/${project.id}/deliveries`} reloadKey={deliveriesKey} />
        </section>
      )}

      <ArchivePanel project={project} act={act} />
      <DepartmentMove project={project} act={act} />

      <section aria-labelledby="history-heading" className="box">
        <h2 id="history-heading" className="box-title">History</h2>
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

/** A task as the Overview reads it from `GET /projects/:id/records`. */
interface OverviewTask { id: string; title: string; dueOn: string; status: TaskStatus; assignee: { displayName: string } }

/**
 * The top of the Overview (spec 7.5): on the left what needs this person's attention in this project; on the right the
 * stage flow, the task-status split and the tasks due in the next 14 days.
 */
function OverviewGlance({ project, contentAllowed, dashboard }: { project: Project; contentAllowed: boolean; dashboard: DashboardState }) {
  const [attention, setAttention] = useState<NeedsYouItem[] | null>(null);
  const [attentionError, setAttentionError] = useState<string | null>(null);
  const [tasks, setTasks] = useState<OverviewTask[] | null>(null);
  const [tasksError, setTasksError] = useState<string | null>(null);
  useEffect(() => {
    let stale = false;
    setAttention(null);
    setAttentionError(null);
    api.get<PersonalDashboard>('/dashboard/me?includeArchived=1&showCompleted=0').then(
      (r) => !stale && setAttention(projectAttention(r.needsYou, project.id)),
      (e: Error) => !stale && setAttentionError(e.message),
    );
    return () => {
      stale = true;
    };
  }, [project.id]);
  useEffect(() => {
    if (!contentAllowed) return;
    let stale = false;
    setTasks(null);
    setTasksError(null);
    api.get<{ tasks: OverviewTask[] }>(`/projects/${project.id}/records`).then(
      (r) => !stale && setTasks(r.tasks),
      (e: Error) => !stale && setTasksError(e.message),
    );
    return () => {
      stale = true;
    };
  }, [project.id, contentAllowed]);

  const today = todayUtc8();
  const flow = stageFlowFrom(project.stages, project.stagePeriods, new Date());
  // A closed project has been through every stage.
  const steps = project.status === 'closed' ? flow.map((s) => ({ name: s.name, state: 'done' as const })) : flow;
  const cancelled = (tasks ?? []).filter((t) => t.status === 'cancelled').length;
  const due = dueWithin(tasks ?? [], today, 14);
  const plannedEnd = dashboard.d ? plannedEndLabel(dashboard.d.measures.plannedEnd) : null;
  const dueColumns: Column<OverviewTask>[] = [
    { key: 'task', header: 'Task', sortValue: (t) => t.title.toLowerCase(), cell: (t) => <a href={taskHref(project.id, t.id)}>{t.title}</a> },
    { key: 'due', header: 'Due', sortValue: (t) => t.dueOn, cell: (t) => (t.dueOn === today ? `Today, ${dayLabel(t.dueOn)}` : dayLabel(t.dueOn)) },
    { key: 'assignee', header: 'Assignee', sortValue: (t) => t.assignee.displayName.toLowerCase(), cell: (t) => t.assignee.displayName },
    { key: 'status', header: 'Status', sortValue: (t) => TASK_STATUS_LABEL[t.status], cell: (t) => <StatusLabel meaning={TASK_STATUS_MEANING[t.status]} word={TASK_STATUS_LABEL[t.status]} /> },
  ];

  return (
    <div className="overview-top">
      <Box title="Needs attention in this project">
        {attentionError ? (
          <p role="alert" className="error">{attentionError}</p>
        ) : attention === null ? (
          <p className="loading">Loading</p>
        ) : (
          <AttentionQueue items={attention} empty="Nothing in this project needs you now." inProject />
        )}
      </Box>
      <div className="overview-side">
        <Box title="Stage">
          <StageFlow stages={steps} />
          <dl className="facts">
            {project.stage?.substage && (
              <>
                <dt>Substage</dt>
                <dd>{project.stage.substage}</dd>
              </>
            )}
            <dt>Planned end</dt>
            <dd>
              {project.plannedEnd ? dayLabel(project.plannedEnd) : 'Not set'}
              {project.plannedEnd && plannedEnd && <span className="meta"> ({plannedEnd})</span>}
            </dd>
          </dl>
        </Box>
        {contentAllowed && (
          <Box title="Tasks">
            {tasksError ? (
              <p role="alert" className="error">{tasksError}</p>
            ) : tasks === null ? (
              <p className="loading">Loading</p>
            ) : (
              <>
                <StackedBar parts={taskStatusParts(tasks)} />
                {cancelled > 0 && <p className="meta">{cancelled} cancelled, not counted.</p>}
                <p className="meta"><a href={`#/projects/${project.id}/work`}>Open Work</a></p>
              </>
            )}
          </Box>
        )}
        {contentAllowed && (
          <Box title="Due in the next 14 days">
            {tasksError ? (
              <p className="meta">Not available: the tasks could not be read.</p>
            ) : (
              <DataTable
                caption={`Unfinished tasks due by ${dayLabel(addDays(today, 14))}`}
                columns={dueColumns}
                rows={due}
                rowKey={(t) => t.id}
                loading={tasks === null}
                empty="No unfinished task is due in the next 14 days."
                initialSort={{ key: 'due', dir: 'asc' }}
              />
            )}
          </Box>
        )}
      </div>
    </div>
  );
}

/** The stages a person may move the project into: the active ones, in the project's order. */
const activeStages = (project: Project): ProjectStage[] => project.stages.filter((s) => s.status === 'active');

function TransitionForm({ project, option, act, onDone }: { project: Project; option: TransitionOption; act: Act; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [outcome, setOutcome] = useState<ClosureOutcome | ''>(option.outcomes?.length === 1 ? option.outcomes[0] : '');
  const choices = activeStages(project);
  const [stage, setStage] = useState(choices.find((s) => s.name === project.stage?.stage)?.name ?? choices[0]?.name ?? '');

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
            {choices.map((s) => (
              <option key={s.id}>{s.name}</option>
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
  const choices = activeStages(project);
  const [stage, setStage] = useState(choices.find((s) => s.name === project.stage?.stage)?.name ?? choices[0]?.name ?? '');
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
          {choices.map((s) => (
            <option key={s.id}>{s.name}</option>
          ))}
        </select>
      </label>
      <label>
        Substage (optional)
        <select value={substage} onChange={(e) => setSubstage(e.target.value)}>
          <option value="">None</option>
          {(choices.find((c) => c.name === stage)?.substages ?? []).map((s) => (
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

const INVITATION_STATE_WORD: Record<InvitationRow['status'], string> = { invited: 'Waiting', accepted: 'Accepted', declined: 'Declined', revoked: 'Withdrawn', expired: 'Expired' };

/** The project's People tab (spec 7.6): who holds which role, hand-over, Audit and Oversight access, and invitations. */
function People({ project, act }: { project: Project; act: Act }) {
  const invitable = manageableRoles(project.myRoles, project.isAdmin, project.status);
  const current = project.memberships.filter((m) => m.state !== 'revoked');
  const past = project.memberships.filter((m) => m.state === 'revoked');
  const onHold = current.filter((m) => m.state === 'on_hold').length;
  const waitingInvitations = project.invitations.filter((i) => i.status === 'invited').length;
  const memberColumns: Column<Membership>[] = [
    {
      key: 'person',
      header: 'Person',
      sortValue: (m) => m.displayName.toLowerCase(),
      cell: (m) => (
        <span>
          {m.displayName}
          <span className="meta work-parent">{m.email}</span>
        </span>
      ),
    },
    { key: 'role', header: 'Role', sortValue: (m) => roleLabel(m.role), cell: (m) => roleLabel(m.role) },
    { key: 'dates', header: 'Dates', sortValue: (m) => m.startsOn, cell: (m) => `from ${m.startsOn}${m.expiresOn ? ` to ${m.expiresOn}` : ''}` },
    {
      key: 'state',
      header: 'State',
      sortValue: (m) => membershipStateLabel(m.state),
      cell: (m) => (
        <span className="label-stack">
          <StatusLabel meaning={MEMBERSHIP_MEANING[m.state]} word={membershipStateLabel(m.state)} />
          {m.holdReason && <span className="meta">{m.holdReason}</span>}
        </span>
      ),
    },
    { key: 'actions', header: 'Actions', wide: true, cell: (m) => <MemberActions m={m} project={project} act={act} /> },
  ];
  const pastColumns: Column<Membership>[] = [
    { key: 'person', header: 'Person', sortValue: (m) => m.displayName.toLowerCase(), cell: (m) => m.displayName },
    { key: 'role', header: 'Role', sortValue: (m) => roleLabel(m.role), cell: (m) => roleLabel(m.role) },
    { key: 'from', header: 'From', sortValue: (m) => m.startsOn, cell: (m) => m.startsOn },
    { key: 'state', header: 'State', cell: () => <StatusLabel meaning="off" word="Revoked" /> },
  ];
  const invitationColumns: Column<InvitationRow>[] = [
    { key: 'email', header: 'Email', sortValue: (i) => i.email.toLowerCase(), cell: (i) => i.email },
    { key: 'role', header: 'Role', sortValue: (i) => roleLabel(i.role), cell: (i) => (i.kind === 'handover' ? 'Project Manager (handover)' : roleLabel(i.role)) },
    {
      key: 'status',
      header: 'Status',
      sortValue: (i) => i.status,
      cell: (i) => (
        <span className="label-stack">
          <StatusLabel meaning={INVITATION_MEANING[i.status]} word={INVITATION_STATE_WORD[i.status]} />
          {i.status === 'invited' && <span className="meta">{formatExpiry(i.expiresAt)}</span>}
        </span>
      ),
    },
    {
      key: 'actions',
      header: 'Actions',
      cell: (i) => {
        const manage = canManage(i.role, project.myRoles, project.isAdmin, project.status, 'invitation');
        // Withdrawing is cleanup, allowed in any status; the PM may withdraw their own handover.
        const withdraw = canManage(i.role, project.myRoles, project.isAdmin, project.status, 'appointment') || (i.kind === 'handover' && project.myRoles.includes('pm'));
        const resend = manage && (i.status === 'invited' || i.status === 'expired');
        const canWithdraw = withdraw && i.status === 'invited';
        if (!resend && !canWithdraw) return <span className="meta">None</span>;
        return (
          <span className="decision">
            {resend && (
              <button
                className="link-button"
                onClick={() =>
                  void act(
                    () => api.post(`/invitations/${i.id}/resend`),
                    (r) => ((r as { delivered?: boolean }).delivered === false ? 'The email was not sent. Send again.' : `A new invitation was sent to ${i.email}.`),
                  )
                }
              >
                Send again<span className="visually-hidden"> to {i.email}</span>
              </button>
            )}
            {canWithdraw && (
              <button className="link-button" onClick={() => void act(() => api.post(`/invitations/${i.id}/revoke`), 'Invitation withdrawn.')}>
                Withdraw<span className="visually-hidden"> the invitation to {i.email}</span>
              </button>
            )}
          </span>
        );
      },
    },
  ];
  return (
    <>
      <div className="stat-grid">
        <StatTile label="People with a role" value={String(new Set(current.map((m) => m.userId)).size)} note={plural(current.length, 'appointment')} />
        <StatTile label="On Hold" value={String(onHold)} meaning={onHold > 0 ? 'attention' : undefined} word={onHold > 0 ? 'Investigation needed' : undefined} />
        <StatTile label="Invitations waiting" value={String(waitingInvitations)} />
        {project.grants.length > 0 && <StatTile label="Audit and Oversight access" value={String(project.grants.filter((g) => g.state === 'active').length)} note="Active now" />}
      </div>
      <section aria-labelledby="members-heading" className="box">
        <h2 id="members-heading" className="box-title">People</h2>
        <DataTable caption="Everyone who holds a role in this project" columns={memberColumns} rows={current} rowKey={(m) => m.id} empty="No one holds a role yet." />
        {past.length > 0 && (
          <details>
            <summary>Earlier appointments ({past.length})</summary>
            <DataTable caption="Earlier appointments" columns={pastColumns} rows={past} rowKey={(m) => m.id} empty="None." />
          </details>
        )}
      </section>

      <HandoverForm project={project} act={act} />
      <GrantsSection project={project} act={act} />

      {invitable.length > 0 && (
        <section aria-labelledby="invite-heading" className="box">
          <h2 id="invite-heading" className="box-title">Invite someone</h2>
          <InviteForm project={project} roles={invitable} act={act} />
        </section>
      )}
      <section aria-labelledby="invitations-heading" className="box">
        <h2 id="invitations-heading" className="box-title">Invitations</h2>
        <DataTable caption="Invitations to this project" columns={invitationColumns} rows={project.invitations} rowKey={(i) => i.id} empty="No invitations yet." />
      </section>
    </>
  );
}

/** A role's actions: the hold's findings and restore, Change expiry and Remove, each with its form in place. */
function MemberActions({ m, project, act }: { m: Membership; project: Project; act: Act }) {
  const manage = canManage(m.role, project.myRoles, project.isAdmin, project.status, 'appointment');
  const [mode, setMode] = useState<'none' | 'extend' | 'revoke'>('none');
  const [date, setDate] = useState(m.expiresOn ?? '');
  const [reason, setReason] = useState('');
  if (m.state !== 'on_hold' && !manage) return <span className="meta">None</span>;
  return (
    <div className="work-details">
      {m.state === 'on_hold' && <HoldActions m={m} project={project} act={act} canRestore={manage} />}
      {manage && mode === 'none' && (
        <span className="decision">
          <button className="link-button" onClick={() => setMode('extend')}>Change expiry<span className="visually-hidden"> for {m.displayName}</span></button>
          <button className="link-button" onClick={() => setMode('revoke')}>Remove<span className="visually-hidden"> {m.displayName} as {roleLabel(m.role)}</span></button>
        </span>
      )}
      {mode === 'extend' && (
        <form
          className="inline-form stack change-form"
          aria-label={`Change the expiry of the role held by ${m.displayName}`}
          onSubmit={async (e) => {
            e.preventDefault();
            if (await act(() => api.post(`/memberships/${m.id}/extend`, { expiresOn: date }), 'Expiry changed.')) setMode('none');
          }}
        >
          <label>
            New expiry <input type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <div className="decision">
            <button className="primary">Save</button>
            <button type="button" onClick={() => setMode('none')}>Cancel</button>
          </div>
        </form>
      )}
      {mode === 'revoke' && (
        <form
          className="inline-form stack change-form"
          aria-label={`Remove ${m.displayName} as ${roleLabel(m.role)}`}
          onSubmit={async (e) => {
            e.preventDefault();
            if (await act(() => api.post(`/memberships/${m.id}/revoke`, { reason }), `${m.displayName} no longer holds the ${roleLabel(m.role)} role.`)) setMode('none');
          }}
        >
          <p className="meta">They lose this role straight away. The appointment stays under Earlier appointments.</p>
          <label>
            Reason <input required value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <div className="decision">
            <button className="reject">Remove</button>
            <button type="button" onClick={() => setMode('none')}>Cancel</button>
          </div>
        </form>
      )}
    </div>
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
    <form className="stack" onSubmit={submit} aria-label="Invite someone">
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
