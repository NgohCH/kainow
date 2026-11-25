import { useCallback, useDeferredValue, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { ApiError, api, setCsrfToken, type Department, type Project, type User } from '../api.ts';
import { go } from '../App.tsx';
import { plural } from '../format.ts';
import { type DupState, type Offer, type Part, allTasks, buildBody, fieldOf, mergeOffer, mergedLine, problemsOf, refusalPart, startState, takeOutUnavailable, termsOf, withServerTerms } from '../duplicate.ts';
import { Box } from '../ui/Box.tsx';
import { PageHeader } from '../ui/PageHeader.tsx';
import { StatusLabel } from '../ui/StatusLabel.tsx';
import { leaveGuard } from '../ui/leaveGuard.ts';
import { useLeaveGuard } from '../ui/useLeaveGuard.ts';
import { CarriedField, PartError, ProblemList, carriedProps } from './DuplicateFields.tsx';
import { DuplicateHolidays, DuplicateResources, DuplicateRisks, DuplicateSettings, DuplicateStages } from './DuplicateParts.tsx';
import { DuplicateTasks } from './DuplicateTasks.tsx';

const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'That did not work. Try again.');

interface Loaded { offer: Offer; departments: Department[]; approved: { input: string[]; output: string[] } | null }

async function loadAll(projectId: string): Promise<Loaded> {
  const [offer, departments, outputs] = await Promise.all([
    api.get<Offer>(`/projects/${projectId}/duplicate`),
    api.get<{ departments: Department[] }>('/departments'),
    // Only for the list of formats to choose from; without it, the original's own are still offered.
    api.get<{ approvedFormats: { input: string[]; output: string[] } }>(`/projects/${projectId}/output-settings`).catch(() => null),
  ]);
  return { offer, departments: departments.departments.filter((d) => d.status === 'active'), approved: outputs?.approvedFormats ?? null };
}

/** `#/projects/<id>/duplicate`: everything that may be carried into a new project, prefilled and open to change (D140). */
export function DuplicateProject({ projectId, meId }: { projectId: string; meId: string }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let stale = false;
    loadAll(projectId).then(
      (l) => !stale && setLoaded(l),
      (e) => !stale && setError(errText(e)),
    );
    return () => {
      stale = true;
    };
  }, [projectId]);
  if (!loaded) {
    return (
      <main className="page narrow">
        {error ? <p role="alert" className="error">{error}</p> : <p className="loading">Loading</p>}
        <a href={`#/projects/${projectId}`}>Back to the project</a>
      </main>
    );
  }
  return <Review first={loaded} meId={meId} />;
}

interface Refusal { message: string; part: Part | null; problems: string[]; loadAgain: boolean; uncertain: boolean; created: string | null }

/** What a failed Create says, and what can be done about it. */
function readRefusal(e: unknown): Refusal {
  const data = (e instanceof ApiError ? e.data : null) as { problems?: unknown; projectId?: unknown } | null;
  const created = typeof data?.projectId === 'string' ? data.projectId : null;
  const problems = Array.isArray(data?.problems) ? data.problems.filter((p): p is string => typeof p === 'string') : [];
  const status = e instanceof ApiError ? e.status : 0;
  const message = status === 413 ? 'There is too much text to copy at once. Take out some tasks or shorten descriptions.' : errText(e);
  return {
    message,
    problems,
    part: problems.length > 0 ? null : refusalPart(message),
    loadAgain: problems.length === 0 && created === null && (status === 400 || status === 409),
    // No answer, or one that says nothing about what happened.
    uncertain: status === 0 || (status >= 500 && status !== 503),
    created,
  };
}

