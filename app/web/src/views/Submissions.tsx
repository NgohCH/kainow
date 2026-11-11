import { type FormEvent, useState } from 'react';
import { ApiError, type Membership } from '../api.ts';
import { go } from '../App.tsx';
import { meetingStartConfirmation, publishSubmission, returnSubmission } from '../discussion.ts';
import { AudienceChoice, namablePeople } from './AudiencePanel.tsx';
import { Intake } from './Intake.tsx';

const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong. Try again.');

/** A Member's route to getting notes into the project: they are held for a reviewer, who publishes or returns them. */
export function SubmitNotes({ projectId }: { projectId: string }) {
  const [intended, setIntended] = useState<'project' | 'restricted'>('project');
  return (
    <section className="panel" aria-label="Submit notes">
      <p className="hint">Submitted notes are seen only by you and the Project Manager, Deputies, Owner and Sponsors until one of them publishes them or returns them with a reason.</p>
      <label>
        Audience you suggest
        <select value={intended} onChange={(e) => setIntended(e.target.value as 'project' | 'restricted')}>
          <option value="project">Project-wide</option>
          <option value="restricted">Restricted</option>
        </select>
      </label>
      <Intake
        withTitle
        pasteUrl={`/projects/${projectId}/notes/submissions`}
        uploadUrl={`/projects/${projectId}/notes/submissions/upload`}
        submitLabel="Submit notes"
        extra={{ intendedMode: intended }}
        onDone={(r) => go(`#/notes/${r.id}`)}
      />
    </section>
  );
}

/** Publish (choosing the final audience, shown before confirming) or return (with a reason) a submission waiting for review. */
export function SubmissionReview({
  sourceId,
  kind,
  intendedMode,
  memberships,
  onDone,
}: {
  sourceId: string;
  /** Minutes submitted from a meeting keep the meeting's audience; submitted notes need one chosen. */
  kind: string;
  intendedMode: 'project' | 'restricted' | null;
  memberships: Membership[];
  onDone: () => void;
}) {
  const fromMeeting = kind === 'minutes';
  const [mode, setMode] = useState<'project' | 'restricted'>(intendedMode ?? 'project');
  const [named, setNamed] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  const [step, setStep] = useState<'choose' | 'publish' | 'return'>('choose');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function publish(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await publishSubmission(sourceId, fromMeeting ? undefined : { mode, namedUserIds: mode === 'project' ? [] : named });
      setNotice(r.notice ?? 'Published.');
      onDone();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  async function giveBack(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await returnSubmission(sourceId, reason);
      onDone();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel" aria-label="Review this submission">
      <h2>Review this submission</h2>
      <p className="meta">Only you, the person who submitted it and the other reviewers can see it until it is published.</p>
      {step === 'choose' && (
        <div className="actions">
          <button type="button" className="primary" onClick={() => setStep('publish')}>Publish</button>
          <button type="button" onClick={() => setStep('return')}>Return with a reason</button>
        </div>
      )}
      {step === 'publish' && (
        <form className="stack" onSubmit={publish}>
          {fromMeeting ? (
            <p>These minutes keep the meeting's audience.</p>
          ) : (
            <>
              <AudienceChoice legend="Publish to" mode={mode} named={named} candidates={namablePeople(memberships, [])} onMode={setMode} onNamed={setNamed} canRestrict />
              <p role="status">{meetingStartConfirmation(memberships, mode, named).replace('this meeting and its minutes', 'these notes')}</p>
            </>
          )}
          <span className="actions">
            <button className="primary" disabled={busy}>Publish</button>
            <button type="button" onClick={() => setStep('choose')}>Cancel</button>
          </span>
        </form>
      )}
      {step === 'return' && (
        <form className="stack" onSubmit={giveBack}>
          <label>
            Reason (shown to the person who submitted it)
            <input value={reason} onChange={(e) => setReason(e.target.value)} required maxLength={500} autoFocus />
          </label>
          <span className="actions">
            <button className="primary" disabled={busy || reason.trim() === ''}>Return</button>
            <button type="button" onClick={() => setStep('choose')}>Cancel</button>
          </span>
        </form>
      )}
      {error && <p role="alert" className="error">{error}</p>}
      {notice && <p role="status" className="meta">{notice}</p>}
    </section>
  );
}
