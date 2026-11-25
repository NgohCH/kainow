import { useEffect, useState } from 'react';
import { ApiError, api } from '../api.ts';
import { awaitingLabel, cancelledLabel, completionLabel, dayLabel, onTimeLabel, plannedEndLabel, stageLabel, updatedLabel } from '../dashboard.ts';
import { DEFAULT_STATUSES, LEADERSHIP_FIELDS, type LeadershipCard, type LeadershipSummary, leadershipQuery, visibleFields } from '../leadership.ts';
import { defaultPrefs, openChoice, type Prefs } from '../prefs.ts';
import { STATUS_LABEL } from '../projects.ts';
import { budgetCardLines, resourcesCardText } from '../resourceScreens.ts';
import { Customise } from './Customise.tsx';
import { PageHeader } from '../ui/PageHeader.tsx';
import { StatTile } from '../ui/StatTile.tsx';
import { StatusLabel } from '../ui/StatusLabel.tsx';
import { projectMeaning } from '../ui/meanings.ts';
import type { ProjectStatus } from '../projects.ts';

const isProjectStatus = (s: string | undefined): s is ProjectStatus => !!s && s in STATUS_LABEL;

/** A count over the cards, or null when no card carries that field (it is hidden or not granted). */
function total(cards: LeadershipCard[], key: 'overdue' | 'blocked'): number | null {
  const shown = cards.filter((c) => typeof c[key] === 'number');
  return shown.length === 0 ? null : shown.reduce((n, c) => n + (c[key] ?? 0), 0);
}

const ALL_STATUSES = ['draft', 'planned', 'active', 'deferred', 'closed'] as const;

function flagsOf(c: LeadershipCard): string[] {
  const f = c.attentionFlags;
  if (!f) return [];
  return [
    f.missingRole ? 'Missing a required role' : '',
    f.noIndependentEscalation ? 'No independent escalation recipient' : '',
    f.deadlineReview ? 'Deadline review required' : '',
  ].filter(Boolean);
}

/** One catalogue field as a term and its value. Name, attention flags and refresh are drawn in the card header. */
function FieldRow({ k, c }: { k: string; c: LeadershipCard }) {
  switch (k) {
    case 'owningDepartment':
      return c.owningDepartment === undefined ? null : <><dt>Owning department</dt><dd>{c.owningDepartment}</dd></>;
    case 'contributingDepartments':
      return c.contributingDepartments === undefined ? null : (
        <><dt>Contributing departments</dt><dd>{c.contributingDepartments.length > 0 ? c.contributingDepartments.join(', ') : 'None'}</dd></>
      );
    case 'projectManager':
      return c.projectManager === undefined ? null : <><dt>Project Manager</dt><dd>{c.projectManager ?? 'None'}</dd></>;
    case 'status':
      return c.status === undefined ? null : (
        <><dt>Status</dt><dd>{isProjectStatus(c.status) ? <StatusLabel meaning={projectMeaning(c.status)} word={STATUS_LABEL[c.status]} /> : c.status}</dd></>
      );
    case 'stage':
      return c.stage === undefined ? null : (
        <><dt>Stage</dt><dd>{stageLabel(c.stage)}</dd></>
      );
    case 'taskCompletion': {
      if (!c.taskCompletion) return null;
      const cancelled = cancelledLabel(c.taskCompletion);
      return <><dt>Task completion</dt><dd>{completionLabel(c.taskCompletion)}{cancelled && <span className="meta"> · {cancelled}</span>}</dd></>;
    }
    case 'onTime': {
      if (!c.onTime) return null;
      const waiting = awaitingLabel(c.onTime);
      return <><dt>On-time completion</dt><dd>{onTimeLabel(c.onTime)}{waiting && <span className="meta"> · {waiting}</span>}</dd></>;
    }
    case 'plannedEnd':
      return c.plannedEnd === undefined ? null : <><dt>Planned end</dt><dd>{plannedEndLabel(c.plannedEnd)}</dd></>;
    case 'overdue':
      return c.overdue === undefined ? null : <><dt>Overdue tasks</dt><dd>{c.overdue}</dd></>;
    case 'blocked':
      return c.blocked === undefined ? null : <><dt>Blocked tasks</dt><dd>{c.blocked}</dd></>;
    case 'significantRisks':
      if (!c.significantRisks) return null;
      return (
        <>
          <dt>Significant risks</dt>
          <dd>
            {c.significantRisks.count}
            {c.significantRisks.items.length > 0 && (
              <ul className="plain">
                {c.significantRisks.items.map((r, i) => (
                  <li key={i}>
                    {r.description} <span className="meta">· {r.severity === 'critical' ? 'Critical' : 'High'}{r.reviewOn ? ` · review ${dayLabel(r.reviewOn)}` : ''}</span>
                  </li>
                ))}
              </ul>
            )}
          </dd>
        </>
      );
    case 'resources':
      return c.resources === undefined ? null : <><dt>Resources</dt><dd>{resourcesCardText(c.resources)}</dd></>;
    case 'budget':
      if (c.budget === undefined) return null;
      return (
        <>
          <dt>Budget</dt>
          <dd>{budgetCardLines(c.budget).map((t, i) => <span key={i} className={i === 0 ? undefined : 'meta'}>{i > 0 && <br />}{t}</span>)}</dd>
        </>
      );
    case 'nextDates':
      if (!c.nextDates) return null;
      return (
        <>
          <dt>Next dates</dt>
          <dd>
            Next task due: {c.nextDates.nextTaskDue ? dayLabel(c.nextDates.nextTaskDue) : 'None'}
            <br />
            Next risk review: {c.nextDates.nextRiskReview ? dayLabel(c.nextDates.nextRiskReview) : 'None'}
          </dd>
        </>
      );
    default:
      return null;
  }
}

