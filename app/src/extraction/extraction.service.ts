import { triggerLabelSql } from '../analysis/labels';
import { itemDiscussionEvidence, itemSourceFlags, occurrenceLabels } from '../discussion/masking';
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { writeAudit } from '../audit/audit';
import { CLOCK, type Clock } from '../auth/tokens';
import { uuidv7 } from '../common/uuid7';
import { PROPOSAL_REJECTED_REASON, lockPendingAuthorisation, rejectPendingAuthorisation } from '../changes/end-pending';
import { PG_POOL } from '../db/database.module';
import { notHeldSql, refuseHeld } from '../history/deleted-sql';
import { QUOTE_CHANGED_TEXT, quoteChangedItems } from '../quarantine/clean';
import { POSSIBLE_COPY_TEXT, possibleCopyLabelSql, possibleCopySql } from '../quarantine/labels';
import { listedSourceSql } from '../notes/notes.service';
import { locateQuote } from '../notes/text';
import { activeMembershipSql } from '../projects/access-sql';
import { ROLE_LABEL } from '../projects/matrix';
import { type ProjectRole, todayUtc8 } from '../projects/membership';
import { type DueReading, type ReviewerDue, isCalendarDate, readDue } from './due';
import { EXTRACTION_QUEUE, type ExtractionQueue } from './queue';

export const AUTHORISED_MESSAGE = 'This proposal has been authorised; its record changes only through an amendment.';

/** What authorising a proposal works from: the wording in force and its due reading. */
export interface ApprovedItem {
  id: string;
  kind: 'action' | 'decision' | 'question' | 'risk';
  text: string;
  owner: string | null;
  due: DueReading;
  quote: string;
}

export const NEEDS_DATE_MESSAGE = 'This action needs a due date, a date range or the event it waits on before it can be approved.';

type Queryable = Pick<Pool, 'query'>;

/** The latest reviewer edit of item i, joined as e. */
export const LATEST_EDIT = `LEFT JOIN LATERAL (
  SELECT id, kind, text, owner, due, due_earliest, due_latest, due_event, ignore_model_event
    FROM extraction_item_edits WHERE item_id = i.id ORDER BY edited_at DESC, id DESC LIMIT 1
) e ON true`;

/**
 * The type in force of item i with its latest edit e (D130): the latest edit's when set, else the model's. Edits
 * written before 0036 have no kind; they never changed it.
 */
export const KIND_IN_FORCE = 'COALESCE(e.kind, i.kind)';

export const PROPOSAL_KINDS = ['decision', 'action', 'question', 'risk'] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];
export const MAX_CORRECTION_REASON = 500;
export const REASON_NEEDED = 'Give a reason for changing the type.';

/** One reviewer correction of a proposal as everyone sees it (D130), newest first. */
export interface Correction {
  at: string;
  by: string;
  role: string | null;
  changed: Array<'type' | 'text' | 'owner' | 'due'>;
  from: { kind: string };
  to: { kind: string };
  reason: string | null;
}

/** Fixed role order: the first Active role in it names the editor. */
const ROLE_ORDER = Object.keys(ROLE_LABEL) as ProjectRole[];

/** What a due reading is worked out from, for item i with its latest edit e. */
const DUE_COLUMNS = `CASE WHEN e.id IS NULL THEN i.due ELSE e.due END AS due, i.due_event AS "dueEvent",
  to_char(e.due_earliest, 'YYYY-MM-DD') AS "reviewerEarliest", to_char(e.due_latest, 'YYYY-MM-DD') AS "reviewerLatest",
  e.due_event AS "reviewerEvent", COALESCE(e.ignore_model_event, false) AS "reviewerIgnoreEvent"`;

interface DueRow {
  due: string | null;
  dueEvent: string | null;
  reviewerEarliest: string | null;
  reviewerLatest: string | null;
  reviewerEvent: string | null;
  reviewerIgnoreEvent: boolean;
}

type FullReviewerDue = ReviewerDue & { ignoreModelEvent: boolean };

function reviewerDueOf(row: DueRow): FullReviewerDue | null {
  return row.reviewerEarliest || row.reviewerEvent || row.reviewerIgnoreEvent
    ? { earliest: row.reviewerEarliest, latest: row.reviewerLatest, event: row.reviewerEvent, ignoreModelEvent: row.reviewerIgnoreEvent }
    : null;
}

function dueReadingOf(row: DueRow, meetingDate: string | null): DueReading {
  return readDue({ due: row.due, dueEvent: row.dueEvent, meetingDate }, reviewerDueOf(row));
}

type DueFields = { dueEarliest?: unknown; dueLatest?: unknown; dueEvent?: unknown; ignoreModelEvent?: unknown };

/** True when an edit body says anything about the due; the four fields are then replaced together. */
const givesDue = (input: DueFields): boolean =>
  input.dueEarliest !== undefined || input.dueLatest !== undefined || input.dueEvent !== undefined || input.ignoreModelEvent !== undefined;

