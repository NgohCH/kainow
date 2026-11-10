import { useEffect, useRef, useState } from 'react';
import { ApiError, api } from '../api.ts';
import { formatWhen, plural } from '../format.ts';

const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'That did not work. Try again.');

interface DigestPreview { recipients: number; asAt: string; subject: string; body: string }

/**
 * Project Manager, Owner or Sponsor of an Active project: preview the action-item email, then confirm. `onSent` tells
 * the page the emails are queued, so its Email delivery list reloads.
 */
export function DigestSend({ projectId, onSent }: { projectId: string; onSent?: () => void }) {
  const [preview, setPreview] = useState<DigestPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const start = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (preview) panel.current?.focus();
  }, [preview]);

  async function show() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setPreview(await api.get<DigestPreview>(`/projects/${projectId}/digest/preview`));
    } catch (e) {
      setError(errText(e)); // includes "Nothing to send: no open tasks"
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ digestRunId: string; recipients: number }>(`/projects/${projectId}/digest`);
      setPreview(null);
      setResult(`Queued for ${plural(r.recipients, 'person', 'people')}. You can follow it under Email delivery.`);
      onSent?.();
      setTimeout(() => start.current?.focus(), 0);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="digest-heading">
      <h2 id="digest-heading">Action-item email</h2>
      <p className="meta">Send everyone on the project a list of their open tasks and the other open tasks, now.</p>
      {error && <p role="alert" className="error">{error}</p>}
      {result && <p role="status" className="ok">{result}</p>}
      {!preview && (
        <button ref={start} type="button" className="primary" disabled={busy} onClick={() => void show()}>
          Send action-item email
        </button>
      )}
      {preview && (
        <div ref={panel} tabIndex={-1} className="panel stack" role="region" aria-label="Action-item email preview">
          <dl className="facts">
            <div><dt>Subject</dt><dd>{preview.subject}</dd></div>
            <div><dt>Goes to</dt><dd>{plural(preview.recipients, 'person', 'people')}</dd></div>
            <div><dt>As at</dt><dd>{formatWhen(preview.asAt)} (UTC+8)</dd></div>
          </dl>
          <p className="meta">This is your copy. Each person gets their own open tasks first.</p>
          <pre className="email-body">{preview.body}</pre>
          <div className="decision">
            <button type="button" className="primary" disabled={busy} onClick={() => void confirm()}>Confirm and send</button>
            <button type="button" onClick={() => { setPreview(null); setTimeout(() => start.current?.focus(), 0); }}>Cancel</button>
          </div>
        </div>
      )}
    </section>
  );
}

interface Flag { taskId: string; title: string; dueOn: string }

/** Tasks whose escalation has nobody else to go to. Shown to anyone who can read the project. */
export function EscalationFlags({ projectId }: { projectId: string }) {
  const [flags, setFlags] = useState<Flag[]>([]);
  useEffect(() => {
    api.get<Flag[]>(`/projects/${projectId}/escalation-flags`).then(setFlags, () => setFlags([]));
  }, [projectId]);
  if (flags.length === 0) return null;
  return (
    <section className="warn flag-panel" role="status" aria-label="No independent escalation recipient">
      <strong>No independent escalation recipient</strong>
      <ul className="plain">
        {flags.map((f) => (
          <li key={f.taskId}>
            <a href={`#/projects/${projectId}/work/${f.taskId}`}>{f.title}</a> · due {f.dueOn}
          </li>
        ))}
      </ul>
    </section>
  );
}
