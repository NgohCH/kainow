/**
 * Reads a proposal's due wording ("End of November 2026", "Immediate", "after approval") as an exact day,
 * a range of days, an event the item waits on, or "needs a date". Kainow works this out each time a
 * proposal is shown or approved; the reading is never stored, so a new meeting date takes effect at once.
 *
 * Days are 'YYYY-MM-DD' calendar dates (UTC+8 days, no time). All arithmetic uses UTC so the server's
 * own time zone never shifts a day.
 */

export type DueState = 'exact' | 'range' | 'event' | 'needs_date';

export interface DueReading {
  state: DueState;
  earliest: string | null;
  latest: string | null;
  event: string | null;
  reason: string | null;
  note: string | null;
  usedMeetingDate: boolean;
}

export interface DueInput {
  due: string | null;
  dueEvent: string | null;
  meetingDate: string | null;
}

export interface ReviewerDue {
  earliest: string | null;
  latest: string | null;
  event: string | null;
}

const REASON = {
  none: 'no due given',
  noYear: 'no year and no meeting date',
  relative: 'relative wording and no meeting date',
  period: 'a period or repeat, not a deadline',
  several: 'several dates in one item; not all are dates',
  unknown: 'wording not understood',
} as const;
const SEVERAL_NOTE = 'several dates in one item';

/** English and Bahasa Melayu month names and short forms. */
const MONTHS: Record<string, number> = {
  january: 1, jan: 1, januari: 1,
  february: 2, feb: 2, februari: 2,
  march: 3, mar: 3, mac: 3,
  april: 4, apr: 4,
  may: 5, mei: 5,
  june: 6, jun: 6,
  july: 7, jul: 7, julai: 7,
  august: 8, aug: 8, ogos: 8, ogo: 8,
  september: 9, sep: 9, sept: 9,
  october: 10, oct: 10, oktober: 10, okt: 10,
  november: 11, nov: 11,
  december: 12, dec: 12, disember: 12, dis: 12,
};
const MONTH = `(${Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|')})`;
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const NUMBER_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const COUNT = `(\\d{1,3}|${Object.keys(NUMBER_WORDS).join('|')})`;

const re = (src: string) => new RegExp(`^${src}$`);
const P = {
  isoDate: re(`(\\d{4})-(\\d{2})-(\\d{2})`),
  /** Day first, as dates are written in Malaysia: 14/05/2026 is 14 May. */
  numericDate: re(`(\\d{1,2})[/-](\\d{1,2})[/-](\\d{4})`),
  dayMonthYear: re(`(\\d{1,2}) ${MONTH} (\\d{4})`),
  dayMonth: re(`(\\d{1,2}) ${MONTH}`),
  beforeDay: re(`before (\\d{1,2}) ${MONTH}(?: (\\d{4}))?`),
  beforeMonth: re(`before ${MONTH}(?: (\\d{4}))?`),
  partOfMonth: re(`(?:by )?(end(?: of)?|mid|early|late)(?:-| )?${MONTH}(?: (\\d{4}))?`),
  monthSpan: re(`${MONTH} ?- ?${MONTH}(?: (\\d{4}))?`),
  month: re(`${MONTH}(?: (\\d{4}))?`),
  weekday: re(`(${WEEKDAYS.join('|')})`),
  immediate: re(`(immediate|immediately|asap)`),
  within: re(`within ${COUNT} (days?|weeks?)`),
  next: re(`next ${COUNT} (days?|weeks?)`),
  nextWeek: /^next week$/,
  nextMonth: /^next month$/,
  nextWeekday: re(`next (${WEEKDAYS.join('|')})`),
  period: /^(every|throughout|ongoing|once (a|an|every|per)\b)/,
  event: /^(after|upon|before|during|following|once|next|subject to|on completion)\b/,
  /**
   * An event word followed straight away by something that looks like a date ("before 30 Nov", "before June
   * rollout", "next year"). Such wording is date wording that could not be read, never an event: an event
   * lets an action be approved with no date.
   */
  eventLooksLikeDate: new RegExp(
    `^(after|upon|before|during|following|once|next|subject to) (\\d|the \\d|${MONTH}\\b|(end|mid|early|late)\\b|(week|month|year|quarter|semester|term)\\b)`,
  ),
};

/** "by" and "on" before a date or a weekday add nothing: "By 30 November", "on Friday". */
const LEADING_BY = new RegExp(`^(by|on) (?=\\d|${MONTH}\\b|(${WEEKDAYS.join('|')})\\b|(end|mid|early|late|next|within)\\b)`);

/** True for a real day written 'YYYY-MM-DD'. */
export function isCalendarDate(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number);
  return m >= 1 && m <= 12 && d >= 1 && d <= lastDay(y, m);
}

