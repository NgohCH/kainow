import { useCallback, useState } from 'react';
import { ApiError, api } from '../api.ts';

export type Act = (path: string, body: object, done: string) => Promise<boolean>;
export type Propose = (kind: string, targetKind: string, targetId: string, terms: Record<string, unknown>) => Promise<boolean>;

const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'That did not work. Try again.');

/** Changes to a project's records, as the Work tab and the task page make them: send, show the outcome, reload. */
export function useRecordChanges(projectId: string, load: () => void) {
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  /** A change made elsewhere on the page (a decided request, a deletion, a report): its message, and reload. */
  const changed = useCallback(
    (message: string) => {
      setError(null);
      setNotice(message);
      load();
    },
    [load],
  );

  const attempt = useCallback(
    async (path: string, body: object, done: string) => {
      setError(null);
      setNotice(null);
      try {
        await api.post(path, body);
        changed(done);
        return true;
      } catch (e) {
        setError(errText(e));
        return false;
      }
    },
    [changed],
  );

  /** Sends one change and reloads; shows the server's reason when it is refused. */
  const act: Act = attempt;

  /** Proposes a change for authorisation; the request then appears under Waiting for authorisation. */
  const propose: Propose = useCallback(
    (kind, targetKind, targetId, terms) =>
      attempt(`/projects/${projectId}/changes`, { kind, targetKind, targetId, terms, reason: String(terms.reason ?? '') }, 'Proposed. It now waits for authorisation.'),
    [projectId, attempt],
  );

  return { error, setError, notice, setNotice, act, propose, changed };
}
