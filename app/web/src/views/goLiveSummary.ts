import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import type { GoLiveSummary } from '../golive.ts';

/**
 * The summary while the checklist is open; null otherwise (a 404 for non-Administrators means no banner).
 * Enable it only once the organisation is registered: before that every request is refused. It is fetched again
 * on every page change, so a close made elsewhere is picked up.
 */
export function useGoLiveSummary(enabled: boolean): GoLiveSummary | null {
  const [s, setS] = useState<GoLiveSummary | null>(null);
  useEffect(() => {
    if (!enabled) {
      setS(null);
      return;
    }
    const load = () => {
      api.get<GoLiveSummary>('/go-live/summary').then((r) => setS(r.open ? r : null), () => setS(null));
    };
    load();
    window.addEventListener('golive-changed', load);
    window.addEventListener('hashchange', load);
    return () => {
      window.removeEventListener('golive-changed', load);
      window.removeEventListener('hashchange', load);
    };
  }, [enabled]);
  return s;
}
