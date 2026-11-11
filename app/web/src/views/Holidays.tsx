import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '../api.ts';
import type { Preview } from '../settings.ts';
import { PreviewList } from './PreviewList.tsx';

const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'That did not work. Try again.');

interface Holiday { id: string; date: string; name: string; removedAt: string | null }
interface Listing { holidays: Holiday[]; organisationHolidays?: Array<{ id: string; date: string; name: string }> }

type Pending = { kind: 'add'; date: string; name: string } | { kind: 'remove'; id: string; label: string };

/** Holidays for the organisation or one project: add or remove with a reason, after seeing what would move. */
export function Holidays({ projectId, canEdit, notice: blockedNote, onChanged }: { projectId?: string; canEdit: boolean; notice?: string | null; onChanged?: () => void }) {
  const base = projectId ? `/projects/${projectId}/holidays` : '/notification-settings/holidays';
  const [list, setList] = useState<Listing | null>(null);
  const [date, setDate] = useState('');
  const [name, setName] = useState('');
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    api.get<Listing>(base).then(setList, (e) => setError(errText(e)));
  }, [base]);
  useEffect(load, [load]);

  const cancel = () => {
    setPending(null);
    setPreview(null);
    setReason('');
  };

  async function show(p: Pending) {
    setError(null);
    setNotice(null);
    try {
      setPreview(await api.post<Preview>(`${base}/preview`, p.kind === 'add' ? { add: { date: p.date } } : { removeId: p.id }));
      setPending(p);
    } catch (e) {
      setError(errText(e));
    }
  }

  function startAdd(e: FormEvent) {
    e.preventDefault();
    void show({ kind: 'add', date, name });
  }

  async function confirm(e: FormEvent) {
    e.preventDefault();
    if (!pending) return;
    setError(null);
    try {
      if (pending.kind === 'add') await api.post(base, { date: pending.date, name: pending.name, reason });
      else await api.delete(`${base}/${pending.id}`, { reason });
      setNotice(pending.kind === 'add' ? 'Holiday added.' : 'Holiday removed.');
      if (pending.kind === 'add') {
        setDate('');
        setName('');
      }
      cancel();
      load();
      onChanged?.();
    } catch (err) {
      setError(errText(err));
    }
  }

  const own = (list?.holidays ?? []).filter((h) => !h.removedAt);
  const inherited = list?.organisationHolidays ?? [];
  const id = projectId ? 'proj-holidays' : 'org-holidays';
  return (
    <section aria-labelledby={id}>
      <h2 id={id}>Holidays</h2>
      <p className="meta">A holiday is not a working day. It moves notices that have not been sent. It never changes a deadline.</p>
      {error && <p role="alert" className="error">{error}</p>}
      {notice && <p role="status" className="ok">{notice}</p>}
      {list && own.length === 0 && inherited.length === 0 && <p className="meta">No holidays yet.</p>}
      {(own.length > 0 || inherited.length > 0) && (
        <ul className="plain">
          {inherited.map((h) => (
            <li key={h.id}>{h.date} · {h.name} <span className="meta">From the organisation</span></li>
          ))}
          {own.map((h) => (
            <li key={h.id}>
              {h.date} · {h.name} {projectId && <span className="meta">Set for this project </span>}
              {canEdit && !pending && (
                <button type="button" className="quiet" onClick={() => void show({ kind: 'remove', id: h.id, label: `${h.date} ${h.name}` })}>
                  Remove<span className="visually-hidden"> {h.date} {h.name}</span>
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {!canEdit && blockedNote && <p className="meta">{blockedNote}</p>}
      {canEdit && !pending && (
        <form className="panel stack" onSubmit={startAdd} aria-label="Add a holiday">
          <label>Date <input type="date" required value={date} onChange={(e) => setDate(e.target.value)} /></label>
          <label>Name <input required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} /></label>
          <button className="primary">Preview adding this holiday</button>
        </form>
      )}
      {pending && preview && (
        <form className="stack" onSubmit={confirm} aria-label={pending.kind === 'add' ? 'Confirm adding the holiday' : 'Confirm removing the holiday'}>
          <p>{pending.kind === 'add' ? `Add ${pending.date} ${pending.name}` : `Remove ${pending.label}`}</p>
          <PreviewList preview={preview} />
          <label>Reason for the change <textarea required rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></label>
          <div className="decision">
            <button className="primary">{pending.kind === 'add' ? 'Add holiday' : 'Remove holiday'}</button>
            <button type="button" onClick={cancel}>Cancel</button>
          </div>
        </form>
      )}
    </section>
  );
}
