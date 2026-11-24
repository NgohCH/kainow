import { type FormEvent, useEffect, useRef, useState } from 'react';
import { ApiError, type Membership } from '../api.ts';
import { go } from '../App.tsx';
import { type DiscussionItem, itemHref, formatMeetingDate, listDiscussion, listTag, pollDelay, restrictedLabel, startThread, threadPath } from '../discussion.ts';
import { formatWhen, plural } from '../format.ts';
import { Intake } from './Intake.tsx';
import { StartMeetingForm } from './Meeting.tsx';
import { QuarantineNote } from './ReportSecret.tsx';
import { SubmitNotes } from './Submissions.tsx';

type Kinds = ReadonlyArray<DiscussionItem['kind']>;
const THREAD_KINDS: Kinds = ['discussion', 'meeting'];
const NOTE_KINDS: Kinds = ['notes', 'minutes', 'submission'];

/** The project's discussion items of some kinds, newest activity first; the list refreshes every 30 seconds (spec 9). */
function useItems(projectId: string, kinds: Kinds) {
  const [items, setItems] = useState<DiscussionItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;
    const load = () => {
      listDiscussion(projectId).then(
        (r) => {
          if (stopped) return;
          setItems(r.filter((i) => kinds.includes(i.kind)));
          setError(null);
          timer = window.setTimeout(load, pollDelay(false));
        },
        (e: Error) => {
          if (stopped) return;
          setError(e.message);
          timer = window.setTimeout(load, pollDelay(false));
        },
      );
    };
    load();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [projectId, kinds]);
  return { items, error };
}

function ItemList({ projectId, items }: { projectId: string; items: DiscussionItem[] }) {
  return (
    <ul className="list">
      {items.map((i) => (
        <li key={`${i.kind}:${i.id}`}>
          <a href={itemHref(projectId, i)}>
            <strong>{i.title}</strong>
            <span className="meta">
              {listTag(i.kind, i.label)}
              {' · '}
              {restrictedLabel(i.audienceMode) ?? 'Project-wide'}
              {i.kind === 'meeting' && i.meetingDate ? ` · ${formatMeetingDate(i.meetingDate)}` : ''}
              {i.kind === 'meeting' && i.state === 'ended' ? ' · Ended' : ''}
              {i.messageCount !== null ? ` · ${plural(i.messageCount, 'message')}` : ''}
              {' · '}
              {formatWhen(i.lastActivityAt)}
            </span>
          </a>
          <QuarantineNote text={i.quarantineLabel} />
        </li>
      ))}
    </ul>
  );
}

/** The Discussion tab: the project's threads and meetings, newest activity first. */
export function Discussion({
  projectId,
  canStart,
  canRestrict,
  memberships,
}: {
  projectId: string;
  canStart: boolean;
  /** May start a Restricted meeting. */
  canRestrict: boolean;
  memberships: Membership[];
}) {
  const { items, error } = useItems(projectId, THREAD_KINDS);
  const [starting, setStarting] = useState(false);
  const [meeting, setMeeting] = useState(false);
  const [title, setTitle] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function start(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setFormError(null);
    try {
      const t = await startThread(projectId, title);
      go(threadPath(projectId, t.id));
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.');
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="discussion-heading">
      <div className="row">
        <h2 id="discussion-heading">Discussion</h2>
        {canStart && (
          <span className="actions">
            <button className="primary" onClick={() => { setStarting((s) => !s); setMeeting(false); }} aria-expanded={starting}>
              {starting ? 'Close' : 'New thread'}
            </button>
            <button onClick={() => { setMeeting((m) => !m); setStarting(false); }} aria-expanded={meeting}>
              {meeting ? 'Close' : 'Start meeting'}
            </button>
          </span>
        )}
      </div>
      {starting && (
        <section className="panel" aria-label="New thread">
          <form className="stack" onSubmit={start}>
            <label>
              Title
              <input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} autoFocus />
              <span className="hint">Everyone in the project can read and write in a thread.</span>
            </label>
            {formError && <p role="alert" className="error">{formError}</p>}
            <button className="primary" disabled={busy}>Start thread</button>
          </form>
        </section>
      )}
      {meeting && <StartMeetingForm projectId={projectId} memberships={memberships} canRestrict={canRestrict} />}
      {error && <p role="alert" className="error">{error}</p>}
      {items === null && !error && <p className="loading">Loading</p>}
      {items?.length === 0 && !starting && !meeting && (
        <p className="empty">
          No threads or meetings yet.{' '}
          {canStart ? 'Start a thread to talk something through, or start a meeting.' : 'Threads and meetings appear here when someone starts one.'}
        </p>
      )}
      {items && items.length > 0 && <ItemList projectId={projectId} items={items} />}
    </section>
  );
}

/** The Notes tab: notes people supplied, published minutes and submitted notes; each opens with its versions. */
export function Notes({
  projectId,
  canAdd,
  canSubmit,
  addRequest = 0,
}: {
  projectId: string;
  /** Project Manager, Deputy, Owner or Sponsor: notes are imported straight away. */
  canAdd: boolean;
  /** A Member: notes are submitted for a reviewer to publish. */
  canSubmit: boolean;
  /** Goes up each time "Add notes" is chosen in the project header: the form opens with focus in it. */
  addRequest?: number;
}) {
  const { items, error } = useItems(projectId, NOTE_KINDS);
  const [adding, setAdding] = useState(addRequest > 0);
  const form = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (addRequest > 0) setAdding(true);
  }, [addRequest]);
  // Chosen from the header: the form is open and its first field has focus.
  useEffect(() => {
    if (addRequest > 0 && adding) form.current?.querySelector<HTMLElement>('select, input, textarea')?.focus();
  }, [addRequest, adding]);

  return (
    <section aria-labelledby="notes-heading">
      <div className="row">
        <h2 id="notes-heading">Notes</h2>
        {(canAdd || canSubmit) && (
          <span className="actions">
            <button className="primary" onClick={() => setAdding((a) => !a)} aria-expanded={adding}>
              {adding ? 'Close' : canAdd ? 'Add notes' : 'Submit notes'}
            </button>
          </span>
        )}
      </div>
      <div ref={form}>
      {adding && canSubmit && !canAdd && <SubmitNotes projectId={projectId} />}
      {adding && canAdd && (
        <section className="panel" aria-label="Add notes">
          <Intake
            withTitle
            pasteUrl={`/projects/${projectId}/notes`}
            uploadUrl={`/projects/${projectId}/notes/upload`}
            submitLabel="Add notes"
            onDone={(r) => go(`#/notes/${r.source.id}`)}
          />
        </section>
      )}
      </div>
      {error && <p role="alert" className="error">{error}</p>}
      {items === null && !error && <p className="loading">Loading</p>}
      {items?.length === 0 && !adding && (
        <p className="empty">
          No notes yet.{' '}
          {canAdd || canSubmit ? 'Add the notes from a meeting, or the minutes, to keep them with the project.' : 'Notes and minutes appear here when someone adds them.'}
        </p>
      )}
      {items && items.length > 0 && <ItemList projectId={projectId} items={items} />}
    </section>
  );
}
