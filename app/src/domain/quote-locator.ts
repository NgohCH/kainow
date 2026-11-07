// R02: source quotes are located by character offset in NFC-normalised text.
// Matching is exact (no whitespace or case folding), so a stored offset always
// maps back to the text the user sees. Repeated quotes are disambiguated by an
// occurrence index.

export interface Span {
  start: number; // inclusive, UTF-16 code-unit offset in the NFC text
  end: number; // exclusive
  occurrence: number; // 0-based index among all exact matches
}

export type LocateResult =
  | { status: "found"; span: Span }
  | { status: "not_found" }
  | { status: "empty_quote" }
  | { status: "ambiguous"; matches: number }
  | { status: "occurrence_out_of_range"; matches: number };

export function normaliseText(text: string): string {
  return text.normalize("NFC");
}

export function findOccurrences(sourceNfc: string, quoteNfc: string): Span[] {
  const spans: Span[] = [];
  let from = 0;
  let occurrence = 0;
  for (;;) {
    const at = sourceNfc.indexOf(quoteNfc, from);
    if (at === -1) break;
    spans.push({ start: at, end: at + quoteNfc.length, occurrence });
    occurrence += 1;
    from = at + 1; // allow overlapping matches so none are silently skipped
  }
  return spans;
}

// Locates a quote in the source. If the quote occurs more than once, the caller
// must pass the occurrence index it means; otherwise the result is "ambiguous".
export function locateQuote(
  source: string,
  quote: string,
  occurrence?: number,
): LocateResult {
  const quoteNfc = normaliseText(quote);
  if (quoteNfc.length === 0) return { status: "empty_quote" };

  const matches = findOccurrences(normaliseText(source), quoteNfc);
  if (matches.length === 0) return { status: "not_found" };

  if (occurrence === undefined) {
    if (matches.length > 1) return { status: "ambiguous", matches: matches.length };
    return { status: "found", span: matches[0] };
  }

  const chosen = matches[occurrence];
  if (!Number.isInteger(occurrence) || chosen === undefined) {
    return { status: "occurrence_out_of_range", matches: matches.length };
  }
  return { status: "found", span: chosen };
}
