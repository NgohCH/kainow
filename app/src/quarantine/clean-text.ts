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

/**
 * Replaces every occurrence of every mark (exact, case-sensitive) with MARKER. Occurrences that overlap or touch
 * each other (including a mark overlapping itself) are merged into one span and one marker. With `htmlEscaped`
 * the HTML-escaped form of each mark is matched too. `edits` are in text order.
 */
export function cleanText(text: string, marks: string[], htmlEscaped = false): { text: string; edits: Edit[] } {
  const spans: Array<[number, number]> = [];
  for (const form of searchForms(marks, htmlEscaped)) {
    for (let at = text.indexOf(form); at !== -1; at = text.indexOf(form, at + 1)) spans.push([at, at + form.length]);
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
 * Cleans a text that may have been cut out of a longer one (a quote the model shortened): whole occurrences as
 * cleanText, then a start that is a suffix of a mark, or an end that is a prefix of one, of at least MIN_FRAGMENT
 * characters, is replaced by the marker too.
 */
export function cleanEdges(text: string, marks: string[]): string {
  let out = cleanText(text, marks).text;
  for (const m of searchForms(marks)) {
    for (let n = Math.min(m.length - 1, out.length); n >= MIN_FRAGMENT; n--) {
      if (out.endsWith(m.slice(0, n))) {
        out = out.slice(0, out.length - n) + MARKER;
        break;
      }
    }
    for (let n = Math.min(m.length - 1, out.length); n >= MIN_FRAGMENT; n--) {
      if (out.startsWith(m.slice(m.length - n))) {
        out = MARKER + out.slice(n);
        break;
      }
    }
  }
  return out;
}
