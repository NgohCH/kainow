/**
 * Citation check for AI answers and drafts (spec 5.2, 6.2). Pure: no database.
 * Every `[P<n>]` marker in the text must be one that was sent and must be listed in `cited`; every listed marker must
 * have been sent. Details name markers only, never the answer text.
 */

const MARKER = /\[(P\d+)\]/g;

/** The passage markers written in the text, each once, in order of first appearance. */
export function markersIn(markdown: string): string[] {
  const out: string[] = [];
  for (const m of markdown.matchAll(MARKER)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

export function validateCitations(markdown: string, cited: string[], sent: string[]): { ok: true } | { ok: false; detail: string } {
  const known = new Set(sent);
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
