import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api } from '../api.ts';
import { formatWhen } from '../format.ts';
import {
  type Current, type Draft, type Preview, FIELD_LABEL, WEEKDAY_NAMES, afterSave, buildChanges, changeErrors, draftFrom, leadDaysText,
} from '../settings.ts';
import { Holidays } from './Holidays.tsx';
import { useRefreshCalendar } from './ProjectCalendar.tsx';
import { PreviewList } from './PreviewList.tsx';

const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'That did not work. Try again.');
const NOT_ALLOWED = 'The Administrator has not allowed projects to change this setting.';
const NOT_EDITOR = 'Only a Project Manager, Owner or Sponsor can change this.';
type Group = 'calendar' | 'timings' | 'digest';
type Source = 'organisation' | 'project';
type SourceKey = 'dayCounting' | 'weekdays' | 'leadDays' | 'escalationDays';

interface HistoryRow { id: string; field: string; oldValue: string | null; newValue: string | null; reason: string; actor: string; at: string }
interface OrgView extends Current {
  projectsMayChangeCalendar: boolean;
  projectsMayChangeTimings: boolean;
  projectsMayChangeDigest: boolean;
  sweepMinutes: number;
  history: HistoryRow[];
}
interface ProjectView extends Current {
  sources: Record<SourceKey, Source>;
  delegation: Record<Group, boolean>;
  digest: { frequency: 'daily' | 'weekly'; weekday: number | null; time: string } | null;
  canEdit: Record<Group, boolean>;
  own: NonNullable<Current['own']>;
  history: HistoryRow[];
}

const SOURCE_TEXT: Record<Source, string> = { organisation: 'From the organisation', project: 'Set for this project' };
const GROUP_OF: Record<SourceKey, Group> = { dayCounting: 'calendar', weekdays: 'calendar', leadDays: 'timings', escalationDays: 'timings' };
const dayList = (days: number[]) => [...days].sort((a, b) => a - b).map((d) => WEEKDAY_NAMES[d]).join(', ');
const digestText = (d: ProjectView['digest']) =>
  d ? `${d.frequency === 'weekly' ? `Every ${WEEKDAY_NAMES[d.weekday ?? 1]}` : 'Every day'} at ${d.time} (UTC+8)` : 'Not scheduled';

function History({ rows }: { rows: HistoryRow[] }) {
  if (rows.length === 0) return <p className="meta">No changes yet.</p>;
  return (
    <details>
      <summary>Change history ({rows.length})</summary>
      <ul className="plain">
        {rows.map((h) => (
          <li key={h.id}>
            {formatWhen(h.at)}: {h.actor} changed {FIELD_LABEL[h.field] ?? h.field} from {h.oldValue ?? 'not set'} to {h.newValue ?? 'not set'} — {h.reason}
          </li>
        ))}
      </ul>
    </details>
  );
}

/** One setting: the control, where its value comes from, and (for a project's own value) the way back to the organisation's. */
function Setting({ source, children, back }: { source?: Source; children: ReactNode; back?: ReactNode }) {
  return (
    <div className="setting">
      {children}
      {source && <span className="hint">{SOURCE_TEXT[source]}</span>}
      {back}
    </div>
  );
}

