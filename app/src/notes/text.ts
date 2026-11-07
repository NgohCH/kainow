import { createHash } from 'node:crypto';

/** Technical safety limits, not product policy. Change them here if the Product Owner asks. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_TEXT_CHARS = 500_000;

export class NoteTextError extends Error {}

/**
 * The text contract (R02). Stored text is UTF-8, Unicode NFC, with LF line ends.
 * Character offsets are UTF-16 code units, that is, the index into the JavaScript string
 * returned by this function. An offset range is [start, end), end exclusive.
 * Anything that stores or displays an offset must use the stored normalised text, never the original.
 */
export function normaliseText(raw: string): string {
  let text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  if (text.includes('\u0000')) {
    throw new NoteTextError('The text contains a NUL character, so it is not plain text.');
  }
  text = text.replace(/\r\n?/g, '\n').normalize('NFC');
  if (text.trim() === '') {
    throw new NoteTextError('The text is empty.');
  }
  if (text.length > MAX_TEXT_CHARS) {
    throw new NoteTextError(`The text is longer than ${MAX_TEXT_CHARS} characters.`);
  }
  return text;
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export interface QuoteMatch {
  start: number;
  end: number;
  /** 0 for the first place the quote occurs, 1 for the second, and so on. */
  occurrence: number;
}

/**
 * Finds every place a quote occurs in the stored text. The quote is normalised the same way
 * (NFC, LF) so a model's answer with CRLF or decomposed accents still matches. Matches may
 * overlap. An empty quote matches nowhere.
 */
export function locateQuote(text: string, quote: string): QuoteMatch[] {
  const q = quote.replace(/\r\n?/g, '\n').normalize('NFC');
  if (q === '') {
    return [];
  }
  const found: QuoteMatch[] = [];
  let from = 0;
  for (;;) {
    const at = text.indexOf(q, from);
    if (at === -1) {
      return found;
    }
    found.push({ start: at, end: at + q.length, occurrence: found.length });
    from = at + 1;
  }
}
