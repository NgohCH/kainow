import { type FormEvent, useEffect, useState } from 'react';
import { ApiError, type Membership } from '../api.ts';
import { go } from '../App.tsx';
import { type DiscussionItem, itemHref, KIND_TAG, listDiscussion, pollDelay, restrictedLabel, startThread, threadPath } from '../discussion.ts';
import { formatWhen, plural } from '../format.ts';
import { Intake } from './Intake.tsx';
import { StartMeetingForm } from './Meeting.tsx';
import { SubmitNotes } from './Submissions.tsx';

/** The Notes & discussion tab: threads, meetings, notes and published minutes of one project, newest activity first. */
export function Discussion({
  projectId,
  canAdd,
  canSubmit,
  canStart,
  canRestrict,
  memberships,
}: {
  projectId: string;
  /** Project Manager, Deputy, Owner or Sponsor: notes are imported straight away. */
  canAdd: boolean;
  /** A Member: notes are submitted for a reviewer to publish. */
  canSubmit: boolean;
  canStart: boolean;
  /** May start a Restricted meeting. */
  canRestrict: boolean;
  memberships: Membership[];
}) {
  const [items, setItems] = useState<DiscussionItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [starting, setStarting] = useState(false);
  const [meeting, setMeeting] = useState(false);
  const [title, setTitle] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The list refreshes every 30 seconds (spec 9).
  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;
    const load = () => {
      listDiscussion(projectId).then(
        (r) => {
          if (stopped) return;
          setItems(r);
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
  }, [projectId]);

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
        <h2 id="discussion-heading">Notes &amp; discussion</h2>
        <span className="actions">
          {canStart && (
            <button className="primary" onClick={() => { setStarting((s) => !s); setAdding(false); setMeeting(false); }} aria-expanded={starting}>
              {starting ? 'Close' : 'New thread'}
            </button>
          )}
          {canStart && (
            <button onClick={() => { setMeeting((m) => !m); setAdding(false); setStarting(false); }} aria-expanded={meeting}>
              {meeting ? 'Close' : 'Start meeting'}
            </button>
          )}
          {(canAdd || canSubmit) && (
            <button onClick={() => { setAdding((a) => !a); setStarting(false); setMeeting(false); }} aria-expanded={adding}>
              {adding ? 'Close' : canAdd ? 'Add notes' : 'Submit notes'}
            </button>
          )}
        </span>
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
      {adding && !canAdd && <SubmitNotes projectId={projectId} />}
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
      {error && <p role="alert" className="error">{error}</p>}
      {items === null && !error && <p className="loading">Loading</p>}
      {items?.length === 0 && !adding && !starting && !meeting && (
        <p className="empty">
          Nothing here yet.{' '}
          {canStart ? 'Start a thread to talk something through, or add the notes from a meeting.' : 'Threads, meetings and notes appear here when someone adds them.'}
        </p>
      )}
      {items && items.length > 0 && (
        <ul className="list">
          {items.map((i) => (
            <li key={`${i.kind}:${i.id}`}>
              <a href={itemHref(projectId, i)}>
                <strong>{i.title}</strong>
                <span className="meta">
                  {KIND_TAG[i.kind]}
                  {i.label ? ` · ${i.label}` : ''}
                  {' · '}
                  {restrictedLabel(i.audienceMode) ?? 'Project-wide'}
                  {i.kind === 'meeting' && i.meetingDate ? ` · ${i.meetingDate}` : ''}
                  {i.kind === 'meeting' && i.state === 'ended' ? ' · Ended' : ''}
                  {i.messageCount !== null ? ` · ${plural(i.messageCount, 'message')}` : ''}
                  {' · '}
                  {formatWhen(i.lastActivityAt)}
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
