/** Email delivery helpers for the Email delivery page. */
export interface DeliveryLike { status: string; createdAt: string }

export const needsAction = (status: string): boolean => status === 'failed' || status === 'uncertain';

/** Failed and uncertain emails first, then the rest; each group keeps its order (newest first). */
export function failuresFirst<T extends DeliveryLike>(rows: T[]): T[] {
  return [...rows.filter((r) => needsAction(r.status)), ...rows.filter((r) => !needsAction(r.status))];
}

/** What the last 24 hours look like in the rows that are loaded. */
export function lastDay(rows: DeliveryLike[], now: number): { sent: number; failed: number; uncertain: number; waiting: number; total: number } {
  const since = now - 24 * 3600 * 1000;
  const recent = rows.filter((r) => new Date(r.createdAt).getTime() >= since);
  const count = (f: (s: string) => boolean) => recent.filter((r) => f(r.status)).length;
  return {
    sent: count((s) => s === 'sent'),
    failed: count((s) => s === 'failed'),
    uncertain: count((s) => s === 'uncertain'),
    waiting: count((s) => s === 'queued' || s === 'sending' || s === 'retry_wait'),
    total: recent.length,
  };
}
