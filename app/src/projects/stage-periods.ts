/**
 * Where a stage stops (D138). A stored stage period stays open while its project is Deferred or Closed, and resuming or
 * reopening closes it at that moment; what is shown ends at the deferral or closure instead. Worked out on read from the
 * status history, on exact instants, so several changes on one day come out in their true order.
 */
import type { ProjectStatus } from './matrix';
import { todayUtc8 } from './membership';

export interface PeriodTimes {
  startedAt: Date;
  endedAt: Date | null;
}

export interface TransitionTime {
  to: ProjectStatus;
  at: Date;
}

/** `endedAt` is where the period is shown to end and `endedOn` its UTC+8 day; `stopped` says what stopped it, or null when nothing did. */
export type ClippedPeriod<P extends PeriodTimes> = P & { endedOn: string | null; stopped: 'deferred' | 'closed' | null };

interface Pause {
  why: 'deferred' | 'closed';
  from: number;
  /** When the project was resumed or reopened; Infinity while it has not been. */
  until: number;
}

/** Deferred and then closed is one pause, from the deferral. One with no end counts only while the project is Deferred or Closed now. */
function pausesOf(transitions: readonly TransitionTime[], status: ProjectStatus): Pause[] {
  const out: Pause[] = [];
  for (const { to, at } of transitions) {
    const last = out[out.length - 1];
    const paused = last !== undefined && last.until === Infinity;
    if (to === 'deferred' || to === 'closed') {
      if (!paused) out.push({ why: to, from: at.getTime(), until: Infinity });
    } else if (paused) last.until = at.getTime();
  }
  return status === 'deferred' || status === 'closed' ? out : out.filter((x) => x.until !== Infinity);
}

/**
 * Each period clipped at the first deferral or closure inside it. `transitions` are the project's, oldest first, and `status` is its status now. A pause
 * over by the time the period began does not touch it (a resumption's period begins at the same instant as it), nor does
 * one that began as the period ended, unless the resumption is what ended it.
 */
export function clipPeriods<P extends PeriodTimes>(periods: readonly P[], transitions: readonly TransitionTime[], status: ProjectStatus): ClippedPeriod<P>[] {
  const pauses = pausesOf(transitions, status);
  return periods.map((p) => {
    const start = p.startedAt.getTime();
    const end = p.endedAt === null ? Infinity : p.endedAt.getTime();
    const pause = pauses.find((x) => x.until > start && (x.from < end || x.until === end));
    const endedAt = pause ? new Date(Math.max(start, pause.from)) : p.endedAt;
    return { ...p, endedAt, endedOn: endedAt === null ? null : todayUtc8(endedAt), stopped: pause?.why ?? null };
  });
}
