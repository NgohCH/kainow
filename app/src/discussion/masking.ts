import type { Pool, PoolClient } from 'pg';
import { locateQuote } from '../notes/text';
import type { MessageState } from './messages';

/** One message's place in a stored transcript, with the message's state now. */
export interface SpanState {
  headerStart: number;
  bodyStart: number;
  bodyEnd: number;
  state: MessageState;
}

/** A message of the transcript hidden or deleted (4a), or the whole source Deleted (history spec 4.2). */
export type SourceFlag = 'deleted' | 'hidden' | 'source_deleted';

export const SOURCE_FLAG_TEXT: Record<SourceFlag, string> = {
  deleted: 'Source message deleted — review',
  hidden: 'Source message hidden — review',
  source_deleted: 'Source deleted — review',
};

const MASK: Record<'deleted' | 'hidden', string> = { deleted: '[Message deleted]', hidden: '[Message hidden]' };

/**
 * An earlier transcript keeps its stored text (it is the evidence of earlier proposals), but wherever it is shown
 * the header and body of a message now hidden or deleted are replaced by a marker (spec 4.3).
 */
export function maskTranscript(text: string, spans: SpanState[]): string {
  const hidden = spans.filter((s) => s.state !== 'visible').sort((a, b) => a.headerStart - b.headerStart);
  let out = '';
  let at = 0;
  for (const s of hidden) {
    if (s.headerStart < at) continue;
    out += text.slice(at, s.headerStart) + MASK[s.state as 'deleted' | 'hidden'];
    at = s.bodyEnd;
  }
  return out + text.slice(at);
}

/** The state of the message holding the start of a quote; null when the quote is unplaced or its message is visible. */
export function quoteSourceFlag(quoteStart: number | null, quoteEnd: number | null, spans: SpanState[]): SourceFlag | null {
  if (quoteStart === null || quoteEnd === null) return null;
  const span = spans.find((s) => quoteStart >= s.headerStart && quoteStart < s.bodyEnd);
  return span && span.state !== 'visible' ? span.state : null;
}

type Db = Pool | PoolClient;

/** The spans of one stored transcript with each message's current state. Empty for a source that is not a discussion transcript. */
export async function loadSpanStates(db: Db, sourceVersionId: string): Promise<SpanState[]> {
  const { rows } = await db.query(
    `SELECT sp.header_start AS "headerStart", sp.body_start AS "bodyStart", sp.body_end AS "bodyEnd", m.state
       FROM transcript_spans sp
       JOIN source_versions v ON v.id = sp.source_version_id
       JOIN sources s ON s.id = v.source_id AND s.kind = 'discussion'
       JOIN discussion_messages m ON m.thread_id = s.thread_id AND m.message_no = sp.message_no
      WHERE sp.source_version_id = $1 ORDER BY sp.header_start`,
    [sourceVersionId],
  );
  return rows as SpanState[];
}

/** The note text as shown: masked for a discussion transcript, unchanged otherwise. */
export async function maskedVersionText(db: Db, sourceVersionId: string, text: string): Promise<string> {
  const spans = await loadSpanStates(db, sourceVersionId);
  return spans.length === 0 ? text : maskTranscript(text, spans);
}

interface ItemPlace {
  versionId: string;
  start: number;
  end: number;
}

/**
 * Where each proposal's quote sits in its stored transcript: the first place, or the one the reviewer chose among repeats.
 * Proposals from any other kind of source, or with an unplaced quote, are absent from the result.
 */
async function discussionItemPlaces(db: Db, itemIds: string[]): Promise<Map<string, ItemPlace>> {
  const places = new Map<string, ItemPlace>();
  if (itemIds.length === 0) return places;
  const { rows } = await db.query(
    `SELECT i.id, i.source_version_id AS "versionId", i.quote, i.quote_start AS "quoteStart", i.quote_end AS "quoteEnd",
            i.chosen_occurrence AS "chosen"
       FROM extraction_items i
       JOIN source_versions v ON v.id = i.source_version_id
       JOIN sources s ON s.id = v.source_id AND s.kind = 'discussion'
      WHERE i.id = ANY($1::uuid[]) AND i.quote_start IS NOT NULL`,
    [itemIds],
  );
  const textByVersion = new Map<string, string>();
  for (const r of rows) {
    let start: number = r.quoteStart;
    let end: number = r.quoteEnd;
    if (r.chosen) {
      // The reviewer picked a later occurrence of a repeated quote; that is the place that counts.
      if (!textByVersion.has(r.versionId)) {
        textByVersion.set(r.versionId, (await db.query(`SELECT text_content AS text FROM source_versions WHERE id = $1`, [r.versionId])).rows[0].text);
      }
      const place = locateQuote(textByVersion.get(r.versionId) as string, r.quote)[r.chosen];
      if (place) ({ start, end } = place);
    }
    places.set(r.id, { versionId: r.versionId, start, end });
  }
  return places;
}

/**
 * The flag for each proposal (extraction item) whose evidence is no longer there, worked out when shown: the source of
 * its version is Deleted (`source_deleted`, history spec 4.2; restoring clears it), or its quote lies in a message that
 * is now hidden or deleted. Items with neither are absent from the result. Nothing about the proposal itself changes.
 */