/** The form for the organisation's settings (Administrator) or one project's (Project Manager, Owner, Sponsor). */
export function NotificationSettingsForm({ projectId }: { projectId?: string }) {
  const scope = projectId ? 'project' : 'organisation';
  const base = projectId ? `/projects/${projectId}/notification-settings` : '/notification-settings';
  const [view, setView] = useState<(OrgView | ProjectView) | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [cleared, setCleared] = useState<Set<string>>(new Set());
  const [reason, setReason] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const previewBox = useRef<HTMLDivElement>(null);
  const status = useRef<HTMLParagraphElement>(null);
  const refreshCalendar = useRefreshCalendar();

  const load = useCallback(() => {
    api.get<OrgView | ProjectView>(base).then(
      (v) => {
        setView(v);
        setDraft(draftFrom(v));
        setCleared(new Set());
      },
      (e) => setError(errText(e)),
    );
  }, [base]);
  useEffect(load, [load]);
  useEffect(() => {
    if (preview) previewBox.current?.focus();
  }, [preview]);
  // The Save button disappears with the preview; focus moves to the outcome, beside where the person was working.
  useEffect(() => {
    if (notice) status.current?.focus();
  }, [notice]);

  if (!view || !draft) return error ? <p role="alert" className="error">{error}</p> : <p className="loading">Loading</p>;
  const proj = scope === 'project' ? (view as ProjectView) : null;
  const can = (g: Group) => (proj ? proj.canEdit[g] : true);
  const why = (g: Group) => (proj && !proj.delegation[g] ? NOT_ALLOWED : NOT_EDITOR);
  const changes = buildChanges(scope, view, draft, cleared);
  const anyChange = Object.keys(changes).length > 0;
  const edit = (patch: Partial<Draft>) => {
    setDraft({ ...draft, ...patch });
    setPreview(null);
  };
  const toggleBack = (field: string) => {
    const next = new Set(cleared);
    if (next.has(field)) next.delete(field);
    else next.add(field);
    setCleared(next);
    setPreview(null);
  };
  const source = (f: SourceKey) => proj?.sources[f];
  const backButton = (f: SourceKey) =>
    proj && proj.sources[f] === 'project' && can(GROUP_OF[f]) ? (
      <button type="button" className="quiet" onClick={() => toggleBack(f)} aria-pressed={cleared.has(f)}>
        {cleared.has(f) ? 'Keep the value set for this project' : "Use the organisation's value"}
      </button>
    ) : null;
  const off = (f: string) => cleared.has(f);

  async function showPreview(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    const problems = changeErrors(scope, draft!, cleared);
    if (problems.length > 0) {
      setError(problems.join(' '));
      return;
    }
    try {
      setPreview(await api.post<Preview>(`${base}/preview`, { changes }));
    } catch (err) {
      setError(errText(err));
    }
  }

  async function save() {
    setError(null);
    setNotice(null);
    try {
      // The PUT answers with the saved view (values and history); it is shown as it is, with no second request.
      const next = afterSave(await api.put<OrgView | ProjectView>(base, { changes, reason }));
      setView(next.view);
      setDraft(next.draft);
      setCleared(next.cleared);
      setPreview(next.preview);
      setReason(next.reason);
      setNotice(next.notice);
      refreshCalendar();
    } catch (err) {
      setError(errText(err));
    }
  }

  const readOnly = (g: Group, rows: Array<[string, string, Source | undefined]>) => (
    <>
      <dl className="facts">
        {rows.map(([k, v, s]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}{s && <span className="meta"> · {SOURCE_TEXT[s]}</span>}</dd>
          </div>
        ))}
      </dl>
      <p className="meta">{why(g)}</p>
    </>
  );

  const calendar = can('calendar') ? (
    <>
      <Setting source={source('dayCounting')} back={backButton('dayCounting')}>
        <label>
          Day counting
          <select value={draft.dayCounting} disabled={off('dayCounting')} onChange={(e) => edit({ dayCounting: e.target.value as Draft['dayCounting'] })}>
            <option value="working">Working Days</option>
            <option value="calendar">Calendar Days</option>
          </select>
        </label>
      </Setting>
      <Setting source={source('weekdays')} back={backButton('weekdays')}>
        <fieldset disabled={off('weekdays')}>
          <legend>Working weekdays</legend>
          <div className="weekdays">
            {[1, 2, 3, 4, 5, 6, 7].map((d) => (
              <label key={d} className="check">
                <input
                  type="checkbox"
                  checked={draft.weekdays.includes(d)}
                  onChange={(e) => edit({ weekdays: e.target.checked ? [...draft.weekdays, d].sort((a, b) => a - b) : draft.weekdays.filter((x) => x !== d) })}
                />{' '}
                {WEEKDAY_NAMES[d]}
              </label>
            ))}
          </div>
        </fieldset>
      </Setting>
    </>
  ) : (
    readOnly('calendar', [
      ['Day counting', view.dayCounting === 'working' ? 'Working Days' : 'Calendar Days', source('dayCounting')],
      ['Working weekdays', dayList(view.weekdays), source('weekdays')],
    ])
  );

  const timings = can('timings') ? (
    <>
      <Setting source={source('leadDays')} back={backButton('leadDays')}>
        <label>
          Reminder days before the due date
          <input value={draft.leadText} disabled={off('leadDays')} aria-describedby="lead-hint" onChange={(e) => edit({ leadText: e.target.value })} />
          <span id="lead-hint" className="hint">One to three whole numbers, 1–30, separated by commas. For example: 7, 1</span>
        </label>
      </Setting>
      <Setting source={source('escalationDays')} back={backButton('escalationDays')}>
        <label>
          Escalation delay in days after the due date
          <input type="number" min={1} max={10} value={draft.escalation} disabled={off('escalationDays')} onChange={(e) => edit({ escalation: e.target.value })} />
        </label>
      </Setting>
    </>
  ) : (
    readOnly('timings', [
      ['Reminder days before the due date', leadDaysText(view.leadDays), source('leadDays')],
      ['Escalation delay after the due date', `${view.escalationDays} ${view.escalationDays === 1 ? 'day' : 'days'}`, source('escalationDays')],
    ])
  );

  return (
    <form className="stack" onSubmit={showPreview} aria-label={proj ? 'Notification settings for this project' : 'Notification settings for the organisation'}>
      {error && <p role="alert" className="error">{error}</p>}
      <fieldset className="panel stack settings-group">
        <legend>Calendar</legend>
        {calendar}
      </fieldset>
      <fieldset className="panel stack settings-group">
        <legend>Reminders and escalation</legend>
        {timings}
      </fieldset>
      {!proj && (
        <>
          <fieldset className="panel stack settings-group">
            <legend>Checking for due dates</legend>
            <label>
              Sweep interval in minutes
              <input type="number" min={5} max={60} value={draft.sweep} onChange={(e) => edit({ sweep: e.target.value })} />
              <span className="hint">How often Kainow looks for notices to send, 5–60 minutes.</span>
            </label>
          </fieldset>
          <fieldset className="panel stack settings-group">
            <legend>What projects may change for themselves</legend>
            <label className="check"><input type="checkbox" checked={draft.mayCalendar} onChange={(e) => edit({ mayCalendar: e.target.checked })} /> The calendar (day counting, weekdays and holidays)</label>
            <label className="check"><input type="checkbox" checked={draft.mayTimings} onChange={(e) => edit({ mayTimings: e.target.checked })} /> Reminder days and the escalation delay</label>
            <label className="check"><input type="checkbox" checked={draft.mayDigest} onChange={(e) => edit({ mayDigest: e.target.checked })} /> The action-item email schedule</label>
          </fieldset>
        </>
      )}
      {proj && (
        <fieldset className="panel stack settings-group">
          <legend>Action-item email schedule</legend>
          {can('digest') ? (
            <>
              <label className="check"><input type="checkbox" checked={draft.digestEnabled} onChange={(e) => edit({ digestEnabled: e.target.checked })} /> Send the action-item email on a schedule</label>
              {draft.digestEnabled && (
                <>
                  <label>
                    How often
                    <select value={draft.digestFrequency} onChange={(e) => edit({ digestFrequency: e.target.value as Draft['digestFrequency'] })}>
                      <option value="daily">Every day</option>
                      <option value="weekly">Every week</option>
                    </select>
                  </label>
                  {draft.digestFrequency === 'weekly' && (
                    <label>
                      Weekday
                      <select value={draft.digestWeekday} onChange={(e) => edit({ digestWeekday: Number(e.target.value) })}>
                        {[1, 2, 3, 4, 5, 6, 7].map((d) => <option key={d} value={d}>{WEEKDAY_NAMES[d]}</option>)}
                      </select>
                    </label>
                  )}
                  <label>
                    Time (UTC+8)
                    <input type="time" required value={draft.digestTime} onChange={(e) => edit({ digestTime: e.target.value })} />
                  </label>
                </>
              )}
            </>
          ) : (
            readOnly('digest', [['Action-item email schedule', digestText(proj.digest), undefined]])
          )}
        </fieldset>
      )}
      {(can('calendar') || can('timings') || can('digest')) && (
        <div className="panel stack">
          <label>
            Reason for the change
            <textarea required rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          {!anyChange && <p className="meta">Change a setting to see what it would do.</p>}
          <button className="primary" disabled={!anyChange}>Preview changes</button>
        </div>
      )}
      {/* Always in the page, so a screen reader announces the text when it appears; shown next to the Save step. */}
      <p ref={status} role="status" tabIndex={-1} className={notice ? 'ok' : 'visually-hidden'}>{notice ?? ''}</p>
      <div ref={previewBox} tabIndex={-1} className="preview-box">
        {preview && (
          <>
            <PreviewList preview={preview} />
            <div className="decision">
              <button type="button" className="primary" onClick={() => void save()}>Save changes</button>
              <button type="button" onClick={() => setPreview(null)}>Back to editing</button>
            </div>
          </>
        )}
      </div>
      <History rows={view.history} />
    </form>
  );
}