const HEADER_KEYS = ['name', 'attentionFlags', 'refresh'];

function Card({ c, keys, open, onToggle }: { c: LeadershipCard; keys: string[]; open: boolean; onToggle: () => void }) {
  const flags = flagsOf(c);
  const panel = `leadership-${c.id}`;
  // Status shows in the header when the person shows that field, so the body leaves it out.
  const statusShown = keys.includes('status') && isProjectStatus(c.status);
  const body = keys.filter((k) => !HEADER_KEYS.includes(k) && !(k === 'status' && statusShown));
  return (
    <li className={`box leadership-card${flags.length > 0 ? ' edge-left m-attention' : ''}`}>
      <h3>
        <button type="button" className="disclosure" aria-expanded={open} aria-controls={open ? panel : undefined} onClick={onToggle}>
          {c.name ?? 'Project'}
        </button>
      </h3>
      {(flags.length > 0 || statusShown) && (
        <ul className="flag-row" aria-label="Status and attention flags">
          {statusShown && isProjectStatus(c.status) && <li><StatusLabel meaning={projectMeaning(c.status)} word={STATUS_LABEL[c.status]} /></li>}
          {flags.map((f) => <li key={f}><StatusLabel meaning="attention" word={f} /></li>)}
        </ul>
      )}
      {c.refresh && <p className="meta">{updatedLabel(c.refresh)}</p>}
      {open && (
        <div id={panel} className="home-project-body">
          <dl className="facts">{body.map((k) => <FieldRow key={k} k={k} c={c} />)}</dl>
          {c.link && <p><a href={`#/projects/${c.id}`}>Open the project</a></p>}
        </div>
      )}
    </li>
  );
}

