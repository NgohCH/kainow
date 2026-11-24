import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { ApiError, type Project } from '../api.ts';
import {
  type RecordKind,
  type SourceKind,
  delegateDeletion,
  delegationLabel,
  deleteItem,
  mayDelegateDeletion,
  reasonProblem,
  restoreDialogView,
  restoreItem,
  restorePreview,
  revokeDeletionDelegation,
} from '../history.ts';
import { formatDay } from '../format.ts';
import type { Act } from './ProjectAccessPanels.tsx';
import { StatusLabel } from '../ui/StatusLabel.tsx';

const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'That did not work. Try again.');

/**
 * A reason box with a confirm button, shown under the button that opened it. Keyboard operable: focus moves to the
 * reason when it opens, Escape closes it, and focus goes back to the opening button. The confirm button stays enabled;
 * leaving the reason empty shows the problem instead of silently doing nothing.
 */
export function ReasonDialog({
  title,
  confirm,
  onConfirm,
  onClose,
  canConfirm = true,
  children,
}: {
  title: string;
  confirm: string;
  onConfirm: (reason: string) => Promise<void>;
  onClose: () => void;
  canConfirm?: boolean;
  children?: React.ReactNode;
}) {
  const id = useId();
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => box.current?.focus(), []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || !canConfirm) return;
    const p = reasonProblem(reason);
    setProblem(p);
    setError(null);
    if (p) return box.current?.focus();
    setBusy(true);
    try {
      await onConfirm(reason.trim());
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="box stack delete-dialog change-form"
      role="dialog"
      aria-modal="false"
      aria-labelledby={`${id}-title`}
      noValidate
      onSubmit={submit}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <h3 id={`${id}-title`}>{title}</h3>
      {children}
      <label htmlFor={`${id}-reason`}>Reason (1 to 1,000 characters)</label>
      <textarea
        id={`${id}-reason`}
        ref={box}
        rows={3}
        value={reason}
        aria-invalid={problem ? true : undefined}
        aria-describedby={problem ? `${id}-problem` : undefined}
        onChange={(e) => setReason(e.target.value)}
      />
      {problem && <p id={`${id}-problem`} role="alert" className="error">{problem}</p>}
      {error && <p role="alert" className="error">{error}</p>}
      <div className="decision">
        <button className="primary" disabled={busy || !canConfirm} aria-disabled={busy || !canConfirm}>{confirm}</button>
        <button type="button" onClick={onClose}>Cancel</button>
      </div>
    </form>
  );
}

/** A button that opens a dialog below it; focus returns to the button when the dialog closes. */
function useOpener() {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const was = useRef(false);
  useEffect(() => {
    if (was.current && !open) button.current?.focus();
    was.current = open;
  }, [open]);
  return { open, setOpen, button };
}

/** Delete on a source or a record: asks for a reason, then reports what the server says. */
export function DeleteAction({
  kind,
  id,
  label,
  onDone,
}: {
  kind: SourceKind | RecordKind;
  id: string;
  /** What the button is about, for screen readers: `task “Order the pipes”`. */
  label: string;
  onDone: (message: string) => void;
}) {
  const { open, setOpen, button } = useOpener();
  return (
    <>
      <button type="button" ref={button} className="link-button" aria-expanded={open} aria-label={`Delete ${label}`} onClick={() => setOpen((o) => !o)}>
        Delete
      </button>
      {open && (
        <ReasonDialog
          title={`Delete this ${kind === 'minutes' ? 'set of minutes' : kind}`}
          confirm="Delete"
          onClose={() => setOpen(false)}
          onConfirm={async (reason) => {
            await deleteItem(kind, id, reason);
            setOpen(false);
            onDone('Deleted. It can be restored by the people who may restore it, and its deletion stays in the project history.');
          }}
        >
          <p className="meta">The reason is kept in the project history. Nothing is erased: the item is hidden and can be restored.</p>
        </ReasonDialog>
      )}
    </>
  );
}

