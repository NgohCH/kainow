import { BadRequestException } from '@nestjs/common';

export const SEARCH_KINDS = ['project', 'person', 'note', 'ai_proposal', 'human_proposal', 'task', 'decision', 'question', 'risk'] as const;
export type SearchKind = (typeof SEARCH_KINDS)[number];

/** Ranking order of kinds in results; the two proposal kinds share a rank. */
export const KIND_ORDER: Record<SearchKind, number> = {
  project: 0,
  person: 1,
  task: 2,
  decision: 3,
  question: 4,
  risk: 5,
  ai_proposal: 6,
  human_proposal: 6,
  note: 7,
};

const MAX_LENGTH = 200;
const MAX_WORDS = 8;
const MIN_WORD = 3;
const NEEDS_WORD = 'Type at least one word of 3 or more letters.';
const BS = String.fromCharCode(92);
const ESCAPED = new RegExp('[' + BS + BS + '%_]', 'g');

/** Words of the phrase, plus a LIKE pattern for each with `\`, `%` and `_` escaped. */
export function parsePhrase(q: unknown): { words: string[]; patterns: string[] } {
  if (typeof q !== 'string') throw new BadRequestException(NEEDS_WORD);
  const trimmed = q.trim();
  if (trimmed.length > MAX_LENGTH) throw new BadRequestException(`Search is limited to ${MAX_LENGTH} characters.`);
  const words = trimmed.normalize('NFC').split(/\s+/).filter((w) => [...w].length >= 2).slice(0, MAX_WORDS);
  if (!words.some((w) => [...w].length >= MIN_WORD)) throw new BadRequestException(NEEDS_WORD);
  const patterns = words.map((w) => `%${w.replace(ESCAPED, (c) => BS + c)}%`);
  return { words, patterns };
}

export function parseKinds(v: unknown): SearchKind[] {
  if (typeof v !== 'string' || v === '') return [...SEARCH_KINDS];
  return v.split(',').map((k) => {
    if (!(SEARCH_KINDS as readonly string[]).includes(k)) throw new BadRequestException(`Unknown kind: ${k}.`);
    return k as SearchKind;
  });
}

export function parseOffset(v: unknown): number {
  if (v === undefined || v === null || v === '') return 0;
  if (typeof v !== 'string' || !/^\d+$/.test(v)) throw new BadRequestException('Offset must be a whole number of 0 or more.');
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new BadRequestException('Offset must be a whole number of 0 or more.');
  return n;
}

export function hrefFor(r: {
  kind: SearchKind;
  projectId: string;
  itemId: string;
  runId: string | null;
  versionNo: number | null;
  isCurrent: boolean;
}): string {
  switch (r.kind) {
    case 'project':
      return `#/projects/${r.projectId}`;
    case 'person':
      return `#/projects/${r.projectId}/people`;
    case 'note':
      return !r.isCurrent && r.versionNo !== null ? `#/notes/${r.itemId}/v/${r.versionNo}` : `#/notes/${r.itemId}`;
    case 'ai_proposal':
      return `#/runs/${r.runId}`;
    case 'human_proposal':
      return `#/projects/${r.projectId}/notes/${r.itemId}`;
    default:
      return `#/projects/${r.projectId}/work/${r.itemId}`;
  }
}
