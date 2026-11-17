import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { ApiError, type Project, api } from '../api.ts';
import { type ItemKind, reportBody, reportProblems, reportSecret } from '../quarantine.ts';

const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'That did not work. Try again.');

/** What the person has selected on the page right now (empty when nothing, or when the selection is inside a form box). */
export function selectedPageText(): string {
  try {
    return window.getSelection()?.toString().trim() ?? '';
  } catch {
    return '';
  }
}

/**
 * "Report a suspected secret", offered on every item the person can read. The person selects the secret in the item
 * before pressing the button (it is picked up here) or pastes it; a reason is required. The marked text lives only in
 * this form's state: it is never shown again after sending and is cleared as soon as the server accepts the report.
 * The form is keyboard operable: focus moves into it when it opens, Escape closes it, and focus returns to the button.
 */
export function ReportSecret({
  projectId,
  kind,
  id,
  label,
  onReported,
}: {
  projectId: string;
  kind: ItemKind;
  id: string;
  /** What the button is about, for screen readers: `task “Order the pipes”`. */
  label: string;
  onReported?: () => void;
}) {
  const uid = useId();
  const [open, setOpen] = useState(false);
  const [marked, setMarked] = useState('');
  const [reason, setReason] = useState('');
  const [problems, setProblems] = useState<{ marked: string | null; reason: string | null }>({ marked: null, reason: null });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reported, setReported] = useState(false);
  const [holder, setHolder] = useState('');
  const [people, setPeople] = useState<Array<{ userId: string; displayName: string; email: string }>>([]);
  const button = useRef<HTMLButtonElement>(null);
  const markedBox = useRef<HTMLTextAreaElement>(null);
  const reasonBox = useRef<HTMLTextAreaElement>(null);
  const wasOpen = useRef(false);

  useEffect(() => {
    if (open) markedBox.current?.focus();
    else if (wasOpen.current) button.current?.focus();
    wasOpen.current = open;
  }, [open]);

  function show() {
    if (open) return close();
    // Picked up before focus moves: pressing a button does not change the page selection.
    setMarked(selectedPageText());
    setReported(false);
    setOpen(true);
    // The project's current people, for naming who holds the credential (optional).
    api.get<{ project: Project }>(`/projects/${projectId}`).then(
      (r) =>
        setPeople([
          ...new Map(r.project.memberships.filter((m) => m.state === 'active' || m.state === 'scheduled').map((m) => [m.userId, { userId: m.userId, displayName: m.displayName, email: m.email }])).values(),
        ]),
      () => setPeople([]),
    );
  }
  function close() {
    setOpen(false);
    setMarked('');
    setReason('');
    setHolder('');
    setProblems({ marked: null, reason: null });
    setError(null);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const p = reportProblems({ marked: [marked], reason });
    setProblems(p);
    setError(null);
    if (p.marked) return markedBox.current?.focus();
    if (p.reason) return reasonBox.current?.focus();
    setBusy(true);
    try {
      await reportSecret(projectId, { ...reportBody(kind, id, { marked: [marked], reason }), ...(holder ? { holderUserId: holder } : {}) });
      // The marked text is gone from this component the moment the server has it; nothing echoes it back.
      close();
      setReported(true);
      onReported?.();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" ref={button} className="link-button" aria-expanded={open} aria-label={`Report a suspected secret in ${label}`} onClick={show}>
        Report a suspected secret
      </button>
      {reported && (
        <p role="status" className="meta">
          Reported. The item is held while the text is removed from every copy, and the Administrators and the project's reviewers have been told.
        </p>
      )}
      {open && (
        <form
          className="panel stack delete-dialog"
          role="dialog"
          aria-modal="false"
          aria-labelledby={`${uid}-title`}
          noValidate
          onSubmit={submit}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              close();
            }
          }}
        >
          <h3 id={`${uid}-title`}>Report a suspected secret</h3>
          <p className="meta">
            Select the secret in the text before opening this form, or paste it here (at least 4 characters, exactly as it appears). The item is held at once and the text is removed from every copy.
            Kainow cannot recall copies already sent outside it.
          </p>
          <label htmlFor={`${uid}-marked`}>The secret text</label>
          <textarea
            id={`${uid}-marked`}
            ref={markedBox}
            rows={2}
            value={marked}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={problems.marked ? true : undefined}
            aria-describedby={problems.marked ? `${uid}-marked-problem` : undefined}
            onChange={(e) => setMarked(e.target.value)}
          />
          {problems.marked && <p id={`${uid}-marked-problem`} role="alert" className="error">{problems.marked}</p>}
          <label htmlFor={`${uid}-reason`}>Why you think it is a secret (1 to 1,000 characters; do not type the secret here)</label>
          <textarea
            id={`${uid}-reason`}
            ref={reasonBox}
            rows={3}
            value={reason}
            aria-invalid={problems.reason ? true : undefined}
            aria-describedby={problems.reason ? `${uid}-reason-problem` : undefined}
            onChange={(e) => setReason(e.target.value)}
          />
          {problems.reason && <p id={`${uid}-reason-problem`} role="alert" className="error">{problems.reason}</p>}
          <label htmlFor={`${uid}-holder`}>Who holds this credential? (optional)</label>
          <select id={`${uid}-holder`} value={holder} onChange={(e) => setHolder(e.target.value)} aria-describedby={`${uid}-holder-help`}>
            <option value="">Not named</option>
            {people.map((p) => (
              <option key={p.userId} value={p.userId}>{p.displayName} ({p.email})</option>
            ))}
          </select>
          <p id={`${uid}-holder-help`} className="meta">The person named is told at once, so they can revoke or rotate it.</p>
          {error && <p role="alert" className="error">{error}</p>}
          <div className="decision">
            <button className="primary" disabled={busy} aria-disabled={busy}>Report and hold</button>
            <button type="button" onClick={close}>Cancel</button>
          </div>
        </form>
      )}
    </>
  );
}

/** A record's quarantine line (`Credential removed — under review`, when it has one) and its Report a suspected secret button. */
export function QuarantineBar({
  projectId,
  kind,
  id,
  label,
  quarantineLabel,
  onReported,
}: {
  projectId: string;
  kind: ItemKind;
  id: string;
  label: string;
  quarantineLabel?: string | null;
  onReported?: () => void;
}) {
  return (
    <>
      {quarantineLabel && <p className="warn" role="note">{quarantineLabel}</p>}
      <div className="decision">
        <ReportSecret projectId={projectId} kind={kind} id={id} label={label} onReported={onReported} />
      </div>
    </>
  );
}
