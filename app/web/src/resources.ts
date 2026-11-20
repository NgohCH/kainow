/**
 * Resources on the web (resources-budget spec 3, 4). The types mirror what the server sends (app/src/resources/lines.service.ts,
 * report.service.ts, vocabulary.ts); the web cannot import server code. The wording is the server's wording.
 */
import type { FinanceSummary, FinanceView } from './finance.ts';
import { plural } from './format.ts';

export const UNITS = {
  hours: 'Hours',
  days: 'Days',
  person_hours: 'Person-hours',
  person_days: 'Person-days',
  items: 'Items',
  seats: 'Seats',
  square_metres: 'Square metres',
} as const;
export type Unit = keyof typeof UNITS;

export const LINE_STATUSES = {
  needed: 'Needed',
  arranged: 'Arranged',
  in_use: 'In use',
  finished: 'Finished',
  cancelled: 'Cancelled',
} as const;
export type LineStatus = keyof typeof LINE_STATUSES;

export const ONE_OFF_KINDS = ['equipment', 'facility', 'other'] as const;
export type OneOffKind = (typeof ONE_OFF_KINDS)[number];

export interface Overlap {
  named: { projectId: string; name: string }[];
  others: number;
}

export interface LineView {
  id: string;
  item: { id: string; kind: string; reference: string; name: string; category: string | null; retired: boolean } | null;
  oneOffKind: string | null;
  description: string;
  /** Two decimals as the server writes it ("2.00"). */
  quantity: string | null;
  unit: string | null;
  startsOn: string | null;
  endsOn: string | null;
  neededBy: string | null;
  notes: string;
  status: LineStatus;
  neededByPassed: boolean;
  overlap: Overlap | null;
  createdAt: string;
  updatedAt: string;
}

export interface PersonRow {
  userId: string;
  name: string;
  department: string | null;
  roles: string[];
  openTasks: number;
  overdue: number;
}

/** `GET /projects/:id/resources`. */
export interface ResourcesList {
  lines: LineView[];
  counts: Record<LineStatus, number>;
  people: PersonRow[];
  finance: FinanceSummary;
  computedAt: string;
}

export const REPORT_NOTE = 'Usage records, not bookings';

export interface ResourcesReport {
  header: { project: string; owningDepartment: string; generatedAt: string; note: typeof REPORT_NOTE };
  lines: LineView[];
  neededByPassed: LineView[];
  people: PersonRow[];
  /** Present only for the project's finance readers. */
  finance?: FinanceView;
}

export const unitLabel = (unit: string | null): string => (unit === null ? '' : ((UNITS as Record<string, string>)[unit] ?? unit));
export const statusLabel = (status: string): string => (LINE_STATUSES as Record<string, string>)[status] ?? status;

/** Whether a line shows in the list before the person asks for more: Finished and Cancelled are hidden by default. */
export function lineDefaultFilter(status: LineStatus): boolean {
  return status !== 'finished' && status !== 'cancelled';
}

/**
 * The overlap warning (D91), or null when no other project records the item in the period. A clause whose count is 0 is
 * left out: no names, or no hidden projects.
 */
export function overlapText(o: Overlap | null): string | null {
  if (o === null) return null;
  const hidden = o.others;
  const total = o.named.length + hidden;
  if (total === 0) return null;
  const parts = o.named.map((n) => n.name);
  if (hidden > 0) parts.push(`${plural(hidden, 'project')} you can't see`);
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return `Also recorded by ${plural(total, 'other project')} in this period: ${list}. This is not a booking. Arrange use with the resource's owner outside Kainow.`;
}

export interface LineForm {
  itemId: string | null;
  oneOffKind: string | null;
  description: string;
  quantity: string;
  unit: string | null;
  startsOn: string;
  endsOn: string;
  neededBy: string;
  notes: string;
}

const CHOOSE = 'Choose a catalogue item or describe a one-off resource.';
const ONE_OFF_KIND = 'Choose Equipment, Facility or Other.';
const DESCRIPTION = 'Enter a description of 1 to 200 characters.';
const NOTES = 'Notes can be up to 2,000 characters.';
const QUANTITY = 'Enter a quantity above 0 with at most 2 decimal places.';
const UNIT = 'Choose a unit from the list.';
const BOTH = 'Enter both a quantity and a unit, or neither.';
const DATE = 'Enter dates as YYYY-MM-DD.';
const START_FIRST = 'Enter a start date for the period.';
const END_BEFORE_START = 'The end date cannot be before the start date.';

const isBlank = (s: string | null | undefined): boolean => s === null || s === undefined || s.trim() === '';

function validDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** The first problem with a line form, in the server's order and words, or null when it can be sent. */
export function validateLineForm(form: LineForm): string | null {
  const hasItem = !isBlank(form.itemId);
  const hasKind = !isBlank(form.oneOffKind);
  if (hasItem === hasKind) return CHOOSE;
  if (hasKind) {
    if (!(ONE_OFF_KINDS as readonly string[]).includes(form.oneOffKind as string)) return ONE_OFF_KIND;
    const d = form.description.trim();
    if (d.length < 1 || d.length > 200) return DESCRIPTION;
  }
  const hasQuantity = !isBlank(form.quantity);
  const hasUnit = !isBlank(form.unit);
  if (hasQuantity !== hasUnit) return BOTH;
  if (hasQuantity) {
    const q = form.quantity.trim();
    if (!/^\d{1,12}(\.\d{1,2})?$/.test(q) || Number(q) === 0) return QUANTITY;
  }
  if (hasUnit && !Object.prototype.hasOwnProperty.call(UNITS, form.unit as string)) return UNIT;
  for (const d of [form.startsOn, form.endsOn, form.neededBy]) if (!isBlank(d) && !validDate(d.trim())) return DATE;
  const start = form.startsOn.trim();
  const end = form.endsOn.trim();
  if (end !== '' && start === '') return START_FIRST;
  if (end !== '' && end < start) return END_BEFORE_START;
  if (form.notes.trim().length > 2000) return NOTES;
  return null;
}
