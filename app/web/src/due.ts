import type { Item, Run } from './api.ts';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function parts(iso: string): { y: string; m: string; d: number } {
  const [y, m, d] = iso.split('-');
  return { y, m: MONTHS[Number(m) - 1], d: Number(d) };
}

/** '2026-11-04' → '4 Nov 2026'. Due days are calendar days, so no time zone is involved. */
export function formatDay(iso: string): string {
  const { y, m, d } = parts(iso);
  return `${d} ${m} ${y}`;
}

/** A span of days, written as briefly as reads clearly: '4–7 Nov 2026', '28 Nov – 2 Dec 2026'. */
export function formatSpan(earliest: string, latest: string): string {
  if (earliest === latest) return formatDay(earliest);
  const a = parts(earliest);
  const b = parts(latest);
  if (a.y !== b.y) return `${formatDay(earliest)} – ${formatDay(latest)}`;
  if (a.m !== b.m) return `${a.d} ${a.m} – ${b.d} ${b.m} ${b.y}`;
  return `${a.d}–${b.d} ${b.m} ${b.y}`;
}

/** The line shown under a proposal about its due, or null when there is nothing to say. */
export function dueLine(item: Item, run: Run): { tone: 'plain' | 'warn'; text: string } | null {
  const r = item.dueReading;
  if (r.state === 'event') return { tone: 'plain', text: `Waits on: ${r.event}` };
  if (r.state === 'needs_date') {
    if (item.kind !== 'action') return null;
    return { tone: 'warn', text: item.due ? `Needs a date: “${item.due}”: ${r.reason}` : `Needs a date: ${r.reason}` };
  }
  const span = formatSpan(r.earliest as string, r.latest as string);
  if (item.reviewerDue) return { tone: 'plain', text: `Set by reviewer: ${span}` };
  let text = `Notes say “${item.due}” → ${span}`;
  if (r.usedMeetingDate && run.meetingDate) {
    const whose = run.meetingDateSource === 'reviewer' ? 'the meeting date you entered' : 'the meeting date in the notes';
    text += ` (from ${whose}, ${formatDay(run.meetingDate)})`;
  }
  if (r.note) text += ` (${r.note})`;
  return { tone: 'plain', text };
}

/** An action whose due still needs a date cannot be approved. Other kinds never need one. */
export function blocksApproval(item: Item): boolean {
  return item.kind === 'action' && item.dueReading.state === 'needs_date';
}

/** The edit form's fields; '' means none. The form sends all of them on every save. */
export interface EditFields {
  text: string;
  owner: string;
  due: string;
  dueEarliest: string;
  dueLatest: string;
  dueEvent: string;
  ignoreModelEvent: boolean;
}

/** Starts the edit form from the wording and the reviewer's due in force, so saving new wording keeps the dates. */
export function editFormFrom(item: Item): EditFields {
  return {
    text: item.text,
    owner: item.owner ?? '',
    due: item.due ?? '',
    dueEarliest: item.reviewerDue?.earliest ?? '',
    dueLatest: item.reviewerDue?.latest ?? '',
    dueEvent: item.reviewerDue?.event ?? '',
    ignoreModelEvent: item.reviewerDue?.ignoreModelEvent ?? false,
  };
}
