import type { ProjectStatus } from '../projects/matrix';
import type { EffectiveAnalysisSettings } from './settings.service';

/** What the pure rules need to know about one thread. Loaded set-based by facts.ts. */
export interface ThreadFacts {
  kind: 'discussion' | 'meeting';
  projectStatus: ProjectStatus;
  meetingState: 'open' | 'ended' | null;
  /** The newest visible message above the "analysed up to" cursor (the newest visible message when any is unanalysed). */
  newestVisibleAt: Date | null;
  unanalysedCount: number;
  activeRun: 'queued' | 'running' | null;
  /** Starts of automatic (quiet_period) runs; older than the rolling window are ignored by the rules. */
  recentAutoStarts: Date[];
  hasHumanDraft: boolean;
  lastAnalysedAt: Date | null;
  lastFailure: string | null;
}

/** Whether an automatic run could be paid for. A missing AI key is not a status reason: it shows as a run failure (ruling R5). */
export interface Readiness {
  spendApproved: boolean;
  allowanceLeft: boolean;
}

export type AnalysisStatus =
  | { state: 'up_to_date'; lastAnalysedAt: Date | null }
  | { state: 'waiting'; at: Date; reason: 'quiet' | 'limit' }
  | { state: 'queued' }
  | { state: 'running' }
  | { state: 'paused'; reason: string }
  | { state: 'blocked'; reason: string };

export const ROLLING_WINDOW_MINUTES = 20;
export const ROLLING_LIMIT = 2;
const MINUTE = 60_000;
const OPEN_STATES: ProjectStatus[] = ['draft', 'planned', 'active'];

/** Spec 7.2 and 7.3: one place decides both the status shown and whether the tick starts a run. */
export function analysisState(t: ThreadFacts, s: EffectiveAnalysisSettings, r: Readiness, now: Date): { status: AnalysisStatus; due: boolean } {
  const show = (status: AnalysisStatus) => ({ status, due: false });
  if (t.activeRun) return show({ state: t.activeRun });
  if (!OPEN_STATES.includes(t.projectStatus)) {
    return show({ state: 'paused', reason: `The project is ${t.projectStatus === 'deferred' ? 'Deferred' : 'Closed'}.` });
  }
  if (t.unanalysedCount === 0) return show({ state: 'up_to_date', lastAnalysedAt: t.lastAnalysedAt });
  if (t.kind === 'meeting' && t.meetingState === 'ended') return show({ state: 'up_to_date', lastAnalysedAt: t.lastAnalysedAt });
  if (!s.automatic) return show({ state: 'paused', reason: 'Automatic analysis is off for this project.' });
  if (t.kind === 'meeting' && t.hasHumanDraft) return show({ state: 'paused', reason: 'Automatic minutes paused: edited by a person.' });
  const newest = t.newestVisibleAt ?? now;
  const quietEnds = new Date(newest.getTime() + s.quietMinutes * MINUTE);
  if (now < quietEnds) return show({ state: 'waiting', at: quietEnds, reason: 'quiet' });
  const windowStart = now.getTime() - ROLLING_WINDOW_MINUTES * MINUTE;
  const inWindow = t.recentAutoStarts.filter((d) => d.getTime() > windowStart).sort((a, b) => b.getTime() - a.getTime());
  if (inWindow.length >= ROLLING_LIMIT) {
    // The limit lifts when the older of the last two starts leaves the window.
    return show({ state: 'waiting', at: new Date(inWindow[ROLLING_LIMIT - 1].getTime() + ROLLING_WINDOW_MINUTES * MINUTE), reason: 'limit' });
  }
  if (!r.spendApproved) return show({ state: 'blocked', reason: 'The AI spend settings have not been approved yet.' });
  if (!r.allowanceLeft) return show({ state: 'blocked', reason: 'There is no AI allowance left.' });
  return { status: { state: 'waiting', at: now, reason: 'quiet' }, due: true };
}

/** The sentence shown beneath every status (spec 7.3, O04). */
export function explanation(s: EffectiveAnalysisSettings): string {
  if (!s.automatic) return 'Automatic analysis is off for this project.';
  return `Automatic analysis: after ${s.quietMinutes} minutes without new messages; maximum ${ROLLING_LIMIT} analyses per thread in any rolling ${ROLLING_WINDOW_MINUTES} minutes.`;
}

/** HH:mm in UTC+8. */
export function hhmm(d: Date): string {
  return new Date(d.getTime() + 8 * 60 * MINUTE).toISOString().slice(11, 16);
}

export function statusLine(st: AnalysisStatus): string {
  switch (st.state) {
    case 'up_to_date':
      return st.lastAnalysedAt ? `Up to date — last analysed ${hhmm(st.lastAnalysedAt)}` : 'Up to date';
    case 'waiting':
      return st.reason === 'limit' ? `Limit reached — next eligible ${hhmm(st.at)}` : `Analysis at ${hhmm(st.at)} if no new messages`;
    case 'queued':
      return 'Queued';
    case 'running':
      return 'Running';
    case 'paused':
      return `Paused — ${st.reason}`;
    case 'blocked':
      return `Blocked — ${st.reason}`;
  }
}
