import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '../api.ts';
import { formatWhen } from '../format.ts';
import {
  EMAIL_CHOICES,
  NO_ACCESS_TEXT,
  type EmailChoice,
  type EmailPreferences,
  type NotificationItem,
  type NotificationPage,
} from '../notifications.ts';

const message = (e: unknown): string => (e instanceof ApiError ? e.message : 'Something went wrong. Try again.');

function Entry({ n, onRead }: { n: NotificationItem; onRead: (id: string) => void }) {
  const unread = n.readAt === null;
  const [failed, setFailed] = useState(false);

  function markRead() {
    setFailed(false);
    api.post(`/notifications/${n.id}/read`).then(
      () => onRead(n.id),
      () => setFailed(true),
    );
  }

  const text = n.noAccess ? NO_ACCESS_TEXT : (n.summary ?? 'A notice');
  return (
    <li className={unread ? 'notif unread' : 'notif'}>
      <div className="notif-head">
        {unread && <span className="visually-hidden">Unread. </span>}
        {n.urgent && <span className="notif-urgent">Urgent</span>}
        {!n.noAccess && n.projectName && <strong>{n.projectName}</strong>}
        <span className="meta">{formatWhen(n.createdAt)}</span>
        {unread && <span className="meta" aria-hidden="true">Unread</span>}
      </div>
      <p>
        {n.noAccess || !n.link ? (
          text
        ) : (
          // Following the link marks the notice read; the request is not waited for.
          <a
            href={n.link}
            onClick={() => {
              if (unread) api.post(`/notifications/${n.id}/read`).then(() => onRead(n.id), () => undefined);
            }}
          >
            {text}
          </a>
        )}
      </p>
      {(unread || failed) && (
        <div className="notif-actions">
          {unread && (
            <button type="button" onClick={markRead} aria-label={`Mark read: ${text}`}>
              Mark read
            </button>
          )}
          {failed && <span role="alert" className="error">Could not mark this read. Try again.</span>}
        </div>
      )}
    </li>
  );
}

