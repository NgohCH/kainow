import { type FormEvent, useState } from 'react';
import { ApiError, type Membership } from '../api.ts';
import { go } from '../App.tsx';
import { todayUtc8 } from '../changes.ts';
import { endMeeting, meetingStartConfirmation, presentCandidates, setPresent, startMeeting, type ThreadView, threadPath } from '../discussion.ts';
import { AudienceChoice, AudiencePanel, namablePeople } from './AudiencePanel.tsx';

const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong. Try again.');

/** The meeting's Present list, End meeting, and the audience panel. */
export function MeetingControls({
  thread,
  memberships,
  canEnd,
  canChangeAudience,
  onThread,
  onAudienceChanged,
}: {
  thread: ThreadView;
  memberships: Membership[];
  canEnd: boolean;
  canChangeAudience: boolean;
  onThread: (t: ThreadView) => void;
  onAudienceChanged: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const ended = thread.state === 'ended';
  const candidates = presentCandidates(memberships, thread.audience);
  const present = thread.present.map((p) => p.id);

  async function toggle(id: string, on: boolean) {
    setBusy(true);
    setError(null);
    try {
      const next = on ? [...present, id] : present.filter((x) => x !== id);
      const people = await setPresent(thread.id, next);
      onThread({ ...thread, present: people });
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  async function end() {
    setBusy(true);
    setError(null);
    try {
      onThread(await endMeeting(thread.id));
      setConfirmEnd(false);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <fieldset className="present" disabled={ended || !thread.canPost || busy}>
        <legend>Present</legend>
        {candidates.length === 0 && <p className="meta">No one to mark present.</p>}
        <div className="present-list">
          {candidates.map((p) => (
            <label key={p.id} className="check">
              <input type="checkbox" checked={present.includes(p.id)} onChange={(e) => void toggle(p.id, e.target.checked)} /> {p.displayName}
            </label>
          ))}
        </div>
        {!ended && !thread.canPost && <p className="meta">You can read this meeting but not change who is present.</p>}
      </fieldset>
      {canEnd && !ended && !confirmEnd && <button type="button" onClick={() => setConfirmEnd(true)}>End meeting</button>}
      {canEnd && !ended && confirmEnd && (
        <div className="panel" role="group" aria-label="Confirm ending the meeting">
          <p>End this meeting? No more messages, edits or changes to who is present can be made, and a final draft of the minutes is requested. A meeting is not reopened.</p>
          <span className="actions">
            <button type="button" className="primary" disabled={busy} onClick={() => void end()}>End meeting</button>
            <button type="button" onClick={() => setConfirmEnd(false)}>Cancel</button>
          </span>
        </div>
      )}
      {error && <p role="alert" className="error">{error}</p>}
      <AudiencePanel audience={thread.audience} memberships={memberships} canChange={canChangeAudience} onChanged={onAudienceChanged} />
    </>
  );
}

/** Title, date (today in UTC+8 by default) and audience; for Restricted the confirmation lists exactly who will be able to read. */
export function StartMeetingForm({ projectId, memberships, canRestrict }: { projectId: string; memberships: Membership[]; canRestrict: boolean }) {
  const [title, setTitle] = useState('');
  const [date, setDate] = useState(todayUtc8());
  const [mode, setMode] = useState<'project' | 'restricted'>('project');
  const [named, setNamed] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function start(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const t = await startMeeting(projectId, { title, meetingDate: date, audience: { mode, namedUserIds: mode === 'project' ? [] : named } });
      go(threadPath(projectId, t.id));
    } catch (err) {
      setError(errText(err));
      setBusy(false);
    }
  }

  return (
    <section className="panel" aria-label="Start meeting">
      <form className="stack" onSubmit={start}>
        <label>
          Title
          <input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} autoFocus />
        </label>
        <label>
          Meeting date
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
        </label>
        <AudienceChoice
          legend="Who can read"
          mode={mode}
          named={named}
          candidates={namablePeople(memberships, [])}
          onMode={setMode}
          onNamed={setNamed}
          canRestrict={canRestrict}
        />
        <p role="status" className="meta">{meetingStartConfirmation(memberships, mode, named)}</p>
        {error && <p role="alert" className="error">{error}</p>}
        <button className="primary" disabled={busy || title.trim() === ''}>Start meeting</button>
      </form>
    </section>
  );
}
