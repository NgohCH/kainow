import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '../api.ts';
import { formatWhen, plural } from '../format.ts';
import { rolesText } from '../projects.ts';
import {
  LINE_STATUSES,
  type LineEvent,
  type LineStatus,
  type LineView,
  READ_ONLY_NOTE,
  type ResourcesList,
  eventText,
  lineDefaultFilter,
  overlapText,
  resourceActions,
  statusLabel,
  unitLabel,
} from '../resources.ts';
import { FinanceSection } from './Finance.tsx';
import { ResourceLineForm } from './ResourceLineForm.tsx';
import { useReturnFocus } from './useReturnFocus.ts';

const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'That did not work. Try again.');
const ORDER: LineStatus[] = ['needed', 'arranged', 'in_use', 'finished', 'cancelled'];
const STATUS_CHOICES: LineStatus[] = ['needed', 'arranged', 'in_use', 'finished'];
const KIND_LABEL: Record<string, string> = { equipment: 'Equipment', facility: 'Facility', other: 'Other' };

export function lineName(l: LineView): string {
  if (l.item) return `${l.item.reference} · ${l.item.name}${l.item.retired ? ' (retired)' : ''}`;
  return `${l.description} (one-off, ${KIND_LABEL[l.oneOffKind ?? ''] ?? 'Other'})`;
}

export function periodText(l: LineView): string {
  if (!l.startsOn) return 'Period not provided';
  return l.endsOn ? `${l.startsOn} to ${l.endsOn}` : `from ${l.startsOn}`;
}

/** The project Resources tab (spec 4): status chips, lines, People, Finance and the report links. */
export function Resources({ projectId, roles, status }: { projectId: string; roles: string[]; status: string }) {
  const [data, setData] = useState<ResourcesList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const actions = resourceActions(roles, status);
  useReturnFocus(adding ? 'add-resource' : null);

  const load = useCallback(() => {
    api.get<ResourcesList>(`/projects/${projectId}/resources`).then(
      (r) => {
        setData(r);
        setError(null);
      },
      (e: unknown) => setError(errText(e)),
    );
  }, [projectId]);
  useEffect(load, [load]);
  const changed = (message: string) => {
    setAdding(false);
    setEditing(null);
    setNotice(message);
    load();
  };

  if (!data) return error ? <p role="alert" className="error">{error}</p> : <p className="loading">Loading</p>;

  const shown = data.lines.filter((l) => showAll || lineDefaultFilter(l.status));
  const passed = data.lines.filter((l) => l.neededByPassed).length;
  const hiddenCount = data.counts.finished + data.counts.cancelled;
  const csv = api.url(`/projects/${projectId}/resources/report?format=csv`);

  return (
    <>
      <section aria-labelledby="resources-heading">
        <div className="row">
          <h2 id="resources-heading" tabIndex={-1}>Resources</h2>
          {actions.editLines && (
            <button type="button" className="primary" data-opener="add-resource" aria-expanded={adding} onClick={() => setAdding((a) => !a)}>
              + Add resource
            </button>
          )}
        </div>
        {actions.readOnly && <p className="meta">{READ_ONLY_NOTE}</p>}
        <p role="status" aria-live="polite" className="meta">{notice ?? ''}</p>
        {error && <p role="alert" className="error">{error}</p>}
        <ul className="chips-list" aria-label="Lines by status">
          {ORDER.map((s) => (
            <li key={s} className="chip-quiet">
              {LINE_STATUSES[s]} ({data.counts[s]})
            </li>
          ))}
        </ul>
        {passed > 0 && <p className="warn">Resources past needed-by date: {passed}</p>}
        {adding && <ResourceLineForm projectId={projectId} onSaved={changed} onCancel={() => setAdding(false)} />}
        {hiddenCount > 0 && (
          <label>
            <span>
              <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
              Show finished and cancelled ({hiddenCount})
            </span>
          </label>
        )}
        {shown.length === 0 ? (
          <p className="meta">{data.lines.length === 0 ? 'No resources have been recorded for this project yet.' : 'No lines to show with this filter.'}</p>
        ) : (
          <ul className="plain">
            {shown.map((l) => (
              <LineRow
                key={l.id}
                projectId={projectId}
                line={l}
                canEdit={actions.editLines && l.status !== 'cancelled'}
                editing={editing === l.id}
                onEdit={() => setEditing(editing === l.id ? null : l.id)}
                onChanged={changed}
              />
            ))}
          </ul>
        )}
        <p className="meta">Usage records, not bookings</p>
      </section>

      <section aria-labelledby="people-heading">
        <h2 id="people-heading">People</h2>
        {data.people.length === 0 ? (
          <p className="meta">No one is on the project right now.</p>
        ) : (
          <ul className="plain">
            {data.people.map((p) => (
              <li key={p.userId}>
                <a href={`#/projects/${projectId}/work`}>{p.name}</a> · {rolesText(p.roles)}
                {p.department ? ` · ${p.department}` : ''} · {plural(p.openTasks, 'open task')}
                {p.overdue > 0 ? ` (${p.overdue} overdue)` : ''}
              </li>
            ))}
          </ul>
        )}
      </section>

      <FinanceSection projectId={projectId} summary={data.finance} actions={actions} computedAt={data.computedAt} onChanged={changed} />

      <section aria-labelledby="report-heading">
        <h2 id="report-heading">Report</h2>
        <div className="decision">
          <a className="button" href={`#/projects/${projectId}/resources/report`}>View report</a>
          <a className="button" href={csv} download>Download CSV</a>
        </div>
      </section>
    </>
  );
}

