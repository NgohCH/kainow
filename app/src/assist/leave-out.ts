/**
 * The leave-out check of a shareable summary (spec 7.2). Pure: no database.
 *
 * Every Leave out phrase and every project member's name that appears in a summary version is marked. Matching is
 * case- and accent-insensitive and whole-word: both texts are decomposed (NFKD), combining marks are dropped, letters
 * are lower-cased and every run of white space (line breaks included) counts as one space. Positions are returned in
 * the original text, so a mark can be shown where it is.
 */

export type MarkKind = 'leave_out' | 'name';

export interface Mark {
  phrase: string;
  kind: MarkKind;
  start: number;
  end: number;
}

/** The Leave out box: one item per line or comma-separated; trimmed, empty items dropped, repeats kept once. */
export function parseLeaveOut(text: string): string[] {
  const out: string[] = [];
  for (const part of text.split(/[\r\n,]+/)) {
    const item = part.trim().replace(/\s+/g, ' ');
    if (item !== '' && !out.includes(item)) out.push(item);
  }
  return out;
}

const WORD = /[\p{L}\p{N}]/u;
const MARKS = /\p{M}/gu;

interface Folded {
  text: string;
  /** For each character of `text`: where it starts in the original, and where it ends there. */
  from: number[];
  to: number[];
}

/** The text folded for matching, with a map from each folded character back to the original. */
function fold(original: string): Folded {
  let text = '';
  const from: number[] = [];
  const to: number[] = [];
  let i = 0;
  for (const ch of original) {
    const start = i;
    i += ch.length;
    if (/\s/u.test(ch)) {
      if (text.endsWith(' ')) {
        to[to.length - 1] = i;
        continue;
      }
      text += ' ';
      from.push(start);
      to.push(i);
      continue;
    }
    const folded = ch.normalize('NFKD').replace(MARKS, '').toLowerCase();
    // A combining mark written on its own belongs to the letter before it.
    if (folded === '' && to.length > 0) to[to.length - 1] = i;
    for (const f of folded) {
      text += f;
      for (let k = 0; k < f.length; k++) {
        from.push(start);
        to.push(i);
      }
    }
  }
  return { text, from, to };
}

const foldPhrase = (phrase: string) => fold(phrase.trim()).text.trim();

/** Every whole-word place where a Leave out phrase or a member's name appears in `body`, in order of position. */
export function findMarks(body: string, phrases: string[], names: string[]): Mark[] {
  const hay = fold(body);
  const out: Mark[] = [];
  const seen = new Set<string>();
  const look = (phrase: string, kind: MarkKind) => {
    const needle = foldPhrase(phrase);
    if (needle === '' || seen.has(`${kind}\n${needle}`)) return;
    seen.add(`${kind}\n${needle}`);
    let at = hay.text.indexOf(needle);
    while (at !== -1) {
      const end = at + needle.length;
      const before = at === 0 ? '' : hay.text[at - 1];
      const after = end >= hay.text.length ? '' : hay.text[end];
      const startsWord = !WORD.test(needle[0]) || before === '' || !WORD.test(before);
      const endsWord = !WORD.test(needle[needle.length - 1]) || after === '' || !WORD.test(after);
      if (startsWord && endsWord) out.push({ phrase: phrase.trim(), kind, start: hay.from[at], end: hay.to[end - 1] });
      at = hay.text.indexOf(needle, at + 1);
    }
  };
  for (const p of phrases) look(p, 'leave_out');
  for (const n of names) look(n, 'name');
  return out.sort((a, b) => a.start - b.start || a.end - b.end);
}