/** A reviewer's due from an edit body: dates or an event, not both. Blank means none. */
function cleanReviewerDue(input: DueFields): FullReviewerDue {
  if (input.ignoreModelEvent !== undefined && typeof input.ignoreModelEvent !== 'boolean') {
    throw new BadRequestException('ignoreModelEvent must be true or false');
  }
  const day = (v: unknown): string | null => {
    if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) return null;
    if (typeof v === 'string' && isCalendarDate(v.trim())) return v.trim();
    throw new BadRequestException('Dates must be in the form YYYY-MM-DD');
  };
  const earliest = day(input.dueEarliest);
  const latest = day(input.dueLatest);
  const event = cleanWording(input.dueEvent, 'dueEvent', MAX_PROPOSAL_FIELD, false);
  if (event && (earliest || latest)) throw new BadRequestException('Give dates or an event, not both');
  if (latest && !earliest) throw new BadRequestException('Give the earliest date first');
  if (earliest && latest && latest < earliest) throw new BadRequestException('The latest date cannot be before the earliest date');
  return { earliest, latest: earliest ? (latest ?? earliest) : null, event, ignoreModelEvent: input.ignoreModelEvent === true };
}

/** A quote that repeats more often than this lists only its first places for choosing. */
export const MAX_OCCURRENCE_CHOICES = 100;

export const MAX_PROPOSAL_TEXT = 2000;
export const MAX_PROPOSAL_FIELD = 200;

/** A typed value: NFC, line ends as LF, trimmed. Blank owner or due becomes null; blank text is refused. */
function cleanWording(value: unknown, name: string, max: number, required: boolean): string | null {
  if (value === undefined || value === null) {
    if (required) throw new BadRequestException(`${name} is required`);
    return null;
  }
  if (typeof value !== 'string') throw new BadRequestException(`${name} must be text`);
  const v = value.replace(/\r\n?/g, '\n').normalize('NFC').trim();
  if (v === '') {
    if (required) throw new BadRequestException(`${name} must not be blank`);
    return null;
  }
  if (v.length > max) throw new BadRequestException(`${name} must be at most ${max} characters`);
  return v;
}

const RUN_COLUMNS = `id, source_version_id AS "sourceVersionId", status, failure_code AS "failureCode", failure_detail AS "failureDetail",
  attempts, item_count AS "itemCount", unlocated_count AS "unlocatedCount", model_id AS "modelId",
  created_at AS "createdAt", started_at AS "startedAt", finished_at AS "finishedAt"`;

/** Who asked for a run, for display: the person's name, or why the system started it. Run table aliased r. */
const REQUESTER_LABEL = `${triggerLabelSql(
  `COALESCE((SELECT ar.trigger FROM analysis_runs ar WHERE ar.extraction_run_id = r.id LIMIT 1), r.trigger)`,
  `(SELECT display_name FROM users WHERE id = r.requested_by)`,
)} AS "requestedByLabel"`;

/** One extraction run as the project's Proposals tab lists it (11a spec 6.3). */
export interface ProposalRun {
  runId: string;
  sourceId: string;
  /** The note's title, or the possible-copy label while the note is one (as the notes list shows it). */
  sourceTitle: string;
  versionNo: number;
  finishedAt: string;
  /** Proposals still waiting for review; held proposals are left out of both counts, as the review screen leaves them out. */
  waiting: number;
  total: number;
}

/** Succeeded runs with proposals, of the project's notes in the viewer's notes list (its permission and audience filter). */
const LISTED_RUN_ITEMS = `extraction_runs r JOIN source_versions v ON v.id = r.source_version_id JOIN sources s ON s.id = v.source_id
  JOIN audiences a ON a.id = s.audience_id JOIN extraction_items i ON i.run_id = r.id AND ${notHeldSql('i')}
 WHERE r.status = 'succeeded' AND s.project_id = $1 AND ${listedSourceSql('s', 'a', '$2', '$3')}`;

/**
 * The Proposals tab's runs, newest first (`GET /projects/:projectId/proposal-runs`). The caller has checked `note.view`;
 * runs of notes outside the viewer's audience are neither listed nor counted.
 */
export async function proposalRuns(db: Queryable, projectId: string, userId: string, today: string): Promise<ProposalRun[]> {
  const { rows } = await db.query(
    `SELECT r.id AS "runId", s.id AS "sourceId",
            CASE WHEN ${possibleCopySql('source', 's.id')} THEN '${POSSIBLE_COPY_TEXT}' ELSE s.title END AS "sourceTitle",
            v.version_no AS "versionNo", COALESCE(r.finished_at, r.created_at) AS "finishedAt",
            (count(*) FILTER (WHERE i.review_status = 'pending'))::int AS waiting, count(*)::int AS total
       FROM ${LISTED_RUN_ITEMS}
      GROUP BY r.id, s.id, v.version_no
      ORDER BY COALESCE(r.finished_at, r.created_at) DESC, r.id DESC`,
    [projectId, userId, today],
  );
  return rows.map((r) => ({ ...r, finishedAt: (r.finishedAt as Date).toISOString() }));
}

/**
 * Proposals waiting for review that the viewer may read (the project dashboard's `proposals.waiting`): pending
 * extraction proposals of notes in their notes list, plus pending people's proposals. The caller decides whether the
 * viewer may read project content at all.
 */
