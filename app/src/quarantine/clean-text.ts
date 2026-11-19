/**
 * Pure text cleaning for quarantine (history spec 7.4): every occurrence of a marked string is replaced by the marker,
 * and offsets into the original text are mapped into the cleaned one. Offsets are UTF-16 indexes, as everywhere in
 * Kainow (passages, transcript spans, quote locations).
 */

export const MARKER = '[credential removed]';

/** One replaced span: [from, to) of the original became [newFrom, newTo) (the marker) of the cleaned text. */
export interface Edit {
  from: number;
  to: number;
  newFrom: number;
  newTo: number;
}

/** The form of a string inside HTML text, as organisation/email.ts escapes it. */
export function htmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** The strings to look for: the marks (non-empty, distinct) and, in html mode, their escaped forms. */
export function searchForms(marks: string[], htmlEscaped = false): string[] {
  const forms = new Set<string>();
  for (const m of marks) {
    if (m === '') continue;
    forms.add(m);
    if (htmlEscaped) forms.add(htmlEscape(m));
  }
  return [...forms];
}

/** Every [start, end) of the marker in a text. */
function markerSpans(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let at = text.indexOf(MARKER); at !== -1; at = text.indexOf(MARKER, at + MARKER.length)) out.push([at, at + MARKER.length]);
  return out;
}

/**
 * Replaces every occurrence of every mark (exact, case-sensitive) with MARKER. Occurrences that overlap or touch
 * each other (including a mark overlapping itself) are merged into one span and one marker. With `htmlEscaped`
 * the HTML-escaped form of each mark is matched too. `edits` are in text order.
 */
export function cleanText(text: string, marks: string[], htmlEscaped = false): { text: string; edits: Edit[] } {
  const markers = markerSpans(text);
  const spans: Array<[number, number]> = [];
  for (const form of searchForms(marks, htmlEscaped)) {
    for (let at = text.indexOf(form); at !== -1; at = text.indexOf(form, at + 1)) {
      // An occurrence overlapping a marker already there (an earlier sweep) is left alone: markers are never nested.
      if (markers.some(([from, to]) => at < to && at + form.length > from)) continue;
      spans.push([at, at + form.length]);
    }
  }
  if (spans.length === 0) return { text, edits: [] };
  spans.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<[number, number]> = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
    else merged.push([s[0], s[1]]);
  }
  const edits: Edit[] = [];
  let out = '';
  let at = 0;
  for (const [from, to] of merged) {
    out += text.slice(at, from);
    const newFrom = out.length;
    out += MARKER;
    edits.push({ from, to, newFrom, newTo: out.length });
    at = to;
  }
  return { text: out + text.slice(at), edits };
}

/**
 * Maps an offset of the original text into the cleaned text. An offset strictly inside a replaced span is widened
 * to the whole marker: to its start for the start of a range, to its end for the end of a range, so a range that
 * touched the secret now holds the whole marker and no fragment. Offsets outside every span shift by the length
 * differences before them.
 */
export function mapOffset(edits: Edit[], offset: number, side: 'start' | 'end'): number {
  let delta = 0;
  for (const e of edits) {
    if (offset <= e.from) break;
    if (offset < e.to) return side === 'start' ? e.newFrom : e.newTo;
    delta = e.newTo - e.to;
  }
  return offset + delta;
}

/** Cleans every string leaf of a JSON value (objects, arrays, nested). Keys and non-string leaves are untouched. */
export function cleanJson(value: unknown, marks: string[]): unknown {
  if (typeof value === 'string') return cleanText(value, marks).text;
  if (Array.isArray(value)) return value.map((v) => cleanJson(v, marks));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = cleanJson(v, marks);
    return out;
  }
  return value;
}

/** Shortest fragment of a mark treated as the secret at the edge of a cut text (Review Focus 1: "longer than 3"). */
export const MIN_FRAGMENT = 4;

/**
 * Cleans a text that may have been cut out of a longer one (an unplaced quote of a cleaned version, which the model may
 * have shortened, cut off with "..." or "…", or elided in the middle): whole occurrences as cleanText, then every
 * maximal run of at least MIN_FRAGMENT characters that also occurs inside a mark is replaced by the marker (Review
 * Focus 1: no fragment longer than 3 characters survives; final review I5). Runs that overlap or touch are merged into
 * one marker; markers already in the text are left alone. This may over-mask ordinary words that share 4 or more
 * characters with a mark; that is accepted, since the original is encrypted and restores exactly.
 */
export function cleanEdges(text: string, marks: string[]): string {
  const out = cleanText(text, marks).text;
  const forms = searchForms(marks);
  const markers = markerSpans(out);
  const insideMarker = (i: number) => markers.some(([from, to]) => i >= from && i < to);
  const spans: Array<[number, number]> = [];
  for (let i = 0; i < out.length; i++) {
    if (insideMarker(i)) continue;
    // The longest run from i, outside every marker, that occurs inside some mark.
    let len = 0;
    while (i + len < out.length && !insideMarker(i + len) && forms.some((m) => m.includes(out.slice(i, i + len + 1)))) len++;
    if (len >= MIN_FRAGMENT) spans.push([i, i + len]);
  }
  if (spans.length === 0) return out;
  const merged: Array<[number, number]> = [];
  for (const sp of spans) {
    const last = merged[merged.length - 1];
    if (last && sp[0] <= last[1]) last[1] = Math.max(last[1], sp[1]);
    else merged.push([sp[0], sp[1]]);
  }
  let result = '';
  let at = 0;
  for (const [from, to] of merged) {
    result += out.slice(at, from) + MARKER;
    at = to;
  }
  return result + out.slice(at);
}

/**
 * Where the removed text sits in an original, given a cleaned form of it (each removed span became one MARKER):
 * the [start, end) of every span in `original`. The text between markers is matched in order, each at its first
 * place after the previous span (a span is never empty). Adjacent markers (two sweeps that touched) give one span.
 * Null when `cleaned` is not a cleaned form of `original` (changed since, or never cleaned).
 */
export function removedSpans(original: string, cleaned: string): Array<{ start: number; end: number }> | null {
  const parts = cleaned.split(MARKER);
  if (parts.length === 1) return cleaned === original ? [] : null;
  const first = parts[0];
  const last = parts[parts.length - 1];
  if (!original.startsWith(first)) return null;
  const tailStart = original.length - last.length;
  if (tailStart < first.length || !original.endsWith(last)) return null;
  const spans: Array<{ start: number; end: number }> = [];
  let start = first.length;
  for (const part of parts.slice(1, -1)) {
    if (part === '') continue;
    const at = original.indexOf(part, start + 1);
    if (at === -1 || at + part.length > tailStart) return null;
    spans.push({ start, end: at });
    start = at + part.length;
  }
  if (tailStart <= start) return null;
  spans.push({ start, end: tailStart });
  return spans;
}
