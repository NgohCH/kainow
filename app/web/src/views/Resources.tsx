import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '../api.ts';
import { formatWhen, plural } from '../format.ts';
import { rolesText } from '../projects.ts';
import {
  LINE_STATUSES,
  LINE_STATUS_MEANING,
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
import { DataTable, type Column } from '../ui/DataTable.tsx';
import { StatTile } from '../ui/StatTile.tsx';
import { StatusLabel } from '../ui/StatusLabel.tsx';
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

export function quantityText(l: LineView): string {
  return l.quantity === null ? 'Not provided' : `${l.quantity} ${unitLabel(l.unit)}`.trim();
}

/** A line's status, with Past needed-by date and an overlap beside it. Shared with the report. */
export function LineLabels({ line: l }: { line: LineView }) {
  return (
    <span className="label-stack">
      <StatusLabel meaning={LINE_STATUS_MEANING[l.status]} word={statusLabel(l.status)} />
      {l.neededByPassed && <StatusLabel meaning="overdue" word="Past needed-by date" />}
    </span>
  );
}

/** The project Resources tab (spec 4, 7.6): counts by status, the lines as a table, People, Finance and the report links. */
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
  const columns: Column<LineView>[] = [
    {
      key: 'resource',
      header: 'Resource',
      sortValue: (l) => lineName(l).toLowerCase(),
      cell: (l) => (
        <span>
          {lineName(l)}
          {l.item?.category && <span className="meta work-parent">{l.item.category}</span>}
        </span>
      ),
    },
    { key: 'status', header: 'Status', sortValue: (l) => ORDER.indexOf(l.status), cell: (l) => <LineLabels line={l} /> },
    { key: 'quantity', header: 'Quantity', cell: quantityText },
    { key: 'period', header: 'Period', sortValue: (l) => l.startsOn ?? '', cell: periodText },
    { key: 'neededBy', header: 'Needed by', sortValue: (l) => l.neededBy ?? '', cell: (l) => l.neededBy ?? 'Not set' },
    {
      key: 'details',
      header: 'Details and actions',
      wide: true,
      cell: (l) => (
        <LineDetails
          projectId={projectId}
          line={l}
          canEdit={actions.editLines && l.status !== 'cancelled'}
          editing={editing === l.id}
          onEdit={() => setEditing(editing === l.id ? null : l.id)}
          onChanged={changed}
          showAll={showAll}
        />
      ),
    },
  ];
  const peopleColumns: Column<ResourcesList['people'][number]>[] = [
    { key: 'name', header: 'Person', sortValue: (p) => p.name.toLowerCase(), cell: (p) => <a href={`#/projects/${projectId}/work`}>{p.name}</a> },
    { key: 'roles', header: 'Roles', cell: (p) => rolesText(p.roles) },
    { key: 'department', header: 'Department', sortValue: (p) => p.department ?? '', cell: (p) => p.department ?? 'Not recorded' },
    {
      key: 'tasks',
      header: 'Open tasks',
      sortValue: (p) => p.openTasks,
      cell: (p) => (
        <span className="label-stack">
          <span>{plural(p.openTasks, 'open task')}</span>
          {p.overdue > 0 && <StatusLabel meaning="overdue" word={`${p.overdue} overdue`} />}
        </span>
      ),
    },
  ];

  return (
    <>
      <section aria-labelledby="resources-heading" className="box">
        <div className="settings-box-head">
          <h2 id="resources-heading" className="box-title" tabIndex={-1}>Resources</h2>
          {actions.editLines && (
            <button type="button" className="primary" data-opener="add-resource" aria-expanded={adding} onClick={() => setAdding((a) => !a)}>
              + Add resource
            </button>
          )}
        </div>
        <p className="meta">Usage records, not bookings</p>
        {actions.readOnly && <p className="meta">{READ_ONLY_NOTE}</p>}
        <p role="status" aria-live="polite" className="meta">{notice ?? ''}</p>
        {error && <p role="alert" className="error">{error}</p>}
        <div className="stat-grid" role="list" aria-label="Lines by status">
          {ORDER.map((s) => (
            <div role="listitem" key={s}>
              <StatTile label={LINE_STATUSES[s]} value={String(data.counts[s])} />
            </div>
          ))}
          {passed > 0 && (
            <div role="listitem">
              <StatTile label="Past needed-by date" value={String(passed)} meaning="overdue" word="Resources past needed-by date" />
            </div>
          )}
        </div>
        {adding && <ResourceLineForm projectId={projectId} onSaved={changed} onCancel={() => setAdding(false)} />}
        {hiddenCount > 0 && (
          <label>
            <span>
              <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
              Show finished and cancelled ({hiddenCount})
            </span>
          </label>
        )}
        <DataTable
          caption={showAll ? 'Resource lines, all statuses' : 'Resource lines, without finished and cancelled'}
          columns={columns}
          rows={shown}
          rowKey={(l) => l.id}
          empty={data.lines.length === 0 ? 'No resources have been recorded for this project yet.' : 'No lines to show with this filter.'}
        />
      </section>

      <section aria-labelledby="people-heading" className="box">
        <h2 id="people-heading" className="box-title">People</h2>
        <DataTable caption="People on the project and their open tasks" columns={peopleColumns} rows={data.people} rowKey={(p) => p.userId} empty="No one is on the project right now." />
      </section>

      <FinanceSection projectId={projectId} summary={data.finance} actions={actions} computedAt={data.computedAt} onChanged={changed} />

      <section aria-labelledby="report-heading" className="box">
        <h2 id="report-heading" className="box-title">Report</h2>
        <p className="meta">A printable page of this project's resource records, and the same as a CSV file.</p>
        <div className="decision">
          <a className="button" href={`#/projects/${projectId}/resources/report`}>View report</a>
          <a className="button" href={csv} download>Download CSV</a>
        </div>
      </section>
    </>
  );
}

/** A line's warnings, notes, actions and their forms, and its history: the last cell of its row. */
function LineDetails({ projectId, line: l, canEdit, editing, onEdit, onChanged, showAll }: { projectId: string; line: LineView; canEdit: boolean; editing: boolean; onEdit: () => void; onChanged: (m: string) => void; showAll: boolean }) {
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
      // The row leaves the default list (Finished): its Set status button goes, so focus the section heading.
      if (!showAll && !lineDefaultFilter(next as LineView['status'])) document.getElementById('resources-heading')?.focus();
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
    <div className="work-details">
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
        <form className="stack change-form" aria-label="Cancel this resource" onSubmit={(e) => void cancel(e)}>
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
    </div>
  );
}
