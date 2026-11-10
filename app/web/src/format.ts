const when = new Intl.DateTimeFormat('en-MY', { timeZone: 'Asia/Kuala_Lumpur', dateStyle: 'medium', timeStyle: 'short' });

/** Times are stored in UTC and shown in UTC+8, as the product rules require. */
export function formatWhen(iso: string): string {
  return when.format(new Date(iso));
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Notices start from Tue 10 Nov 2026, 09:30 (UTC+8)" for a stored UTC time. */
export function noticesStartLine(iso: string): string {
  const d = new Date(new Date(iso).getTime() + 8 * 3_600_000);
  const hm = d.toISOString().slice(11, 16);
  return `Notices start from ${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${hm} (UTC+8)`;
}

export function plural(n: number, one: string, many: string = one + 's'): string {
  return `${n} ${n === 1 ? one : many}`;
}

export const KIND_LABEL = { decision: 'Decision', action: 'Action', question: 'Open question', risk: 'Risk' } as const;
