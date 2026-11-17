/**
 * Citation check for AI answers and drafts (spec 5.2, 6.2). Pure: no database.
 * Every `[P<n>]` marker in the text must be one that was sent and must be listed in `cited`; every listed marker must
 * have been sent. Details name markers only, never the answer text.
 */

const GROUP = /\[([^\]]*)\]/g;
const MARKER = /\bP\d+\b/gi;

/**
 * The passage markers written in the text, each once, upper-cased, in order of first appearance. Every square-bracket
 * group is read and every P-marker in it counts, so `[P1, P4]`, `[P1; P4]` and `[p4]` are all checked.
 */
export function markersIn(markdown: string): string[] {
  const out: string[] = [];
  for (const g of markdown.matchAll(GROUP)) {
    for (const m of g[1].matchAll(MARKER)) {
      const marker = m[0].toUpperCase();
      if (!out.includes(marker)) out.push(marker);
    }
  }
  return out;
}

/** A cited entry as a marker (`p3 ` becomes `P3`), or null when it is not a marker at all. */
export function normalizeMarker(entry: string): string | null {
  const t = entry.trim();
  return /^P\d+$/i.test(t) ? t.toUpperCase() : null;
}

export function validateCitations(markdown: string, cited: string[], sent: string[]): { ok: true } | { ok: false; detail: string } {
  const known = new Set(sent);
  const normal = cited.map(normalizeMarker);
  // Never echo a malformed entry: it is model output and could hold any text.
  if (normal.some((m) => m === null)) return { ok: false, detail: 'The AI answer listed a cited entry that is not a passage marker.' };
  cited = normal as string[];
  const listed = new Set(cited);
  const written = markersIn(markdown);
  const unknownInText = written.filter((m) => !known.has(m));
  if (unknownInText.length > 0) {
    return { ok: false, detail: `The AI answer cited ${unknownInText.join(', ')}, which ${unknownInText.length === 1 ? 'was' : 'were'} not sent to it.` };
  }
  const unknownCited = cited.filter((m) => !known.has(m));
  if (unknownCited.length > 0) {
    return { ok: false, detail: `The AI answer listed ${unknownCited.join(', ')} as cited, which ${unknownCited.length === 1 ? 'was' : 'were'} not sent to it.` };
  }
  const unlisted = written.filter((m) => !listed.has(m));
  if (unlisted.length > 0) {
    return { ok: false, detail: `The AI answer used ${unlisted.join(', ')} without listing ${unlisted.length === 1 ? 'it' : 'them'} as cited.` };
  }
  return { ok: true };
}
