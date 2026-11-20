export type Span = { start: string | null; end: string | null };

/** ISO dates (YYYY-MM-DD) compare correctly as strings. Ends are inclusive; a null end runs forever. */
export function spansOverlap(a: Span, b: Span): boolean {
  if (a.start === null || b.start === null) return false;
  const aEndsBeforeBStarts = a.end !== null && a.end < b.start;
  const bEndsBeforeAStarts = b.end !== null && b.end < a.start;
  return !aEndsBeforeBStarts && !bEndsBeforeAStarts;
}
