import { useCallback, useDeferredValue, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { ApiError, api, setCsrfToken, type Department, type Project, type User } from '../api.ts';
import { go } from '../App.tsx';
import { plural } from '../format.ts';
import { type DupState, type Loaded, type Offer, type Page, type Refusal, allTasks, buildBody, fieldOf, loadedAgain, problemsOf, blockedReason, purposeUnchanged, readRefusal, replacedOf, startPage, termsOf, withServerTerms } from '../duplicate.ts';
import { Box } from '../ui/Box.tsx';
import { PageHeader } from '../ui/PageHeader.tsx';
import { StatusLabel } from '../ui/StatusLabel.tsx';
import { leaveGuard } from '../ui/leaveGuard.ts';
import { useLeaveGuard } from '../ui/useLeaveGuard.ts';
import { CarriedField, PartError, ProblemList, carriedProps } from './DuplicateFields.tsx';
import { DuplicateHolidays, DuplicateResources, DuplicateRisks, DuplicateSettings, DuplicateStages } from './DuplicateParts.tsx';
import { DuplicateTasks } from './DuplicateTasks.tsx';

const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'That did not work. Try again.');

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

const refusalOf = (e: unknown): Refusal => readRefusal(e instanceof ApiError ? e.status : 0, errText(e), e instanceof ApiError ? e.data : null);

