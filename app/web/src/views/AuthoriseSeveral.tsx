import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api } from '../api.ts';
import { type ItemTerms, type ManyProposal, type ManyResult, type SubtaskTerms, MAX_AT_ONCE, buildItems, itemProblem, resultLine, startItem } from '../authoriseMany.ts';
import type { CopiedFrom } from '../duplicate.ts';
import { recordHref } from '../proposalLinks.ts';
import { StatusLabel } from '../ui/StatusLabel.tsx';
import { useLeaveGuard } from '../ui/useLeaveGuard.ts';
import { Assignee, type Person } from './AuthoriseForm.tsx';
import { CopiedFromLabel } from './CopiedFromLabel.tsx';
import { QuarantineNote } from './ReportSecret.tsx';

export interface SeveralProposal extends ManyProposal {
  description: string | null;
  proposedBy: string;
  copiedFrom?: CopiedFrom;
  quarantineLabel?: string | null;
}
interface Draft { on: boolean; terms: ItemTerms }
type Edit = (id: string, change: (d: Draft) => Draft) => void;

/** One waiting action: its terms show once it is ticked. Drawn again only when it changes itself. */
const Item = memo(function Item({ proposal: p, draft, people, error, showNeeds, edit }: { proposal: SeveralProposal; draft: Draft; people: Person[]; error: string | undefined; showNeeds: boolean; edit: Edit }) {
  const terms = (change: Partial<ItemTerms>) => edit(p.id, (d) => ({ ...d, terms: { ...d.terms, ...change } }));
  const sub = (i: number, change: Partial<SubtaskTerms>) => edit(p.id, (d) => ({ ...d, terms: { ...d.terms, subtasks: d.terms.subtasks.map((x, j) => (j === i ? { ...x, ...change } : x)) } }));
  const needs = draft.on ? itemProblem(draft.terms) : null;
  return (
    <li className="many-item" id={`many-${p.id}`} tabIndex={-1}>
      <label className="check">
        <input type="checkbox" checked={draft.on} onChange={(e) => edit(p.id, (d) => ({ ...d, on: e.target.checked }))} />
        <strong>{p.text}</strong>
      </label>
      <QuarantineNote text={p.quarantineLabel} />
      <span className="meta">
        {p.copiedFrom ? <><CopiedFromLabel from={p.copiedFrom} />, by {p.proposedBy}</> : `Proposed by ${p.proposedBy}`}
        {p.owner ? ` · who: ${p.owner}` : ''}
        {p.due ? ` · by when: ${p.due}` : ''}
        {draft.terms.subtasks.length > 0 ? ` · ${draft.terms.subtasks.length} ${draft.terms.subtasks.length === 1 ? 'subtask' : 'subtasks'}` : ''}
      </span>
      {error && <p className="error">Not authorised: {error}</p>}
      {draft.on && (
        <>
          {p.description && <p className="task-description">{p.description}</p>}
          <div className="grid-2">
            <Assignee label="Assignee" people={people} value={draft.terms.assignee} onChange={(assignee) => terms({ assignee })} email={draft.terms.email} onEmail={(email) => terms({ email })} />
            <label>
              Due date
              <input type="date" required value={draft.terms.dueOn} onChange={(e) => terms({ dueOn: e.target.value })} />
            </label>
          </div>
          {draft.terms.subtasks.map((s, i) => (
            <fieldset key={i} className="subtask-row">
              <legend>Subtask {i + 1}</legend>
              <label className="check">
                <input type="checkbox" checked={s.on} onChange={(e) => sub(i, { on: e.target.checked })} /> Create “{s.title}”
              </label>
              {s.on && (
                <>
                  {s.description && <p className="task-description">{s.description}</p>}
                  <div className="grid-2">
                    <Assignee label="Assignee of the subtask" people={people} value={s.assignee} onChange={(assignee) => sub(i, { assignee })} email={s.email} onEmail={(email) => sub(i, { email })} />
                    <label>
                      Due date of the subtask
                      <input type="date" required value={s.dueOn} onChange={(e) => sub(i, { dueOn: e.target.value })} />
                    </label>
                  </div>
                </>
              )}
            </fieldset>
          ))}
          {showNeeds && needs && <p className="error">{needs}</p>}
        </>
      )}
    </li>
  );
});

/**
 * Authorises several waiting actions at once (D140), each with its own assignee and due date and each on its own: one
 * that is refused undoes none of the others, stays ticked with what was typed, and says why.
 */
