export interface Located {
  id: string;
  /** Character offsets into the stored text (UTF-16 code units, end exclusive). null when the quote was not found. */
  quoteStart: number | null;
  quoteEnd: number | null;
}

export interface Segment {
  start: number;
  end: number;
  text: string;
  /** Every proposal whose quoted passage covers this stretch of text. Empty for plain text. */
  ids: string[];
}

/**
 * Cuts the source text at every boundary of every located passage, so overlapping passages are shown
 * correctly: each piece knows which proposals it belongs to. Offsets that do not fit the text are ignored
 * rather than guessed at.
 */
export function buildSegments(text: string, items: Located[]): Segment[] {
  const spans = items.filter(
    (i): i is Located & { quoteStart: number; quoteEnd: number } =>
      i.quoteStart !== null && i.quoteEnd !== null && i.quoteStart >= 0 && i.quoteEnd > i.quoteStart && i.quoteEnd <= text.length,
  );
  const cuts = new Set<number>([0, text.length]);
  for (const s of spans) {
    cuts.add(s.quoteStart);
    cuts.add(s.quoteEnd);
  }
  const points = [...cuts].sort((a, b) => a - b);
  const out: Segment[] = [];
  for (let k = 0; k < points.length - 1; k++) {
    const start = points[k];
    const end = points[k + 1];
    out.push({
      start,
      end,
      text: text.slice(start, end),
      ids: spans.filter((s) => s.quoteStart <= start && s.quoteEnd >= end).map((s) => s.id),
    });
  }
  return out;
}
