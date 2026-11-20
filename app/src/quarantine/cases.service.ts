/**
 * Reporting a suspected secret (history spec 7.1, 7.2, 7.3 without the key, 7.4 copies, 7.7): one transaction opens the
 * case, holds the item, runs the removal hook, cancels queued emails holding the text, cleans the item (or waits for
 * the protected key), finds the other places holding the same text and masks them at once (or holds them without the
 * key), works out the known disclosures, and notifies.
 *
 * The marked text is a parameter of SQL statements only. It is never logged, never written to a case, event,
 * notification, email or audit row, and never returned. Without the key it is not stored at all: the case keeps the
 * offsets of each mark in the held item's current text (numbers, in the `held` event's detail), and the worker job
 * reads the marks back from that text, which cannot change while held.
 *
 * Decisions (Claude's call, see the task report):
 *  - Held via held_case_id on the item's own row; a summary also holds its summary source, a minutes draft its
 *    meeting thread (spec 7.2) and the minutes sources published from it, so every source read path (and History)
 *    hides them through sources.held_case_id.
 *  - A reporter who cannot read the item now (audience rules), or an item already held or Deleted, finds nothing (404).
 *  - The reason may not repeat the marked text (400), so the case row never holds it even before cleaning.
 *  - Known disclosures are worked out at report time (emails can only be matched before the sweep cleans them) and
 *    kept in the `reported` event's detail: dates, provider, model, recipient counts and the audience size, no text.
 *  - The [kind] of the 7.7 notice is the detector's kind when the credential check recognises the marked text, else
 *    "credential".
 */
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { onMaterialRemoved, type RemovedMaterial } from '../assist/removal';
import { loadSummaryRow, summaryVisible } from '../assist/summaries.service';
import { writeAudit } from '../audit/audit';
import { CLOCK, type AuthUser, type Clock } from '../auth/tokens';
import { readReason } from '../common/reason';
import { UUID, uuidv7 } from '../common/uuid7';
import { APP_CONFIG, type AppConfig } from '../config';
import { PG_POOL } from '../db/database.module';
import { RESTRICTED_ROLES, inAudience } from '../discussion/audience';
import { AudienceService } from '../discussion/audience.service';
import { EMAIL_NUDGE, type EmailNudge } from '../email/nudge';
import { writeOutbox } from '../email/outbox';
import { findCredentialMatches, findCredentials } from '../extraction/credentials';
import { HELD, liveRecordSql } from '../history/deleted-sql';
import { requeueDigest } from '../digests/digest';
import { HELD_EMAIL_REASON, cancelQueuedHolding, sentHolding } from '../notifications/mailing';
import { loadOutputAccessRow, readsOutput } from '../outputs/readers';
import { type ProjectContext, ProjectAccess, canReadContent } from '../projects/access.service';
import { grantGivesAccess } from '../projects/grants';
import { effectiveRoles } from '../projects/membership';
import { cleanItem, findPlaces, restoreOriginals } from './clean';
import { MARKER, searchForms } from './clean-text';
import { POSSIBLE_COPY_TEXT } from './labels';
import { MAX_MARK_CHARS, MIN_MARK } from './mark-limits';
import { PROTECTED_KEY, type ProtectedKey } from './protected-key';
import { lockSweeps } from './sweep-lock';
import { ITEM_KINDS, ITEM_PROJECT, type ItemKind, TEXT_COLUMNS } from './registry';

export { POSSIBLE_COPY_TEXT, MIN_MARK, MAX_MARK_CHARS };
/** The reason on a queued email cancelled because it holds the reported text (spec 7.2). */
export const CANCELLED_REASON = HELD_EMAIL_REASON;
export const MARKS_REFUSED = 'Mark the suspected secret: text of at least 4 characters that appears exactly in the item as it is now.';
export const REASON_REPEATS = 'Do not repeat the suspected secret in the reason.';
export const HOLDER_REFUSED = 'Name the credential holder from the organisation’s people.';
export const KIND_REFUSED = 'Choose the kind of item the suspected secret is in.';
export const WAITING_FOR_KEY = 'Waiting for the protected key';
export const CASE_CLOSED = 'This case is closed.';
export const ALREADY_DECIDED = 'This place has already been confirmed or dismissed.';
export const NOT_CLEANED = 'This case cannot be released until its item is cleaned: it is waiting for the protected key.';
/**
 * A real credential reaches a handful of places in one project (the item, a quote, minutes, a task drawn from it). Marked
 * text found in more other places than this is an ordinary word, and the report or Mark more is refused (PO, 18 Nov 2026).
 */
export const MAX_PLACES = 10;
export const TOO_COMMON = (n: number) =>
  `This text appears in ${n} other places in the project, too common to be a credential. Mark a longer, more exact part.`;
export const MARKS_MORE_REFUSED = 'Mark further text of at least 4 characters that appears exactly in the cleaned text, outside the removed credentials.';
const MAX_MARKS = 20;
/** Kainow's own report marks every match the detector found, so its limit is wider than a person's. */
const MAX_KAINOW_MARKS = 500;


type Db = Pool | PoolClient;
export type Reporter = AuthUser | 'kainow';

export interface ReportInput {
  projectId: string;
  kind: ItemKind;
  id: string;
  marked: string[];
  reason: string | null;
  holderUserId?: string;
}

export interface Disclosures {
  aiRequests: Array<{ at: string; provider: string; model: string }>;
  emails: Array<{ at: string; recipients: number }>;
  audienceSize: number;
}

/** A case as a reviewer reads it (spec 7.5): references and counts, never the marked text. */
interface ReviewRow {
  id: string;
  projectId: string;
  kind: ItemKind;
  itemId: string;
  state: 'held' | 'cleaned' | 'released' | 'released_unchanged';
  waitingForKey: boolean;
  reporterId: string | null;
  reporterName: string | null;
  reason: string | null;
  reportedAt: Date;
  cleanedAt: Date | null;
}
const REVIEW_COLUMNS = `c.id, c.project_id AS "projectId", c.item_kind AS kind, c.item_id AS "itemId", c.state, c.waiting_for_key AS "waitingForKey",
  c.reporter_id AS "reporterId", u.display_name AS "reporterName", c.reason, c.reported_at AS "reportedAt", c.cleaned_at AS "cleanedAt"`;

export interface HeldCase {
  caseId: string;
  kind: ItemKind;
  itemId: string;
  state: string;
  /** "Waiting for the protected key" while the item is held uncleaned. */
  label: string | null;
  /** The item's title or reference, once cleaned (never while it still holds the marked text). */
  reference: string | null;
  /** The reporter's name, or "Kainow". */
  reporter: string;
  reason: string | null;
  reportedAt: string;
  cleanedAt: string | null;
}

/** The only AI provider Kainow sends to (spec 7.7: "provider" in the known disclosures). */
const PROVIDER = 'OpenAI';

// ---------------------------------------------------------------------------------------------------------------
// Per kind: where held_case_id lives, the item's current text, its author, a reference for the copies list
// ---------------------------------------------------------------------------------------------------------------

/** The meeting thread of a minutes draft id or a meeting thread id. */
const MINUTES_THREAD = `(SELECT thread_id FROM minutes_drafts WHERE id = $1 UNION SELECT id FROM discussion_threads WHERE id = $1 AND kind = 'meeting' LIMIT 1)`;

/** Statements setting held_case_id ($2) on the item's rows ($1) where it is still unset; one per row group. */
const HOLD: Record<ItemKind, string[]> = {
  message: [`UPDATE discussion_messages SET held_case_id = $2 WHERE id = $1 AND held_case_id IS NULL`],
  source: [
    `UPDATE sources SET held_case_id = $2 WHERE id = $1 AND held_case_id IS NULL`,
    `UPDATE summaries SET held_case_id = $2 WHERE summary_source_id = $1 AND held_case_id IS NULL`,
  ],
  task: [`UPDATE tasks SET held_case_id = $2 WHERE id = $1 AND held_case_id IS NULL`],
  decision: [`UPDATE decisions SET held_case_id = $2 WHERE id = $1 AND held_case_id IS NULL`],
  question: [`UPDATE questions SET held_case_id = $2 WHERE id = $1 AND held_case_id IS NULL`],
  risk: [`UPDATE risks SET held_case_id = $2 WHERE id = $1 AND held_case_id IS NULL`],
  proposal: [`UPDATE extraction_items SET held_case_id = $2 WHERE id = $1 AND held_case_id IS NULL`],
  human_proposal: [`UPDATE human_proposals SET held_case_id = $2 WHERE id = $1 AND held_case_id IS NULL`],
  answer: [`UPDATE ai_answers SET held_case_id = $2 WHERE request_id = $1 AND held_case_id IS NULL`],
  report_draft: [`UPDATE report_drafts SET held_case_id = $2 WHERE id = $1 AND held_case_id IS NULL`],
  summary: [
    `UPDATE summaries SET held_case_id = $2 WHERE id = $1 AND held_case_id IS NULL`,
    `UPDATE sources SET held_case_id = $2 WHERE summary_id = $1 AND held_case_id IS NULL`,
  ],
  minutes_draft: [
    `UPDATE discussion_threads SET held_case_id = $2 WHERE id = ${MINUTES_THREAD} AND held_case_id IS NULL`,
    `UPDATE sources SET held_case_id = $2 WHERE kind = 'minutes' AND thread_id = ${MINUTES_THREAD} AND held_case_id IS NULL`,
  ],
  feedback: [`UPDATE ai_feedback SET held_case_id = $2 WHERE id = $1 AND held_case_id IS NULL`],
  thread: [`UPDATE discussion_threads SET held_case_id = $2 WHERE id = $1 AND held_case_id IS NULL`],
  output: [
    `UPDATE outputs SET held_case_id = $2 WHERE id = $1 AND held_case_id IS NULL`,
    `UPDATE output_versions SET held_case_id = $2 WHERE output_id = $1 AND held_case_id IS NULL`,
  ],
};

