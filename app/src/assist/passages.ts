/**
 * Splitting text into passages for the search index (spec 4.1). Pure: no database.
 * Offsets are UTF-16 indexes into the text given, so `text.slice(start, end) === body` always holds.
 */

export interface PassageDraft {
  ordinal: number;
  start: number;
  end: number;
  body: string;
  location: string;
}

export interface PassageLabel {
  messageNo?: number;
  author?: string;
  at?: string;
}

export const MAX_PASSAGE = 1500;
export const MIN_PASSAGE = 200;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `d Mon HH:mm` in UTC+8, for example `11 Nov 10:31`. */
export function formatMessageTime(at: Date): string {
  const l = new Date(at.getTime() + 8 * 3600_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${l.getUTCDate()} ${MONTHS[l.getUTCMonth()]} ${pad(l.getUTCHours())}:${pad(l.getUTCMinutes())}`;
}

interface Span {
  start: number;
  end: number;
}

/** Trims whitespace off both ends of a span; null when nothing is left. */
function trimmed(text: string, start: number, end: number): Span | null {
  let s = start;
  let e = end;
  while (s < e && /\s/.test(text[s])) s++;
  while (e > s && /\s/.test(text[e - 1])) e--;
  return s < e ? { start: s, end: e } : null;
}

/** Splits one span of more than MAX_PASSAGE characters at sentence ends into pieces of at most MAX_PASSAGE. */
function splitLong(text: string, span: Span): Span[] {
  if (span.end - span.start <= MAX_PASSAGE) return [span];
  const body = text.slice(span.start, span.end);
  const ends: number[] = []; // exclusive end of each sentence, relative to the span
  const re = /[.!?]+["')\]]*(?=\s|$)/g;
  for (let m = re.exec(body); m; m = re.exec(body)) ends.push(m.index + m[0].length);
  if (ends[ends.length - 1] !== body.length) ends.push(body.length);
  // A sentence longer than the limit is cut at the last space inside the limit.
  const pieces: number[] = [];
  let from = 0;
  for (const e of ends) {
    let cut = from;
    while (e - cut > MAX_PASSAGE) {
      let at = body.lastIndexOf(' ', cut + MAX_PASSAGE);
      if (at <= cut) {
        at = cut + MAX_PASSAGE;
        // Never cut between the halves of a surrogate pair (emoji, some CJK): a lone surrogate cannot be stored.
        const c = body.charCodeAt(at - 1);
        if (c >= 0xd800 && c <= 0xdbff) at--;
      }
      pieces.push(at);
      cut = at;
    }
    pieces.push(e);
    from = e;
  }
  const out: Span[] = [];
  let chunkStart = 0;
  let last = 0;
  for (const p of pieces) {
    if (p - chunkStart > MAX_PASSAGE && last > chunkStart) {
      const t = trimmed(text, span.start + chunkStart, span.start + last);
      if (t) out.push(t);
      chunkStart = last;
    }
    last = p;
  }
  const t = trimmed(text, span.start + chunkStart, span.start + last);
  if (t) out.push(t);
  return out;
}

interface Block extends Span {
  location: string;
}

export function splitPassages(text: string, kind: 'document' | 'message', label: PassageLabel = {}): PassageDraft[] {
  if (kind === 'message') {
    const whole = trimmed(text, 0, text.length);
    if (!whole) return [];
    const location = `Message #${label.messageNo ?? '?'} by ${label.author ?? 'unknown'}, ${label.at ?? ''}`.replace(/,\s*$/, '');
    return splitLong(text, whole).map((s, ordinal) => ({ ordinal, start: s.start, end: s.end, body: text.slice(s.start, s.end), location }));
  }

  // Blocks at blank lines, each located by the nearest preceding heading and its paragraph number under it.
  const blocks: Block[] = [];
  const re = /\r?\n[ \t]*\r?\n/g;
  let heading: string | null = null;
  let paragraph = 0;
  const push = (from: number, to: number) => {
    const s = trimmed(text, from, to);
    if (!s) return;
    const block = text.slice(s.start, s.end);
    const h = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(block.split(/\r?\n/)[0]);
    if (h) {
      heading = h[1];
      paragraph = 0;
    }
    const headingOnly = h !== null && !block.includes('\n');
    if (!headingOnly) paragraph++;
    const n = Math.max(paragraph, 1);
    blocks.push({ ...s, location: heading ? `§${heading}, paragraph ${n}` : `Paragraph ${n}` });
  };
  let from = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    push(from, m.index);
    from = m.index + m[0].length;
  }
  push(from, text.length);

  // Short blocks merge with the next; a long result is then split at sentence ends.
  const merged: Block[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = { ...blocks[i] };
    while (b.end - b.start < MIN_PASSAGE && i + 1 < blocks.length) {
      b.end = blocks[i + 1].end;
      i++;
    }
    merged.push(b);
  }
  const out: PassageDraft[] = [];
  for (const b of merged) {
    for (const s of splitLong(text, b)) out.push({ ordinal: out.length, start: s.start, end: s.end, body: text.slice(s.start, s.end), location: b.location });
  }
  return out;
}