function Review({ first, meId }: { first: Loaded; meId: string }) {
  // The offer and what was made of it are one state: they are never drawn from different loads.
  const [page, change] = useReducer((p: Page, next: (p: Page) => Page) => next(p), first, startPage);
  const { loaded: { offer, departments, approved }, dup: state, notice } = page;
  const id = offer.original.id;
  const update = useCallback((edit: (s: DupState) => DupState) => change((p) => ({ ...p, dup: edit(p.dup) })), []);
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(false);
  const busy = creating || loading;
  // Create may answer after the person has chosen to leave.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [allProblems, setAllProblems] = useState(false);
  // What a refusal named as no longer available.
  const unavailable = useRef<string[]>([]);
  const errorBox = useRef<HTMLDivElement>(null);
  const noticeBox = useRef<HTMLParagraphElement>(null);

  const unsaved = state !== useRef(state).current;
  useLeaveGuard(unsaved);

  // Finding old terms and what is left to change may wait a moment; what is typed may not.
  const deferred = useDeferredValue(page);
  const termsText = useDeferredValue(state.termsText);
  const terms = useMemo(() => termsOf(termsText).slice(0, offer.limits.terms), [termsText, offer.limits.terms]);
  const problems = useMemo(() => problemsOf(deferred.loaded.offer, deferred.dup, new Set(deferred.loaded.departments.map((d) => d.id))), [deferred]);
  const replaced = useMemo(() => replacedOf(deferred.loaded.offer, deferred.dup), [deferred]);
  const blocked = blockedReason(offer);
  const has = (field: string) => problems.some((p) => p.field === field);
  useEffect(() => {
    if (refusal) errorBox.current?.focus();
  }, [refusal]);
  useEffect(() => {
    if (notice) noticeBox.current?.focus();
  }, [notice]);

  const set = useCallback((change: Partial<DupState>) => update((s) => ({ ...s, ...change })), [update]);
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
    if (problemsOf(offer, state, new Set(departments.map((d) => d.id))).length > 0) return;
    setCreating(true);
    setRefusal(null);
    change((p) => ({ ...p, notice: null }));
    try {
      const r = await post();
      if (!mounted.current) return;
      leaveGuard.release();
      go(`#/projects/${r.project.id}`);
    } catch (e) {
      const data = (e instanceof ApiError ? e.data : null) as { terms?: Array<{ key: string; term: string }> } | null;
      if (Array.isArray(data?.terms)) {
        const named = data.terms;
        update((s) => withServerTerms(s, offer, named));
      }
      setRefusal(refusalOf(e));
      unavailable.current = e instanceof ApiError && Array.isArray((e.data as { unavailable?: unknown } | null)?.unavailable) ? (e.data as { unavailable: string[] }).unavailable : [];
      setCreating(false);
    }
  }

  /** Reads the original again and keeps what was typed. */
  async function loadAgain() {
    setLoading(true);
    try {
      const next = await loadAll(id);
      const gone = unavailable.current;
      change((p) => loadedAgain(p, next, gone));
      setRefusal(null);
      unavailable.current = [];
    } catch (e) {
      setRefusal((r) => ({ ...(r ?? refusalOf(e)), message: `The original could not be loaded again: ${errText(e)} What you typed is kept.`, part: null, problems: [], loadAgain: true, uncertain: false, created: null, hint: null }));
    } finally {
      setLoading(false);
    }
  }

  const chosenTasks = allTasks(offer).filter((t) => state.tasks[t.id].on);
  const subtasks = chosenTasks.filter((t) => t.parentId !== null).length;
  const inUse = new Set(departments.map((d) => d.id));
  // Also the original's own retired ones, so that unticking one can be taken back.
  const retiredKept = [...new Set([...offer.original.contributingDepartments.map((d) => d.id), ...state.contributing])].filter((d) => !inUse.has(d)).map((d) => ({ id: d, name: page.departmentNames[d] ?? 'A department' }));
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
      {notice && <p ref={noticeBox} tabIndex={-1} className="ok">{notice}</p>}

      {blocked && (
        <Box title="This project cannot be copied now" meaning="blocked">
          <p>{blocked}</p>
          <button type="button" disabled={busy} onClick={() => void loadAgain()}>Load again</button>
        </Box>
      )}
      {replaced.length > 0 && (
        <Box title="Replaced when you loaded again" meaning="attention">
          <ProblemList problems={replaced} projectId={id} all={allProblems} onAll={() => setAllProblems((a) => !a)} />
        </Box>
      )}

      <Box title="What you still need to change" meaning={problems.length > 0 ? 'attention' : 'ok'}>
        <p role="status"><StatusLabel meaning={problems.length > 0 ? 'attention' : 'ok'} word={left} /></p>
        {problems.length > 0 ? list : <p className="meta">You can create the project at the end of this page.</p>}
      </Box>

      <fieldset className="dup-fields" disabled={busy}>
      <legend className="visually-hidden">The new project</legend>
      <Box title="What must be different">
        <PartError refusal={refusal} part="details" />
        <div className="stack">
          <CarriedField {...carriedProps('name', part)} text={state.name} mustChange={has('dup-name')}>
            {(note) => (
              <label>
                Name
                <input id="dup-name" maxLength={200} value={state.name} aria-describedby={note} onChange={(e) => set({ name: e.target.value })} />
                <span className="hint">The original is {offer.original.name}.</span>
              </label>
            )}
          </CarriedField>
          <div className={`stack carried${has('dup-planned-end') ? ' asked open' : ''}`}>
            <label>
              Planned end
              <input id="dup-planned-end" type="date" aria-describedby={has('dup-planned-end') ? 'dup-planned-end-note' : undefined} disabled={state.noPlannedEnd} value={state.noPlannedEnd ? '' : state.plannedEnd} onChange={(e) => set({ plannedEnd: e.target.value })} />
              <span className="hint">{offer.original.plannedEnd ? `The original ends on ${offer.original.plannedEnd}.` : 'The original has no planned end.'}</span>
            </label>
            {has('dup-planned-end') && <p id="dup-planned-end-note" className="carried-note"><StatusLabel meaning="attention" word="Must be changed" /></p>}
            <label className="check">
              <input type="checkbox" checked={state.noPlannedEnd} onChange={(e) => set({ noPlannedEnd: e.target.checked })} /> No planned end
            </label>
          </div>
          <CarriedField {...carriedProps('purpose', part)} text={state.purpose} mustDecide={purposeUnchanged(offer, state)}>
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
        <PartError refusal={refusal} part="departments" />
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
              {state.owning !== '' && !inUse.has(state.owning) && <option value={state.owning}>{page.departmentNames[state.owning] ?? 'A department'} (retired: choose another)</option>}
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

      </fieldset>

      <Box title="Review and create" meaning={problems.length > 0 ? 'attention' : 'ok'}>
        <p>
          A new Draft project with you as its only member and Project Manager: {plural(state.stages.length, 'stage')}, {plural(chosenTasks.length - subtasks, 'task')} and {plural(subtasks, 'subtask')} as proposals,{' '}
          {plural(offer.risks.filter((r) => state.risks[r.id].on).length, 'risk')} as proposals and {plural(offer.resources.filter((l) => state.resources[l.id].on).length, 'resource line')}.
        </p>
        <p className="meta">Not copied: people, notes, discussions, decisions, questions, outputs, files, history, budget, AI settings, access and change requests. The original is not changed.</p>
        <p><StatusLabel meaning={problems.length > 0 ? 'attention' : 'ok'} word={left} /></p>
        {problems.length > 0 && list}
        {blocked && <p className="error">{blocked}</p>}
        {refusal && (
          <div ref={errorBox} tabIndex={-1} role="group" aria-label="Why the project was not created" className="stack">
            {refusal.created !== null && <p>{refusal.message} <a href={`#/projects/${refusal.created}`} onClick={(e) => !(e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) && leaveGuard.release()}>Open the new project</a></p>}
            {refusal.created === null && <p className="error">The project was not created{refusal.uncertain ? ' as far as Kainow can tell' : ''}. {refusal.problems.length === 0 && refusal.message}</p>}
            {refusal.problems.length > 0 && <ul>{refusal.problems.map((p) => <li key={p} className="error">{p}</li>)}</ul>}
            {refusal.uncertain && <p>It may have been created all the same: look in <a href="#/projects" target="_blank" rel="noreferrer">Projects (opens in a new tab)</a> before you press Create again.</p>}
            {refusal.loadAgain && (
              <div>
                {refusal.hint && <p className="meta">{refusal.hint}</p>}
                <button type="button" disabled={busy} onClick={() => void loadAgain()}>Load again</button>
              </div>
            )}
          </div>
        )}
        <div className="decision">
          <button type="button" className="primary" disabled={busy || problems.length > 0 || blocked !== null} onClick={() => void create()}>{busy ? 'Working' : 'Create project'}</button>
          <a href={`#/projects/${id}`}>Cancel</a>
        </div>
      </Box>
    </main>
  );
}