export async function itemSourceFlags(db: Db, itemIds: string[]): Promise<Map<string, SourceFlag>> {
  const flags = new Map<string, SourceFlag>();
  if (itemIds.length === 0) return flags;
  const { rows: gone } = await db.query<{ id: string }>(
    `SELECT i.id FROM extraction_items i
       JOIN source_versions v ON v.id = i.source_version_id
       JOIN sources s ON s.id = v.source_id
      WHERE i.id = ANY($1::uuid[]) AND s.status = 'deleted'`,
    [itemIds],
  );
  for (const r of gone) flags.set(r.id, 'source_deleted');
  const places = await discussionItemPlaces(db, itemIds.filter((id) => !flags.has(id)));
  const spansByVersion = new Map<string, SpanState[]>();
  for (const [id, place] of places) {
    if (!spansByVersion.has(place.versionId)) spansByVersion.set(place.versionId, await loadSpanStates(db, place.versionId));
    const spans = spansByVersion.get(place.versionId) as SpanState[];
    if (spans.every((s) => s.state === 'visible')) continue;
    const flag = quoteSourceFlag(place.start, place.end, spans);
    if (flag) flags.set(id, flag);
  }
  return flags;
}

/** Where a proposal came from in a discussion: the message, who wrote it and when. */
export interface DiscussionEvidence {
  threadId: string;
  messageNo: number;
  authorName: string;
  at: string;
}

/**
 * For each proposal whose quote lies in a discussion transcript: "Message #12 by <name>" from the transcript span at the start of the
 * quote (spec 7.4). A message now hidden or deleted gives no evidence (its header is masked, so the author is not named). Proposals
 * from any other kind of source are absent.
 */
export async function itemDiscussionEvidence(db: Db, itemIds: string[]): Promise<Map<string, DiscussionEvidence>> {
  const evidence = new Map<string, DiscussionEvidence>();
  const places = await discussionItemPlaces(db, itemIds);
  const byVersion = new Map<string, Array<DiscussionEvidence & { headerStart: number; bodyEnd: number }>>();
  for (const [id, place] of places) {
    if (!byVersion.has(place.versionId)) {
      const { rows } = await db.query(
        `SELECT s.thread_id AS "threadId", sp.message_no AS "messageNo", u.display_name AS "authorName", m.created_at AS at,
                sp.header_start AS "headerStart", sp.body_end AS "bodyEnd"
           FROM transcript_spans sp
           JOIN source_versions v ON v.id = sp.source_version_id
           JOIN sources s ON s.id = v.source_id AND s.kind = 'discussion'
           JOIN discussion_messages m ON m.thread_id = s.thread_id AND m.message_no = sp.message_no AND m.state = 'visible'
           JOIN users u ON u.id = sp.author_id
          WHERE sp.source_version_id = $1 ORDER BY sp.header_start`,
        [place.versionId],
      );
      byVersion.set(place.versionId, rows.map((r) => ({ ...r, at: (r.at as Date).toISOString() })));
    }
    const span = (byVersion.get(place.versionId) ?? []).find((s) => place.start >= s.headerStart && place.start < s.bodyEnd);
    if (span) evidence.set(id, { threadId: span.threadId, messageNo: span.messageNo, authorName: span.authorName, at: span.at });
  }
  return evidence;
}

const LABEL_TIME = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kuala_Lumpur', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/**
 * A label for each place a repeated quote occurs in a stored transcript, so a reviewer can choose without the masked text:
 * "Message #n by <name>, d MMM HH:mm" inside a visible new message, "Hidden or deleted message" once that message is no longer visible,
 * "Earlier message #n (context)" for a context message, "Message #n" for a header. No message text is used. Null where no message lies at the offset.
 */
export async function occurrenceLabels(db: Db, sourceVersionId: string, places: Array<{ start: number }>): Promise<Array<string | null>> {
  const { rows } = await db.query(
    `SELECT sp.message_no AS "no", sp.header_start AS "headerStart", sp.body_start AS "bodyStart", sp.body_end AS "bodyEnd", sp.is_context AS "ctx",
            m.state, m.created_at AS "at", u.display_name AS "name"
       FROM transcript_spans sp
       JOIN source_versions v ON v.id = sp.source_version_id
       JOIN sources s ON s.id = v.source_id AND s.kind = 'discussion'
       JOIN discussion_messages m ON m.thread_id = s.thread_id AND m.message_no = sp.message_no
       JOIN users u ON u.id = sp.author_id
      WHERE sp.source_version_id = $1 ORDER BY sp.header_start`,
    [sourceVersionId],
  );
  return places.map(({ start }) => {
    const sp = rows.find((r) => start >= r.headerStart && start < r.bodyEnd);
    if (!sp) return null;
    if (sp.state !== 'visible') return 'Hidden or deleted message';
    if (sp.ctx) return `Earlier message #${sp.no} (context)`;
    if (start < sp.bodyStart) return `Message #${sp.no}`;
    return `Message #${sp.no} by ${sp.name}, ${LABEL_TIME.format(sp.at as Date).replace(',', '').replace(/\bSept\b/, 'Sep')}`;
  });
}