export function AuthoriseSeveral({ projectId, proposals, people, onDone, onClose }: { projectId: string; proposals: SeveralProposal[]; people: Person[]; onDone: () => void; onClose: () => void }) {
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [results, setResults] = useState<Array<{ result: ManyResult; text: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const resultBox = useRef<HTMLDivElement>(null);

  const starts = useMemo(() => new Map(proposals.map((p) => [p.id, { on: false, terms: startItem(p, people) }])), [proposals, people]);
  const draftOf = (id: string): Draft => drafts[id] ?? (starts.get(id) as Draft);
  const startsRef = useRef(starts);
  startsRef.current = starts;
  const edit = useCallback<Edit>((id, change) => setDrafts((d) => ({ ...d, [id]: change(d[id] ?? (startsRef.current.get(id) as Draft)) })), []);
  const chooseAll = (on: boolean) => setDrafts((d) => ({ ...d, ...Object.fromEntries(proposals.map((p, i) => [p.id, { ...(d[p.id] ?? (starts.get(p.id) as Draft)), on: on && i < MAX_AT_ONCE }])) }));

  const chosen = proposals.filter((p) => draftOf(p.id).on);
  const waiting = chosen.filter((p) => itemProblem(draftOf(p.id).terms) !== null);
  useLeaveGuard(proposals.some((p) => drafts[p.id] !== undefined && drafts[p.id].on));
  useEffect(() => {
    if (results.length > 0) resultBox.current?.focus();
  }, [results]);

  async function submit() {
    setTried(true);
    setError(null);
    if (waiting.length > 0) {
      const first = document.getElementById(`many-${waiting[0].id}`);
      first?.scrollIntoView({ block: 'center' });
      first?.focus({ preventScroll: true });
      return;
    }
    setBusy(true);
    try {
      const titles = new Map(chosen.map((p) => [p.id, p.text]));
      const r = await api.post<{ results: ManyResult[] }>(`/projects/${projectId}/proposals/authorise-many`, { items: buildItems(chosen.map((p) => [p.id, draftOf(p.id).terms])) });
      setResults(r.results.map((result) => ({ result, text: titles.get(result.proposalId) ?? 'A proposal' })));
      const done = new Set(r.results.filter((x) => x.ok).map((x) => x.proposalId));
      setDrafts((d) => Object.fromEntries(Object.entries(d).filter(([id]) => !done.has(id))));
      setTried(false);
      onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That did not work. Try again.');
      onDone();
    } finally {
      setBusy(false);
    }
  }

  const failures = new Map(results.flatMap(({ result }) => (result.ok ? [] : [[result.proposalId, result.error] as const])));
  const ok = results.filter((r) => r.result.ok).length;
  return (
    <section className="box" aria-labelledby="several-heading">
      <h3 id="several-heading" className="box-title">Authorise several actions</h3>
      <p className="meta">Each ticked action needs its own assignee and due date. Each is authorised on its own: one that fails does not undo the others. Where the project needs more than one approval, they wait for the others first.</p>
      {results.length > 0 && (
        <div ref={resultBox} tabIndex={-1} role="status">
          <p><strong>{ok} of {results.length} accepted.</strong></p>
          <ul>
            {results.map(({ result, text }) => (
              <li key={result.proposalId}>
                <StatusLabel meaning={!result.ok ? 'failing' : 'waiting' in result ? 'review' : 'ok'} word={resultLine(result).word} />{' '}
                {result.ok && 'record' in result ? <a href={recordHref(projectId, result.record)}>{text}</a> : text}. {resultLine(result).detail}
              </li>
            ))}
          </ul>
        </div>
      )}
      {proposals.length === 0 ? (
        <p className="meta">No action from people is waiting.</p>
      ) : (
        <>
          <div className="dup-tools">
            <button type="button" onClick={() => chooseAll(true)}>{proposals.length > MAX_AT_ONCE ? `Select the first ${MAX_AT_ONCE}` : 'Select all'}</button>
            <button type="button" onClick={() => chooseAll(false)}>Select none</button>
            <span role="status">{chosen.length} of {proposals.length} chosen</span>
          </div>
          <ul className="plain">
            {proposals.map((p) => (
              <Item key={p.id} proposal={p} draft={draftOf(p.id)} people={people} error={failures.get(p.id)} showNeeds={tried} edit={edit} />
            ))}
          </ul>
        </>
      )}
      {error && <p role="alert" className="error">{error} What you typed is kept.</p>}
      {tried && waiting.length > 0 && <p role="alert" className="error">{waiting.length} of the chosen actions still {waiting.length === 1 ? 'needs' : 'need'} an assignee or a due date.</p>}
      {chosen.length > MAX_AT_ONCE && <p className="error">At most {MAX_AT_ONCE} can be authorised at once. Take out {chosen.length - MAX_AT_ONCE}.</p>}
      <div className="decision">
        <button type="button" className="primary" disabled={busy || chosen.length === 0 || chosen.length > MAX_AT_ONCE} onClick={() => void submit()}>
          {busy ? 'Working' : `Authorise ${chosen.length} ${chosen.length === 1 ? 'action' : 'actions'}`}
        </button>
        <button type="button" onClick={onClose}>Close</button>
      </div>
    </section>
  );
}