function Review({ first, meId }: { first: Loaded; meId: string }) {
  const [loaded, setLoaded] = useState(first);
  const { offer, departments, approved } = loaded;
  const id = offer.original.id;
  const [state, update] = useReducer((s: DupState, change: (s: DupState) => DupState) => change(s), first.offer, startState);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [allProblems, setAllProblems] = useState(false);
  // What a refusal named as no longer available.
  const unavailable = useRef<string[]>([]);
  const errorBox = useRef<HTMLDivElement>(null);
  const noticeBox = useRef<HTMLParagraphElement>(null);

  const unsaved = state !== useRef(state).current;
  useLeaveGuard(unsaved);

  // Finding old terms and what is left to change may wait a moment; what is typed may not.
  const deferred = useDeferredValue(state);
  const termsText = useDeferredValue(state.termsText);
  const terms = useMemo(() => termsOf(termsText).slice(0, offer.limits.terms), [termsText, offer.limits.terms]);
  const problems = useMemo(() => problemsOf(offer, deferred), [offer, deferred]);
  useEffect(() => {
    if (refusal) errorBox.current?.focus();
  }, [refusal]);
  useEffect(() => {
    if (notice) noticeBox.current?.focus();
  }, [notice]);

  const set = useCallback((change: Partial<DupState>) => update((s) => ({ ...s, ...change })), []);
  const part = { offer, state, terms, update };

  async function post(): Promise<{ project: Project }> {
    const send = () => api.post<{ project: Project }>(`/projects/${id}/duplicate`, buildBody(offer, state));
    try {
      return await send();
    } catch (e) {
      if (!(e instanceof ApiError) || !(e.status === 401 || (e.status === 403 && /anti-forgery/.test(e.message)))) throw e;
      // The session ended while the page was open; the person may have signed in again in another tab.
      const me = await api.get<{ user: User; csrfToken: string | null }>('/auth/me').catch(() => {
        throw new ApiError('You are signed out. Sign in to Kainow in another tab, then press Create project again here. What you typed is kept.', 401);
      });
      if (me.user.id !== meId) throw new ApiError('Another person has signed in to Kainow in this browser. Sign in as yourself in another tab, then press Create project again here.', 401);
      setCsrfToken(me.csrfToken);
      return send();
    }
  }

  async function create() {
    if (problemsOf(offer, state).length > 0) return;
    setBusy(true);
    setRefusal(null);
    setNotice(null);
    try {
      const r = await post();
      leaveGuard.release();
      go(`#/projects/${r.project.id}`);
    } catch (e) {
      const data = (e instanceof ApiError ? e.data : null) as { terms?: Array<{ key: string; term: string }> } | null;
      if (Array.isArray(data?.terms)) {
        const named = data.terms;
        update((s) => withServerTerms(s, offer, named));
      }
      setRefusal(readRefusal(e));
      unavailable.current = e instanceof ApiError && Array.isArray((e.data as { unavailable?: unknown } | null)?.unavailable) ? (e.data as { unavailable: string[] }).unavailable : [];
      setBusy(false);
    }
  }

  /** Reads the original again and keeps what was typed. */
  async function loadAgain() {
    setBusy(true);
    try {
      const next = await loadAll(id);
      const merged = mergeOffer(offer, next.offer, takeOutUnavailable(state, offer, unavailable.current));
      update(() => merged.state);
      setLoaded(next);
      setRefusal(null);
      setNotice(mergedLine(merged.removed, merged.added));
      unavailable.current = [];
    } catch (e) {
      setRefusal((r) => ({ ...(r ?? readRefusal(e)), message: `The original could not be loaded again: ${errText(e)} What you typed is kept.`, part: null, problems: [], loadAgain: true, uncertain: false, created: null }));
    } finally {
      setBusy(false);
    }
  }

  const chosenTasks = allTasks(offer).filter((t) => state.tasks[t.id].on);
  const subtasks = chosenTasks.filter((t) => t.parentId !== null).length;
  const retiredKept = offer.original.contributingDepartments.filter((d) => d.retired && !departments.some((x) => x.id === d.id));
  const list = (
    <ProblemList problems={problems} projectId={id} all={allProblems} onAll={() => setAllProblems((a) => !a)} />
  );
  const left = problems.length === 0 ? 'Nothing left to change' : `${plural(problems.length, 'thing')} to change`;

  return (
    <main className="page duplicate-page">
      <PageHeader
        crumbs={[{ text: 'Projects', href: '#/projects' }, { text: offer.original.name, href: `#/projects/${id}` }]}
        title="Duplicate project"
        intro="Nothing is created until you press Create. Everything below is filled in from the original: change whatever differs for the new project."
      />
      {notice && <p ref={noticeBox} role="status" tabIndex={-1} className="ok">{notice}</p>}

      <Box title="What you still need to change" meaning={problems.length > 0 ? 'attention' : 'ok'}>
        <p role="status"><StatusLabel meaning={problems.length > 0 ? 'attention' : 'ok'} word={left} /></p>
        {problems.length > 0 ? list : <p className="meta">You can create the project at the end of this page.</p>}
      </Box>

      <Box title="What must be different">
        <PartError refusal={refusal} part="details" />
        <div className="stack">
          <CarriedField {...carriedProps('name', part)} text={state.name} mustChange={problems.some((p) => p.field === 'dup-name')}>
            {(note) => (
              <label>
                Name
                <input id="dup-name" maxLength={200} value={state.name} aria-describedby={note} onChange={(e) => set({ name: e.target.value })} />
                <span className="hint">The original is {offer.original.name}.</span>
              </label>
            )}
          </CarriedField>
          <div className={`stack carried${problems.some((p) => p.field === 'dup-planned-end') ? ' asked open' : ''}`}>
            <label>
              Planned end
              <input id="dup-planned-end" type="date" disabled={state.noPlannedEnd} value={state.noPlannedEnd ? '' : state.plannedEnd} onChange={(e) => set({ plannedEnd: e.target.value })} />
              <span className="hint">{offer.original.plannedEnd ? `The original ends on ${offer.original.plannedEnd}.` : 'The original has no planned end.'}</span>
            </label>
            {problems.some((p) => p.field === 'dup-planned-end') && <StatusLabel meaning="attention" word="Must be changed" />}
            <label className="check">
              <input type="checkbox" checked={state.noPlannedEnd} onChange={(e) => set({ noPlannedEnd: e.target.checked })} /> No planned end
            </label>
          </div>
          <CarriedField {...carriedProps('purpose', part)} text={state.purpose} mustDecide={state.purpose.trim() === offer.original.purpose.trim()}>
            {(note) => (
              <label>
                Purpose
                <textarea id={fieldOf('purpose')} rows={4} maxLength={4000} value={state.purpose} aria-describedby={note} onChange={(e) => set({ purpose: e.target.value })} />
              </label>
            )}
          </CarriedField>
          <label>
            Old terms to look for (optional, one per line)
            <textarea id="dup-terms" rows={3} value={state.termsText} onChange={(e) => set({ termsText: e.target.value })} />
            <span className="hint">
              Up to {offer.limits.terms} words or phrases that belong to the original only, such as the customer or the year. Every text below that holds one is marked, and you change it or tick “Still correct”. The list is not stored.
            </span>
          </label>
        </div>
      </Box>

      <Box title="Details">
        <div className="stack">
          <label>
            Owning department
            <select
              id="dup-owning"
              value={state.owning}
              onChange={(e) => {
                const owning = e.target.value;
                update((s) => ({ ...s, owning, contributing: s.contributing.filter((d) => d !== owning) }));
              }}
            >
              <option value="">Choose a department</option>
              {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
            {offer.original.owningDepartment.retired && <span className="hint">The original's department, {offer.original.owningDepartment.name}, is retired.</span>}
          </label>
          <fieldset>
            <legend>Contributing departments (optional)</legend>
            {[...departments.filter((d) => d.id !== state.owning), ...retiredKept.map((d) => ({ ...d, status: 'retired' as const }))].map((d) => (
              <label key={d.id} className="check">
                <input
                  id={`dup-contributing:${d.id}`}
                  type="checkbox"
                  checked={state.contributing.includes(d.id)}
                  onChange={(e) => {
                    const on = e.target.checked;
                    update((s) => ({ ...s, contributing: on ? [...s.contributing, d.id] : s.contributing.filter((x) => x !== d.id) }));
                  }}
                />{' '}
                {d.name}{d.status === 'retired' ? ' (retired: cannot be copied)' : ''}
              </label>
            ))}
          </fieldset>
          <section aria-labelledby="dup-stages-heading">
            <h3 id="dup-stages-heading">Stages</h3>
            <PartError refusal={refusal} part="stages" />
            <DuplicateStages {...part} />
          </section>
          <section aria-labelledby="dup-holidays-heading">
            <h3 id="dup-holidays-heading">Project holidays</h3>
            <PartError refusal={refusal} part="holidays" />
            <DuplicateHolidays {...part} />
          </section>
        </div>
      </Box>

      <Box title="Settings">
        <PartError refusal={refusal} part="settings" />
        <DuplicateSettings {...part} approved={approved} />
      </Box>

      <div id="dup-tasks" tabIndex={-1}>
        <Box title="Tasks">
          <PartError refusal={refusal} part="tasks" />
          <DuplicateTasks {...part} />
        </Box>
      </div>

      <div id="dup-risks" tabIndex={-1}>
        <Box title="Risks">
          <PartError refusal={refusal} part="risks" />
          <DuplicateRisks {...part} />
        </Box>
      </div>

      <div id="dup-resources" tabIndex={-1}>
        <Box title="Resources">
          <PartError refusal={refusal} part="resources" />
          <DuplicateResources {...part} />
        </Box>
      </div>

      <Box title="Review and create" meaning={problems.length > 0 ? 'attention' : 'ok'}>
        <p>
          A new Draft project with you as its only member and Project Manager: {plural(state.stages.length, 'stage')}, {plural(chosenTasks.length - subtasks, 'task')} and {plural(subtasks, 'subtask')} as proposals,{' '}
          {plural(offer.risks.filter((r) => state.risks[r.id].on).length, 'risk')} as proposals and {plural(offer.resources.filter((l) => state.resources[l.id].on).length, 'resource line')}.
        </p>
        <p className="meta">Not copied: people, notes, discussions, decisions, questions, outputs, files, history, budget, AI settings, access and change requests. The original is not changed.</p>
        <p><StatusLabel meaning={problems.length > 0 ? 'attention' : 'ok'} word={left} /></p>
        {problems.length > 0 && list}
        {refusal && (
          <div ref={errorBox} tabIndex={-1} role="alert" className="stack">
            {refusal.created !== null && <p>{refusal.message} <a href={`#/projects/${refusal.created}`} onClick={() => leaveGuard.release()}>Open the new project</a></p>}
            {refusal.created === null && <p className="error">The project was not created{refusal.uncertain ? ' as far as Kainow can tell' : ''}. {refusal.problems.length === 0 && refusal.message}</p>}
            {refusal.problems.length > 0 && <ul>{refusal.problems.map((p) => <li key={p} className="error">{p}</li>)}</ul>}
            {refusal.uncertain && <p>It may have been created all the same: look in <a href="#/projects" target="_blank" rel="noreferrer">Projects (opens in a new tab)</a> before you press Create again.</p>}
            {refusal.loadAgain && (
              <div>
                <p className="meta">The original may have changed since you opened this page. Loading it again keeps what you typed.</p>
                <button type="button" disabled={busy} onClick={() => void loadAgain()}>Load again</button>
              </div>
            )}
          </div>
        )}
        <div className="decision">
          <button type="button" className="primary" disabled={busy || problems.length > 0} onClick={() => void create()}>{busy ? 'Working' : 'Create project'}</button>
          <a href={`#/projects/${id}`}>Cancel</a>
        </div>
      </Box>
    </main>
  );
}
