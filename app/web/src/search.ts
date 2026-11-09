// Cross-project search: the shapes the API returns, and the small pure helpers the search page uses.

export type SearchKind = 'project' | 'person' | 'note' | 'ai_proposal' | 'human_proposal' | 'task' | 'decision' | 'question' | 'risk';

export interface SearchResult {
  kind: SearchKind;
  id: string;
  title: string;
  snippet: string | null;
  matchNote: string | null;
  status: string | null;
  href: string;
}

export interface SearchProject {
  id: string;
  name: string;
  status: 'draft' | 'planned' | 'active' | 'deferred' | 'closed';
  archived: boolean;
  myAccess: { roles: Array<'pm' | 'deputy_pm' | 'owner' | 'sponsor' | 'member'>; grant: 'audit' | 'oversight' | null };
  total: number;
  results: SearchResult[];
}

export interface SearchResponse {
  searched: number;
  projects: SearchProject[];
}

export const KIND_LABELS: Record<SearchKind, string> = {
  project: 'Project',
  person: 'Person',
  note: 'Note',
  ai_proposal: 'AI proposal',
  human_proposal: 'Human proposal',
  task: 'Task',
  decision: 'Decision',
  question: 'Question',
  risk: 'Risk',
};

export const SEARCH_KINDS = Object.keys(KIND_LABELS) as SearchKind[];

/** The words of a phrase, the way the server reads it: split on spaces, one-character words dropped, at most 8. */
export function searchWords(q: string): string[] {
  return q
    .trim()
    .split(/\s+/)
    .filter((w) => w.length >= 2)
    .slice(0, 8);
}

/** Cuts text into plain and marked pieces. Case-insensitive; overlapping or touching matches become one mark. Never HTML. */
export function highlight(text: string, words: string[]): Array<{ text: string; mark: boolean }> {
  if (!text) return [];
  const lower = text.toLowerCase();
  const spans: Array<[number, number]> = [];
  for (const w of words) {
    const needle = w.toLowerCase();
    if (!needle) continue;
    let from = 0;
    for (;;) {
      const at = lower.indexOf(needle, from);
      if (at < 0) break;
      spans.push([at, at + needle.length]);
      from = at + 1;
    }
  }
  spans.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<[number, number]> = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
    else merged.push([s[0], s[1]]);
  }
  const out: Array<{ text: string; mark: boolean }> = [];
  let pos = 0;
  for (const [a, b] of merged) {
    if (a > pos) out.push({ text: text.slice(pos, a), mark: false });
    out.push({ text: text.slice(a, b), mark: true });
    pos = b;
  }
  if (pos < text.length) out.push({ text: text.slice(pos), mark: false });
  return out;
}

export function searchPath(p: { q: string; kinds?: string[]; archived?: boolean; project?: string; offset?: number }): string {
  const parts = [`q=${encodeURIComponent(p.q)}`];
  if (p.kinds && p.kinds.length > 0) parts.push(`kinds=${p.kinds.map(encodeURIComponent).join(',')}`);
  if (p.archived) parts.push('archived=1');
  if (p.project) parts.push(`project=${encodeURIComponent(p.project)}`);
  if (p.offset) parts.push(`offset=${p.offset}`);
  return `/search?${parts.join('&')}`;
}

/** Reads the state of the search page from the address (`#/search?q=…`). */
export function parseSearchHash(hash: string): { q: string; kinds: string[]; archived: boolean; project: string | null } {
  const at = hash.indexOf('?');
  const params = new URLSearchParams(at < 0 ? '' : hash.slice(at + 1));
  const kinds = (params.get('kinds') ?? '').split(',').filter((k) => k !== '');
  return { q: params.get('q') ?? '', kinds, archived: params.get('archived') === '1', project: params.get('project') || null };
}

export function searchedLine(n: number): string {
  return `Searched ${n} ${n === 1 ? 'project' : 'projects'} you can currently see`;
}
