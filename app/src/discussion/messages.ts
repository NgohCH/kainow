import { BadRequestException } from '@nestjs/common';
import { findCredentials } from '../extraction/credentials';
import { NoteTextError, normaliseText } from '../notes/text';

export type MessageState = 'visible' | 'hidden' | 'deleted';

export const MAX_MESSAGE_CHARS = 10_000;
const QUOTE_CHARS = 140;

/** Normalised message text of 1 to 10,000 characters (spec 4.2). */
export function cleanBody(raw: unknown): string {
  if (typeof raw !== 'string') throw new BadRequestException('Write a message of 1 to 10,000 characters.');
  let text: string;
  try {
    text = normaliseText(raw);
  } catch (err) {
    if (err instanceof NoteTextError) throw new BadRequestException(err.message === 'The text is empty.' ? 'The message is empty.' : err.message);
    throw err;
  }
  if (text.length > MAX_MESSAGE_CHARS) throw new BadRequestException(`The message is longer than ${MAX_MESSAGE_CHARS.toLocaleString('en-US')} characters.`);
  return text;
}

/** Refuses text that looks like it holds a credential, naming only the kinds (never the match). */
export function refuseSecrets(text: string): void {
  const found = findCredentials(text);
  if (found.length === 0) return;
  throw new BadRequestException(`Not posted: this looks like it contains ${found.map((f) => f.pattern).join(', ')}. Remove it and post again.`);
}

/** The first 140 characters, cut at a word, with an ellipsis when something was cut. */
export function replyQuote(body: string): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  if (flat.length <= QUOTE_CHARS) return flat;
  let cut = flat.slice(0, QUOTE_CHARS);
  if (flat[QUOTE_CHARS] !== ' ') {
    const space = cut.lastIndexOf(' ');
    if (space > 0) cut = cut.slice(0, space);
  }
  return `${cut.trimEnd()}…`;
}

/**
 * What a reader sees of a message. `stateBy` is the moderator's display name. A hidden message still shows
 * its text to its author, with the notice; a deleted one shows no text to anybody (spec 4.3).
 */
export function displayBody(
  m: { state: MessageState; body: string; stateBy: string | null; stateReason: string | null },
  viewerIsAuthor: boolean,
): { text: string | null; notice: string | null } {
  if (m.state === 'visible') return { text: m.body, notice: null };
  const who = m.stateBy ?? 'a moderator';
  const reason = m.stateReason ?? 'no reason recorded';
  if (m.state === 'hidden') return { text: viewerIsAuthor ? m.body : null, notice: `Hidden by ${who}: ${reason}` };
  return { text: null, notice: `Deleted by ${who}: ${reason}` };
}