function LineRow({ projectId, line: l, canEdit, editing, onEdit, onChanged }: { projectId: string; line: LineView; canEdit: boolean; editing: boolean; onEdit: () => void; onChanged: (m: string) => void }) {
  const [mode, setMode] = useState<null | 'cancel' | 'history'>(null);
  const [history, setHistory] = useState<LineEvent[] | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [pickedStatus, setPickedStatus] = useState<string>(l.status);
  const [busy, setBusy] = useState(false);
  const overlap = overlapText(l.overlap);
  const focus = useReturnFocus(editing ? `edit-${l.id}` : mode ? `${mode}-${l.id}` : null);
  useEffect(() => setPickedStatus(l.status), [l.status]);

  useEffect(() => {
    if (mode !== 'history') return;
    let stale = false;
    setHistory(null);
    setHistoryError(null);
    api.get<{ events: LineEvent[] }>(`/projects/${projectId}/resources/lines/${l.id}/history`).then(
      (r) => !stale && setHistory(r.events),
      (e: unknown) => !stale && setHistoryError(errText(e)),
    );
    return () => {
      stale = true;
    };
  }, [mode, projectId, l.id, l.updatedAt]);

  async function setStatus(next: string) {
    setError(null);
    setBusy(true);
    try {
      await api.post(`/projects/${projectId}/resources/lines/${l.id}/status`, { status: next });
      onChanged(`Status set to ${statusLabel(next)}.`);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }
  async function cancel(e: FormEvent) {
    e.preventDefault();
    if (reason.trim() === '') return setError('Enter a reason for cancelling.');
    setError(null);
    setBusy(true);
    try {
      await api.post(`/projects/${projectId}/resources/lines/${l.id}/cancel`, { reason: reason.trim() });
      focus.leaving('resources-heading');
      setMode(null);
      setReason('');
      onChanged('Resource cancelled.');
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="panel work-item">
      <div className="row">
        <strong>{lineName(l)}</strong>
        <span className="badge">{statusLabel(l.status)}</span>
      </div>
      <p className="meta">
        {l.item?.category ? `${l.item.category} · ` : ''}
        {l.quantity !== null ? `${l.quantity} ${unitLabel(l.unit)}` : 'Not provided'} · {periodText(l)}
        {l.neededBy ? ` · needed by ${l.neededBy}` : ''}
      </p>
      {l.neededByPassed && <p className="warn">Past needed-by date</p>}
      {overlap && (
        <p className="warn" role="note">
          <span aria-hidden="true">⚠ </span>
          {overlap}
        </p>
      )}
      {l.notes && <p>{l.notes}</p>}
      {error && <p role="alert" className="error">{error}</p>}
      <div className="decision">
        {canEdit && (
          <label>
            Status of {lineName(l)}
            <select value={pickedStatus} disabled={busy} onChange={(e) => setPickedStatus(e.target.value)}>
              {STATUS_CHOICES.map((s) => (
                <option key={s} value={s}>{LINE_STATUSES[s]}</option>
              ))}
            </select>
          </label>
        )}
        {canEdit && (
          <button type="button" disabled={busy || pickedStatus === l.status} onClick={() => void setStatus(pickedStatus)}>Set status</button>
        )}
        {canEdit && (
          <button type="button" data-opener={`edit-${l.id}`} aria-expanded={editing} onClick={onEdit}>{editing ? 'Close edit' : 'Edit'}</button>
        )}
        {canEdit && (
          <button type="button" className="reject" data-opener={`cancel-${l.id}`} aria-expanded={mode === 'cancel'} onClick={() => setMode(mode === 'cancel' ? null : 'cancel')}>
            Cancel resource
          </button>
        )}
        <button type="button" className="quiet" data-opener={`history-${l.id}`} aria-expanded={mode === 'history'} onClick={() => setMode(mode === 'history' ? null : 'history')}>
          {mode === 'history' ? 'Hide history' : 'History'}
        </button>
      </div>
      {editing && <ResourceLineForm projectId={projectId} line={l} onSaved={onChanged} onCancel={onEdit} />}
      {mode === 'cancel' && (
        <form className="stack" aria-label="Cancel this resource" onSubmit={(e) => void cancel(e)}>
          <label>
            Reason for cancelling (cannot be undone; add a new line if the need returns)
            <textarea rows={2} value={reason} maxLength={1000} onChange={(e) => setReason(e.target.value)} required />
          </label>
          <div className="decision">
            <button type="submit" className="reject" disabled={busy}>Cancel this resource</button>
            <button type="button" onClick={() => setMode(null)} disabled={busy}>Keep it</button>
          </div>
        </form>
      )}
      {mode === 'history' && (
        <div>
          <h3>History</h3>
          {historyError ? (
            <p role="alert" className="error">{historyError}</p>
          ) : history === null ? (
            <p className="loading">Loading</p>
          ) : (
            <ul className="plain">
              {history.map((h) => (
                <li key={h.id}>
                  {eventText(h)} <span className="meta">by {h.actor}, {formatWhen(h.at)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}
