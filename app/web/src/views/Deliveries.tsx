import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api } from '../api.ts';
import { formatWhen } from '../format.ts';

const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'That did not work. Try again.');
const DUPLICATE = 'Possible duplicate: an earlier attempt may have been delivered';

interface Delivery {
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
  queued: 'Queued', sending: 'Sending', retry_wait: 'Waiting to retry', sent: 'Sent', failed: 'Failed', cancelled: 'Cancelled', uncertain: 'Uncertain',
};
const kindText = (k: string) => k.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

/** Email deliveries, newest first, 50 at a time. With `onResend` (Administrator) failed and uncertain rows can be sent again. */
export function DeliveryHistory({ path, onResend, reloadKey = 0 }: { path: string; onResend?: (id: string) => Promise<void>; reloadKey?: number }) {
  const [rows, setRows] = useState<Delivery[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const firstNew = useRef<string | null>(null);
  const table = useRef<HTMLTableElement>(null);

  const load = useCallback(
    async (cursor: string | null) => {
      setError(null);
      try {
        const page = await api.get<Page>(cursor ? `${path}?before=${encodeURIComponent(cursor)}` : path);
        if (cursor) firstNew.current = page.items[0]?.id ?? null;
        setRows((r) => (cursor ? [...r, ...page.items] : page.items));
        setNext(page.more ? page.next : null);
      } catch (e) {
        setError(errText(e));
      } finally {
        setLoaded(true);
      }
    },
    [path],
  );
  useEffect(() => void load(null), [load, reloadKey]);

  // After "Show more", focus moves to the first new row so a keyboard user continues from there.
  useEffect(() => {
    if (!firstNew.current) return;
    table.current?.querySelector<HTMLElement>(`[data-row="${firstNew.current}"]`)?.focus();
    firstNew.current = null;
  }, [rows]);

  async function resend(id: string) {
    setBusy(id);
    try {
      await onResend?.(id);
      await load(null);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      {error && <p role="alert" className="error">{error}</p>}
      {loaded && rows.length === 0 && !error && <p className="empty">No emails yet.</p>}
      {rows.length > 0 && (
        <table className="table deliveries" ref={table}>
          <caption>Email delivery, newest first</caption>
          <thead>
            <tr>
              <th scope="col">Recipient</th>
              <th scope="col">Kind</th>
              <th scope="col">Subject</th>
              <th scope="col">Created (UTC+8)</th>
              <th scope="col">Status</th>
              <th scope="col">Attempts</th>
              <th scope="col">Last reason</th>
              {onResend && <th scope="col">Action</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} data-row={r.id} tabIndex={-1}>
                <td>{r.recipientName}<span className="meta"> {r.toAddress}</span></td>
                <td>{kindText(r.kind)}</td>
                <td>{r.subject}</td>
                <td>{formatWhen(r.createdAt)}</td>
                <td>
                  {STATUS_TEXT[r.status] ?? r.status}
                  {r.possibleDuplicate && <span className="warn inline">{DUPLICATE}</span>}
                </td>
                <td>{r.attempts}</td>
                <td>{r.lastReason ?? ''}</td>
                {onResend && (
                  <td>
                    {(r.status === 'failed' || r.status === 'uncertain') && (
                      <button type="button" disabled={busy !== null} onClick={() => void resend(r.id)}>
                        Resend<span className="visually-hidden">: {r.subject} to {r.recipientName}</span>
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {next && <button type="button" onClick={() => void load(next)}>Show more</button>}
    </div>
  );
}

interface Status { provider: string; from: string | null; lastOutcome: { status: string; at: string } | null }

/** Administration → Email delivery. */
export function Deliveries() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const noticeBox = useRef<HTMLParagraphElement>(null);

  const loadStatus = useCallback(() => {
    api.get<Status>('/email/status').then(setStatus, (e) => setError(errText(e)));
  }, []);
  useEffect(loadStatus, [loadStatus]);

  const say = (m: string) => {
    setNotice(m);
    setTimeout(() => noticeBox.current?.focus(), 0);
  };

  async function test() {
    setError(null);
    setNotice(null);
    try {
      await api.post('/email/test');
      say('A test email is queued for your own address. Refresh the list in a minute to see how it went.');
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

  return (
    <main className="page">
      <h1>Email delivery</h1>
      {error && <p role="alert" className="error">{error}</p>}
      <p ref={noticeBox} tabIndex={-1} role="status" className="ok">{notice}</p>
      <section className="panel" aria-labelledby="provider-heading">
        <h2 id="provider-heading">Email provider</h2>
        {status ? (
          <dl className="facts">
            <div><dt>Provider</dt><dd>{status.provider}</dd></div>
            <div><dt>Sender</dt><dd>{status.from ?? 'Not set (emails are written to the server log)'}</dd></div>
            <div>
              <dt>Last outcome</dt>
              <dd>{status.lastOutcome ? `${STATUS_TEXT[status.lastOutcome.status] ?? status.lastOutcome.status}, ${formatWhen(status.lastOutcome.at)}` : 'No email sent yet'}</dd>
            </div>
          </dl>
        ) : (
          <p className="loading">Loading</p>
        )}
        <button type="button" onClick={() => void test()}>Send test email</button>
      </section>
      <DeliveryHistory path="/deliveries" onResend={resend} reloadKey={reload} />
    </main>
  );
}
