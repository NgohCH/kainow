/**
 * Duplicating a project (D140): the checks that need no database. The old terms are used here and never stored.
 */

export const DUPLICATE_LIMITS = { tasks: 500, risks: 200, resources: 200, terms: 10, termChars: 100 } as const;

/**
 * One text of the new project, under the key the review page knows it by. `typed` names a text that was not carried over
 * (it came without an id): nothing is there to confirm as still correct, so an old term in it must be changed.
 */
export interface CarriedText {
  key: string;
  text: string;
  typed?: string;
}

export interface FoundTerm {
  key: string;
  term: string;
}

/** How text is compared: case, runs of white space and the two ways of writing an accented letter do not matter. */
const plain = (s: string): string => s.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();

/** Every text that holds one of the old terms, once per term it holds. */
export function findTerms(texts: readonly CarriedText[], terms: readonly string[]): FoundTerm[] {
  const wanted = terms.map((term) => ({ term, find: plain(term) })).filter((t) => t.find !== '');
  const out: FoundTerm[] = [];
  for (const t of texts) {
    const text = plain(t.text);
    for (const w of wanted) if (text.includes(w.find)) out.push({ key: t.key, term: w.term });
  }
  return out;
}

/** The texts still holding an old term that were not confirmed as still correct; a typed one cannot be. */
export function unconfirmedTerms(texts: readonly CarriedText[], terms: readonly string[], confirmedKeys: readonly string[]): FoundTerm[] {
  const confirmed = new Set(confirmedKeys);
  for (const t of texts) if (t.typed) confirmed.delete(t.key);
  return findTerms(texts, terms).filter((f) => !confirmed.has(f.key));
}

export interface DuplicateChoices {
  original: { name: string; purpose: string; plannedEnd: string | null };
  name: string;
  plannedEnd: string | null;
  noPlannedEnd: boolean;
  purpose: string;
  purposeConfirmed: boolean;
  /** Texts as they would be created. */
  texts: readonly CarriedText[];
  oldTerms: readonly string[];
  confirmedKeys: readonly string[];
  counts: { tasks: number; risks: number; resources: number };
}

const number = (n: number) => n.toLocaleString('en-US');

/** What is still to be decided before the new project can be created, in plain words; empty when nothing is. */
export function duplicateProblems(d: DuplicateChoices): string[] {
  const over: string[] = [];
  const limit = (n: number, max: number, what: string) => {
    if (n > max) over.push(`You chose ${number(n)} ${what}; at most ${number(max)} can be copied at once.`);
  };
  limit(d.counts.tasks, DUPLICATE_LIMITS.tasks, 'tasks and subtasks');
  limit(d.counts.risks, DUPLICATE_LIMITS.risks, 'risks');
  limit(d.counts.resources, DUPLICATE_LIMITS.resources, 'resource lines');
  if (over.length > 0) return over;

  const out: string[] = [];
  if (plain(d.name) === plain(d.original.name)) out.push("Give the new project a name different from the original's.");
  if (d.noPlannedEnd && d.plannedEnd !== null) out.push('Give a planned end date or choose "No planned end", not both.');
  else if (!d.noPlannedEnd && d.plannedEnd === null) out.push('Give a planned end date or choose "No planned end".');
  else if (d.plannedEnd !== null && d.plannedEnd === d.original.plannedEnd) out.push("Give a planned end date different from the original's.");
  if (!d.purposeConfirmed && plain(d.purpose) === plain(d.original.purpose)) out.push('Change the purpose or confirm it is still correct.');
  const keys = new Set(unconfirmedTerms(d.texts, d.oldTerms, d.confirmedKeys).map((f) => f.key));
  for (const t of d.texts) {
    if (!t.typed || !keys.delete(t.key)) continue;
    out.push(`${t.typed} holds an old term. Change it.`);
  }
  const texts = keys.size;
  if (texts === 1) out.push('1 text still holds an old term. Change it or confirm it is still correct.');
  else if (texts > 1) out.push(`${number(texts)} texts still hold an old term. Change each one or confirm it is still correct.`);
  return out;
}
