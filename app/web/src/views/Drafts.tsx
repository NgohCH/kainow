import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { ApiError } from '../api.ts';
import {
  createDraft,
  DRAFT_POLL_MS,
  type DraftListItem,
  type DraftStatus,
  emptyDraftForm,
  isRecordKind,
  listDrafts,
  MAX_BRIEF,
  MAX_CHOSEN,
  MAX_TITLE,
  newDraftBody,
  newDraftProblem,
  type NewDraftForm,
  REPORT_KINDS,
  type ReportKind,
} from '../assist.ts';
import { type DiscussionItem, listDiscussion } from '../discussion.ts';
import { formatWhen } from '../format.ts';
import { DraftDetail } from './DraftView.tsx';
import { AiSettingsLink } from './AiLink.tsx';
import { QuarantineNote } from './ReportSecret.tsx';
import { DataTable, type Column } from '../ui/DataTable.tsx';
import { StatusLabel } from '../ui/StatusLabel.tsx';
import type { Meaning } from '../ui/meanings.ts';

const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong. Try again.');
const STATUS_TEXT: Record<DraftStatus, string> = { queued: 'Waiting to start', running: 'Being drafted', ready: 'Ready', failed: 'AI draft unavailable', blocked: 'AI draft unavailable' };
const STATUS_MEANING: Record<DraftStatus, Meaning> = { queued: 'planned', running: 'active', ready: 'ok', failed: 'failing', blocked: 'failing' };

export const draftPath = (projectId: string, id: string) => `#/projects/${projectId}/drafts/${id}`;

/** The Drafts tab: the project's drafts you can see, a form for a new one, or one draft when an id is in the address. */
export function Drafts({ projectId, draftId }: { projectId: string; draftId?: string }) {
  if (draftId) return <DraftDetail key={draftId} projectId={projectId} draftId={draftId} />;
  return <DraftList projectId={projectId} />;
}

function DraftList({ projectId }: { projectId: string }) {
  const [items, setItems] = useState<DraftListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      setItems(await listDrafts(projectId));
      setError(null);
    } catch (e) {
      setError(errText(e));
    }
  }, [projectId]);
  useEffect(() => void load(), [load]);

  const active = (items ?? []).some((d) => d.status === 'queued' || d.status === 'running');
  useEffect(() => {
    if (!active) return;
    const timer = window.setTimeout(() => void load().finally(() => setTick((n) => n + 1)), DRAFT_POLL_MS);
    return () => window.clearTimeout(timer);
  }, [active, tick, load]);

  const columns: Column<DraftListItem>[] = [
    {
      key: 'title',
      header: 'Draft',
      sortValue: (d) => d.title.toLowerCase(),
      cell: (d) => (
        <span>
          <span className="ai-label">AI draft</span> <a href={draftPath(projectId, d.id)}>{d.title}</a>
          <span className="meta work-parent">{d.kindLabel}</span>
        </span>
      ),
    },
    {
      key: 'state',
      header: 'State',
      sortValue: (d) => STATUS_TEXT[d.status],
      cell: (d) => (
        <div className="label-stack" role={d.status === 'queued' || d.status === 'running' ? 'status' : undefined}>
          <StatusLabel meaning={STATUS_MEANING[d.status]} word={d.notice ?? STATUS_TEXT[d.status]} />
          {d.shared && <StatusLabel meaning={d.inReview ? 'review' : 'active'} word={d.inReview ? 'Shared, waiting for review' : 'Shared'} />}
          <QuarantineNote text={d.quarantineLabel} />
        </div>
      ),
    },
    { key: 'requested', header: 'Requested by', sortValue: (d) => d.requestedBy.displayName.toLowerCase(), cell: (d) => d.requestedBy.displayName },
    { key: 'updated', header: 'Updated', sortValue: (d) => d.updatedAt, cell: (d) => formatWhen(d.updatedAt) },
    { key: 'versions', header: 'Versions', sortValue: (d) => d.versionCount, cell: (d) => String(d.versionCount) },
  ];

  return (
    <section aria-labelledby="drafts-heading" className="box">
      <div className="settings-box-head">
        <h2 id="drafts-heading" className="box-title">Drafts</h2>
        <button type="button" aria-expanded={creating} onClick={() => setCreating((v) => !v)}>{creating ? 'Close the form' : 'New draft'}</button>
      </div>
      <p className="meta">Reports and specifications written by AI from this project. Each one is an AI draft, not approved.</p>
      {creating && <NewDraftFormView projectId={projectId} onDone={() => setCreating(false)} />}
      {error && <p role="alert" className="error">{error}</p>}
      <AiSettingsLink projectId={projectId} show={!!items?.some((d) => d.status === 'blocked')} />
      <DataTable caption="Drafts in this project you can see" columns={columns} rows={items ?? []} rowKey={(d) => d.id} loading={items === null && !error} empty="There are no drafts yet." />
    </section>
  );
}

