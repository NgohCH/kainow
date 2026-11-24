import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api } from '../api.ts';
import { failuresFirst, lastDay, needsAction } from '../deliveries.ts';
import { formatWhen } from '../format.ts';
import { DataTable, type Column } from '../ui/DataTable.tsx';
import { PageHeader } from '../ui/PageHeader.tsx';
import { StatTile } from '../ui/StatTile.tsx';
import { StatusLabel } from '../ui/StatusLabel.tsx';
import type { Meaning } from '../ui/meanings.ts';

const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'That did not work. Try again.');
const DUPLICATE = 'Possible duplicate: an earlier attempt may have been delivered';

export interface Delivery {
  id: string;
  recipientName: string;
  toAddress: string;
  kind: string;
  subject: string;
  createdAt: string;
  status: string;
  attempts: number;
  lastReason: string | null;
  possibleDuplicate: boolean;
}
interface Page { items: Delivery[]; more: boolean; next: string | null }

const STATUS_TEXT: Record<string, string> = {
  queued: 'Queued', sending: 'Sending', retry_wait: 'Waiting to retry', sent: 'Sent', failed: 'Failed', cancelled: 'Cancelled', uncertain: 'Uncertain', not_sent_restored: 'Not sent — restored from backup',
};
const STATUS_MEANING: Record<string, Meaning> = {
  queued: 'planned', sending: 'planned', retry_wait: 'attention', sent: 'ok', failed: 'failing', cancelled: 'off', uncertain: 'attention', not_sent_restored: 'attention',
};
const kindText = (k: string) => k.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