function lastDay(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function iso(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return iso(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

type Part =
  | { kind: 'date'; earliest: string; latest: string; used: boolean }
  | { kind: 'event' }
  | { kind: 'needs'; reason: string };

const unknown = (): Part => ({ kind: 'needs', reason: REASON.unknown });

/**
 * A span of days in one year. When the wording gave no year, the meeting's year is used, moved one year
 * on if the span would already be over at the meeting.
 */
function inYear(year: string | undefined, meeting: string | null, make: (y: number) => [string, string] | null): Part {
  if (year) {
    const span = make(Number(year));
    return span ? { kind: 'date', earliest: span[0], latest: span[1], used: false } : unknown();
  }
  if (!meeting) return { kind: 'needs', reason: REASON.noYear };
  const y = Number(meeting.slice(0, 4));
  let span = make(y);
  if (span && span[1] < meeting) span = make(y + 1);
  return span ? { kind: 'date', earliest: span[0], latest: span[1], used: true } : unknown();
}

function day(y: number, month: string, d: string): string | null {
  const m = MONTHS[month];
  const n = Number(d);
  return n >= 1 && n <= lastDay(y, m) ? iso(y, m, n) : null;
}

function relative(meeting: string | null, make: (meeting: string) => [string, string]): Part {
  if (!meeting) return { kind: 'needs', reason: REASON.relative };
  const [earliest, latest] = make(meeting);
  return { kind: 'date', earliest, latest, used: true };
}

const count = (v: string): number => NUMBER_WORDS[v] ?? Number(v);
const days = (n: number, unit: string): number => (unit.startsWith('week') ? n * 7 : n);

/** Reads one piece of wording, already lower case with spaces collapsed. */
function readPart(s: string, meeting: string | null): Part {
  let m: RegExpExecArray | null;
  if ((m = P.isoDate.exec(s) ?? P.numericDate.exec(s))) {
    const [y, mo, d] = P.isoDate.test(s) ? [m[1], m[2], m[3]] : [m[3], m[2], m[1]];
    const v = iso(Number(y), Number(mo), Number(d));
    return isCalendarDate(v) ? { kind: 'date', earliest: v, latest: v, used: false } : unknown();
  }
  if ((m = P.dayMonthYear.exec(s))) {
    const d = day(Number(m[3]), m[2], m[1]);
    return d ? { kind: 'date', earliest: d, latest: d, used: false } : unknown();
  }
  if ((m = P.dayMonth.exec(s))) {
    const [, d, month] = m;
    return inYear(undefined, meeting, (y) => {
      const v = day(y, month, d);
      return v ? [v, v] : null;
    });
  }
  if ((m = P.beforeDay.exec(s))) {
    const [, d, month, year] = m;
    return inYear(year, meeting, (y) => {
      const v = day(y, month, d);
      return v ? [addDays(v, -1), addDays(v, -1)] : null;
    });
  }
  if ((m = P.beforeMonth.exec(s))) {
    const [, month, year] = m;
    return inYear(year, meeting, (y) => {
      const v = addDays(iso(y, MONTHS[month], 1), -1);
      return [v, v];
    });
  }
  if ((m = P.partOfMonth.exec(s))) {
    const [, part, month, year] = m;
    const mo = MONTHS[month];
    return inYear(year, meeting, (y) => {
      const last = lastDay(y, mo);
      if (part.startsWith('end')) return [iso(y, mo, last), iso(y, mo, last)];
      if (part === 'mid') return [iso(y, mo, 10), iso(y, mo, 20)];
      if (part === 'early') return [iso(y, mo, 1), iso(y, mo, 10)];
      return [iso(y, mo, 21), iso(y, mo, last)];
    });
  }
  if ((m = P.monthSpan.exec(s))) {
    const [, from, to, year] = m;
    // "November-January" runs into the next year.
    return inYear(year, meeting, (y) => {
      const y2 = MONTHS[to] < MONTHS[from] ? y + 1 : y;
      return [iso(y, MONTHS[from], 1), iso(y2, MONTHS[to], lastDay(y2, MONTHS[to]))];
    });
  }
  if ((m = P.month.exec(s))) {
    const [, month, year] = m;
    return inYear(year, meeting, (y) => [iso(y, MONTHS[month], 1), iso(y, MONTHS[month], lastDay(y, MONTHS[month]))]);
  }
  if ((m = P.weekday.exec(s))) {
    const target = WEEKDAYS.indexOf(m[1]);
    return relative(meeting, (meet) => {
      const [y, mo, d] = meet.split('-').map(Number);
      const today = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
      const ahead = ((target - today + 7) % 7) || 7;
      const v = addDays(meet, ahead);
      return [v, v];
    });
  }
  if (P.immediate.test(s)) return relative(meeting, (meet) => [meet, addDays(meet, 3)]);
  if ((m = P.within.exec(s))) {
    const n = days(count(m[1]), m[2]);
    return relative(meeting, (meet) => [meet, addDays(meet, n)]);
  }
  if ((m = P.next.exec(s))) {
    const n = days(count(m[1]), m[2]);
    return relative(meeting, (meet) => [addDays(meet, 1), addDays(meet, n)]);
  }
  if (P.nextWeek.test(s)) {
    return relative(meeting, (meet) => {
      const monday = addDays(meet, daysToNextMonday(meet));
      return [monday, addDays(monday, 6)];
    });
  }
  if (P.nextMonth.test(s)) {
    return relative(meeting, (meet) => {
      const [y, mo] = meet.split('-').map(Number);
      const ny = mo === 12 ? y + 1 : y;
      const nm = mo === 12 ? 1 : mo + 1;
      return [iso(ny, nm, 1), iso(ny, nm, lastDay(ny, nm))];
    });
  }
  if ((m = P.nextWeekday.exec(s))) {
    // That weekday in the week (Monday to Sunday) after the meeting's week.
    const target = WEEKDAYS.indexOf(m[1]);
    return relative(meeting, (meet) => {
      const v = addDays(meet, daysToNextMonday(meet) + ((target + 6) % 7));
      return [v, v];
    });
  }
  if (P.period.test(s)) return { kind: 'needs', reason: REASON.period };
  if (/^before end( of)? /.test(s)) return readPart(s.replace(/^before /, ''), meeting);
  if (/^during /.test(s)) {
    const inner = readPart(s.replace(/^during /, ''), meeting);
    if (inner.kind === 'date') return inner;
  }
  if (P.eventLooksLikeDate.test(s)) return unknown();
  if (P.event.test(s)) return { kind: 'event' };
  return unknown();
}

function daysToNextMonday(day: string): number {
  const [y, m, d] = day.split('-').map(Number);
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return (8 - weekday) % 7 || 7;
}

const tidy = (s: string): string => s.replace(/\s+/g, ' ').trim();
/** Drops a leading "Label:" and a trailing "for the …". */
const core = (s: string): string => tidy(s).replace(/^[^:]+:\s*/, '').replace(/ for (the|a|an) .*$/i, '');
/** Lower case, plain dashes, no trailing full stop or commas, no ordinal endings ("30th"), no leading "by"/"on". */
const lower = (s: string): string =>
  core(s)
    .toLowerCase()
    .replace(/[–—]/g, '-')
    .replace(/[.,;:!]+$/, '')
    .replace(/,/g, '')
    .replace(/\b(\d{1,2})(st|nd|rd|th)\b/g, '$1')
    .replace(LEADING_BY, '');

function reading(over: Partial<DueReading> & { state: DueState }): DueReading {
  return { earliest: null, latest: null, event: null, reason: null, note: null, usedMeetingDate: false, ...over };
}

function fromDates(earliest: string, latest: string, usedMeetingDate: boolean, note: string | null = null): DueReading {
  return reading({ state: earliest === latest ? 'exact' : 'range', earliest, latest, usedMeetingDate, note });
}

/** The reading of a due. A reviewer's due, when given, replaces the reading of the wording. */
export function readDue(input: DueInput, reviewer?: ReviewerDue | null): DueReading {
  if (reviewer?.event) return reading({ state: 'event', event: reviewer.event });
  if (reviewer?.earliest) return fromDates(reviewer.earliest, reviewer.latest ?? reviewer.earliest, false);

  const dueEvent = input.dueEvent && tidy(input.dueEvent) !== '' ? tidy(input.dueEvent) : null;
  const wording = input.due ? tidy(input.due) : '';
  if (wording === '') return dueEvent ? reading({ state: 'event', event: dueEvent }) : reading({ state: 'needs_date', reason: REASON.none });

  const parts = wording.split(';').map((p) => p.trim()).filter((p) => p !== '');
  if (parts.length > 1) {
    const read = parts.map((p) => readPart(lower(p), input.meetingDate));
    if (read.every((r) => r.kind === 'date')) {
      const dates = read as Array<Extract<Part, { kind: 'date' }>>;
      const earliest = dates.map((d) => d.earliest).sort()[0];
      const latest = dates.map((d) => d.latest).sort().at(-1) as string;
      return fromDates(earliest, latest, dates.some((d) => d.used), SEVERAL_NOTE);
    }
    return reading({ state: 'needs_date', reason: REASON.several });
  }

  const part = readPart(lower(wording), input.meetingDate);
  if (part.kind === 'date') return fromDates(part.earliest, part.latest, part.used);
  if (part.kind === 'event') return reading({ state: 'event', event: dueEvent ?? core(wording) });
  // Wording that cannot be read ("TBC") still waits on the event the model named, if it named one.
  if (part.reason === REASON.unknown && dueEvent) return reading({ state: 'event', event: dueEvent });
  return reading({ state: 'needs_date', reason: part.reason });
}
