import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { answerAccess, loadAnswerRow } from '../assist/questions.service';
import { draftAccess, loadDraftRow } from '../assist/reports.service';
import { loadSummaryRow, summaryVisible } from '../assist/summaries.service';
import { writeAudit } from '../audit/audit';
import { can } from '../auth/permissions';
import { CLOCK, type AuthUser, type Clock } from '../auth/tokens';
import { uuidv7 } from '../common/uuid7';
import { PG_POOL } from '../db/database.module';
import { NoteTextError, normaliseText, sha256Hex } from '../notes/text';
import { ProjectAccess } from '../projects/access.service';
import { AudienceService } from './audience.service';
import { refuseSecrets } from './messages';
import { ThreadsService } from './threads.service';

export const TARGET_KINDS = ['minutes_draft', 'analysis_run', 'proposal', 'answer', 'report_version', 'summary_version'] as const;
export const CATEGORIES = ['incorrect', 'missed_item', 'misleading', 'other'] as const;
export const STATUSES = ['open', 'reviewed', 'closed'] as const;
type TargetKind = (typeof TARGET_KINDS)[number];
type Category = (typeof CATEGORIES)[number];
type Status = (typeof STATUSES)[number];

const MAX_NOTE = 2000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Open → Reviewed → Closed; Reviewed or Closed may go back to Open. */
const MOVES: Readonly<Record<Status, readonly Status[]>> = { open: ['reviewed'], reviewed: ['closed', 'open'], closed: ['open'] };

export interface FeedbackView {
  id: string;
  projectId: string;
  targetKind: TargetKind;
  targetId: string;
  category: Category;
  note: string;
  status: Status;
  reporterId: string;
  reporterName: string;
  createdAt: Date;
  escalatedAt: Date | null;
}

export interface AdminFeedbackRow {
  id: string;
  projectName: string;
  category: Category;
  model: string | null;
  runRef: string | null;
  at: Date;
  escalationNote: string;
}

/** The text of a note: 1 to 2,000 characters after normalising, with no credential in it. */
function cleanNote(raw: unknown, what: string): string {
  const message = `${what} must be 1 to ${MAX_NOTE.toLocaleString('en-US')} characters.`;
  if (typeof raw !== 'string') throw new BadRequestException(message);
  let text: string;
  try {
    text = normaliseText(raw);
  } catch (err) {
    if (err instanceof NoteTextError) throw new BadRequestException(message);
    throw err;
  }
  if (text.length < 1 || text.length > MAX_NOTE) throw new BadRequestException(message);
  refuseSecrets(text);
  return text;
}

const oneOf = <T extends string>(list: readonly T[], value: unknown, what: string): T => {
  if (typeof value !== 'string' || !(list as readonly string[]).includes(value)) throw new BadRequestException(`${what} must be one of: ${list.join(', ')}.`);
  return value as T;
};
const idOrNotFound = (v: unknown): string => {
  if (typeof v !== 'string' || !UUID.test(v)) throw new NotFoundException();
  return v;
};