export async function waitingProposals(db: Queryable, projectId: string, userId: string, today: string): Promise<number> {
  const { rows } = await db.query(
    `SELECT (SELECT count(*) FROM ${LISTED_RUN_ITEMS} AND i.review_status = 'pending')::int
          + (SELECT count(*) FROM human_proposals h WHERE h.project_id = $1 AND h.review_status = 'pending' AND ${notHeldSql('h')})::int AS n`,
    [projectId, userId, today],
  );
  return rows[0].n as number;
}

export const SUMMARY_NOT_EVIDENCE ='A shareable summary is never used as evidence, so it cannot be analysed for proposals.';

@Injectable()
export class ExtractionService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly now: Clock,
    @Inject(EXTRACTION_QUEUE) private readonly queue: ExtractionQueue,
  ) {}

  /** Starts an extraction of one exact version. The worker does the work later; this only records and queues it. */
  async request(sourceId: string, versionNo: number, actorUserId: string) {
    const found = await this.pool.query<{ id: string; publication: string; kind: string }>(
      `SELECT v.id, s.publication, s.kind FROM source_versions v JOIN sources s ON s.id = v.source_id
        WHERE v.source_id = $1 AND v.version_no = $2 AND s.status = 'active'`,
      [sourceId, versionNo],
    );
    // A discussion transcript is analysed only by the analysis runner, which rebuilds it from the messages visible at that moment.
    if (!found.rows[0] || found.rows[0].kind === 'discussion') throw new NotFoundException();
    // An approved shareable summary is never evidence for proposals (AI assist spec 7.2).
    if (found.rows[0].kind === 'summary') throw new ConflictException(SUMMARY_NOT_EVIDENCE);
    if (found.rows[0].publication !== 'published') throw new ConflictException('A submission is analysed only after a reviewer publishes it.');
    const versionId = found.rows[0].id;

    const at = this.now();
    const runId = uuidv7(at.getTime());
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO extraction_runs (id, source_version_id, requested_by, status, created_at) VALUES ($1, $2, $3, 'queued', $4)`,
        [runId, versionId, actorUserId, at],
      );
      await writeAudit(client, {
        at,
        action: 'extraction.requested',
        actorUserId,
        subjectType: 'extraction_run',
        subjectId: runId,
        detail: { sourceVersionId: versionId, sourceId, versionNo },
      });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      if ((err as { code?: string }).code === '23505') {
        throw new ConflictException('An extraction of this version is already queued or running');
      }
      throw err;
    } finally {
      client.release();
    }

    try {
      await this.queue.enqueue(runId, { explicit: true });
    } catch {
      await this.pool.query(
        `UPDATE extraction_runs SET status = 'failed', failure_code = 'queue_unavailable',
                failure_detail = 'The job could not be queued. Nothing was sent or charged.', finished_at = $2 WHERE id = $1`,
        [runId, this.now()],
      );
      throw new ServiceUnavailableException('The extraction could not be queued. Try again shortly.');
    }
    return this.getRun(runId);
  }

  /**
   * Starts an extraction that no person asked for (published minutes, a discussion), recorded with no requester and
   * the reason it started. Queued like any run; the runner rechecks the project, the spend caps and the model when it
   * starts, so this only records and queues. Returns the run id.
   */
  async requestAutomatic(versionId: string, trigger: 'minutes_published' | 'discussion'): Promise<string> {
    const kind = (await this.pool.query<{ kind: string }>(`SELECT s.kind FROM source_versions v JOIN sources s ON s.id = v.source_id WHERE v.id = $1`, [versionId])).rows[0]?.kind;
    if (kind === 'summary') throw new ConflictException(SUMMARY_NOT_EVIDENCE);
    const at = this.now();
    const runId = uuidv7(at.getTime());
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO extraction_runs (id, source_version_id, requested_by, trigger, status, created_at) VALUES ($1, $2, NULL, $3, 'queued', $4)`,
        [runId, versionId, trigger, at],
      );
      await writeAudit(client, { at, action: 'extraction.requested', subjectType: 'extraction_run', subjectId: runId, detail: { sourceVersionId: versionId, trigger } });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      if ((err as { code?: string }).code === '23505') throw new ConflictException('An extraction of this version is already queued or running');
      throw err;
    } finally {
      client.release();
    }
    try {
      await this.queue.enqueue(runId);
    } catch {
      await this.pool.query(
        `UPDATE extraction_runs SET status = 'failed', failure_code = 'queue_unavailable',
                failure_detail = 'The job could not be queued. Nothing was sent or charged.', finished_at = $2 WHERE id = $1`,
        [runId, this.now()],
      );
      throw new ServiceUnavailableException('The extraction could not be queued.');
    }
    return runId;
  }

  async getRun(runId: string) {
    const run = await this.pool.query(`SELECT ${RUN_COLUMNS}, ${REQUESTER_LABEL} FROM extraction_runs r WHERE r.id = $1`, [runId]);
    if (!run.rows[0]) throw new NotFoundException();
    const meeting = await this.meetingDateFor(this.pool, runId);
    const items = await this.pool.query(
      `SELECT i.id, i.position, ${KIND_IN_FORCE} AS kind,
              COALESCE(e.text, i.text) AS text,
              CASE WHEN e.id IS NULL THEN i.owner ELSE e.owner END AS owner,
              ${DUE_COLUMNS}, i.alternatives,
              e.id IS NOT NULL AS edited, i.kind AS "originalKind", i.text AS "originalText", i.owner AS "originalOwner", i.due AS "originalDue",
              i.quote, i.quote_start AS "quoteStart", i.quote_end AS "quoteEnd",
              i.quote_matches AS "quoteMatches", i.review_status AS "reviewStatus",
              i.chosen_occurrence AS "chosenOccurrence",
              i.reviewed_by AS "reviewedBy", i.reviewed_at AS "reviewedAt", ${possibleCopyLabelSql('proposal', 'i.id')},
              (SELECT json_build_object('kind', x.kind, 'id', x.id) FROM (
                 SELECT 'task' AS kind, id FROM tasks WHERE origin_item_id = i.id AND depth = 0
                 UNION ALL SELECT 'decision', id FROM decisions WHERE origin_item_id = i.id
                 UNION ALL SELECT 'question', id FROM questions WHERE origin_item_id = i.id
                 UNION ALL SELECT 'risk', id FROM risks WHERE origin_item_id = i.id) x LIMIT 1) AS record
         FROM extraction_items i
         ${LATEST_EDIT}
        WHERE i.run_id = $1 AND ${notHeldSql('i')} ORDER BY i.position`,
      [runId],
    );
    const corrections = await this.correctionsOf(items.rows);
    const model: string | null = run.rows[0].modelId ?? null;
    const shaped = items.rows.map(({ originalKind, originalText, originalOwner, originalDue, reviewerEarliest, reviewerLatest, reviewerEvent, reviewerIgnoreEvent, ...item }) => {
      const dueRow = { due: item.due, dueEvent: item.dueEvent, reviewerEarliest, reviewerLatest, reviewerEvent, reviewerIgnoreEvent };
      return {
        ...item,
        reviewerDue: reviewerDueOf(dueRow),
        dueReading: dueReadingOf(dueRow, meeting.meetingDate),
        approvedWithoutRecord: item.reviewStatus === 'approved' && item.record === null,
        // The model's own proposal is kept beside every correction (D130).
        original: { kind: originalKind, text: originalText, owner: originalOwner, due: originalDue, model },
        corrections: corrections.get(item.id) ?? [],
      };
    });
    const itemIds = shaped.map((i) => i.id);
    const [flags, evidence, quoteChanged] = await Promise.all([itemSourceFlags(this.pool, itemIds), itemDiscussionEvidence(this.pool, itemIds), quoteChangedItems(this.pool, itemIds)]);
    // A quote that overlapped a removed credential was rewritten (history spec 7.4): the reviewer is told.
    const flagged = shaped.map((i) => ({ ...i, sourceFlag: flags.get(i.id) ?? null, discussionEvidence: evidence.get(i.id) ?? null, quoteChanged: quoteChanged.has(i.id) ? QUOTE_CHANGED_TEXT : null }));
    Object.assign(run.rows[0], meeting);
    const src = await this.pool.query(
      `SELECT s.id AS "sourceId", s.title, s.kind AS "sourceKind", v.version_no AS "versionNo"
         FROM extraction_runs r JOIN source_versions v ON v.id = r.source_version_id JOIN sources s ON s.id = v.source_id
        WHERE r.id = $1`,
      [runId],
    );
    const placed = await this.withOccurrences(run.rows[0].sourceVersionId, flagged);
    // A quote whose message is now hidden or deleted reaches no one (the places above carry labels, not text).
    const items2 = placed.map((i) => (i.sourceFlag ? { ...i, quote: null as string | null, quoteMasked: i.sourceFlag } : i));
    return { run: run.rows[0], source: src.rows[0], items: items2 };
  }

  /**
   * Every reviewer correction of these items, newest first, each naming its editor, the editor's project role today
   * (the first Active one in the fixed order, else null), the fields it changed against what was in force before it,
   * the type before and after, and the reason given. `items` carry the model's own kind, text, owner and due.
   */
  private async correctionsOf(items: Array<{ id: string; originalKind: string; originalText: string; originalOwner: string | null; originalDue: string | null }>): Promise<Map<string, Correction[]>> {
    const out = new Map<string, Correction[]>();
    if (items.length === 0) return out;
    const { rows } = await this.pool.query(
      `SELECT e.item_id AS "itemId", e.edited_at AS at, u.display_name AS by, e.kind, e.reason, e.text, e.owner, e.due,
              to_char(e.due_earliest, 'YYYY-MM-DD') AS "dueEarliest", to_char(e.due_latest, 'YYYY-MM-DD') AS "dueLatest",
              e.due_event AS "dueEvent", e.ignore_model_event AS "ignoreModelEvent",
              (SELECT m.role FROM memberships m
                WHERE m.project_id = s.project_id AND m.user_id = e.edited_by AND ${activeMembershipSql('m', '$2')}
                ORDER BY array_position($3::text[], m.role) LIMIT 1) AS role
         FROM extraction_item_edits e
         JOIN users u ON u.id = e.edited_by
         JOIN extraction_items i ON i.id = e.item_id
         JOIN source_versions v ON v.id = i.source_version_id
         JOIN sources s ON s.id = v.source_id
        WHERE e.item_id = ANY($1::uuid[])
        ORDER BY e.item_id, e.edited_at, e.id`,
      [items.map((i) => i.id), todayUtc8(this.now()), ROLE_ORDER],
    );
    const model = new Map(items.map((i) => [i.id, i]));
    type State = { kind: string; text: string; owner: string | null; due: string | null; dates: string };
    const datesOf = (r: { dueEarliest: string | null; dueLatest: string | null; dueEvent: string | null; ignoreModelEvent: boolean | null }) =>
      JSON.stringify([r.dueEarliest ?? null, r.dueLatest ?? null, r.dueEvent ?? null, r.ignoreModelEvent === true]);
    const before = new Map<string, State>();
    for (const r of rows) {
      const m = model.get(r.itemId) as (typeof items)[number];
      const prev = before.get(r.itemId) ?? { kind: m.originalKind, text: m.originalText, owner: m.originalOwner, due: m.originalDue, dates: datesOf({ dueEarliest: null, dueLatest: null, dueEvent: null, ignoreModelEvent: false }) };
      // An edit written before 0036 has no kind: it kept the one in force.
      const next: State = { kind: r.kind ?? prev.kind, text: r.text, owner: r.owner, due: r.due, dates: datesOf(r) };
      const changed: Correction['changed'] = [];
      if (next.kind !== prev.kind) changed.push('type');
      if (next.text !== prev.text) changed.push('text');
      if (next.owner !== prev.owner) changed.push('owner');
      if (next.due !== prev.due || next.dates !== prev.dates) changed.push('due');
      const list = out.get(r.itemId) ?? [];
      list.unshift({
        at: new Date(r.at).toISOString(),
        by: r.by,
        role: r.role ? ROLE_LABEL[r.role as ProjectRole] : null,
        changed,
        from: { kind: prev.kind },
        to: { kind: next.kind },
        reason: r.reason ?? null,
      });
      out.set(r.itemId, list);
      before.set(r.itemId, next);
    }
    return out;
  }

  /** The due inputs of one item as they stand now (wording, model's event, latest reviewer due). */
  private async dueInputsOf(q: Queryable, itemId: string): Promise<DueRow> {
    const { rows } = await q.query(`SELECT ${DUE_COLUMNS} FROM extraction_items i ${LATEST_EDIT} WHERE i.id = $1`, [itemId]);
    return rows[0];
  }

  /** The meeting date in force for a run: the reviewer's latest for its version, else the model's, else none. */
  private async meetingDateFor(q: Queryable, runId: string): Promise<{ meetingDate: string | null; meetingDateSource: 'notes' | 'reviewer' | 'none' }> {
    const { rows } = await q.query(
      `SELECT to_char(r.meeting_date, 'YYYY-MM-DD') AS model,
              (SELECT to_char(m.meeting_date, 'YYYY-MM-DD') FROM source_version_meeting_dates m
                WHERE m.source_version_id = r.source_version_id ORDER BY m.set_at DESC, m.id DESC LIMIT 1) AS reviewer
         FROM extraction_runs r WHERE r.id = $1`,
      [runId],
    );
    const row = rows[0] ?? {};
    if (row.reviewer) return { meetingDate: row.reviewer, meetingDateSource: 'reviewer' };
    if (row.model) return { meetingDate: row.model, meetingDateSource: 'notes' };
    return { meetingDate: null, meetingDateSource: 'none' };
  }

  /** Records the meeting date a reviewer gives for one note version. The latest one is used. */
  async setMeetingDate(sourceId: string, versionNo: number, meetingDate: unknown, actorUserId: string) {
    if (!isCalendarDate(meetingDate)) throw new BadRequestException('meetingDate must be a date in the form YYYY-MM-DD');
    const at = this.now();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const found = await client.query(
        `SELECT v.id FROM source_versions v JOIN sources s ON s.id = v.source_id
          WHERE v.source_id = $1 AND v.version_no = $2 AND s.status = 'active'`,
        [sourceId, versionNo],
      );
      const versionId = found.rows[0]?.id;
      if (!versionId) throw new NotFoundException();
      await client.query(
        `INSERT INTO source_version_meeting_dates (id, source_version_id, meeting_date, set_by, set_at) VALUES ($1, $2, $3, $4, $5)`,
        [uuidv7(), versionId, meetingDate, actorUserId, at],
      );
      await writeAudit(client, {
        at,
        action: 'note.meeting_date_set',
        actorUserId,
        subjectType: 'source_version',
        subjectId: versionId,
        detail: { meetingDate },
      });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    return { meetingDate };
  }

  /**
   * For a quote that appears more than once, lists the places (at most MAX_OCCURRENCE_CHOICES) so the
   * reviewer can say which one is meant. Quotes found once or not at all carry no list.
   */
  private async withOccurrences<T extends { quote: string; quoteMatches: number }>(sourceVersionId: string, items: T[]) {
    if (!items.some((i) => i.quoteMatches > 1)) return items;
    const { rows } = await this.pool.query<{ text: string }>('SELECT text_content AS text FROM source_versions WHERE id = $1', [sourceVersionId]);
    const text = rows[0]?.text ?? '';
    const out = [];
    for (const i of items) {
      if (i.quoteMatches <= 1) {
        out.push(i);
        continue;
      }
      const places = locateQuote(text, i.quote).slice(0, MAX_OCCURRENCE_CHOICES).map(({ start, end }) => ({ start, end }));
      // For a discussion transcript each place also says which message it is in (null for any other source).
      const labels = await occurrenceLabels(this.pool, sourceVersionId, places);
      const named = labels.some((l) => l !== null);
      out.push({ ...i, occurrences: places.map((p, n) => (named ? { ...p, label: labels[n] } : p)) });
    }
    return out;
  }

  async listForVersion(sourceId: string, versionNo: number) {
    const { rows } = await this.pool.query(
      `SELECT ${RUN_COLUMNS.split(',').map((c) => 'r.' + c.trim()).join(', ')}, ${REQUESTER_LABEL}
         FROM extraction_runs r
         JOIN source_versions v ON v.id = r.source_version_id
         JOIN sources s ON s.id = v.source_id
        WHERE v.source_id = $1 AND v.version_no = $2 AND s.status = 'active'
        ORDER BY r.created_at DESC, r.id DESC`,
      [sourceId, versionNo],
    );
    return { runs: rows };
  }

  /**
   * Approves or rejects one proposal. The reviewer states which exact source version they were looking at;
   * if the proposal belongs to a different one the decision is refused, so a decision can never be
   * applied to text the reviewer did not see.
   */
  async review(
    runId: string,
    itemId: string,
    input: { decision: unknown; sourceVersionId: unknown; occurrence?: unknown },
    actorUserId: string,
  ) {
    if (input.decision !== 'approved' && input.decision !== 'rejected') {
      throw new BadRequestException('decision must be "approved" or "rejected"');
    }
    if (typeof input.sourceVersionId !== 'string' || input.sourceVersionId === '') {
      throw new BadRequestException('sourceVersionId is required: the version the reviewer was looking at');
    }
    const at = this.now();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (input.decision === 'approved') {
        await this.approveInTx(client, runId, itemId, input, actorUserId, at);
      } else {
        await lockPendingAuthorisation(client, 'extraction_item', itemId);
        const item = await this.lockForReview(client, runId, itemId, input.sourceVersionId);
        await this.refuseIfAuthorised(client, itemId);
        await client.query(
          `UPDATE extraction_items SET review_status = 'rejected', chosen_occurrence = NULL, reviewed_by = $2, reviewed_at = $3 WHERE id = $1`,
          [itemId, actorUserId, at],
        );
        await writeAudit(client, {
          at,
          action: 'proposal.rejected',
          actorUserId,
          subjectType: 'extraction_item',
          subjectId: itemId,
          detail: { runId, sourceVersionId: item.source_version_id, previousStatus: item.review_status },
        });
        await rejectPendingAuthorisation(client, 'extraction_item', itemId, actorUserId, at, PROPOSAL_REJECTED_REASON);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    const view = await this.getRun(runId);
    return { item: view.items.find((i: { id: string }) => i.id === itemId) };
  }

  /** Locks one item of a finished run for a review decision, checking it is the version the reviewer saw. */
  private async lockForReview(client: PoolClient, runId: string, itemId: string, sourceVersionId: unknown) {
    if (typeof sourceVersionId !== 'string' || sourceVersionId === '') {
      throw new BadRequestException('sourceVersionId is required: the version the reviewer was looking at');
    }
    const found = await client.query(
      `SELECT i.id, i.source_version_id, i.quote_matches, i.review_status, ${KIND_IN_FORCE} AS kind, r.status AS run_status, i.held_case_id
         FROM extraction_items i JOIN extraction_runs r ON r.id = i.run_id ${LATEST_EDIT}
        WHERE i.id = $1 AND i.run_id = $2 FOR UPDATE OF i`,
      [itemId, runId],
    );
    const item = found.rows[0];
    if (!item) throw new NotFoundException();
    refuseHeld(item);
    if (item.run_status !== 'succeeded') throw new ConflictException('The extraction has not finished');
    if (item.source_version_id !== sourceVersionId) {
      throw new ConflictException('This proposal is for a different version of the notes than the one you reviewed');
    }
    return item as { id: string; source_version_id: string; quote_matches: number; review_status: string; kind: string };
  }

  /** Once a proposal has an authorised record, its review decision and wording are settled; changes go through amendments. */
  async refuseIfAuthorised(client: Queryable, itemId: string): Promise<void> {
    const { rowCount } = await client.query(
      `SELECT 1 FROM tasks WHERE origin_item_id = $1 UNION ALL SELECT 1 FROM decisions WHERE origin_item_id = $1
       UNION ALL SELECT 1 FROM questions WHERE origin_item_id = $1 UNION ALL SELECT 1 FROM risks WHERE origin_item_id = $1`,
      [itemId],
    );
    if (rowCount) throw new ConflictException(AUTHORISED_MESSAGE);
  }

  /**
   * The approval half of authorising, inside the caller's transaction: the item is locked, its quote and
   * chosen place and (for an action) its due are checked, and it is marked approved. Returns what was approved.
   */
  async approveInTx(
    client: PoolClient,
    runId: string,
    itemId: string,
    input: { sourceVersionId: unknown; occurrence?: unknown },
    actorUserId: string,
    at: Date,
  ): Promise<ApprovedItem> {
    const item = await this.lockForReview(client, runId, itemId, input.sourceVersionId);
    await this.refuseIfAuthorised(client, itemId);
    if (item.quote_matches === 0) {
      throw new ConflictException('This proposal quotes text that is not in the notes, so it cannot be approved');
    }
    let chosen: number | null = null;
    if (item.quote_matches > 1) {
      if (input.occurrence === undefined) {
        throw new ConflictException('The quote appears more than once in the notes. Choose which place is meant (occurrence: 0 for the first)');
      }
      const places = Math.min(item.quote_matches, MAX_OCCURRENCE_CHOICES);
      if (!Number.isInteger(input.occurrence) || (input.occurrence as number) < 0 || (input.occurrence as number) >= places) {
        throw new BadRequestException(`occurrence must be a whole number from 0 to ${places - 1}`);
      }
      chosen = input.occurrence as number;
    } else if (input.occurrence !== undefined && input.occurrence !== 0) {
      throw new BadRequestException('This quote appears once, so occurrence can only be 0 or left out');
    }
    // Read after the lock, in its own statement, so an edit that committed while we waited is seen.
    const approved = await this.approvedItem(client, runId, itemId);
    if (approved.kind === 'action' && approved.due.state === 'needs_date') throw new ConflictException(NEEDS_DATE_MESSAGE);
    await client.query(
      `UPDATE extraction_items SET review_status = 'approved', chosen_occurrence = $2, reviewed_by = $3, reviewed_at = $4 WHERE id = $1`,
      [itemId, chosen, actorUserId, at],
    );
    await writeAudit(client, {
      at,
      action: 'proposal.approved',
      actorUserId,
      subjectType: 'extraction_item',
      subjectId: itemId,
      detail: { runId, sourceVersionId: item.source_version_id, previousStatus: item.review_status, ...(chosen !== null ? { occurrence: chosen } : {}) },
    });
    return approved;
  }

  /** The wording in force for one item (the latest reviewer edit, else the model's) and its due reading. */
  async approvedItem(client: Queryable, runId: string, itemId: string): Promise<ApprovedItem> {
    const row = (
      await client.query(
        `SELECT i.id, ${KIND_IN_FORCE} AS kind, COALESCE(e.text, i.text) AS text, CASE WHEN e.id IS NULL THEN i.owner ELSE e.owner END AS owner,
                ${DUE_COLUMNS}, i.quote
           FROM extraction_items i ${LATEST_EDIT} WHERE i.id = $1`,
        [itemId],
      )
    ).rows[0];
    const { meetingDate } = await this.meetingDateFor(client, runId);
    return { id: row.id, kind: row.kind, text: row.text, owner: row.owner, due: dueReadingOf(row, meetingDate), quote: row.quote };
  }

  /**
   * Replaces the wording of one proposal (text, owner, due; the body is the complete new wording, a blank
   * owner or due clears it), and may correct its type (D130), with a reason required when the type changes.
   * The model's own proposal is kept and returned as `original`. The quote and where it sits never change.
   * A decision made on the old wording is withdrawn: the proposal goes back to review.
   */
  async edit(
    runId: string,
    itemId: string,
    input: {
      sourceVersionId: unknown; text: unknown; owner?: unknown; due?: unknown; dueEarliest?: unknown; dueLatest?: unknown; dueEvent?: unknown; ignoreModelEvent?: unknown;
      kind?: unknown; reason?: unknown;
    },
    actorUserId: string,
  ) {
    if (typeof input.sourceVersionId !== 'string' || input.sourceVersionId === '') {
      throw new BadRequestException('sourceVersionId is required: the version the reviewer was looking at');
    }
    if (input.kind !== undefined && !PROPOSAL_KINDS.includes(input.kind as ProposalKind)) {
      throw new BadRequestException('kind must be "decision", "action", "question" or "risk"');
    }
    const sentKind = input.kind as ProposalKind | undefined;
    // Trimmed: a blank reason is no reason.
    const reason = cleanWording(input.reason, 'reason', MAX_CORRECTION_REASON, false);
    const text = cleanWording(input.text, 'text', MAX_PROPOSAL_TEXT, true);
    const owner = cleanWording(input.owner, 'owner', MAX_PROPOSAL_FIELD, false);
    const due = cleanWording(input.due, 'due', MAX_PROPOSAL_FIELD, false);
    // The due fields are replaced together; an edit that sends none of them keeps the reviewer's due in force.
    const sentDue = givesDue(input) ? cleanReviewerDue(input) : null;
    const at = this.now();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // A pending authorisation of this item is taken before the item, in the order approving takes them.
      await client.query(
        `SELECT id FROM change_requests WHERE target_kind = 'extraction_item' AND target_id = $1 AND status = 'pending' FOR UPDATE`,
        [itemId],
      );
      const found = await client.query(
        `SELECT i.id, i.source_version_id, i.review_status, r.status AS run_status, i.held_case_id, s.project_id
           FROM extraction_items i
           JOIN extraction_runs r ON r.id = i.run_id
           JOIN source_versions v ON v.id = i.source_version_id
           JOIN sources s ON s.id = v.source_id
          WHERE i.id = $1 AND i.run_id = $2 FOR UPDATE OF i`,
        [itemId, runId],
      );
      if (!found.rows[0]) throw new NotFoundException();
      refuseHeld(found.rows[0]);
      delete found.rows[0].held_case_id;
      // Checked after the item lock, so an authorise that committed while we waited is seen.
      await this.refuseIfAuthorised(client, itemId);
      // The wording in force is read after the lock, in its own statement, so a concurrent edit is seen.
      const current = await client.query(
        `SELECT ${KIND_IN_FORCE} AS kind, COALESCE(e.text, i.text) AS text, CASE WHEN e.id IS NULL THEN i.owner ELSE e.owner END AS owner, ${DUE_COLUMNS}
           FROM extraction_items i ${LATEST_EDIT} WHERE i.id = $1`,
        [itemId],
      );
      const item = { ...found.rows[0], ...current.rows[0] };
      if (item.run_status !== 'succeeded') throw new ConflictException('The extraction has not finished');
      if (item.source_version_id !== input.sourceVersionId) {
        throw new ConflictException('This proposal is for a different version of the notes than the one you reviewed');
      }
      // Every new edit row records the type in force after it; a change of type needs a reason (D130).
      const kind: ProposalKind = sentKind ?? item.kind;
      if (kind !== item.kind && reason === null) throw new BadRequestException(REASON_NEEDED);
      const changed: string[] = (['kind', 'text', 'owner', 'due'] as const).filter((f) => ({ kind, text, owner, due })[f] !== item[f]);
      const before: FullReviewerDue = {
        earliest: item.reviewerEarliest ?? null,
        latest: item.reviewerLatest ?? null,
        event: item.reviewerEvent ?? null,
        ignoreModelEvent: item.reviewerIgnoreEvent === true,
      };
      const dates = sentDue ?? before;
      if (
        before.earliest !== dates.earliest ||
        before.latest !== dates.latest ||
        before.event !== dates.event ||
        before.ignoreModelEvent !== dates.ignoreModelEvent
      ) {
        changed.push('due_dates');
      }
      if (changed.length === 0) throw new ConflictException('Nothing was changed');
      await client.query(
        `INSERT INTO extraction_item_edits (id, item_id, text, owner, due, due_earliest, due_latest, due_event, ignore_model_event, edited_by, edited_at, kind, reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [uuidv7(), itemId, text, owner, due, dates.earliest, dates.latest, dates.event, dates.ignoreModelEvent, actorUserId, at, kind, reason],
      );
      if (item.review_status !== 'pending') {
        await client.query(
          `UPDATE extraction_items SET review_status = 'pending', chosen_occurrence = NULL, reviewed_by = NULL, reviewed_at = NULL WHERE id = $1`,
          [itemId],
        );
      }
      // Approvals were given on the old wording: a pending authorisation is set aside and starts again (spec §3.3).
      const superseded = await client.query(
        `UPDATE change_requests SET status = 'superseded', decided_by = $2, decided_at = $3
          WHERE target_kind = 'extraction_item' AND target_id = $1 AND status = 'pending' RETURNING id, project_id`,
        [itemId, actorUserId, at],
      );
      for (const r of superseded.rows) {
        await writeAudit(client, {
          at,
          action: 'change.superseded',
          actorUserId,
          subjectType: 'change_request',
          subjectId: r.id,
          detail: { projectId: r.project_id, itemId },
        });
      }
      // The audit trail names what changed, never the wording itself.
      await writeAudit(client, {
        at,
        action: 'proposal.edited',
        actorUserId,
        subjectType: 'extraction_item',
        subjectId: itemId,
        detail: { runId, sourceVersionId: item.source_version_id, previousStatus: item.review_status, changed },
      });
      // The correction itself (D130): who, which project and which fields, in the history's own words; never the
      // wording or the reason.
      const fields = [...new Set(changed.map((f) => (f === 'kind' ? 'type' : f === 'due_dates' ? 'due' : f)))];
      await writeAudit(client, {
        at,
        action: 'proposal.corrected',
        actorUserId,
        subjectType: 'extraction_item',
        subjectId: itemId,
        detail: { projectId: item.project_id, runId, fields },
      });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    const view = await this.getRun(runId);
    return { item: view.items.find((i: { id: string }) => i.id === itemId) };
  }
}
