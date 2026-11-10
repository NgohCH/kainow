// Helpers for the notification settings forms (pure, so they can be tested).

/** "7, 1" → [7, 1]. A word that is not a whole number becomes NaN, which the server refuses with its own message. */
export function parseLeadDays(text: string): number[] {
  return text
    .split(/[\s,;]+/)
    .filter((t) => t !== '')
    .map((t) => (/^\d+$/.test(t) ? Number(t) : Number.NaN));
}

export const leadDaysText = (days: number[]): string => days.join(', ');

export const FIELD_LABEL: Record<string, string> = {
  day_counting: 'day counting',
  weekdays: 'working weekdays',
  lead_days: 'reminder days',
  escalation_days: 'escalation delay',
  sweep_minutes: 'sweep interval',
  projects_may_change_calendar: 'projects may change the calendar',
  projects_may_change_timings: 'projects may change reminder timings',
  projects_may_change_digest: 'projects may change the digest',
  digest_enabled: 'action-item email schedule',
  digest_frequency: 'digest frequency',
  digest_weekday: 'digest weekday',
  digest_time: 'digest time',
  holiday: 'a holiday',
};

export const WEEKDAY_NAMES = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export interface PreviewItem { recordKind: string; recordId: string; title: string; kind: string; from: string | null; to: string | null }
export interface Preview { moved: PreviewItem[]; added: PreviewItem[]; removed: PreviewItem[] }

export const previewIsEmpty = (p: Preview): boolean => p.moved.length + p.added.length + p.removed.length === 0;

export const KIND_TEXT: Record<string, string> = {
  reminder: 'Reminder',
  overdue: 'Overdue notice',
  escalation: 'Escalation',
  parent_deadline: 'Parent deadline notice',
  review: 'Review date notice',
};
export const kindText = (k: string): string => KIND_TEXT[k] ?? k.replace(/_/g, ' ');

export interface Draft {
  dayCounting: 'working' | 'calendar';
  weekdays: number[];
  leadText: string;
  escalation: string;
  sweep: string;
  mayCalendar: boolean;
  mayTimings: boolean;
  mayDigest: boolean;
  digestEnabled: boolean;
  digestFrequency: 'daily' | 'weekly';
  digestWeekday: number;
  digestTime: string;
}

/** The values a form starts from. */
export interface Current {
  dayCounting: 'working' | 'calendar';
  weekdays: number[];
  leadDays: number[];
  escalationDays: number;
  sweepMinutes?: number;
  projectsMayChangeCalendar?: boolean;
  projectsMayChangeTimings?: boolean;
  projectsMayChangeDigest?: boolean;
  own?: {
    digestEnabled: boolean;
    digestFrequency: 'daily' | 'weekly' | null;
    digestWeekday: number | null;
    digestTime: string | null;
  };
}

export function draftFrom(c: Current): Draft {
  return {
    dayCounting: c.dayCounting,
    weekdays: [...c.weekdays].sort((a, b) => a - b),
    leadText: leadDaysText(c.leadDays),
    escalation: String(c.escalationDays),
    sweep: String(c.sweepMinutes ?? 15),
    mayCalendar: c.projectsMayChangeCalendar ?? false,
    mayTimings: c.projectsMayChangeTimings ?? false,
    mayDigest: c.projectsMayChangeDigest ?? false,
    digestEnabled: c.own?.digestEnabled ?? false,
    digestFrequency: c.own?.digestFrequency ?? 'daily',
    digestWeekday: c.own?.digestWeekday ?? 1,
    digestTime: c.own?.digestTime ?? '09:00',
  };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * What to send: only the settings that differ from where the form started. For a project, `cleared` names settings
 * handed back to the organisation (sent as null).
 */
export function buildChanges(scope: 'organisation' | 'project', start: Current, d: Draft, cleared: ReadonlySet<string> = new Set()): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const set = (field: string, value: unknown, was: unknown) => {
    if (scope === 'project' && cleared.has(field)) out[field] = null;
    else if (!same(value, was)) out[field] = value;
  };
  set('dayCounting', d.dayCounting, start.dayCounting);
  set('weekdays', [...d.weekdays].sort((a, b) => a - b), [...start.weekdays].sort((a, b) => a - b));
  set('leadDays', parseLeadDays(d.leadText), start.leadDays);
  set('escalationDays', d.escalation.trim() === '' ? Number.NaN : Number(d.escalation), start.escalationDays);
  if (scope === 'organisation') {
    set('sweepMinutes', d.sweep.trim() === '' ? Number.NaN : Number(d.sweep), start.sweepMinutes);
    set('projectsMayChangeCalendar', d.mayCalendar, start.projectsMayChangeCalendar);
    set('projectsMayChangeTimings', d.mayTimings, start.projectsMayChangeTimings);
    set('projectsMayChangeDigest', d.mayDigest, start.projectsMayChangeDigest);
  } else {
    const own = start.own ?? { digestEnabled: false, digestFrequency: null, digestWeekday: null, digestTime: null };
    if (d.digestEnabled !== own.digestEnabled) out.digestEnabled = d.digestEnabled;
    if (d.digestEnabled) {
      if (d.digestFrequency !== own.digestFrequency) out.digestFrequency = d.digestFrequency;
      if (d.digestTime !== own.digestTime) out.digestTime = d.digestTime;
      if (d.digestFrequency === 'weekly' && d.digestWeekday !== own.digestWeekday) out.digestWeekday = d.digestWeekday;
    }
  }
  return out;
}