/** The same rows, released from case $2. */
const UNHOLD: Record<ItemKind, string[]> = Object.fromEntries(
  Object.entries(HOLD).map(([k, sqls]) => [k, sqls.map((s) => s.replace(/SET held_case_id = \$2/, 'SET held_case_id = NULL').replace(/held_case_id IS NULL$/, 'held_case_id = $2'))]),
) as Record<ItemKind, string[]>;

/** The item's current text ($1 = id), one `text` value; the marks must occur in it. */
const CURRENT_TEXT: Record<ItemKind, string> = {
  message: `SELECT v.body AS text FROM message_versions v WHERE v.message_id = $1 ORDER BY v.version_no DESC LIMIT 1`,
  source: `SELECT concat_ws(E'\\n', s.title, (SELECT v.text_content FROM source_versions v WHERE v.source_id = s.id ORDER BY v.version_no DESC LIMIT 1)) AS text FROM sources s WHERE s.id = $1`,
  task: `SELECT concat_ws(E'\\n', title, owner_as_written) AS text FROM tasks WHERE id = $1`,
  decision: `SELECT concat_ws(E'\\n', statement, rationale) AS text FROM decisions WHERE id = $1`,
  question: `SELECT concat_ws(E'\\n', q.text, (SELECT string_agg(a.answer, E'\\n' ORDER BY a.id) FROM question_answers a WHERE a.question_id = q.id)) AS text FROM questions q WHERE q.id = $1`,
  risk: `SELECT concat_ws(E'\\n', description, mitigation) AS text FROM risks WHERE id = $1`,
  proposal: `SELECT concat_ws(E'\\n', i.text, i.owner, i.due, i.due_event, i.quote, array_to_string(i.alternatives, E'\\n'),
                     (SELECT string_agg(concat_ws(E'\\n', e.text, e.owner, e.due, e.due_event), E'\\n' ORDER BY e.edited_at, e.id) FROM extraction_item_edits e WHERE e.item_id = i.id)) AS text
               FROM extraction_items i WHERE i.id = $1`,
  human_proposal: `SELECT concat_ws(E'\\n', text, owner, due) AS text FROM human_proposals WHERE id = $1`,
  answer: `SELECT concat_ws(E'\\n', question, answer_markdown) AS text FROM ai_answers WHERE request_id = $1`,
  report_draft: `SELECT concat_ws(E'\\n', d.title, d.brief, (SELECT v.body FROM report_draft_versions v WHERE v.draft_id = d.id ORDER BY v.version_no DESC LIMIT 1)) AS text FROM report_drafts d WHERE d.id = $1`,
  summary: `SELECT concat_ws(E'\\n', sm.leave_out, (SELECT v.body FROM summary_versions v WHERE v.summary_id = sm.id ORDER BY v.version_no DESC LIMIT 1)) AS text FROM summaries sm WHERE sm.id = $1`,
  minutes_draft: `SELECT d.body AS text FROM minutes_drafts d WHERE d.id = $1 OR d.thread_id = $1 ORDER BY (d.id = $1) DESC, d.version_no DESC LIMIT 1`,
  feedback: `SELECT concat_ws(E'\\n', note, escalation_note) AS text FROM ai_feedback WHERE id = $1`,
  thread: `SELECT title AS text FROM discussion_threads WHERE id = $1`,
  output: `SELECT concat_ws(E'\\n', title, delete_reason) AS text FROM outputs WHERE id = $1`,
};

/** The item's author when a person (spec 7.7: message author, source creator, record's proposer or AI requester). */
const AUTHOR: Record<ItemKind, string> = {
  message: `SELECT author_id AS id FROM discussion_messages WHERE id = $1`,
  source: `SELECT created_by AS id FROM sources WHERE id = $1`,
  task: `SELECT p.proposed_by AS id FROM tasks t JOIN human_proposals p ON p.id = t.origin_proposal_id WHERE t.id = $1`,
  decision: `SELECT p.proposed_by AS id FROM decisions t JOIN human_proposals p ON p.id = t.origin_proposal_id WHERE t.id = $1`,
  question: `SELECT p.proposed_by AS id FROM questions t JOIN human_proposals p ON p.id = t.origin_proposal_id WHERE t.id = $1`,
  risk: `SELECT p.proposed_by AS id FROM risks t JOIN human_proposals p ON p.id = t.origin_proposal_id WHERE t.id = $1`,
  proposal: `SELECT NULL::uuid AS id`,
  human_proposal: `SELECT proposed_by AS id FROM human_proposals WHERE id = $1`,
  answer: `SELECT requested_by AS id FROM ai_requests WHERE id = $1`,
  report_draft: `SELECT created_by AS id FROM report_drafts WHERE id = $1`,
  summary: `SELECT created_by AS id FROM summaries WHERE id = $1`,
  minutes_draft: `SELECT created_by AS id FROM minutes_drafts WHERE id = $1 OR thread_id = $1 ORDER BY (id = $1) DESC, version_no DESC LIMIT 1`,
  feedback: `SELECT reporter_id AS id FROM ai_feedback WHERE id = $1`,
  thread: `SELECT created_by AS id FROM discussion_threads WHERE id = $1`,
  output: `SELECT author_id AS id FROM outputs WHERE id = $1`,
};

/** A short reference for the Possible copies list (spec 7.4: "title or reference"), read only once the place is masked. */
const REFERENCE: Record<ItemKind, string> = {
  message: `SELECT 'Message ' || m.message_no || ' in ' || th.title AS ref FROM discussion_messages m JOIN discussion_threads th ON th.id = m.thread_id WHERE m.id = $1`,
  source: `SELECT title AS ref FROM sources WHERE id = $1`,
  task: `SELECT title AS ref FROM tasks WHERE id = $1`,
  decision: `SELECT statement AS ref FROM decisions WHERE id = $1`,
  question: `SELECT text AS ref FROM questions WHERE id = $1`,
  risk: `SELECT description AS ref FROM risks WHERE id = $1`,
  proposal: `SELECT text AS ref FROM extraction_items WHERE id = $1`,
  human_proposal: `SELECT text AS ref FROM human_proposals WHERE id = $1`,
  answer: `SELECT question AS ref FROM ai_answers WHERE request_id = $1`,
  report_draft: `SELECT title AS ref FROM report_drafts WHERE id = $1`,
  summary: `SELECT 'Shareable summary' AS ref`,
  minutes_draft: `SELECT 'Minutes of ' || th.title AS ref FROM discussion_threads th WHERE th.id = ${MINUTES_THREAD}`,
  feedback: `SELECT 'Feedback note' AS ref`,
  thread: `SELECT title AS ref FROM discussion_threads WHERE id = $1`,
  output: `SELECT title AS ref FROM outputs WHERE id = $1`,
};

/** "in a note" (spec 7.4 alert). Sources by their own kind. */
const KIND_WORDS: Record<ItemKind, string> = {
  message: 'a message', source: 'a note', task: 'a task', decision: 'a decision', question: 'a question', risk: 'a risk',
  proposal: 'a proposal', human_proposal: 'a proposal', answer: 'an AI answer', report_draft: 'a report draft',
  summary: 'a shareable summary', minutes_draft: 'a minutes draft', feedback: 'a feedback note', thread: 'a thread title',
  output: 'an output',
};
const SOURCE_WORDS: Record<string, string> = { notes: 'a note', minutes: 'meeting minutes', summary: 'a shareable summary', discussion: 'a discussion transcript' };

/** The registered column whose itemSql lists a kind's rows of `table` (one column per table is enough to find the rows). */
const columnOf = (table: string, column: string) => TEXT_COLUMNS.find((c) => c.table === table && c.column === column);

// ---------------------------------------------------------------------------------------------------------------
// Helpers shared by the report and the worker job
// ---------------------------------------------------------------------------------------------------------------