/** The leadership summary (spec section 6.2): projects in the viewer's grants as collapsible cards. */
export function Leadership({ prefs, ready, failed, onChange }: { prefs: Prefs; ready: boolean; failed: boolean; onChange: (next: Prefs) => Promise<void> }) {
  const [statuses, setStatuses] = useState<string[]>([...DEFAULT_STATUSES]);
  const [department, setDepartment] = useState('');
  const [includeArchived, setIncludeArchived] = useState(false);
  const [data, setData] = useState<LeadershipSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [local, setLocal] = useState<Record<string, boolean>>({});
  const [fieldsOpen, setFieldsOpen] = useState(false);
  const fieldsKey = JSON.stringify(ready ? prefs.leadership.fields : null);

  useEffect(() => {
    // With preferences that failed to load, the summary still loads (the server falls back to its default fields).
    if (!ready && !failed) return;
    let stale = false;
    setError(null);
    api.get<LeadershipSummary>(`/dashboard/leadership${leadershipQuery({ statuses, department, includeArchived })}`).then(
      (r) => !stale && setData(r),
      (e: Error) => !stale && setError(e.message),
    );
    return () => {
      stale = true;
    };
  }, [ready, failed, statuses.join(','), department, includeArchived, fieldsKey]);

  async function save(next: Prefs) {
    setSaveError(null);
    try {
      await onChange(next);
    } catch (e) {
      setSaveError(e instanceof ApiError ? e.message : 'Could not save that choice. Try again.');
    }
  }

  const keys = visibleFields(ready ? prefs : defaultPrefs(), LEADERSHIP_FIELDS).map((f) => f.key);
  const cards = data?.cards ?? [];
  const ids = cards.map((c) => c.id);
  const isOpen = (id: string) => openChoice(local, prefs.expanded, cards.length, id);
  // A choice always works on the page; it is saved only once the saved preferences have loaded (saving earlier would overwrite them).
  const choose = (patch: Record<string, boolean>) => {
    setLocal((l) => ({ ...l, ...patch }));
    if (ready) void save({ ...prefs, expanded: { ...prefs.expanded, ...patch } });
  };
  const setAll = (open: boolean) => choose(Object.fromEntries(ids.map((id) => [id, open])));
  const flagged = cards.filter((c) => flagsOf(c).length > 0).length;
  const overdueTotal = keys.includes('overdue') ? total(cards, 'overdue') : null;
  const blockedTotal = keys.includes('blocked') ? total(cards, 'blocked') : null;

  return (
    <main className="page home leadership-page">
      <PageHeader
        title="Leadership"
        intro="A leadership grant shows these summary fields only. It does not give access to a project's content."
        action={data ? <span className="meta">{updatedLabel(data.computedAt)}</span> : undefined}
      />
      {error && <p role="alert" className="error">{error}</p>}
      {saveError && <p role="alert" className="error">{saveError}</p>}
      {failed && !ready && <p role="alert" className="error">Your saved display choices could not be loaded, so the default fields are shown and they cannot be changed until they load.</p>}

      {data && (
        <div className="stat-grid">
          <StatTile label="Projects shown" value={String(cards.length)} />
          <StatTile label="With attention flags" value={String(flagged)} meaning={flagged > 0 ? 'attention' : undefined} word={flagged > 0 ? 'Needs attention' : undefined} />
          {overdueTotal !== null && <StatTile label="Overdue tasks" value={String(overdueTotal)} meaning={overdueTotal > 0 ? 'overdue' : undefined} />}
          {blockedTotal !== null && <StatTile label="Blocked tasks" value={String(blockedTotal)} meaning={blockedTotal > 0 ? 'blocked' : undefined} />}
        </div>
      )}

      <form className="box stack" aria-label="Filters" onSubmit={(e) => e.preventDefault()}>
        <fieldset>
          <legend>Status</legend>
          {ALL_STATUSES.map((s) => (
            <label key={s} className="choice">
              <input type="checkbox" checked={statuses.includes(s)} onChange={(e) => setStatuses((cur) => (e.target.checked ? [...cur, s] : cur.filter((x) => x !== s)))} />
              {STATUS_LABEL[s]}
            </label>
          ))}
        </fieldset>
        <label>
          Department
          <select value={department} onChange={(e) => setDepartment(e.target.value)}>
            <option value="">All departments in scope</option>
            {data?.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={includeArchived} onChange={(e) => setIncludeArchived(e.target.checked)} />
          Include archived
        </label>
      </form>

      <div className="inline-form">
        <button type="button" className="quiet" disabled={ids.length === 0} onClick={() => setAll(true)}>Expand all</button>
        <button type="button" className="quiet" disabled={ids.length === 0} onClick={() => setAll(false)}>Collapse all</button>
        <button type="button" className="quiet" aria-expanded={fieldsOpen} onClick={() => setFieldsOpen((o) => !o)}>Choose fields</button>
      </div>
      {fieldsOpen && <Customise prefs={prefs} ready={ready} failed={failed} onChange={onChange} onClose={() => setFieldsOpen(false)} show={['leadership']} />}

      {!data && !error && <p className="loading">Loading</p>}
      {data && cards.length === 0 && <p className="empty">No projects in your leadership scope match these filters.</p>}
      <ul className="plain leadership-cards">
        {cards.map((c) => (
          <Card key={c.id} c={c} keys={keys.filter((k) => k in c)} open={isOpen(c.id)} onToggle={() => choose({ [c.id]: !isOpen(c.id) })} />
        ))}
      </ul>
    </main>
  );
}
