import { useEffect, useState } from 'react';
import { ApiError } from '../api.ts';
import { FeedbackButton } from './Feedback.tsx';
import { analyseNow, analyseSelected, analysisBox, analysisStatus, type AnalysisStatusView } from '../discussion.ts';

/**
 * The status box of a thread: where analysis stands, the settings sentence, the last failure, and the buttons that ask for
 * an analysis. `refresh` changes each time the thread is polled, so the status is polled with the messages.
 */
export function AnalysisStatus({
  threadId,
  projectId,
  refresh,
  canRequest,
  selected,
  onRequested,
}: {
  threadId: string;
  projectId: string;
  refresh: number;
  canRequest: boolean;
  selected: string[];
  onRequested: () => void;
}) {
  const [status, setStatus] = useState<AnalysisStatusView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmRepeat, setConfirmRepeat] = useState(false);
  const [busy, setBusy] = useState(false);
  const [bump, setBump] = useState(0);

  useEffect(() => {
    let stale = false;
    analysisStatus(threadId).then(
      (s) => !stale && setStatus(s),
      () => undefined,
    );
    return () => {
      stale = true;
    };
  }, [threadId, refresh, bump]);

  async function request(work: () => Promise<unknown>, done: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await work();
      setConfirmRepeat(false);
      setNotice(done);
      setBump((b) => b + 1);
      onRequested();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.message.startsWith('No new messages')) {
        setConfirmRepeat(true);
        setError(e.message);
      } else {
        setError(e instanceof ApiError ? e.message : 'Something went wrong. Try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  const lines = status ? analysisBox(status) : [];
  return (
    <section className="panel analysis" aria-label="Analysis">
      {!status && <p className="meta">Loading the analysis status</p>}
      {lines.map((l, i) => (
        <p key={i} className={i === 0 ? 'analysis-line' : 'meta'}>{l}</p>
      ))}
      {canRequest && (
        <div className="actions">
          <button disabled={busy} onClick={() => request(() => analyseNow(threadId), 'Analysis requested.')}>Analyse now</button>
          <button
            disabled={busy || selected.length === 0 || selected.length > 50}
            onClick={() => request(() => analyseSelected(threadId, selected), 'Analysis of the selected messages requested.')}
          >
            Analyse selected messages{selected.length > 0 ? ` (${selected.length})` : ''}
          </button>
          {confirmRepeat && (
            <button disabled={busy} onClick={() => request(() => analyseNow(threadId, true), 'Analysis requested.')}>
              Analyse again anyway
            </button>
          )}
        </div>
      )}
      {canRequest && selected.length > 50 && <p className="error" role="alert">Choose at most 50 messages.</p>}
      {status?.lastRunId && (
        <FeedbackButton projectId={projectId} targetKind="analysis_run" targetId={status.lastRunId} label="The analysis missed an item or got one wrong" defaultCategory="missed_item" />
      )}
      {error && <p role="alert" className="error">{error}</p>}
      {notice && <p role="status" className="meta">{notice}</p>}
    </section>
  );
}