/** Restore: shows who will be able to see the item again, and only then asks for a reason. */
export function RestoreAction({
  kind,
  id,
  label,
  onDone,
}: {
  kind: SourceKind | RecordKind;
  id: string;
  label: string;
  onDone: (message: string) => void;
}) {
  const { open, setOpen, button } = useOpener();
  const [names, setNames] = useState<string[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    let live = true;
    setNames(null);
    setLoadError(null);
    restorePreview(kind, id).then(
      (n) => live && setNames(n),
      (e) => live && setLoadError(errText(e)),
    );
    return () => {
      live = false;
    };
  }, [open, kind, id]);
  const view = restoreDialogView(names);
  return (
    <>
      <button type="button" ref={button} className="link-button" aria-expanded={open} aria-label={`Restore ${label}`} onClick={() => setOpen((o) => !o)}>
        Restore
      </button>
      {open && (
        <ReasonDialog
          title={`Restore this ${kind === 'minutes' ? 'set of minutes' : kind}`}
          confirm="Restore"
          canConfirm={view.canConfirm}
          onClose={() => setOpen(false)}
          onConfirm={async (reason) => {
            await restoreItem(kind, id, reason);
            setOpen(false);
            onDone('Restored. Nothing was started, sent or changed because of it.');
          }}
        >
          <div aria-live="polite">
            {loadError ? (
              <p role="alert" className="error">{loadError}</p>
            ) : names === null ? (
              <p className="meta">Checking who will be able to see it</p>
            ) : (
              <>
                <p><strong>{view.intro}</strong></p>
                {view.empty ? (
                  <p className="meta">{view.empty}</p>
                ) : (
                  <ul className="plain">
                    {view.names.map((n) => <li key={n}>{n}</li>)}
                  </ul>
                )}
              </>
            )}
          </div>
        </ReasonDialog>
      )}
    </>
  );
}

/**
 * Record deletion delegation (D83). Everyone in the project sees who it is delegated to; an Owner or Sponsor can allow the
 * Project Manager to delete and restore authorised records, or take that back, each with a reason.
 */
export function DeletionDelegationPanel({ project, act }: { project: Project; act: Act }) {
  const d = project.recordDeletionDelegation ?? null;
  const may = mayDelegateDeletion(project.myRoles);
  const { open, setOpen, button } = useOpener();
  if (project.myRoles.length === 0 || (!d && !may)) return null;
  return (
    <section aria-labelledby="delegation-heading" className="box">
      <div className="settings-box-head">
        <h2 id="delegation-heading" className="box-title">Record deletion</h2>
        <StatusLabel meaning={d ? 'active' : 'off'} word={d ? 'Project Manager allowed' : 'Owners and Sponsors only'} />
      </div>
      {d ? (
        <p>
          {delegationLabel(d.pm, d.by)}. <span className="meta">{formatDay(d.at)}: {d.reason}</span>
        </p>
      ) : (
        <p className="meta">Only an Owner or Sponsor may delete and restore tasks, decisions, questions and risks. You can allow the Project Manager to as well.</p>
      )}
      {may && (
        <>
          <button type="button" ref={button} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            {d ? 'Take back record deletion' : 'Allow the Project Manager to delete records'}
          </button>
          {open && (
            <ReasonDialog
              title={d ? 'Take back record deletion' : 'Allow the Project Manager to delete and restore records'}
              confirm={d ? 'Take back' : 'Allow'}
              onClose={() => setOpen(false)}
              onConfirm={async (reason) => {
                // The server's refusal shows in this dialog; a no-op change then reloads the project and posts the notice.
                await (d ? revokeDeletionDelegation(project.id, reason) : delegateDeletion(project.id, reason));
                setOpen(false);
                await act(
                  async () => undefined,
                  d ? 'The Project Manager can no longer delete or restore records.' : 'The Project Manager may now delete and restore records. Owners and Sponsors are told each time.',
                );
              }}
            >
              <p className="meta">
                {d
                  ? 'Any Owner or Sponsor may do this. It also ends by itself if the Project Manager changes.'
                  : 'It applies to the current Project Manager and ends by itself if the Project Manager changes. Each Owner and Sponsor gets a notice whenever it is used.'}
              </p>
            </ReasonDialog>
          )}
        </>
      )}
    </section>
  );
}
