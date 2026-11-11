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

export type SourceFlag = 'deleted' | 'hidden';

export const SOURCE_FLAG_TEXT: Record<SourceFlag, string> = {
  deleted: 'Source message deleted — review',
  hidden: 'Source message hidden — review',
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

/**
 * The flag for each proposal (extraction item) whose quote lies in a message that is now hidden or deleted.
 * Items from any other kind of source, or with an unplaced quote, are absent from the result.
 */
export async function itemSourceFlags(db: Db, itemIds: string[]): Promise<Map<string, SourceFlag>> {
  const flags = new Map<string, SourceFlag>();
  if (itemIds.length === 0) return flags;
  const { rows } = await db.query(
    `SELECT i.id, i.source_version_id AS "versionId", i.quote, i.quote_start AS "quoteStart", i.quote_end AS "quoteEnd",
            i.chosen_occurrence AS "chosen"
       FROM extraction_items i
       JOIN source_versions v ON v.id = i.source_version_id
       JOIN sources s ON s.id = v.source_id AND s.kind = 'discussion'
      WHERE i.id = ANY($1::uuid[]) AND i.quote_start IS NOT NULL`,
    [itemIds],
  );
  const spansByVersion = new Map<string, SpanState[]>();
  const textByVersion = new Map<string, string>();
  for (const r of rows) {
    if (!spansByVersion.has(r.versionId)) spansByVersion.set(r.versionId, await loadSpanStates(db, r.versionId));
    const spans = spansByVersion.get(r.versionId) as SpanState[];
    if (spans.every((s) => s.state === 'visible')) continue;
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
    const flag = quoteSourceFlag(start, end, spans);
    if (flag) flags.set(r.id, flag);
  }
  return flags;
}
