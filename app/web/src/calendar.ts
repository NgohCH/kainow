// The project's calendar as the page needs it: which days count as working days (mirrors the server's rule; the server decides).

export interface CalendarSettings {
  dayCounting: 'working' | 'calendar';
  /** ISO weekdays: 1 = Monday … 7 = Sunday. */
  weekdays: number[];
  /** Organisation and project holidays, 'YYYY-MM-DD'. */
  holidays?: Iterable<string>;
}

const DAY = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** `Working Days, Mon–Fri` / `Working Days, Mon, Wed, Fri` / `Calendar Days`. Runs of three or more days read as a range. */
export function modeLabel(s: Pick<CalendarSettings, 'dayCounting' | 'weekdays'>): string {
  if (s.dayCounting === 'calendar') return 'Calendar Days';
  const days = [...new Set(s.weekdays)].filter((d) => d >= 1 && d <= 7).sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < days.length; ) {
    let j = i;
    while (j + 1 < days.length && days[j + 1] === days[j] + 1) j++;
    if (j - i >= 2) parts.push(`${DAY[days[i]]}–${DAY[days[j]]}`);
    else for (let k = i; k <= j; k++) parts.push(DAY[days[k]]);
    i = j + 1;
  }
  return `Working Days, ${parts.join(', ')}`;
}

/** Whether a 'YYYY-MM-DD' date is a working day. In Calendar Days mode every day is; a date that is not a date is not judged. */
export function isWorkingDayClient(s: CalendarSettings, date: string): boolean {
  if (s.dayCounting === 'calendar') return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return true;
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return true;
  const iso = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
  if (!s.weekdays.includes(iso)) return false;
  for (const h of s.holidays ?? []) if (h === date) return false;
  return true;
}

export const NOT_WORKING_DAY = "This is not a working day in this project's calendar. The deadline stays on this date.";
