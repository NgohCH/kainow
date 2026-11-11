import { locateQuote } from '../notes/text';

/** One message as it goes into a transcript: its current version's text. */
export interface TranscriptMessage {
  no: number;
  versionId: string;
  authorId: string;
  authorName: string;
  at: Date;
  body: string;
  isContext: boolean;
}

/** Where one message sits in the transcript text. Offsets are UTF-16 code units; the body is [bodyStart, bodyEnd). */
export interface Span {
  messageNo: number;
  messageVersionId: string;
  authorId: string;
  headerStart: number;
  bodyStart: number;
  bodyEnd: number;
  isContext: boolean;
}

/** The line the builder puts before the first new message; the discussion preamble names it. */
export const NEW_MESSAGES_LINE = '--- New messages ---';

const UTC8_MS = 8 * 60 * 60 * 1000;

/** `2026-11-11 10:31` in UTC+8. */
export function headerTime(at: Date): string {
  const iso = new Date(at.getTime() + UTC8_MS).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

export const headerOf = (m: Pick<TranscriptMessage, 'no' | 'authorName' | 'at'>): string => `[#${m.no} · ${m.authorName} · ${headerTime(m.at)}]`;

const SEPARATOR = '\n\n';

/**
 * The text sent to the AI (spec 7.4): earlier messages for context (the newest ones that fit in `maxContextChars`, oldest first),
 * then the line `--- New messages ---`, then the new messages. Each message is a header line and its text; blocks are separated by
 * a blank line. `earlier` and `newMessages` may arrive in any order; both are sorted by message number.
 */
export function buildTranscript(newMessages: TranscriptMessage[], earlier: TranscriptMessage[], maxContextChars = 40_000): { text: string; spans: Span[] } {
  const blockOf = (m: TranscriptMessage) => `${headerOf(m)}\n${m.body}`;
  const context: TranscriptMessage[] = [];
  let used = 0;
  for (const m of [...earlier].sort((a, b) => b.no - a.no)) {
    const size = blockOf(m).length;
    if (used + size > maxContextChars) break; // keep the context contiguous: nothing older than a message that did not fit
    used += size;
    context.push(m);
  }
  context.reverse();

  let text = '';
  const spans: Span[] = [];
  const add = (block: string): number => {
    if (text !== '') text += SEPARATOR;
    const start = text.length;
    text += block;
    return start;
  };
  const addMessage = (m: TranscriptMessage, isContext: boolean): void => {
    const header = headerOf(m);
    const headerStart = add(`${header}\n${m.body}`);
    const bodyStart = headerStart + header.length + 1;
    spans.push({ messageNo: m.no, messageVersionId: m.versionId, authorId: m.authorId, headerStart, bodyStart, bodyEnd: bodyStart + m.body.length, isContext });
  };
  for (const m of context) addMessage(m, true);
  add(NEW_MESSAGES_LINE);
  for (const m of [...newMessages].sort((a, b) => a.no - b.no)) addMessage(m, false);
  return { text, spans };
}

export type Placement =
  | { kind: 'new'; start: number; end: number; matches: number }
  | { kind: 'context_only' }
  | { kind: 'unlocated' };

/**
 * Where an item's quote lies (spec 7.4). Only a location wholly inside one message body counts. A location inside a new message
 * wins (the first such is the item's place); a quote found only in context messages is `context_only`; a quote found nowhere, or
 * only across a header or two messages, is `unlocated`. `matches` is every place the quote occurs in the whole text, because the
 * reviewer's choice of occurrence counts through all of them (as for notes).
 */
export function placeItem(quote: string, text: string, spans: Span[]): Placement {
  const places = locateQuote(text, quote);
  const spanOf = (p: { start: number; end: number }) => spans.find((s) => p.start >= s.bodyStart && p.end <= s.bodyEnd);
  let sawContext = false;
  for (const p of places) {
    const span = spanOf(p);
    if (!span) continue;
    if (!span.isContext) return { kind: 'new', start: p.start, end: p.end, matches: places.length };
    sawContext = true;
  }
  return sawContext ? { kind: 'context_only' } : { kind: 'unlocated' };
}
