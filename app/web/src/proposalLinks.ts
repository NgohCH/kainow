/** Where a proposal's source, its exact place in that source, and its record open (11a.1, D136), and the addresses that carry a place. The server says what the reader may open. */
import { type DiscussionEvidence, type SourceFlag, threadPath } from './discussion.ts';
import { markedSpan } from './segments.ts';
import { taskHref } from './taskPage.ts';

/** The parts of a source's address, as the server gives them. `threadId` is set for a discussion only. */
export interface SourceAddress {
  sourceId: string;
  sourceKind: string;
  threadId: string | null;
  versionNo: number;
}

/** A passage in a note version's text: character offsets, end exclusive. */
export interface Place {
  start: number;
  end: number;
}

/** A note, minutes or an approved summary at its version; a discussion at its thread. */
export function sourceHref(projectId: string, s: SourceAddress): string | null {
  if (s.sourceKind === 'discussion') return s.threadId ? threadPath(projectId, s.threadId) : null;
  return `#/notes/${s.sourceId}/v/${s.versionNo}`;
}

interface PlacedItem {
  quoteStart: number | null;
  quoteEnd: number | null;
  occurrences?: Array<{ start: number; end: number }>;
  chosenOccurrence: number | null;
  sourceFlag?: SourceFlag | null;
  discussionEvidence?: Pick<DiscussionEvidence, 'threadId' | 'messageNo'> | null;
}

/**
 * The place a proposal's quote came from: the passage in its note version, or the discussion message. `exact` is false
 * when only the source is known (the quote was not found in it). Null when the source does not open for the reader
 * or the quote is masked.
 */
export function placeLink(projectId: string, source: SourceAddress & { opens?: boolean }, item: PlacedItem, picked: number | undefined): { href: string; exact: boolean } | null {
  if (!source.opens || item.sourceFlag) return null;
  const base = sourceHref(projectId, source);
  if (base === null) return null;
  if (source.sourceKind === 'discussion') {
    const ev = item.discussionEvidence;
    return ev ? { href: `${threadPath(projectId, ev.threadId)}?m=${ev.messageNo}`, exact: true } : { href: base, exact: false };
  }
  const { quoteStart, quoteEnd } = markedSpan(item, picked);
  return quoteStart !== null && quoteEnd !== null ? { href: `${base}?at=${quoteStart}-${quoteEnd}`, exact: true } : { href: base, exact: false };
}

/** A task's page, or another record's row in Work. */
export const recordHref = (projectId: string, record: { kind: string; id: string }): string =>
  record.kind === 'task' ? taskHref(projectId, record.id) : `#/projects/${projectId}/work/${record.id}`;

/** `#/runs/<id>`, and `#/runs/<id>/<item>` for one of its proposals. */
export function parseRunHash(hash: string): { runId: string; itemId: string | undefined } | null {
  const m = /^#\/runs\/([0-9a-f-]{36})(?:\/([0-9a-f-]{36}))?$/i.exec(hash);
  return m ? { runId: m[1], itemId: m[2] } : null;
}

/** `#/notes/<id>`, `#/notes/<id>/v/<n>`, and `?at=<start>-<end>` after a version for a place in it; a malformed place is left out. */
export function parseNoteHash(hash: string): { sourceId: string; versionNo: number | null; place: Place | null } | null {
  const m = /^#\/notes\/([0-9a-f-]{36})(?:\/v\/(\d+)(?:\?(.*))?)?$/i.exec(hash);
  if (!m) return null;
  const at = /^at=(\d{1,9})-(\d{1,9})$/.exec(m[3] ?? '');
  return { sourceId: m[1], versionNo: m[2] ? Number(m[2]) : null, place: at ? { start: Number(at[1]), end: Number(at[2]) } : null };
}

/** The text around a place, or null when the place does not fit it. */
export function notePlace(text: string, place: Place | null): { before: string; match: string; after: string } | null {
  if (!place || place.end <= place.start || place.end > text.length) return null;
  return { before: text.slice(0, place.start), match: text.slice(place.start, place.end), after: text.slice(place.end) };
}
