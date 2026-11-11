// Pure working-day calendar (spec §3, §4). No database, no local time zone: dates are
// YYYY-MM-DD strings (UTC+8 calendar dates) and instants are UTC Dates.

export type DayCounting = 'working' | 'calendar';

export interface Calendar {
  dayCounting: DayCounting;
  /** ISO weekdays, 1 = Monday .. 7 = Sunday. */
  weekdays: number[];
  /** Organisation and project holidays, YYYY-MM-DD. */
  holidays: ReadonlySet<string>;
}

const MAX_STEPS = 366;
const DAY_MS = 86_400_000;
const OFFSET_MS = 8 * 3_600_000; // UTC+8

// The date/instant conversions are memoised: the sweep walks the same few hundred dates many thousands of times.
// The keys are calendar dates, so the caches stay small however long the process runs.
const MS_OF = new Map<string, number>();
const DATE_OF = new Map<number, string>();

const dateMs = (date: string): number => {
  const known = MS_OF.get(date);
  if (known !== undefined) return known;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new Error(`Invalid date: ${date}`);
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (MS_OF.size < 50_000) MS_OF.set(date, ms);
  return ms;
};
const msDate = (ms: number): string => {
  const known = DATE_OF.get(ms);
  if (known !== undefined) return known;
  const date = new Date(ms).toISOString().slice(0, 10);
  if (DATE_OF.size < 50_000) DATE_OF.set(ms, date);
  return date;
};
const shiftDays = (date: string, n: number): string => msDate(dateMs(date) + n * DAY_MS);
/** ISO weekday of a UTC midnight: 1970-01-01 was a Thursday (4). */
const isoWeekday = (date: string): number => ((((Math.floor(dateMs(date) / DAY_MS) + 3) % 7) + 7) % 7) + 1;

export function isWorkingDay(cal: Calendar, date: string): boolean {
  if (cal.dayCounting === 'calendar') return true;
  return cal.weekdays.includes(isoWeekday(date)) && !cal.holidays.has(date);
}

function walk(cal: Calendar, date: string, n: number, dir: 1 | -1): string {
  if (!Number.isInteger(n) || n < 0) throw new Error('Step count must be a non-negative integer');
  let d = date;
  let left = n;
  let guard = 0;
  while (left > 0) {
    d = shiftDays(d, dir);
    if (isWorkingDay(cal, d)) left -= 1;
    if (++guard > MAX_STEPS * Math.max(1, n)) throw new Error('Calendar has no working day');
  }
  return d;
}

/** Previous working day, n times (calendar mode: plain days). `date` itself is not counted. */
export function stepBackWorking(cal: Calendar, date: string, n: number): string {
  if (n > 0 && cal.dayCounting === 'working') requireWorkingDay(cal, date);
  return walk(cal, date, n, -1);
}

/** The n-th working day after `date` (calendar mode: plain days). */
export function addWorkingDays(cal: Calendar, date: string, n: number): string {
  if (n > 0 && cal.dayCounting === 'working') requireWorkingDay(cal, date);
  return walk(cal, date, n, 1);
}

function requireWorkingDay(cal: Calendar, from: string): void {
  for (let i = 1; i <= MAX_STEPS; i += 1) {
    if (isWorkingDay(cal, shiftDays(from, i))) return;
  }
  throw new Error('Calendar has no working day');
}

/** 09:00 UTC+8 on the date (01:00Z). */
export function slotOn(date: string): Date {
  return new Date(dateMs(date) + 9 * 3_600_000 - OFFSET_MS);
}

/** 23:59:59 UTC+8 on the date (15:59:59Z). */
export function deadlineOf(date: string): Date {
  return new Date(dateMs(date) + DAY_MS - 1000 - OFFSET_MS);
}

/** 09:00 UTC+8 on the first working day whose 09:00 is at or after t. */
export function nextSlot(cal: Calendar, t: Date): Date {
  let d = msDate(t.getTime() + OFFSET_MS);
  if (slotOn(d).getTime() < t.getTime()) d = shiftDays(d, 1);
  for (let i = 0; i <= MAX_STEPS; i += 1) {
    if (isWorkingDay(cal, d)) return slotOn(d);
    d = shiftDays(d, 1);
  }
  throw new Error('Calendar has no working day');
}

export function reminderAt(cal: Calendar, dueOn: string, lead: number): Date {
  return slotOn(stepBackWorking(cal, dueOn, lead));
}

export function escalationAt(cal: Calendar, dueOn: string, delay: number): Date {
  return nextSlot(cal, deadlineOf(addWorkingDays(cal, dueOn, delay)));
}

export function riskDueAt(cal: Calendar, reviewOn: string): Date {
  return slotOn(isWorkingDay(cal, reviewOn) ? reviewOn : stepBackWorking(cal, reviewOn, 1));
}

export function riskMissedAt(cal: Calendar, reviewOn: string): Date {
  return nextSlot(cal, deadlineOf(reviewOn));
}