function EmailPreferencesSection() {
  const [prefs, setPrefs] = useState<EmailPreferences | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<Record<string, string>>({});
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [note, setNote] = useState('');
  const [awayError, setAwayError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setError(null);
    api.get<EmailPreferences>('/email-preferences').then(setPrefs, (e: unknown) => setError(message(e)));
  }, []);
  useEffect(load, [load]);

  async function choose(projectId: string, choice: EmailChoice) {
    if (!prefs) return;
    const before = prefs.projects.find((p) => p.projectId === projectId)?.choice;
    setPrefs({ ...prefs, projects: prefs.projects.map((p) => (p.projectId === projectId ? { ...p, choice } : p)) });
    setStatus((s) => ({ ...s, [projectId]: 'Saving' }));
    try {
      await api.put(`/email-preferences/${projectId}`, { choice });
      setStatus((s) => ({ ...s, [projectId]: 'Saved' }));
    } catch (e) {
      setPrefs((cur) => (cur && before ? { ...cur, projects: cur.projects.map((p) => (p.projectId === projectId ? { ...p, choice: before } : p)) } : cur));
      setStatus((s) => ({ ...s, [projectId]: `Not saved. ${message(e)}` }));
    }
  }

  async function addAway(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setAwayError(null);
    try {
      await api.post('/away-periods', { startsOn: start, endsOn: end, ...(note.trim() ? { note: note.trim() } : {}) });
      setStart('');
      setEnd('');
      setNote('');
      load();
    } catch (err) {
      setAwayError(message(err));
    } finally {
      setBusy(false);
    }
  }

  async function removeAway(id: string) {
    setAwayError(null);
    try {
      await api.delete(`/away-periods/${id}`);
      load();
    } catch (err) {
      setAwayError(message(err));
    }
  }

  return (
    <section aria-labelledby="email-prefs-heading" className="email-prefs">
      <h2 id="email-prefs-heading">Email preferences</h2>
      <p className="meta">Urgent notices are escalations, alerts about unavailable assignees and due dates set in the past.</p>
      {error && (
        <p role="alert" className="error">
          {error} <button type="button" onClick={load}>Retry</button>
        </p>
      )}
      {!prefs && !error && <p className="loading" role="status">Loading</p>}
      {prefs && (
        <>
          {prefs.projects.length === 0 && <p className="meta">You do not hold a role in any project, so there is nothing to set.</p>}
          {prefs.projects.map((p) => (
            <fieldset key={p.projectId} className="pref-project">
              <legend>{p.name}</legend>
              {EMAIL_CHOICES.map((c) => (
                <label key={c.value}>
                  <input type="radio" name={`pref-${p.projectId}`} value={c.value} checked={p.choice === c.value} onChange={() => void choose(p.projectId, c.value)} />
                  {c.label}
                </label>
              ))}
              <p className="pref-status meta" role="status" aria-live="polite">{status[p.projectId] ?? ''}</p>
            </fieldset>
          ))}

          <h3>Away dates</h3>
          <p className="meta">No notice emails or digests are sent to you on these dates (UTC+8, both days included). They are sent after you return.</p>
          {prefs.away.length === 0 ? (
            <p className="meta">No away dates set.</p>
          ) : (
            <ul className="plain">
              {prefs.away.map((a) => (
                <li key={a.id}>
                  {a.startsOn} to {a.endsOn}
                  {a.note ? `: ${a.note}` : ''}{' '}
                  <button type="button" className="quiet" onClick={() => void removeAway(a.id)} aria-label={`Remove away dates ${a.startsOn} to ${a.endsOn}`}>
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
          <form onSubmit={addAway} className="stack away-form" aria-label="Add away dates">
            <label>
              Start date
              <input type="date" required value={start} onChange={(e) => setStart(e.target.value)} />
            </label>
            <label>
              End date
              <input type="date" required value={end} onChange={(e) => setEnd(e.target.value)} aria-describedby={awayError ? 'away-error' : undefined} />
            </label>
            <label>
              Note (optional)
              <input type="text" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} />
            </label>
            {awayError && <p id="away-error" role="alert" className="error">{awayError}</p>}
            <button className="primary" disabled={busy}>Add away dates</button>
          </form>
        </>
      )}
    </section>
  );
}

export function Notifications() {
  const [items, setItems] = useState<NotificationItem[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [marking, setMarking] = useState(false);

  const load = useCallback(() => {
    setError(null);
    setItems(null);
    api.get<NotificationPage>('/notifications').then(
      (r) => {
        setItems(r.items);
        setNext(r.more ? r.next : null);
      },
      (e: unknown) => setError(message(e)),
    );
  }, []);
  useEffect(load, [load]);

  async function showMore() {
    if (!next) return;
    setLoadingMore(true);
    try {
      const r = await api.get<NotificationPage>(`/notifications?before=${encodeURIComponent(next)}`);
      setItems((cur) => [...(cur ?? []), ...r.items]);
      setNext(r.more ? r.next : null);
    } catch (e) {
      setError(message(e));
    } finally {
      setLoadingMore(false);
    }
  }

  async function markAll() {
    setMarking(true);
    try {
      await api.post('/notifications/read-all');
      window.dispatchEvent(new Event('notifications-changed'));
      const now = new Date().toISOString();
      setItems((cur) => cur && cur.map((n) => (n.readAt ? n : { ...n, readAt: now })));
    } catch (e) {
      setError(message(e));
    } finally {
      setMarking(false);
    }
  }

  const changed = () => window.dispatchEvent(new Event('notifications-changed'));
  const markOne = (id: string) => {
    changed();
    setItems((cur) => cur && cur.map((n) => (n.id === id && !n.readAt ? { ...n, readAt: new Date().toISOString() } : n)));
  };
  const anyUnread = !!items && items.some((n) => n.readAt === null);

  return (
    <main className="notifications-page">
      <h1>Notifications</h1>
      <div className="notif-toolbar">
        <button type="button" onClick={() => void markAll()} disabled={marking || !anyUnread}>Mark all read</button>
      </div>
      {error && (
        <p role="alert" className="error">
          {error} <button type="button" onClick={load}>Retry</button>
        </p>
      )}
      {!items && !error && <p className="loading" role="status">Loading</p>}
      {items && items.length === 0 && <p className="meta">No notifications yet.</p>}
      {items && items.length > 0 && (
        <ul className="notif-list" aria-label="Notifications, newest first">
          {items.map((n) => (
            <Entry key={n.id} n={n} onRead={markOne} />
          ))}
        </ul>
      )}
      {next && <button type="button" disabled={loadingMore} onClick={() => void showMore()}>Show more</button>}
      <EmailPreferencesSection />
    </main>
  );
}
