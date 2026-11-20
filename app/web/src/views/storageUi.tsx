import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { ApiError } from '../api.ts';
import type { ConnectionState, DestinationKind, DestinationPurpose, MoveProgress, SharingRepairRow } from '../storage.ts';
import { STATUS_LABELS, reasonProblem } from '../storage.ts';

export const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'That did not work. Try again.');

export interface Settings {
  tenantId: string | null;
  clientId: string | null;
  hasSecret: boolean;
  approvedInputFormats: string[];
  approvedOutputFormats: string[];
  projectsMayChangeFormats: boolean;
  projectsMayChooseDestination: boolean;
  projectsMaySetExportRoles: boolean;
  directoryLookup: boolean;
  scheduledChecks: boolean;
}
export interface SettingsView {
  settings: Settings;
  protectedKeyLoaded: boolean;
  secret: 'none' | 'saved' | 'unreadable';
}
export interface CheckResult {
  ok: boolean;
  lines: Array<{ key: string; ok: boolean; detail: string }>;
  quotaBytes: number | null;
  usedBytes: number | null;
}
export interface Destination {
  id: string;
  kind: DestinationKind;
  purpose: DestinationPurpose;
  label: string;
  siteUrl: string | null;
  accountEmail: string | null;
  folderPath: string | null;
  status: keyof typeof STATUS_LABELS;
  lastCheck: (CheckResult & { sourceAreaWarning?: string; libraryWarning?: string }) | null;
  lastCheckedAt: string | null;
}
export interface Summary {
  connection: ConnectionState;
  protectedKeyMissing: boolean;
  lastCheckedAt: string | null;
  destinations: Destination[];
  sourceArea: { files: number; bytes: number; quotaBytes: number | null; warning: string | null };
  waiting: number;
  failed: number;
  withheld: number;
  queuedJobs: number;
  sharingToRepair: SharingRepairRow[];
  storageAdmins: Array<{ name: string; since: string }>;
  scheduledChecks: boolean;
  sourceAreaMove: MoveProgress | null;
}

export function Notice({ error, notice }: { error: string | null; notice: string | null }) {
  // The status region is always mounted so a screen reader announces the text when it appears.
  return (
    <>
      {error && <p role="alert" className="error">{error}</p>}
      <p role="status" className="ok">{notice ?? ''}</p>
    </>
  );
}

/**
 * Focus for a form that opens in place of its button: into the field when it opens, back to the button when it closes.
 * Attach `trigger` to the button and `field` to the first input.
 */
export function useReturnFocus<T extends HTMLElement, F extends HTMLElement>(open: boolean) {
  const trigger = useRef<T>(null);
  const field = useRef<F>(null);
  const was = useRef(false);
  useEffect(() => {
    if (open) field.current?.focus();
    else if (was.current) trigger.current?.focus();
    was.current = open;
  }, [open]);
  return { trigger, field };
}

/** A button that asks for a reason before it acts. The reason is cleared once it is sent. */
export function ReasonAction({ label, prompt, onSend, children }: { label: string; prompt: string; onSend: (reason: string) => Promise<void>; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { trigger, field } = useReturnFocus<HTMLButtonElement, HTMLTextAreaElement>(open);
  async function submit(e: FormEvent) {
    e.preventDefault();
    const p = reasonProblem(reason);
    if (p) return setError(p);
    setBusy(true);
    setError(null);
    try {
      await onSend(reason.trim());
      setReason('');
      setOpen(false);
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }
  if (!open) return <button type="button" ref={trigger} onClick={() => setOpen(true)}>{label}</button>;
  return (
    <form className="stack" onSubmit={submit} aria-label={label}>
      {children}
      <label>
        {prompt}
        <textarea ref={field} required rows={2} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      {error && <p role="alert" className="error">{error}</p>}
      <div className="inline-form">
        <button className="primary" disabled={busy}>{label}</button>
        <button type="button" className="quiet" onClick={() => { setOpen(false); setError(null); }}>Cancel</button>
      </div>
    </form>
  );
}
