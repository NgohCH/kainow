import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import type { GoLiveSummary } from '../golive.ts';

/** The summary while the checklist is open; null otherwise (a 404 for non-Administrators means no banner). */
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
    return () => window.removeEventListener('golive-changed', load);
  }, [enabled]);
  return s;
}