/**
 * Holds the item's rows. Returns false when the item's own row was already held (by another case, e.g. a second
 * report racing this one: the UPDATE waits for the other transaction and then finds the row held).
 */
async function hold(db: Db, kind: ItemKind, id: string, caseId: string): Promise<boolean> {
  let own = true;
  for (const [i, sql] of HOLD[kind].entries()) {
    const r = await db.query(sql, [id, caseId]);
    if (i === 0 && !r.rowCount) own = false;
  }
  return own;
}

/** Releases the item's rows from case `caseId` (the reverse of holding them). */
export async function unhold(db: Db, kind: ItemKind, id: string, caseId: string): Promise<void> {
  for (const sql of UNHOLD[kind]) await db.query(sql, [id, caseId]);
}

async function currentText(db: Db, kind: ItemKind, id: string): Promise<string | null> {
  const { rows } = await db.query<{ text: string | null }>(CURRENT_TEXT[kind], [id]);
  return rows[0]?.text ?? null;
}

/**
 * Kainow's own reports (spec 7.1) may mark text found in any stored version of a versioned item, not only the current one,
 * since the sweep cleans every version. The text a mark is looked up in: the current text, then (for a source or a message)
 * the other versions' text. A person's report keeps the current-text rule.
 */
async function markableText(db: Db, kind: ItemKind, id: string, anyVersion: boolean): Promise<string | null> {
  const current = await currentText(db, kind, id);
  if (current === null || !anyVersion) return current;
  const sql =
    kind === 'source'
      ? `SELECT string_agg(text_content, E'\n' ORDER BY version_no DESC) AS text FROM source_versions WHERE source_id = $1`
      : kind === 'message'
        ? `SELECT string_agg(body, E'\n' ORDER BY version_no DESC) AS text FROM message_versions WHERE message_id = $1`
        : null;
  if (!sql) return current;
  const all = (await db.query<{ text: string | null }>(sql, [id])).rows[0]?.text;
  return all ? `${current}
${all}` : current;
}

/**
 * The marks the reported item itself is cleaned with (spec 7.4: "for the reported item itself, every credential-check
 * match"): the marked text plus whatever the credential check finds in any stored version of the item. Only the item
 * itself: other places are searched for the marked text alone (PO decision).
 */
async function ownMarks(db: Db, kind: ItemKind, id: string, marks: string[]): Promise<string[]> {
  const text = await markableText(db, kind, id, true);
  return [...new Set([...marks, ...(text ? findCredentialMatches(text) : [])])];
}

/** Every [start, end) of the marker in a cleaned text. */
function markerSpans(text: string): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  for (let at = text.indexOf(MARKER); at !== -1; at = text.indexOf(MARKER, at + MARKER.length)) out.push({ start: at, end: at + MARKER.length });
  return out;
}

/**
 * Whether a mark cannot be cleaned as a whole: it is part of the marker, or one of its occurrences runs into a marker
 * already in the text (cleaning skips such occurrences, so the secret would stay; M1, NB1).
 */
function crossesMarker(text: string, mark: string): boolean {
  if (MARKER.includes(mark)) return true;
  const spans = markerSpans(text);
  for (let at = text.indexOf(mark); at !== -1; at = text.indexOf(mark, at + 1)) {
    if (spans.some((s) => at < s.end && at + mark.length > s.start)) return true;
  }
  return false;
}

