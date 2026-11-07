const when = new Intl.DateTimeFormat('en-MY', { timeZone: 'Asia/Kuala_Lumpur', dateStyle: 'medium', timeStyle: 'short' });

/** Times are stored in UTC and shown in UTC+8, as the product rules require. */
export function formatWhen(iso: string): string {
  return when.format(new Date(iso));
}

export function plural(n: number, one: string, many: string = one + 's'): string {
  return `${n} ${n === 1 ? one : many}`;
}

export const KIND_LABEL = { decision: 'Decision', action: 'Action', question: 'Open question', risk: 'Risk' } as const;