/** Email deliveries, newest first, 50 at a time. With `onResend` (Administrator) failed and uncertain rows can be sent again, and failed ones are listed first. */
export function DeliveryHistory({ path, onResend, reloadKey = 0, onLoaded }: { path: string; onResend?: (id: string) => Promise<void>; reloadKey?: number; onLoaded?: (rows: Delivery[], more: boolean) => void }) {
  const [rows, setRows] = useState<Delivery[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [added, setAdded] = useState<string | null>(null);
  const addedBox = useRef<HTMLParagraphElement>(null);

  const load = useCallback(
    async (cursor: string | null) => {
      setError(null);
      try {
        const page = await api.get<Page>(cursor ? `${path}?before=${encodeURIComponent(cursor)}` : path);
        setRows((r) => (cursor ? [...r, ...page.items] : page.items));
        setNext(page.more ? page.next : null);
        // A fresh list starts again at the newest 50, so an earlier "more loaded" no longer holds.
        if (!cursor) setAdded(null);
        else {
          setAdded(`${page.items.length} more ${page.items.length === 1 ? 'email' : 'emails'} loaded.`);
          setTimeout(() => addedBox.current?.focus(), 0);
        }
      } catch (e) {
        setError(errText(e));
      } finally {
        setLoaded(true);
      }
    },
    [path],
  );
  useEffect(() => void load(null), [load, reloadKey]);
  useEffect(() => {
    if (loaded) onLoaded?.(rows, next !== null);
  }, [rows, next, loaded, onLoaded]);

  async function resend(id: string) {
    setBusy(id);
    try {
      await onResend?.(id);
      await load(null);
    } finally {
      setBusy(null);
    }
  }

  const shown = useMemo(() => (onResend ? failuresFirst(rows) : rows), [rows, onResend]);
  const columns: Column<Delivery>[] = [
    { key: 'recipient', header: 'Recipient', cell: (r) => <>{r.recipientName}<span className="meta"> {r.toAddress}</span></> },
    { key: 'kind', header: 'Kind', cell: (r) => kindText(r.kind) },
    { key: 'subject', header: 'Subject', cell: (r) => r.subject },
    { key: 'created', header: 'Created (UTC+8)', cell: (r) => formatWhen(r.createdAt) },
    {
      key: 'status',
      header: 'Status',
      cell: (r) => (
        <>
          <StatusLabel meaning={STATUS_MEANING[r.status] ?? 'attention'} word={STATUS_TEXT[r.status] ?? r.status} />
          {r.possibleDuplicate && <span className="warn inline">{DUPLICATE}</span>}
        </>
      ),
    },
    { key: 'attempts', header: 'Attempts', cell: (r) => r.attempts },
    { key: 'reason', header: 'Last reason', cell: (r) => r.lastReason ?? '' },
    ...(onResend
      ? [{
          key: 'action',
          header: 'Action',
          cell: (r: Delivery) =>
            needsAction(r.status) ? (
              <button type="button" disabled={busy !== null} onClick={() => void resend(r.id)}>
                Resend<span className="visually-hidden">: {r.subject} to {r.recipientName}</span>
              </button>
            ) : null,
        }]
      : []),
  ];

  return (
    <div>
      {error && <p role="alert" className="error">{error}</p>}
      <DataTable
        caption={onResend ? 'Email delivery, failures first, then newest first' : 'Email delivery, newest first'}
        columns={columns}
        rows={shown}
        rowKey={(r) => r.id}
        loading={!loaded && !error}
        empty="No emails yet."
      />
      <p ref={addedBox} tabIndex={-1} role="status" className="meta">{added ?? ''}</p>
      {next && <button type="button" onClick={() => void load(next)}>Show more</button>}
    </div>
  );
}

interface Status { provider: string; from: string | null; lastOutcome: { status: string; at: string } | null }

/** Settings → Email delivery. */
export function Deliveries() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [rows, setRows] = useState<Delivery[] | null>(null);
  const [more, setMore] = useState(false);
  const noticeBox = useRef<HTMLParagraphElement>(null);

  const loadStatus = useCallback(() => {
    api.get<Status>('/email/status').then(setStatus, (e) => setError(errText(e)));
  }, []);
  useEffect(loadStatus, [loadStatus]);
  const onLoaded = useCallback((r: Delivery[], m: boolean) => {
    setRows(r);
    setMore(m);
  }, []);

  const say = (m: string) => {
    setNotice(m);
    setTimeout(() => noticeBox.current?.focus(), 0);
  };

  async function test() {
    setError(null);
    setNotice(null);
    try {
      await api.post('/email/test');
      say('A test email is queued for your own address. Use Refresh in a minute to see how it went.');
      setReload((n) => n + 1);
      loadStatus();
    } catch (e) {
      setError(errText(e));
    }
  }

  async function resend(id: string) {
    setError(null);
    setNotice(null);
    try {
      await api.post(`/deliveries/${id}/resend`);
      say('Queued to send again.');
      loadStatus();
    } catch (e) {
      setError(errText(e));
    }
  }

  const day = rows ? lastDay(rows, Date.now()) : null;
  // Only the newest 50 emails are loaded; when all of them are from the last 24 hours there may be more.
  const atLeast = !!rows && more && rows.length > 0 && day !== null && day.total >= rows.length;
  const figure = (n: number) => String(n);
  const newest = atLeast ? 'Counted in the newest emails loaded (50 at a time)' : undefined;
  const sender = status ? (status.from ?? 'Not set (emails are written to the server log)') : null;

  return (
    <main className="page">
      <PageHeader
        crumbs={[{ text: 'Settings', href: '#/settings' }]}
        title="Email delivery"
        intro="Whether the emails Kainow sends are getting through, and which ones need sending again."
        action={<button type="button" onClick={() => { setReload((n) => n + 1); loadStatus(); }}>Refresh</button>}
      />
      {error && <p role="alert" className="error">{error}</p>}
      <p ref={noticeBox} tabIndex={-1} role="status" className="ok">{notice}</p>
      <section aria-labelledby="at-a-glance" className="settings-area">
        <h2 id="at-a-glance">At a glance</h2>
        <div className="stat-grid">
          <StatTile
            label="Email provider"
            value={status ? status.provider : '—'}
            meaning={status ? (status.provider === 'log' ? 'attention' : 'ok') : undefined}
            word={status?.provider === 'log' ? 'Not sending' : 'Set up'}
            note={sender ? `Sender: ${sender}` : undefined}
          />
          <StatTile label="Sent in the last 24 hours" value={day ? figure(day.sent) : '—'} meaning={day ? 'ok' : undefined} word="Delivered" note={newest} />
          <StatTile
            label="Failed in the last 24 hours"
            value={day ? figure(day.failed) : '—'}
            meaning={day ? (day.failed > 0 ? 'failing' : 'ok') : undefined}
            word={day && day.failed > 0 ? 'Failing' : 'None failed'}
            note={[day && day.uncertain > 0 ? `${day.uncertain} more with an uncertain outcome` : null, newest].filter(Boolean).join('. ') || undefined}
          />
          <StatTile
            label="Last outcome"
            value={status ? (status.lastOutcome ? (STATUS_TEXT[status.lastOutcome.status] ?? status.lastOutcome.status) : 'None yet') : '—'}
            note={status?.lastOutcome ? formatWhen(status.lastOutcome.at) : status ? 'No email sent yet' : undefined}
          />
        </div>
        <DeliveryHistory path="/deliveries" onResend={resend} reloadKey={reload} onLoaded={onLoaded} />
      </section>
      <section aria-labelledby="settings-area" className="settings-area">
        <h2 id="settings-area">Settings</h2>
        <section className="box settings-box" aria-labelledby="setting-test-email">
          <div className="settings-box-head">
            <h3 id="setting-test-email" className="box-title">Test email</h3>
            <button type="button" onClick={() => void test()}>Send test email</button>
          </div>
          <div className="settings-current">
            <p className="meta">Sends one email to your own address, to check that delivery works. The provider and sender are set when Kainow is installed and are shown above.</p>
          </div>
        </section>
      </section>
    </main>
  );
}