function NewDraftFormView({ projectId, onDone }: { projectId: string; onDone: () => void }) {
  const [form, setForm] = useState<NewDraftForm>(() => emptyDraftForm('status'));
  const [notes, setNotes] = useState<DiscussionItem[]>([]);
  const [threads, setThreads] = useState<DiscussionItem[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const record = isRecordKind(form.kind);

  useEffect(() => {
    listDiscussion(projectId).then(
      (all) => {
        setNotes(all.filter((i) => i.kind === 'notes' || i.kind === 'minutes'));
        setThreads(all.filter((i) => i.kind === 'discussion' || i.kind === 'meeting'));
      },
      () => undefined,
    );
  }, [projectId]);

  const set = (patch: Partial<NewDraftForm>) => {
    setForm((f) => ({ ...f, ...patch }));
    setProblem(null);
  };
  const changeKind = (kind: ReportKind) => {
    // A new kind restarts the period and the choices, but keeps the words typed.
    setForm((f) => ({ ...emptyDraftForm(kind), title: f.title, brief: f.brief }));
    setProblem(null);
  };
  const toggle = (key: 'sourceIds' | 'threadIds', id: string) =>
    set({ [key]: form[key].includes(id) ? form[key].filter((x) => x !== id) : [...form[key], id] } as Partial<NewDraftForm>);
  const chosen = form.sourceIds.length + form.threadIds.length;

  async function send(e: FormEvent) {
    e.preventDefault();
    const p = newDraftProblem(form);
    setProblem(p);
    if (p) return;
    setSending(true);
    setError(null);
    try {
      const d = await createDraft(projectId, newDraftBody(form));
      onDone();
      window.location.hash = draftPath(projectId, d.id);
    } catch (err) {
      setError(errText(err));
    } finally {
      setSending(false);
    }
  }

  return (
    <form className="box stack change-form" onSubmit={send} noValidate aria-label="New draft">
      <p className="form-box-title">New draft</p>
      <p className="meta">AI writes it from what you choose. It is an AI draft, not approved, and opens here when it is ready.</p>
      <label>
        Kind of draft
        <select value={form.kind} onChange={(e) => changeKind(e.target.value as ReportKind)}>
          {REPORT_KINDS.map((k) => (
            <option key={k.value} value={k.value}>{k.label}</option>
          ))}
        </select>
      </label>
      <label>
        Title{form.kind === 'free_form' ? '' : ' (optional)'}
        <input value={form.title} onChange={(e) => set({ title: e.target.value })} aria-describedby="draft-title-count" />
      </label>
      <span id="draft-title-count" className="hint">{form.title.trim().length} / {MAX_TITLE}{form.kind === 'free_form' ? ' (1 to 200 characters)' : ''}</span>
      {!record && (
        <>
          <label>
            Brief{form.kind === 'free_form' ? '' : ' (optional)'}
            <textarea rows={4} value={form.brief} onChange={(e) => set({ brief: e.target.value })} aria-describedby="draft-brief-count" />
          </label>
          <span id="draft-brief-count" className="hint">
            {form.brief.trim().length} / {MAX_BRIEF.toLocaleString('en')}{form.kind === 'free_form' ? ' (1 to 2,000 characters)' : ''}. Do not paste passwords or keys.
          </span>
        </>
      )}
      <fieldset>
        <legend>Period{record ? '' : ' (optional)'}</legend>
        <label>
          From
          <input type="date" value={form.periodFrom} onChange={(e) => set({ periodFrom: e.target.value })} />
        </label>
        <label>
          To
          <input type="date" value={form.periodTo} onChange={(e) => set({ periodTo: e.target.value })} />
        </label>
        <span className="hint">{record ? 'Starts as the last 14 days (UTC+8).' : 'Leave both empty to use what you chose, whatever its date.'}</span>
      </fieldset>
      {!record && (
        <fieldset aria-describedby="draft-chosen-count">
          <legend>Choose 1 to {MAX_CHOSEN} sources or threads</legend>
          {notes.length === 0 && threads.length === 0 && <p className="empty">There are no notes or threads you can use.</p>}
          {notes.map((n) => (
            <label key={n.id} className="check">
              <input type="checkbox" checked={form.sourceIds.includes(n.id)} onChange={() => toggle('sourceIds', n.id)} /> {n.kind === 'minutes' ? 'Minutes' : 'Notes'}: {n.title}
            </label>
          ))}
          {threads.map((t) => (
            <label key={t.id} className="check">
              <input type="checkbox" checked={form.threadIds.includes(t.id)} onChange={() => toggle('threadIds', t.id)} /> {t.kind === 'meeting' ? 'Meeting' : 'Discussion'}: {t.title}
            </label>
          ))}
          <span id="draft-chosen-count" className="hint">{chosen} chosen (1 to {MAX_CHOSEN})</span>
        </fieldset>
      )}
      {problem && <p role="alert" className="error">{problem}</p>}
      {error && <p role="alert" className="error">{error}</p>}
      <div className="actions">
        <button className="primary" disabled={sending}>{sending ? 'Sending' : 'Draft it'}</button>
        <button type="button" onClick={onDone}>Cancel</button>
      </div>
    </form>
  );
}