/** Administration → Notifications and email. */
export function NotificationsSettings() {
  return (
    <main className="page narrow">
      <h1>Notifications and email</h1>
      <p className="meta">When reminders go out and how days are counted. Projects use these unless you let them set their own. <a href="#/deliveries">See email delivery</a></p>
      <NotificationSettingsForm />
      <Holidays canEdit />
    </main>
  );
}

/** Project → Settings. Everyone who can read the project sees the values; editing follows `canEdit`. */
export function ProjectSettings({ projectId }: { projectId: string }) {
  const [canEditCalendar, setCanEditCalendar] = useState(false);
  const [blocked, setBlocked] = useState<string | null>(null);
  const refreshCalendar = useRefreshCalendar();
  useEffect(() => {
    api.get<{ canEdit: { calendar: boolean }; delegation: { calendar: boolean } }>(`/projects/${projectId}/notification-settings`).then(
      (v) => {
        setCanEditCalendar(v.canEdit.calendar);
        setBlocked(v.delegation.calendar ? null : NOT_ALLOWED);
      },
      () => setCanEditCalendar(false),
    );
  }, [projectId]);
  return (
    <>
      <h2>Notification settings</h2>
      <NotificationSettingsForm projectId={projectId} />
      <Holidays projectId={projectId} canEdit={canEditCalendar} notice={blocked} onChanged={refreshCalendar} />
    </>
  );
}
