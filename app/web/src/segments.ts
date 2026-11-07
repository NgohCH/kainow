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

/**
 * The stretch of text to mark for a proposal. For a quote that repeats it is the place the reviewer
 * approved, else the place they are looking at, else the first. `picked` is an index into `occurrences`.
 */
export function markedSpan(
  item: { quoteStart: number | null; quoteEnd: number | null; occurrences?: Array<{ start: number; end: number }>; chosenOccurrence: number | null },
  picked: number | undefined,
): { quoteStart: number | null; quoteEnd: number | null } {
  const at = item.chosenOccurrence ?? picked;
  const place = at === undefined ? undefined : item.occurrences?.[at];
  return place ? { quoteStart: place.start, quoteEnd: place.end } : { quoteStart: item.quoteStart, quoteEnd: item.quoteEnd };
}

/** A few words of the notes before and after a place, so the reviewer can tell repeated places apart. */
export function contextAround(text: string, start: number, end: number, width = 40): { before: string; match: string; after: string } {
  const flat = (t: string) => t.replace(/\s+/g, ' ');
  const lead = Math.max(0, start - width);
  const tail = Math.min(text.length, end + width);
  return {
    before: (lead > 0 ? '…' : '') + flat(text.slice(lead, start)),
    match: flat(text.slice(start, end)),
    after: flat(text.slice(end, tail)) + (tail < text.length ? '…' : ''),
  };
}