/** Feedback on AI output (spec 8). It never changes a draft, a run, a proposal or a setting. */
@Injectable()
export class FeedbackService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly now: Clock,
    private readonly access: ProjectAccess,
    private readonly threads: ThreadsService,
    private readonly audiences: AudienceService,
  ) {}

  /** Finds the target inside the project and applies the reading rule of its thread or source; anything else is 404. */
  private async assertTargetReadable(db: PoolClient, user: AuthUser, projectId: string, kind: TargetKind, id: string): Promise<void> {
    if (kind === 'answer') {
      // The answer's own visibility (AI assist spec 5.3, 5.5): requester or thread, review state, every source still readable.
      const row = await loadAnswerRow(db, id);
      if (!row || row.projectId !== projectId) throw new NotFoundException();
      if ((await answerAccess(db, await this.access.load(projectId, user, db), row)) !== 'readable') throw new NotFoundException();
      if (row.answerMarkdown === null) throw new BadRequestException('Only AI output can be flagged; this question has no AI answer.');
      return;
    }
    if (kind === 'report_version') {
      // The draft's own visibility (AI assist spec 6.3): requester, or shared and every passage of its AI versions readable.
      const v = (await db.query<{ draftId: string; origin: string }>(`SELECT draft_id AS "draftId", origin FROM report_draft_versions WHERE id = $1`, [id])).rows[0];
      const draft = v ? await loadDraftRow(db, v.draftId) : undefined;
      if (!draft || draft.projectId !== projectId) throw new NotFoundException();
      if ((await draftAccess(db, await this.access.load(projectId, user, db), draft)) !== 'readable') throw new NotFoundException();
      if (v.origin !== 'ai') throw new BadRequestException('Only AI output can be flagged; this version was written by a person.');
      return;
    }
    if (kind === 'summary_version') {
      // The summary's own visibility (AI assist spec 7.2): the original's audience only.
      const v = (await db.query<{ summaryId: string; origin: string }>(`SELECT summary_id AS "summaryId", origin FROM summary_versions WHERE id = $1`, [id])).rows[0];
      const summary = v ? await loadSummaryRow(db, v.summaryId) : undefined;
      if (!summary || summary.projectId !== projectId) throw new NotFoundException();
      if (!(await summaryVisible(db, await this.access.load(projectId, user, db), summary))) throw new NotFoundException();
      if (v.origin !== 'ai') throw new BadRequestException('Only AI output can be flagged; this version was written by a person.');
      return;
    }
    if (kind === 'proposal') {
      const { rows } = await db.query(
        `SELECT sv.source_id AS "sourceId", s.project_id AS "projectId"
           FROM extraction_items i JOIN source_versions sv ON sv.id = i.source_version_id JOIN sources s ON s.id = sv.source_id
          WHERE i.id = $1`,
        [id],
      );
      if (!rows[0] || rows[0].projectId !== projectId) throw new NotFoundException();
      await this.audiences.assertSourceReadable(user, rows[0].sourceId, db);
      return;
    }
    const sql =
      kind === 'minutes_draft'
        ? `SELECT thread_id AS "threadId", origin FROM minutes_drafts WHERE id = $1`
        : `SELECT thread_id AS "threadId", 'ai' AS origin FROM analysis_runs WHERE id = $1`;
    const { rows } = await db.query(sql, [id]);
    if (!rows[0]) throw new NotFoundException();
    const t = await this.threads.threadRow(db, rows[0].threadId);
    if (t.projectId !== projectId) throw new NotFoundException();
    await this.threads.readable(db, user, t);
    if (rows[0].origin !== 'ai') throw new BadRequestException('Only AI output can be flagged; this draft was written by a person.');
  }

  /** Anyone who can read the AI output may flag it, in any project state (reading is allowed in all of them). */
  async create(user: AuthUser, projectId: string, body: { targetKind: unknown; targetId: unknown; category: unknown; note: unknown }): Promise<FeedbackView> {
    const kind = oneOf(TARGET_KINDS, body.targetKind, 'targetKind');
    const category = oneOf(CATEGORIES, body.category, 'category');
    const note = cleanNote(body.note, 'The correction note');
    const id = uuidv7();
    await this.threads.inTransaction(async (db) => {
      await this.access.authorize(user, 'note.view', idOrNotFound(projectId), db);
      const targetId = idOrNotFound(body.targetId);
      await this.assertTargetReadable(db, user, projectId, kind, targetId);
      const at = this.now();
      await db.query(
        `INSERT INTO ai_feedback (id, project_id, target_kind, target_id, category, note, status, reporter_id, created_at) VALUES ($1, $2, $3, $4, $5, $6, 'open', $7, $8)`,
        [id, projectId, kind, targetId, category, note, user.id, at],
      );
      await db.query(`INSERT INTO feedback_events (id, feedback_id, actor_id, action, from_status, to_status, note, at) VALUES ($1, $2, $3, 'created', NULL, 'open', NULL, $4)`, [uuidv7(at.getTime()), id, user.id, at]);
      await writeAudit(db, {
        at,
        action: 'feedback.created',
        actorUserId: user.id,
        subjectType: 'ai_feedback',
        subjectId: id,
        detail: { projectId, targetKind: kind, category, noteLength: note.length, noteSha256: sha256Hex(note) },
      });
    });
    return this.one(this.pool, id);
  }

  private async one(db: Pool | PoolClient, id: string): Promise<FeedbackView> {
    return (await this.rows(db, 'f.id = $1', [id]))[0];
  }

  private async rows(db: Pool | PoolClient, where: string, params: unknown[]): Promise<FeedbackView[]> {
    const { rows } = await db.query(
      `SELECT f.id, f.project_id AS "projectId", f.target_kind AS "targetKind", f.target_id AS "targetId", f.category, f.note, f.status,
              f.reporter_id AS "reporterId", u.display_name AS "reporterName", f.created_at AS "createdAt", f.escalated_at AS "escalatedAt"
         FROM ai_feedback f JOIN users u ON u.id = f.reporter_id WHERE ${where} ORDER BY f.created_at DESC, f.id DESC`,
      params,
    );
    return rows as FeedbackView[];
  }

  /** The project's managers (feedback.review) see all of its feedback; everyone else sees their own. */
  async list(user: AuthUser, projectId: string): Promise<{ feedback: FeedbackView[]; canReview: boolean }> {
    const ctx = await this.access.authorize(user, 'note.view', idOrNotFound(projectId));
    const canReview = this.threads.allowed(ctx, 'feedback.review');
    const feedback = canReview ? await this.rows(this.pool, 'f.project_id = $1', [projectId]) : await this.rows(this.pool, 'f.project_id = $1 AND f.reporter_id = $2', [projectId, user.id]);
    return { feedback, canReview };
  }

  /** Locks the feedback row and checks the caller may review it; a stranger to the project finds nothing. */
  private async reviewable(db: PoolClient, user: AuthUser, id: string) {
    const { rows } = await db.query(`SELECT id, project_id AS "projectId", status, escalated_at AS "escalatedAt" FROM ai_feedback WHERE id = $1 FOR UPDATE`, [idOrNotFound(id)]);
    if (!rows[0]) throw new NotFoundException();
    await this.access.authorize(user, 'feedback.review', rows[0].projectId, db);
    return rows[0] as { id: string; projectId: string; status: Status; escalatedAt: Date | null };
  }

  async setStatus(user: AuthUser, id: string, body: { status: unknown; note: unknown }): Promise<FeedbackView> {
    const to = oneOf(STATUSES, body.status, 'status');
    const note = cleanNote(body.note, 'The note');
    await this.threads.inTransaction(async (db) => {
      const f = await this.reviewable(db, user, id);
      if (!MOVES[f.status].includes(to)) throw new ConflictException(`Feedback that is ${f.status} cannot move to ${to}.`);
      const at = this.now();
      await db.query(`UPDATE ai_feedback SET status = $2 WHERE id = $1`, [f.id, to]);
      await db.query(`INSERT INTO feedback_events (id, feedback_id, actor_id, action, from_status, to_status, note, at) VALUES ($1, $2, $3, 'status', $4, $5, $6, $7)`, [
        uuidv7(at.getTime()), f.id, user.id, f.status, to, note, at,
      ]);
      await writeAudit(db, {
        at,
        action: 'feedback.status_changed',
        actorUserId: user.id,
        subjectType: 'ai_feedback',
        subjectId: f.id,
        detail: { projectId: f.projectId, from: f.status, to, noteLength: note.length },
      });
    });
    return this.one(this.pool, id);
  }

  /** Sends the Administrators a notice (title only) and an entry in their list; the entry carries only the PM's note. */
  async escalate(user: AuthUser, id: string, body: { note: unknown }): Promise<FeedbackView> {
    const note = cleanNote(body.note, 'The escalation note');
    await this.threads.inTransaction(async (db) => {
      const f = await this.reviewable(db, user, id);
      if (f.escalatedAt) throw new ConflictException('This feedback has already been escalated.');
      const at = this.now();
      await db.query(`UPDATE ai_feedback SET escalated_at = $2, escalation_note = $3 WHERE id = $1`, [f.id, at, note]);
      await db.query(`INSERT INTO feedback_events (id, feedback_id, actor_id, action, from_status, to_status, note, at) VALUES ($1, $2, $3, 'escalated', $4, $4, $5, $6)`, [
        uuidv7(at.getTime()), f.id, user.id, f.status, note, at,
      ]);
      const name = (await db.query(`SELECT name FROM projects WHERE id = $1`, [f.projectId])).rows[0].name as string;
      const admins = (await db.query(`SELECT id FROM users WHERE role = 'enterprise_administrator' AND status = 'active' ORDER BY id`)).rows as { id: string }[];
      for (const a of admins) {
        await db.query(
          `INSERT INTO notifications (id, user_id, project_id, kind, summary, link, created_at, email_off)
           VALUES ($1, $2, $3, 'feedback_escalated', $4, '#/escalated-feedback', $5, EXISTS (SELECT 1 FROM email_preferences WHERE user_id = $2 AND project_id = $3 AND choice = 'off'))`,
          [uuidv7(at.getTime()), a.id, f.projectId, `AI feedback escalated from ${name}`, at],
        );
      }
      await writeAudit(db, {
        at,
        action: 'feedback.escalated',
        actorUserId: user.id,
        subjectType: 'ai_feedback',
        subjectId: f.id,
        detail: { projectId: f.projectId, noteLength: note.length, notified: admins.length },
      });
    });
    return this.one(this.pool, id);
  }

  /**
   * The Administrator's list: project, category, model, run reference, time and the PM's note, nothing else.
   * The run is the analysis run (analysis_run, minutes_draft), the extraction run (proposal) or the AI request (answer, report_version, summary_version). The model is the one
   * the extraction run recorded, else the one the spend ledger charged for that run; null when neither says.
   */
  async adminList(user: AuthUser): Promise<{ feedback: AdminFeedbackRow[] }> {
    if (!can(user.role, 'ai.settings.manage')) throw new ForbiddenException();
    const { rows } = await this.pool.query(
      `SELECT f.id, p.name AS "projectName", f.category, r.run_ref AS "runRef", f.escalated_at AS at, f.escalation_note AS "escalationNote",
              COALESCE(
                (SELECT x.model_id FROM extraction_runs x WHERE x.id = r.extraction_ref),
                (SELECT e.model_id FROM ai_spend_entries e WHERE e.request_id IN (r.run_ref, r.extraction_ref) AND e.status <> 'released' ORDER BY e.created_at DESC, e.attempt_no DESC LIMIT 1)
              ) AS model
         FROM ai_feedback f
         JOIN projects p ON p.id = f.project_id
         LEFT JOIN LATERAL (
           SELECT CASE f.target_kind
                    WHEN 'proposal' THEN (SELECT i.run_id FROM extraction_items i WHERE i.id = f.target_id)
                    WHEN 'analysis_run' THEN f.target_id
                    WHEN 'answer' THEN f.target_id
                    WHEN 'report_version' THEN (SELECT v.request_id FROM report_draft_versions v WHERE v.id = f.target_id)
                    WHEN 'summary_version' THEN (SELECT v.request_id FROM summary_versions v WHERE v.id = f.target_id)
                    ELSE (SELECT d.analysis_run_id FROM minutes_drafts d WHERE d.id = f.target_id)
                  END AS run_ref,
                  CASE f.target_kind
                    WHEN 'proposal' THEN (SELECT i.run_id FROM extraction_items i WHERE i.id = f.target_id)
                    WHEN 'analysis_run' THEN (SELECT a.extraction_run_id FROM analysis_runs a WHERE a.id = f.target_id)
                    WHEN 'answer' THEN NULL
                    WHEN 'report_version' THEN NULL
                    WHEN 'summary_version' THEN NULL
                    ELSE (SELECT a.extraction_run_id FROM minutes_drafts d JOIN analysis_runs a ON a.id = d.analysis_run_id WHERE d.id = f.target_id)
                  END AS extraction_ref
         ) r ON true
        WHERE f.escalated_at IS NOT NULL ORDER BY f.escalated_at DESC, f.id DESC`,
    );
    return { feedback: rows as AdminFeedbackRow[] };
  }
}