async function event(
  db: Db,
  e: { caseId: string; projectId: string; actorId: string | null; action: string; kind?: ItemKind | null; itemId?: string | null; reason?: string | null; detail?: Record<string, unknown> | null; at: Date },
): Promise<void> {
  await db.query(
    `INSERT INTO quarantine_events (id, case_id, project_id, actor_id, action, item_kind, item_id, reason, detail, at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [uuidv7(e.at.getTime()), e.caseId, e.projectId, e.actorId, e.action, e.kind ?? null, e.itemId ?? null, e.reason ?? null, e.detail ? JSON.stringify(e.detail) : null, e.at],
  );
}

/**
 * Proposals among the places that hold the marks only in the quote they took from the reported item (a row derived
 * from it, spec 7.4), not in their own wording: not other places. Matters without the key, when the reported item
 * is not cleaned before the search; with the key its sweep has already cleaned those quotes.
 */
async function quoteOnlyProposals(db: Db, kind: ItemKind, id: string, marks: string[]): Promise<Set<string>> {
  const quote = columnOf('extraction_items', 'quote')?.itemSql?.[kind];
  if (!quote) return new Set();
  const forms = searchForms(marks);
  const derived = (await db.query<{ id: string }>(`SELECT q.id::text AS id FROM (${quote}) q WHERE EXISTS (SELECT 1 FROM unnest($2::text[]) m WHERE strpos(q.value, m) > 0)`, [id, forms])).rows.map((r) => r.id);
  const out = new Set<string>();
  for (const proposal of derived) {
    let own = false;
    for (const col of TEXT_COLUMNS) {
      if ((col.table !== 'extraction_items' && col.table !== 'extraction_item_edits') || col.column === 'quote') continue;
      const sql = col.itemSql?.proposal;
      if (!sql) continue;
      const value = col.array ? `array_to_string(q.value, E'\\n')` : 'q.value';
      const hit = await db.query(`SELECT 1 FROM (${sql}) q WHERE EXISTS (SELECT 1 FROM unnest($2::text[]) m WHERE strpos(${value}, m) > 0) LIMIT 1`, [proposal, forms]);
      if (hit.rowCount) {
        own = true;
        break;
      }
    }
    if (!own) out.add(proposal);
  }
  return out;
}

/** Marks a case cleaned once its item and places are cleaned. */
async function markCleaned(db: Db, caseId: string, projectId: string, at: Date, detail: Record<string, unknown>): Promise<void> {
  await db.query(`UPDATE quarantine_cases SET state = 'cleaned', cleaned_at = $2, waiting_for_key = false WHERE id = $1`, [caseId, at]);
  await event(db, { caseId, projectId, actorId: null, action: 'cleaned', detail, at });
}

async function inTransaction<T>(pool: Pool, work: (db: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * The worker job `quarantine.clean-waiting` (spec 7.3): when the key is present, cleans the cases that were reported
 * without it, oldest report first, one transaction each. The marks are read back from the held item's current text at
 * the offsets the case kept; the item is cleaned, then every place held for the case is cleaned and released from
 * hold (masked, as if the key had been there at report time). Returns how many cases were cleaned.
 */
export async function cleanWaitingCases(pool: Pool, key: ProtectedKey, now: Date, log: (m: string) => void = () => undefined): Promise<number> {
  const waiting = (await pool.query<{ id: string }>(`SELECT id FROM quarantine_cases WHERE waiting_for_key AND state = 'held' ORDER BY reported_at, id`)).rows;
  let cleaned = 0;
  for (const { id } of waiting) {
    // One case that fails must not stop the others: logged by case id and SQLSTATE only (never a value), then the next.
    let done = false;
    try {
      done = await inTransaction(pool, async (db) => {
        // The project's sweep lock first, before any row lock (C1).
        const project = (await db.query<{ projectId: string }>(`SELECT project_id AS "projectId" FROM quarantine_cases WHERE id = $1`, [id])).rows[0];
        if (!project) return false;
        await lockSweeps(db, project.projectId);
        const c = (
          await db.query<{ projectId: string; kind: ItemKind; itemId: string; kainow: boolean }>(
            `SELECT project_id AS "projectId", item_kind AS kind, item_id AS "itemId", reporter_id IS NULL AS kainow FROM quarantine_cases
              WHERE id = $1 AND waiting_for_key AND state = 'held' FOR UPDATE SKIP LOCKED`,
            [id],
          )
        ).rows[0];
        if (!c) return false;
        const held = (await db.query<{ detail: { textLength?: number; marks?: Array<{ start: number; end: number }> } }>(
          `SELECT detail FROM quarantine_events WHERE case_id = $1 AND action = 'held' ORDER BY at, id LIMIT 1`,
          [id],
        )).rows[0]?.detail;
        const text = await markableText(db, c.kind, c.itemId, c.kainow);
        if (!held?.marks || text === null || text.length !== held.textLength) {
          log('A case waiting for the protected key could not be cleaned: its held item is not as it was reported.');
          return false;
        }
        const marks = [...new Set(held.marks.map((m) => text.slice(m.start, m.end)))];
        const at = now;
        const item = await cleanItem(db, key, id, c.kind, c.itemId, await ownMarks(db, c.kind, c.itemId, marks));
        const places = (
          await db.query<{ kind: ItemKind; id: string }>(
            `SELECT item_kind AS kind, item_id AS id FROM quarantine_possible_copies
              WHERE case_id = $1 AND NOT masked AND decision IS DISTINCT FROM 'dismissed' ORDER BY found_at, item_kind, item_id FOR UPDATE`,
            [id],
          )
        ).rows;
        let rows = item.rows;
        for (const p of places) {
          rows += (await cleanItem(db, key, id, p.kind, p.id, marks)).rows;
          await unhold(db, p.kind, p.id, id);
          await db.query(`UPDATE quarantine_possible_copies SET masked = true WHERE case_id = $1 AND item_kind = $2 AND item_id = $3`, [id, p.kind, p.id]);
        }
        await markCleaned(db, id, c.projectId, at, { rows, places: places.length });
        return true;
      });
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      log(`A case waiting for the protected key could not be cleaned (case ${id}${typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? `, SQLSTATE ${code}` : ''}); it stays waiting.`);
    }
    if (done) cleaned++;
  }
  return cleaned;
}

// ---------------------------------------------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------------------------------------------

/** One person's view of a project, as ProjectAccess would build it for them today (never an Administrator). */
function asPerson(ctx: ProjectContext, userId: string): ProjectContext {
  return {
    ...ctx,
    viewerId: userId,
    isAdmin: false,
    roles: effectiveRoles(ctx.rows, userId, ctx.today),
    grantKinds: [...new Set(ctx.grants.filter((g) => g.userId === userId && grantGivesAccess(g, ctx.today, ctx.rows)).map((g) => g.kind))],
  };
}

const KAINOW_VIEWER: AuthUser = { id: '00000000-0000-7000-8000-000000000000', email: 'kainow@kainow.test', displayName: 'Kainow', role: 'member' } as AuthUser;

@Injectable()
export class CasesService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly now: Clock,
    @Inject(PROTECTED_KEY) private readonly key: ProtectedKey | null,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(EMAIL_NUDGE) private readonly nudge: EmailNudge,
    private readonly access: ProjectAccess,
    private readonly audiences: AudienceService,
  ) {}

  /**
   * Report a suspected secret (spec 7.1, 7.2): anyone who can read the item now, in any project state; or Kainow itself
   * ('kainow', no reporter). Everything happens in one transaction; the emails queued with it are nudged after commit.
   */
  async report(user: Reporter, input: ReportInput): Promise<{ caseId: string }> {
    if (!ITEM_KINDS.includes(input.kind)) throw new BadRequestException(KIND_REFUSED);
    if (!UUID.test(input.id) || !UUID.test(input.projectId)) throw new NotFoundException();
    const caseId = await inTransaction(this.pool, async (db) => {
      // Whether the item was held already (a plain read; no row is locked before the sweep lock).
      const heldBefore = await this.heldCase(db, input.kind, input.id);
      // The project's sweep lock first (C1): runners saving output read from this project wait, and later saves discard.
      await lockSweeps(db, input.projectId);
      const ctx =
        user === 'kainow'
          ? await this.access.load(input.projectId, KAINOW_VIEWER, db)
          : await this.access.authorize(user, 'secret.report', input.projectId, db);
      if (!ctx) throw new NotFoundException();
      const owner = (await db.query<{ project_id: string }>(ITEM_PROJECT[input.kind], [input.id])).rows[0]?.project_id;
      if (owner !== ctx.project.id) throw new NotFoundException();
      if (user === 'kainow') {
        if (await this.isHeld(db, input.kind, input.id)) throw new ConflictException('This item is already held for a suspected credential.');
      } else if (!(await this.readable(db, ctx, user, input.kind, input.id))) {
        // A report racing another one on the same item (a double submit) waited on the sweep lock and now finds the item
        // held by it: 409 for someone who could read the item but for that hold. An item held before is simply not
        // there (404), as before.
        const heldBy = heldBefore ? null : await this.heldCase(db, input.kind, input.id);
        if (heldBy && (await this.readable(db, ctx, user, input.kind, input.id, heldBy))) throw new ConflictException(HELD);
        throw new NotFoundException();
      }

      // The marks: distinct strings of 4+ characters, each exactly in the item's current text.
      const marks = this.readMarks(input.marked, user === 'kainow');
      const text = await markableText(db, input.kind, input.id, user === 'kainow');
      // A mark inside the marker ("credential", "removed") would rewrite markers already there (M1); one running into a
      // marker already in the text would be skipped by cleaning and stay (NB1).
      if (text === null || marks.some((m) => !text.includes(m) || crossesMarker(text, m))) throw new BadRequestException(MARKS_REFUSED);
      let reason: string | null = null;
      if (user !== 'kainow' || input.reason !== null) {
        reason = readReason(input.reason);
        if (marks.some((m) => reason!.includes(m))) throw new BadRequestException(REASON_REPEATS);
      }
      const holder = input.holderUserId ?? null;
      if (holder !== null) {
        const ok = UUID.test(holder) && (await db.query(`SELECT 1 FROM users WHERE id = $1 AND status = 'active'`, [holder])).rowCount;
        if (!ok) throw new BadRequestException(HOLDER_REFUSED);
      }
      return this.open(db, ctx, user === 'kainow' ? null : user.id, input, marks, text, reason, holder);
    });
    await this.nudge.nudge().catch(() => undefined);
    return { caseId };
  }

  private readMarks(raw: unknown, kainow = false): string[] {
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > (kainow ? MAX_KAINOW_MARKS : MAX_MARKS)) throw new BadRequestException(MARKS_REFUSED);
    if (raw.some((m) => typeof m !== 'string' || m.length < MIN_MARK || m.length > MAX_MARK_CHARS || m.trim().length < MIN_MARK)) throw new BadRequestException(MARKS_REFUSED);
    return [...new Set(raw as string[])];
  }

  private async isHeld(db: Db, kind: ItemKind, id: string): Promise<boolean> {
    return (await this.heldCase(db, kind, id)) !== null;
  }

  /** The case holding the item's own row, or null. */
  private async heldCase(db: Db, kind: ItemKind, id: string): Promise<string | null> {
    // Any of the item's own hold statements would leave it unchanged when it is held already.
    const table = HOLD[kind][0].match(/^UPDATE (\w+) SET held_case_id = \$2 WHERE (.+) AND held_case_id IS NULL$/);
    if (!table) return null;
    const { rows } = await db.query<{ held: string }>(`SELECT held_case_id AS held FROM ${table[1]} WHERE ${table[2]} AND held_case_id IS NOT NULL`, [id]);
    return rows[0]?.held ?? null;
  }

  /** The case itself: everything after the checks, in the report's transaction. */
  private async open(db: PoolClient, ctx: ProjectContext, reporterId: string | null, input: ReportInput, marks: string[], text: string, reason: string | null, holder: string | null): Promise<string> {
    const at = this.now();
    const caseId = uuidv7(at.getTime());
    const projectId = ctx.project.id;
    const { kind, id } = input;
    const detectorKinds = [...new Set(findCredentials(marks.join('\n')).map((f) => f.pattern))];
    const key = this.key;

    // Worked out before anything changes: who can read it now, what was sent, and what is still queued.
    const disclosures: Disclosures = {
      aiRequests: await this.aiDisclosures(db, kind, id),
      emails: await sentHolding(db, marks, { kind, id }),
      audienceSize: await this.audienceSize(db, ctx, kind, id),
    };
    const authorId = (await db.query<{ id: string | null }>(AUTHOR[kind], [id])).rows[0]?.id ?? null;
    const sourceKind = kind === 'source' ? ((await db.query<{ kind: string }>(`SELECT kind FROM sources WHERE id = $1`, [id])).rows[0]?.kind ?? 'notes') : null;

    await db.query(
      `INSERT INTO quarantine_cases (id, project_id, item_kind, item_id, reporter_id, reason, marked_length, detector_kinds, holder_user_id, state, waiting_for_key, reported_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'held', $10, $11)`,
      [caseId, projectId, kind, id, reporterId, reason, marks.reduce((n, m) => n + m.length, 0), detectorKinds, holder, key === null, at],
    );
    await db.query(`INSERT INTO quarantine_items (case_id, item_kind, item_id, role) VALUES ($1, $2, $3, 'reported')`, [caseId, kind, id]);
    await event(db, { caseId, projectId, actorId: reporterId, action: 'reported', kind, itemId: id, detail: { disclosures }, at });

    // Held at once: hidden everywhere; outputs built on it withdrawn or sent to review; summaries of it hidden.
    // Already held (a double submit): no second case, no second round of notices.
    if (!(await hold(db, kind, id, caseId))) throw new ConflictException(HELD);
    const removed = await this.removedMaterial(db, kind, id);
    if (removed) await onMaterialRemoved(db, removed, 'quarantined', at);
    // Without the key the marks are kept only as offsets into the held text (numbers, no text).
    const heldDetail: Record<string, unknown> = key === null ? { waitingForKey: true, textLength: text.length, marks: marks.map((m) => ({ start: text.indexOf(m), end: text.indexOf(m) + m.length })) } : {};
    await event(db, { caseId, projectId, actorId: reporterId, action: 'held', kind, itemId: id, detail: heldDetail, at });

    // Emails still queued that hold the text never go; then the sweep cleans every stored copy.
    const { cancelled, digests } = await cancelQueuedHolding(db, marks, { kind, id });
    let cleanedRows = 0;
    if (key) cleanedRows = (await cleanItem(db, key, caseId, kind, id, await ownMarks(db, kind, id, marks))).rows;

    // Other places in the project: masked at once (cleaned, not held), or held until the key appears.
    const derived = await quoteOnlyProposals(db, kind, id, marks);
    const places = (await findPlaces(db, projectId, marks, { kind, id })).filter((p) => !(p.kind === 'proposal' && derived.has(p.id)));
    // A person's mark found in too many places is an ordinary word: refused, and the whole transaction (hold, cleaning)
    // rolls back. Kainow's own reports are credentials its check recognised, so they are never refused for this.
    if (reporterId !== null && places.length > MAX_PLACES) throw new BadRequestException(TOO_COMMON(places.length));
    for (const p of places) {
      if (key) cleanedRows += (await cleanItem(db, key, caseId, p.kind, p.id, marks)).rows;
      else await hold(db, p.kind, p.id, caseId);
      await db.query(
        `INSERT INTO quarantine_possible_copies (case_id, item_kind, item_id, found_at, masked) VALUES ($1, $2, $3, $4, $5)`,
        [caseId, p.kind, p.id, at, key !== null],
      );
    }
    if (key) await markCleaned(db, caseId, projectId, at, { rows: cleanedRows, places: places.length });
    if (places.length > 0) await event(db, { caseId, projectId, actorId: null, action: 'copies_found', detail: { count: places.length, masked: key !== null }, at });
    // Digests cancelled above go again, rebuilt now that the item is held and its copies masked or held (PO).
    for (const d of digests) await requeueDigest(db, d, at);

    // Notices (spec 7.4, 7.7): never the text.
    const projectName = (await db.query<{ name: string }>(`SELECT name FROM projects WHERE id = $1`, [projectId])).rows[0].name;
    const words = sourceKind ? SOURCE_WORDS[sourceKind] : KIND_WORDS[kind];
    const notified = await this.notify(db, { caseId, projectId, projectName, detectorKinds, authorId, holder, at });
    let alerted = 0;
    if (places.length > 0) alerted = await this.alertCopies(db, ctx, { caseId, projectId, projectName, words, count: places.length, masked: key !== null, at });
    await event(db, { caseId, projectId, actorId: null, action: 'notified', detail: { recipients: notified, copyAlerts: alerted, emailsCancelled: cancelled }, at });
    await writeAudit(db, { at, action: 'quarantine.reported', actorUserId: reporterId, subjectType: 'quarantine_case', subjectId: caseId, detail: { projectId, itemKind: kind } });
    return caseId;
  }

  /** What the removal hook treats as gone (spec 7.2): the item's messages, sources and records. */
  private async removedMaterial(db: Db, kind: ItemKind, id: string): Promise<RemovedMaterial | null> {
    if (kind === 'source') return { sourceIds: [id] };
    if (kind === 'message') return { messageIds: [id] };
    if (kind === 'task' || kind === 'decision' || kind === 'question' || kind === 'risk') return { records: [{ kind, id }] };
    if (kind === 'summary' || kind === 'minutes_draft') {
      const sql =
        kind === 'summary'
          ? `SELECT id FROM sources WHERE summary_id = $1`
          : `SELECT id FROM sources WHERE kind = 'minutes' AND thread_id = ${MINUTES_THREAD}`;
      const ids = (await db.query<{ id: string }>(sql, [id])).rows.map((r) => r.id);
      return ids.length > 0 ? { sourceIds: ids } : null;
    }
    return null;
  }

  /** Urgent notice, in-app and by email at once (spec 7.7): every Administrator, the author if a person, the named holder. */
  private async notify(
    db: Db,
    n: { caseId: string; projectId: string; projectName: string; detectorKinds: string[]; authorId: string | null; holder: string | null; at: Date },
  ): Promise<number> {
    const credential = n.detectorKinds.length > 0 ? n.detectorKinds.join(' or ') : 'credential';
    const summary = `A suspected ${credential} was reported in ${n.projectName} and held. If it is real, revoke or rotate it. Kainow cannot recall copies already sent.`;
    const link = `#/quarantine/cases/${n.caseId}`;
    const people = (
      await db.query<{ id: string; email: string }>(
        `SELECT id, email FROM users WHERE status = 'active' AND (role = 'enterprise_administrator' OR id = ANY($1::uuid[])) ORDER BY id`,
        [[n.authorId, n.holder].filter((x): x is string => x !== null)],
      )
    ).rows;
    for (const p of people) {
      const outboxId = await writeOutbox(db, {
        toUserId: p.id,
        toAddress: p.email,
        subject: `Kainow: a suspected credential was reported in ${n.projectName}`,
        body: `${summary}\n\n${this.config.appUrl}/${link}`,
        kind: 'credential_report',
        projectId: n.projectId,
        initiatedBy: 'system',
        relevance: { kind: 'none', scope: 'account' },
        now: n.at,
      });
      await db.query(
        `INSERT INTO notifications (id, user_id, project_id, kind, urgent, summary, link, created_at, outbox_id, email_off)
         VALUES ($1, $2, $3, 'credential_reported', true, $4, $5, $6, $7, false)`,
        [uuidv7(n.at.getTime()), p.id, n.projectId, summary, link, n.at, outboxId],
      );
    }
    return people.length;
  }

  /** The urgent in-app alert to the PM and every Deputy about the other places (spec 7.4). */
  private async alertCopies(
    db: Db,
    ctx: ProjectContext,
    a: { caseId: string; projectId: string; projectName: string; words: string; count: number; masked: boolean; at: Date },
  ): Promise<number> {
    const places = a.count === 1 ? '1 other place' : `${a.count} other places`;
    const tail = a.masked ? 'has been masked there' : 'has been held there until it can be masked';
    const summary = `The text reported as a suspected credential in ${a.words} also appeared in ${places} in ${a.projectName} and ${tail}`;
    const managers = [...new Set(ctx.rows.map((r) => r.userId))].filter((u) => effectiveRoles(ctx.rows, u, ctx.today).some((r) => r === 'pm' || r === 'deputy_pm')).sort();
    for (const userId of managers) {
      await db.query(
        `INSERT INTO notifications (id, user_id, project_id, kind, urgent, summary, link, created_at, email_off) VALUES ($1, $2, $3, 'quarantine_copies', true, $4, $5, $6, true)`,
        [uuidv7(a.at.getTime()), userId, a.projectId, summary, `#/quarantine/cases/${a.caseId}/copies`, a.at],
      );
    }
    return managers.length;
  }

  /** AI requests and extraction or analysis runs that sent the item or its passages (started, so possibly sent). */
  private async aiDisclosures(db: Db, kind: ItemKind, id: string): Promise<Disclosures['aiRequests']> {
    const parts: string[] = [];
    const material = columnOf('ai_request_material', 'location')?.itemSql?.[kind];
    if (material) {
      parts.push(`SELECT r.started_at AS at, r.model_id AS model FROM ai_requests r
                   WHERE r.started_at IS NOT NULL AND r.id IN (SELECT q.request_id FROM (${material}) q JOIN ai_request_material m ON m.request_id = q.request_id AND m.ordinal = q.ordinal WHERE NOT m.dropped_at_start)`);
    }
    const extraction = columnOf('extraction_runs', 'failure_detail')?.itemSql?.[kind];
    if (extraction) parts.push(`SELECT r.started_at, r.model_id FROM extraction_runs r WHERE r.started_at IS NOT NULL AND r.id IN (SELECT q.id FROM (${extraction}) q)`);
    const analysis = columnOf('analysis_runs', 'failure_detail')?.itemSql?.[kind];
    if (analysis) parts.push(`SELECT r.started_at, NULL::text FROM analysis_runs r WHERE r.started_at IS NOT NULL AND r.kind = 'minutes' AND r.id IN (SELECT q.id FROM (${analysis}) q)`);
    if (parts.length === 0) return [];
    const { rows } = await db.query<{ at: Date; model: string | null }>(`SELECT at, model FROM (${parts.join(' UNION ALL ')}) x ORDER BY at`, [id]);
    return rows.map((r) => ({ at: r.at.toISOString(), provider: PROVIDER, model: r.model ?? 'unknown' }));
  }

  /** How many of the project's people (Active roles and grants giving access today) can read the item now. */
  private async audienceSize(db: Db, ctx: ProjectContext, kind: ItemKind, id: string): Promise<number> {
    const people = new Set<string>([...ctx.rows.map((r) => r.userId), ...ctx.grants.map((g) => g.userId)]);
    let n = 0;
    for (const userId of people) {
      const view = asPerson(ctx, userId);
      if (!canReadContent(view)) continue;
      if (await this.readable(db, view, { id: userId } as AuthUser, kind, id)) n++;
    }
    return n;
  }

  /**
   * Whether this person can read the item now by its audience (spec 7.1: "anyone who can currently read the item"). A
   * held or Deleted item, or a discussion transcript (not an item), is readable by nobody here, except that a hold by
   * `reviewing` (the case under review, spec 7.5) is looked through: its reviewers are the item's audience as if it
   * were not held.
   */
  private async readable(db: Db, ctx: ProjectContext, user: AuthUser, kind: ItemKind, id: string, reviewing: string | null = null): Promise<boolean> {
    if (!canReadContent(ctx)) return false;
    const held = (caseId: string | null | undefined): boolean => !!caseId && caseId !== reviewing;
    const thread = async (threadId: string): Promise<boolean> => {
      const t = (await db.query<{ held: string | null }>(`SELECT held_case_id AS held FROM discussion_threads WHERE id = $1`, [threadId])).rows[0];
      if (!t || held(t.held)) return false;
      return inAudience(ctx, await this.audiences.forThread(threadId, db));
    };
    const source = async (sourceId: string): Promise<boolean> => {
      const s = (await db.query<{ status: string; held: string | null; kind: string }>(`SELECT status, held_case_id AS held, kind FROM sources WHERE id = $1`, [sourceId])).rows[0];
      if (!s || s.status === 'deleted' || held(s.held) || s.kind === 'discussion') return false;
      return this.audiences.canSeeSource(ctx, user, await this.audiences.sourceAccessRow(sourceId, db));
    };
    const one = async (sql: string): Promise<Record<string, any> | undefined> => (await db.query(sql, [id])).rows[0];
    switch (kind) {
      case 'source':
        return source(id);
      case 'message': {
        const m = await one(`SELECT thread_id, state, held_case_id FROM discussion_messages WHERE id = $1`);
        return !!m && m.state === 'visible' && !held(m.held_case_id) && thread(m.thread_id);
      }
      case 'thread':
        return thread(id);
      case 'minutes_draft': {
        const t = await one(`SELECT ${MINUTES_THREAD} AS id`);
        return !!t?.id && thread(t.id);
      }
      case 'task':
      case 'decision':
      case 'question':
      case 'risk': {
        // Every participant reads the project's records (Task 3's ruling); a cleaned record under review is in view.
        const table = { task: 'tasks', decision: 'decisions', question: 'questions', risk: 'risks' }[kind];
        const r = await one(`SELECT (${liveRecordSql('x')}) AS live, x.deleted_at IS NULL AS present, x.held_case_id FROM ${table} x WHERE x.id = $1`);
        return !!r && (r.live || (r.present && !held(r.held_case_id)));
      }
      case 'proposal': {
        const p = await one(`SELECT v.source_id, i.held_case_id FROM extraction_items i JOIN source_versions v ON v.id = i.source_version_id WHERE i.id = $1`);
        if (!p || held(p.held_case_id)) return false;
        // A proposal from a discussion transcript is read with its thread.
        const s = (await db.query<{ kind: string; threadId: string | null }>(`SELECT kind, thread_id AS "threadId" FROM sources WHERE id = $1`, [p.source_id])).rows[0];
        if (s?.kind === 'discussion' && s.threadId) return thread(s.threadId);
        return source(p.source_id);
      }
      case 'human_proposal': {
        const h = await one(`SELECT held_case_id FROM human_proposals WHERE id = $1`);
        return !!h && !held(h.held_case_id);
      }
      case 'answer': {
        const a = await one(
          `SELECT a.visibility, a.shared_thread_id, a.review_state, a.held_case_id, r.requested_by FROM ai_answers a JOIN ai_requests r ON r.id = a.request_id WHERE a.request_id = $1`,
        );
        if (!a || held(a.held_case_id) || a.review_state === 'withdrawn') return false;
        if (a.requested_by === user.id) return true;
        return a.visibility === 'shared' && !!a.shared_thread_id && thread(a.shared_thread_id);
      }
      case 'report_draft': {
        const d = await one(`SELECT created_by, shared, review_state, held_case_id FROM report_drafts WHERE id = $1`);
        return !!d && !held(d.held_case_id) && d.review_state !== 'withdrawn' && (d.created_by === user.id || d.shared === true);
      }
      case 'summary': {
        const row = await loadSummaryRow(db, id);
        if (!row || held(row.heldCaseId)) return false;
        const seen = { ...row, heldCaseId: null };
        if (await summaryVisible(db, ctx, seen)) return true;
        return (row.state === 'approved' || row.state === 'review_required') && !!row.summarySourceId && source(row.summarySourceId);
      }
      case 'feedback': {
        const f = await one(`SELECT reporter_id, held_case_id FROM ai_feedback WHERE id = $1`);
        return !!f && !held(f.held_case_id) && (f.reporter_id === user.id || ctx.roles.some((r) => RESTRICTED_ROLES.includes(r)));
      }
      case 'output': {
        // The output register's own rule (spec 4.6): audience, submission and review state, hold and deletion.
        const row = await loadOutputAccessRow(db, id);
        return !!row && (await readsOutput(db, ctx, row, { lookThroughCase: reviewing }));
      }
    }
  }

  // -------------------------------------------------------------------------------------------------------------
  // Possible copies (spec 7.4)
  // -------------------------------------------------------------------------------------------------------------

  /** The case, for the PM or a Deputy of its project: 404 for anyone outside it, 403 for other roles. */
  private async caseFor(db: Db, user: AuthUser, caseId: string, lock = false): Promise<{ id: string; projectId: string; state: string }> {
    if (!UUID.test(caseId)) throw new NotFoundException();
    if (lock) await this.lockCaseProject(db, caseId);
    const c = (await db.query(`SELECT id, project_id AS "projectId", state FROM quarantine_cases WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`, [caseId])).rows[0];
    if (!c) throw new NotFoundException();
    await this.access.authorize(user, 'quarantine.copies', c.projectId, db);
    return c;
  }

  /**
   * The sweep lock of the case's project (C1), taken first in a transaction that sweeps or restores: before the case
   * row is locked or updated. The project of a case never changes, so it is read without a lock.
   */
  private async lockCaseProject(db: Db, caseId: string): Promise<void> {
    const p = (await db.query<{ projectId: string }>(`SELECT project_id AS "projectId" FROM quarantine_cases WHERE id = $1`, [caseId])).rows[0];
    if (p) await lockSweeps(db, p.projectId);
  }

  /** The project's open cases with places still awaiting a decision (PM and Deputy): references and counts, never text. */
  async copiesAwaiting(user: AuthUser, projectId: string): Promise<{ cases: Array<{ caseId: string; kind: ItemKind; reportedAt: string; awaiting: number }> }> {
    if (!UUID.test(projectId)) throw new NotFoundException();
    const ctx = await this.access.authorize(user, 'quarantine.copies', projectId);
    const { rows } = await this.pool.query<{ caseId: string; kind: ItemKind; reportedAt: Date; awaiting: string }>(
      `SELECT c.id AS "caseId", c.item_kind AS kind, c.reported_at AS "reportedAt", count(*)::text AS awaiting
         FROM quarantine_cases c JOIN quarantine_possible_copies pc ON pc.case_id = c.id AND pc.decision IS NULL
        WHERE c.project_id = $1 AND c.state IN ('held', 'cleaned') GROUP BY c.id ORDER BY c.reported_at, c.id`,
      [ctx.project.id],
    );
    return { cases: rows.map((r) => ({ caseId: r.caseId, kind: r.kind, reportedAt: r.reportedAt.toISOString(), awaiting: Number(r.awaiting) })) };
  }

  /** The Possible copies list: kind, reference and date for each place; never the marked text. */
  async copies(user: AuthUser, caseId: string): Promise<{ copies: Array<{ kind: ItemKind; id: string; reference: string | null; foundAt: string; masked: boolean; decision: string | null; decidedAt: string | null; label: string | null }> }> {
    const c = await this.caseFor(this.pool, user, caseId);
    const { rows } = await this.pool.query<{ kind: ItemKind; id: string; foundAt: Date; masked: boolean; decision: string | null; decidedAt: Date | null }>(
      `SELECT item_kind AS kind, item_id AS id, found_at AS "foundAt", masked, decision, decided_at AS "decidedAt"
         FROM quarantine_possible_copies WHERE case_id = $1 ORDER BY found_at, item_kind, item_id`,
      [c.id],
    );
    const out = [];
    for (const r of rows) {
      // Only a masked place's own text is shown, never one still holding the marked text (held, waiting for the key).
      let reference: string | null = null;
      if (r.masked && r.decision !== 'dismissed') {
        const ref = (await this.pool.query<{ ref: string | null }>(REFERENCE[r.kind], [r.id])).rows[0]?.ref ?? null;
        reference = ref && ref.length > 80 ? `${ref.slice(0, 79)}…` : ref;
      }
      out.push({
        kind: r.kind,
        id: r.id,
        reference,
        foundAt: r.foundAt.toISOString(),
        masked: r.masked,
        decision: r.decision,
        decidedAt: r.decidedAt ? r.decidedAt.toISOString() : null,
        label: r.decision === null ? (r.masked ? POSSIBLE_COPY_TEXT : WAITING_FOR_KEY) : null,
      });
    }
    return { copies: out };
  }

  /**
   * Confirm (the place joins the case as a copy and stays cleaned) or dismiss (its originals are decrypted back into
   * place, scoped to what its own sweep cleaned, with the changed-since-cleaning rule) each place, in one top-level
   * transaction. PM or Deputy, any project state.
   */
  async decideCopies(
    user: AuthUser,
    caseId: string,
    decisions: Array<{ kind: ItemKind; id: string; decision: 'confirmed' | 'dismissed' }>,
  ): Promise<{ decided: Array<{ kind: ItemKind; id: string; decision: string; changedSinceCleaning: number }> }> {
    const list = this.readDecisions(decisions);
    return inTransaction(this.pool, async (db) => {
      const c = await this.caseFor(db, user, caseId, true);
      if (c.state !== 'held' && c.state !== 'cleaned') throw new ConflictException(CASE_CLOSED);
      const at = this.now();
      const out = [];
      for (const d of list) {
        const place = (
          await db.query<{ masked: boolean; decision: string | null }>(
            `SELECT masked, decision FROM quarantine_possible_copies WHERE case_id = $1 AND item_kind = $2 AND item_id = $3 FOR UPDATE`,
            [c.id, d.kind, d.id],
          )
        ).rows[0];
        if (!place) throw new NotFoundException();
        if (place.decision !== null) throw new ConflictException(ALREADY_DECIDED);
        let changed = 0;
        let restored = 0;
        if (d.decision === 'confirmed') {
          await db.query(`INSERT INTO quarantine_items (case_id, item_kind, item_id, role) VALUES ($1, $2, $3, 'copy') ON CONFLICT DO NOTHING`, [c.id, d.kind, d.id]);
        } else if (place.masked) {
          if (!this.key) throw new ConflictException(WAITING_FOR_KEY);
          const r = await restoreOriginals(db, this.key, c.id, { kind: d.kind, id: d.id });
          changed = r.changed.length;
          restored = r.restored;
        } else {
          await unhold(db, d.kind, d.id, c.id);
        }
        await db.query(
          `UPDATE quarantine_possible_copies SET decision = $4, decided_by = $5, decided_at = $6 WHERE case_id = $1 AND item_kind = $2 AND item_id = $3`,
          [c.id, d.kind, d.id, d.decision, user.id, at],
        );
        await event(db, {
          caseId: c.id,
          projectId: c.projectId,
          actorId: user.id,
          action: d.decision === 'confirmed' ? 'copy_confirmed' : 'copy_dismissed',
          kind: d.kind,
          itemId: d.id,
          detail: d.decision === 'dismissed' ? { restored, changedSinceCleaning: changed } : null,
          at,
        });
        out.push({ kind: d.kind, id: d.id, decision: d.decision, changedSinceCleaning: changed });
      }
      return { decided: out };
    });
  }

  private readDecisions(raw: unknown): Array<{ kind: ItemKind; id: string; decision: 'confirmed' | 'dismissed' }> {
    const refused = 'For each place, confirm it or dismiss it.';
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > 500) throw new BadRequestException(refused);
    const seen = new Set<string>();
    return raw.map((d: unknown) => {
      const x = (d ?? {}) as Record<string, unknown>;
      if (!ITEM_KINDS.includes(x.kind as ItemKind) || typeof x.id !== 'string' || !UUID.test(x.id) || (x.decision !== 'confirmed' && x.decision !== 'dismissed')) {
        throw new BadRequestException(refused);
      }
      const k = `${x.kind}:${x.id}`;
      if (seen.has(k)) throw new BadRequestException(refused);
      seen.add(k);
      return { kind: x.kind as ItemKind, id: x.id, decision: x.decision };
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // Review, mark more, release (spec 7.5)
  // -------------------------------------------------------------------------------------------------------------

  /**
   * The case, for a reviewer: PM, Owner or Sponsor of its project (`quarantine.release`, any project state) who can read
   * the item under its audience rules, the case's own hold looked through. 404 for anyone outside the project or the
   * item's audience (even with the role), 403 for other roles of the project.
   */
  private async reviewCase(db: Db, user: AuthUser, caseId: string, lock = false): Promise<ReviewRow & { ctx: ProjectContext }> {
    if (!UUID.test(caseId)) throw new NotFoundException();
    if (lock) await this.lockCaseProject(db, caseId);
    const c = (await db.query<ReviewRow>(`SELECT ${REVIEW_COLUMNS} FROM quarantine_cases c LEFT JOIN users u ON u.id = c.reporter_id WHERE c.id = $1 ${lock ? 'FOR UPDATE OF c' : ''}`, [caseId])).rows[0];
    if (!c) throw new NotFoundException();
    const ctx = await this.access.authorize(user, 'quarantine.release', c.projectId, db);
    if (!(await this.readable(db, ctx, user, c.kind, c.itemId, c.id))) throw new NotFoundException();
    return { ...c, ctx };
  }

  /** One line of the Held for review list or the head of the cleaned view: references, never the item's original. */
  private async summaryOf(db: Db, c: ReviewRow): Promise<HeldCase> {
    const cleaned = c.state === 'cleaned' || c.state === 'released';
    let reference: string | null = null;
    if (cleaned) {
      const ref = (await db.query<{ ref: string | null }>(REFERENCE[c.kind], [c.itemId])).rows[0]?.ref ?? null;
      reference = ref && ref.length > 80 ? `${ref.slice(0, 79)}…` : ref;
    }
    return {
      caseId: c.id,
      kind: c.kind,
      itemId: c.itemId,
      state: c.state,
      label: c.waitingForKey ? WAITING_FOR_KEY : null,
      reference,
      reporter: c.reporterName ?? 'Kainow',
      reason: c.reason,
      reportedAt: c.reportedAt.toISOString(),
      cleanedAt: c.cleanedAt ? c.cleanedAt.toISOString() : null,
    };
  }

  /** The Held for review list (spec 7.5): the project's open cases whose item this PM, Owner or Sponsor can read. */
  async heldForReview(user: AuthUser, projectId: string): Promise<{ cases: HeldCase[] }> {
    if (!UUID.test(projectId)) throw new NotFoundException();
    const ctx = await this.access.authorize(user, 'quarantine.release', projectId);
    const { rows } = await this.pool.query<ReviewRow>(
      `SELECT ${REVIEW_COLUMNS} FROM quarantine_cases c LEFT JOIN users u ON u.id = c.reporter_id
        WHERE c.project_id = $1 AND c.state IN ('held', 'cleaned') ORDER BY c.reported_at, c.id`,
      [ctx.project.id],
    );
    const out: HeldCase[] = [];
    for (const c of rows) if (await this.readable(this.pool, ctx, user, c.kind, c.itemId, c.id)) out.push(await this.summaryOf(this.pool, c));
    return { cases: out };
  }

  /**
   * The cleaned view (spec 7.5): the item's current text, cleaned, with the place of each [credential removed]. While
   * the case waits for the protected key, or once it was released unchanged, the text holds the secret and is not shown.
   */
  async cleanedView(user: AuthUser, caseId: string): Promise<HeldCase & { text: string | null; markers: Array<{ start: number; end: number }> }> {
    const c = await this.reviewCase(this.pool, user, caseId);
    const head = await this.summaryOf(this.pool, c);
    const shown = c.state === 'cleaned' || c.state === 'released';
    const text = shown ? await currentText(this.pool, c.kind, c.itemId) : null;
    return { ...head, text, markers: text ? markerSpans(text) : [] };
  }

  /**
   * Mark more (spec 7.5): further text the reviewer selects in the cleaned text is swept and cleaned as at the report
   * (spec 7.4), its originals encrypted into the same case; other places holding it are masked and alerted as then.
   */
  async markMore(user: AuthUser, caseId: string, marked: unknown): Promise<{ caseId: string; rows: number; places: number }> {
    const out = await inTransaction(this.pool, async (db) => {
      const c = await this.reviewCase(db, user, caseId, true);
      if (c.state === 'released' || c.state === 'released_unchanged') throw new ConflictException(CASE_CLOSED);
      if (c.state !== 'cleaned' || !this.key) throw new ConflictException(WAITING_FOR_KEY);
      const key = this.key;
      const marks = this.readMarks(marked);
      const text = (await currentText(db, c.kind, c.itemId)) ?? '';
      if (marks.some((m) => !text.includes(m) || crossesMarker(text, m))) throw new BadRequestException(MARKS_MORE_REFUSED);
      const at = this.now();
      const projectId = c.projectId;
      const { cancelled, digests } = await cancelQueuedHolding(db, marks, { kind: c.kind, id: c.itemId });
      let rows = (await cleanItem(db, key, c.id, c.kind, c.itemId, await ownMarks(db, c.kind, c.itemId, marks))).rows;
      const derived = await quoteOnlyProposals(db, c.kind, c.itemId, marks);
      const places = (await findPlaces(db, projectId, marks, { kind: c.kind, id: c.itemId })).filter((p) => !(p.kind === 'proposal' && derived.has(p.id)));
      if (places.length > MAX_PLACES) throw new BadRequestException(TOO_COMMON(places.length));
      let added = 0;
      for (const p of places) {
        rows += (await cleanItem(db, key, c.id, p.kind, p.id, marks)).rows;
        // A new place, or one already listed and still undecided or dismissed (dismissed for the earlier marks, it now
        // holds the new ones): masked, undecided and labelled again, so the PM or a Deputy decides it afresh. A place
        // already confirmed stays confirmed (it is part of the case; its new cleaning is released with it).
        const ins = await db.query(
          `INSERT INTO quarantine_possible_copies (case_id, item_kind, item_id, found_at, masked) VALUES ($1, $2, $3, $4, true)
           ON CONFLICT (case_id, item_kind, item_id) DO UPDATE SET masked = true, decision = NULL, decided_by = NULL, decided_at = NULL, found_at = EXCLUDED.found_at
            WHERE quarantine_possible_copies.decision IS DISTINCT FROM 'confirmed'`,
          [c.id, p.kind, p.id, at],
        );
        added += ins.rowCount ?? 0;
      }
      for (const d of digests) await requeueDigest(db, d, at);
      await db.query(`UPDATE quarantine_cases SET marked_length = marked_length + $2 WHERE id = $1`, [c.id, marks.reduce((n, m) => n + m.length, 0)]);
      await event(db, { caseId: c.id, projectId, actorId: user.id, action: 'marked_more', kind: c.kind, itemId: c.itemId, detail: { marks: marks.length, rows, places: places.length, emailsCancelled: cancelled }, at });
      if (added > 0) {
        const projectName = (await db.query<{ name: string }>(`SELECT name FROM projects WHERE id = $1`, [projectId])).rows[0].name;
        await this.alertCopies(db, c.ctx, { caseId: c.id, projectId, projectName, words: await this.wordsFor(db, c.kind, c.itemId), count: added, masked: true, at });
      }
      await writeAudit(db, { at, action: 'quarantine.marked_more', actorUserId: user.id, subjectType: 'quarantine_case', subjectId: c.id, detail: { projectId, itemKind: c.kind } });
      return { caseId: c.id, rows, places: places.length };
    });
    await this.nudge.nudge().catch(() => undefined);
    return out;
  }

  /**
   * Release (spec 7.5), by a reviewer with a reason, in any project state: the cleaned item and the confirmed copies
   * return to their audience and the case closes as `released`; places still undecided are confirmed by the release
   * (copy_confirmed, detail { auto: true }), so they stay masked. Nothing that was withdrawn comes back: AI answers
   * stay withdrawn and a hidden summary stays hidden until confirmed (4b). The reporter (a person) and the PM are told
   * in-app. One top-level transaction; nothing is decrypted, so no quarantine write follows the case-row update.
   */
  async release(user: AuthUser, caseId: string, body: { reason: unknown }): Promise<{ caseId: string; state: 'released'; copies: number }> {
    return inTransaction(this.pool, async (db) => {
      const c = await this.reviewCase(db, user, caseId, true);
      if (c.state === 'released' || c.state === 'released_unchanged') throw new ConflictException(CASE_CLOSED);
      if (c.state !== 'cleaned') throw new ConflictException(NOT_CLEANED);
      const reason = readReason(body.reason);
      const at = this.now();
      await db.query(`UPDATE quarantine_cases SET state = 'released', closed_at = $2, closed_by = $3, close_reason = $4 WHERE id = $1`, [c.id, at, user.id, reason]);
      await unhold(db, c.kind, c.itemId, c.id);
      // Places still undecided are confirmed by the release (their masking stays; nothing is left undecidable once closed).
      const undecided = (
        await db.query<{ kind: ItemKind; id: string }>(
          `SELECT item_kind AS kind, item_id AS id FROM quarantine_possible_copies WHERE case_id = $1 AND decision IS NULL ORDER BY found_at, item_kind, item_id FOR UPDATE`,
          [c.id],
        )
      ).rows;
      for (const p of undecided) {
        await db.query(`INSERT INTO quarantine_items (case_id, item_kind, item_id, role) VALUES ($1, $2, $3, 'copy') ON CONFLICT DO NOTHING`, [c.id, p.kind, p.id]);
        await db.query(
          `UPDATE quarantine_possible_copies SET decision = 'confirmed', decided_by = $4, decided_at = $5 WHERE case_id = $1 AND item_kind = $2 AND item_id = $3`,
          [c.id, p.kind, p.id, user.id, at],
        );
        await event(db, { caseId: c.id, projectId: c.projectId, actorId: user.id, action: 'copy_confirmed', kind: p.kind, itemId: p.id, detail: { auto: true }, at });
      }
      const copies =(await db.query<{ kind: ItemKind; id: string }>(`SELECT item_kind AS kind, item_id AS id FROM quarantine_items WHERE case_id = $1 AND role = 'copy' ORDER BY item_kind, item_id`, [c.id])).rows;
      for (const p of copies) await unhold(db, p.kind, p.id, c.id);
      await event(db, { caseId: c.id, projectId: c.projectId, actorId: user.id, action: 'released', kind: c.kind, itemId: c.itemId, reason, detail: { copies: copies.length }, at });
      const told = await this.notifyReleased(db, c, at);
      await event(db, { caseId: c.id, projectId: c.projectId, actorId: null, action: 'notified', detail: { released: told }, at });
      await writeAudit(db, { at, action: 'quarantine.released', actorUserId: user.id, subjectType: 'quarantine_case', subjectId: c.id, detail: { projectId: c.projectId, itemKind: c.kind } });
      return { caseId: c.id, state: 'released' as const, copies: copies.length };
    });
  }

  private async wordsFor(db: Db, kind: ItemKind, id: string): Promise<string> {
    if (kind !== 'source') return KIND_WORDS[kind];
    const k = (await db.query<{ kind: string }>(`SELECT kind FROM sources WHERE id = $1`, [id])).rows[0]?.kind ?? 'notes';
    return SOURCE_WORDS[k] ?? KIND_WORDS.source;
  }

  /** In-app notice to the reporter (a person) and the project's PM that the case was released (spec 7.5); never the text. */
  private async notifyReleased(db: Db, c: ReviewRow & { ctx: ProjectContext }, at: Date): Promise<number> {
    const projectName = (await db.query<{ name: string }>(`SELECT name FROM projects WHERE id = $1`, [c.projectId])).rows[0].name;
    const summary = `The item held for a suspected credential in ${projectName} (${await this.wordsFor(db, c.kind, c.itemId)}) was released after review, with the credential removed.`;
    const link =
      c.kind === 'source'
        ? `#/notes/${c.itemId}`
        : c.kind === 'summary'
          ? `#/summaries/${c.itemId}`
          : c.kind === 'task'
            ? `#/projects/${c.projectId}/work/${c.itemId}`
            : `#/projects/${c.projectId}`;
    const pms = [...new Set(c.ctx.rows.map((r) => r.userId))].filter((u) => effectiveRoles(c.ctx.rows, u, c.ctx.today).includes('pm'));
    const people = [...new Set([...(c.reporterId ? [c.reporterId] : []), ...pms])].sort();
    for (const userId of people) {
      await db.query(
        `INSERT INTO notifications (id, user_id, project_id, kind, urgent, summary, link, created_at, email_off) VALUES ($1, $2, $3, 'quarantine_released', false, $4, $5, $6, true)`,
        [uuidv7(at.getTime()), userId, c.projectId, summary, link, at],
      );
    }
    return people.length;
  }

  /**
   * Known disclosures (spec 7.7), as worked out at report time. Dates, provider, model and counts only.
   * Internal: no permission check here. Any endpoint exposing it must authorise first (Administrators and security
   * reviewers only; Task 14 adds the Administrators' case view).
   */
  async disclosures(caseId: string): Promise<Disclosures> {
    if (!UUID.test(caseId)) throw new NotFoundException();
    const row = (await this.pool.query<{ detail: { disclosures?: Disclosures } | null }>(
      `SELECT detail FROM quarantine_events WHERE case_id = $1 AND action = 'reported' ORDER BY at, id LIMIT 1`,
      [caseId],
    )).rows[0];
    if (!row) throw new NotFoundException();
    return row.detail?.disclosures ?? { aiRequests: [], emails: [], audienceSize: 0 };
  }
}

