import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Pool } from 'pg';
import { writeAudit } from '../audit/audit';
import { CLOCK, type AuthUser, type Clock } from '../auth/tokens';
import { UUID } from '../common/uuid7';
import { PG_POOL } from '../db/database.module';
import { inAudience } from '../discussion/audience';
import { AudienceService } from '../discussion/audience.service';
import { type ProjectContext, ProjectAccess } from '../projects/access.service';
import { type RecordKind, RECORD_KINDS } from './final-states';

export type SourceItemKind = 'note' | 'minutes' | 'summary';
export type DeletedKind = 'message' | SourceItemKind | RecordKind;
export const DELETED_KINDS: readonly DeletedKind[] = ['message', 'note', 'minutes', 'summary', ...RECORD_KINDS];

/** One line of the project's "Deletions and restorations" (history spec 4.6). */
export interface HistoryLine {
  at: string;
  kind: DeletedKind | 'credential_report';
  action: 'deleted' | 'restored' | 'reported';
  /** Who acted; for a credential report, the reporter only for PM, Owner, Sponsor and Administrators (else null). */
  actor: string | null;
  reason: string | null;
  /** For a credential report: the kind of item it was reported in ("A suspected credential was reported in a [kind]"). */
  itemKind?: string;
  /** Only for a holder of Inspect Deleted Content, and only for an item that is Deleted now and that they may open. */
  title?: string;
  href?: string;
}

/** A Deleted item a holder of Inspect Deleted Content may open (history spec 4.7). */
export interface DeletedItem {
  kind: DeletedKind;
  id: string;
  title: string;
  deletedBy: string;
  deletedAt: string;
  deleteReason: string;
  href: string;
}

const SOURCE_KIND: Readonly<Record<string, SourceItemKind>> = { notes: 'note', minutes: 'minutes', summary: 'summary' };
const RECORD_TITLE: Readonly<Record<RecordKind, { table: string; title: string }>> = {
  task: { table: 'tasks', title: 'title' },
  decision: { table: 'decisions', title: 'statement' },
  question: { table: 'questions', title: 'text' },
  risk: { table: 'risks', title: 'description' },
};

const iso = (d: Date | string): string => (d instanceof Date ? d : new Date(d)).toISOString();

/**
 * The project's history of deletions, restorations and credential reports, and the read-only Deleted items view for
 * holders of Inspect Deleted Content (history spec 4.6, 4.7).
 *
 * Every participant and Active grant holder sees the lines: kind, actor, time and reason, never the title or text.
 * Only a holder of a grant with Inspect Deleted Content (never a role: creator, PM and Administrator get nothing by
 * role) sees titles and may open Deleted items, and only those they could read were they live (audience rules still
 * apply). Held items (in an open quarantine case) are never included; a Deleted item that was cleaned shows its stored,
 * cleaned text. Nothing here feeds search, the Ask panel or any AI request.
 */
@Injectable()
export class HistoryService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly now: Clock,
    private readonly access: ProjectAccess,
    private readonly audiences: AudienceService,
  ) {}

  /** Newest first. 404 for anyone who is neither a participant nor an Active grant holder of the project. */
  async deletions(user: AuthUser, projectId: string): Promise<HistoryLine[]> {
    const ctx = await this.access.authorize(user, 'project.view', projectId);
    const seesReporter = ctx.isAdmin || ctx.roles.some((r) => r === 'pm' || r === 'owner' || r === 'sponsor');
    const { rows } = await this.pool.query(
      `SELECT * FROM (
         SELECT e.at, CASE s.kind WHEN 'notes' THEN 'note' ELSE s.kind END AS kind, e.kind AS action, u.display_name AS actor, e.reason,
                s.id AS "itemId", NULL::text AS "itemKind", e.id AS "eventId"
           FROM source_events e JOIN sources s ON s.id = e.source_id JOIN users u ON u.id = e.actor_id
          WHERE e.project_id = $1
         UNION ALL
         SELECT e.at, 'task', e.kind, u.display_name, e.note, t.id, NULL, e.id
           FROM task_events e JOIN tasks t ON t.id = e.task_id JOIN users u ON u.id = e.actor_id
          WHERE t.project_id = $1 AND e.kind IN ('deleted', 'restored')
         UNION ALL
         SELECT e.at, e.record_kind, e.kind, u.display_name, e.note, e.record_id, NULL, e.id
           FROM record_events e JOIN users u ON u.id = e.actor_id
           LEFT JOIN decisions d ON e.record_kind = 'decision' AND d.id = e.record_id
           LEFT JOIN questions q ON e.record_kind = 'question' AND q.id = e.record_id
           LEFT JOIN risks r ON e.record_kind = 'risk' AND r.id = e.record_id
          WHERE e.kind IN ('deleted', 'restored') AND COALESCE(d.project_id, q.project_id, r.project_id) = $1
         UNION ALL
         SELECT e.at, 'message', e.action, u.display_name, e.reason, e.message_id, NULL, e.id
           FROM discussion_events e JOIN discussion_threads th ON th.id = e.thread_id JOIN users u ON u.id = e.actor_id
          WHERE th.project_id = $1 AND e.message_id IS NOT NULL AND e.action IN ('deleted', 'restored')
         UNION ALL
         SELECT c.reported_at, 'credential_report', 'reported', CASE WHEN $2::boolean THEN u.display_name END, NULL, c.item_id, c.item_kind, c.id
           FROM quarantine_cases c LEFT JOIN users u ON u.id = c.reporter_id
          WHERE c.project_id = $1
       ) lines ORDER BY at DESC, "eventId" DESC`,
      [ctx.project.id, seesReporter],
    );
    const openable = ctx.inspectDeleted ? new Map((await this.collect(ctx, user)).map((i) => [`${i.kind}:${i.id}`, i])) : new Map<string, DeletedItem>();
    return rows.map((r) => {
      const line: HistoryLine = { at: iso(r.at), kind: r.kind, action: r.action, actor: r.actor ?? null, reason: r.action === 'reported' ? null : r.reason };
      if (r.kind === 'credential_report') return { ...line, itemKind: r.itemKind };
      const item = openable.get(`${r.kind}:${r.itemId}`);
      return item ? { ...line, title: item.title, href: item.href } : line;
    });
  }

  /** The Deleted items list: holders of Inspect Deleted Content only (404 for anyone else), newest deletion first. */
  async deletedItems(user: AuthUser, projectId: string): Promise<DeletedItem[]> {
    const ctx = await this.holder(user, projectId);
    return (await this.collect(ctx, user)).sort((a, b) => b.deletedAt.localeCompare(a.deletedAt) || b.id.localeCompare(a.id));
  }

  /**
   * One Deleted item, read-only, with who deleted it, when and why. 404 unless the viewer holds Inspect Deleted Content
   * here, the item is Deleted (not live, not held) in this project, and they could read it by its audience. Each
   * opening writes `deleted.inspected` to audit_events with the item's kind and id, never its text.
   */
  async deletedItem(user: AuthUser, projectId: string, kindIn: string, id: string): Promise<DeletedItem & Record<string, unknown>> {
    const kind = kindIn as DeletedKind;
    if (!DELETED_KINDS.includes(kind) || !UUID.test(id)) throw new NotFoundException();
    const ctx = await this.holder(user, projectId);
    const item = (await this.collect(ctx, user, { kind, id }))[0];
    if (!item) throw new NotFoundException();
    const detail = await this.detail(kind, id);
    await writeAudit(this.pool, { at: this.now(), action: 'deleted.inspected', actorUserId: user.id, subjectType: kind, subjectId: id, detail: { projectId: ctx.project.id } });
    return { ...item, ...detail };
  }

  /** A participant or grant holder of the project (else 404) whose Active grant includes Inspect Deleted Content (else 404). */
  private async holder(user: AuthUser, projectId: string): Promise<ProjectContext> {
    const ctx = await this.access.authorize(user, 'project.view', projectId);
    if (ctx.inspectDeleted !== true) throw new NotFoundException();
    return ctx;
  }

  /**
   * Every item in the project that is Deleted now, not held, and readable by this viewer by its audience; or just the
   * one named by `only`. Records have no audience of their own (spec 4.3); sources and messages keep theirs.
   */
  private async collect(ctx: ProjectContext, user: AuthUser, only?: { kind: DeletedKind; id: string }): Promise<DeletedItem[]> {
    const want = (k: DeletedKind) => !only || only.kind === k;
    const params: unknown[] = only ? [ctx.project.id, only.id] : [ctx.project.id];
    const one = (col: string) => (only ? ` AND ${col} = $2` : '');
    const href = (kind: DeletedKind, id: string) => `#/projects/${ctx.project.id}/deleted/${kind}/${id}`;
    const out: DeletedItem[] = [];
    const push = (kind: DeletedKind, r: { id: string; title: string; by: string; at: Date; reason: string }) =>
      out.push({ kind, id: r.id, title: r.title, deletedBy: r.by, deletedAt: iso(r.at), deleteReason: r.reason, href: href(kind, r.id) });

    if (want('note') || want('minutes') || want('summary')) {
      const { rows } = await this.pool.query(
        `SELECT s.id, s.kind, s.title, u.display_name AS by, s.deleted_at AS at, s.delete_reason AS reason
           FROM sources s JOIN users u ON u.id = s.deleted_by
          WHERE s.project_id = $1 AND s.status = 'deleted' AND s.held_case_id IS NULL AND s.kind IN ('notes', 'minutes', 'summary')${one('s.id')}`,
        params,
      );
      for (const r of rows) {
        const kind = SOURCE_KIND[r.kind];
        if (!want(kind)) continue;
        const row = await this.audiences.sourceAccessRow(r.id);
        // A summary source's summary is withdrawn by its deletion; it was read by its own audience, as notes are.
        if (!this.audiences.canSeeSource(ctx, user, row.kind === 'summary' ? { ...row, kind: 'notes' } : row)) continue;
        push(kind, r);
      }
    }
    for (const kind of RECORD_KINDS) {
      if (!want(kind)) continue;
      const { table, title } = RECORD_TITLE[kind];
      const { rows } = await this.pool.query(
        `SELECT x.id, x.${title} AS title, u.display_name AS by, x.deleted_at AS at, x.delete_reason AS reason
           FROM ${table} x JOIN users u ON u.id = x.deleted_by
          WHERE x.project_id = $1 AND x.deleted_at IS NOT NULL AND x.held_case_id IS NULL${one('x.id')}`,
        params,
      );
      for (const r of rows) push(kind, r);
    }
    if (want('message')) {
      const { rows } = await this.pool.query(
        `SELECT m.id, m.message_no AS no, th.title AS "threadTitle", th.audience_id AS "audienceId",
                u.display_name AS by, m.state_at AS at, m.state_reason AS reason
           FROM discussion_messages m JOIN discussion_threads th ON th.id = m.thread_id JOIN users u ON u.id = m.state_by
          WHERE th.project_id = $1 AND m.state = 'deleted' AND m.held_case_id IS NULL AND th.held_case_id IS NULL${one('m.id')}`,
        params,
      );
      for (const r of rows) {
        if (!inAudience(ctx, await this.audiences.load(r.audienceId))) continue;
        push('message', { ...r, title: `Message ${r.no} in ${r.threadTitle}` });
      }
    }
    return out;
  }

  /** The item's stored (cleaned, if it was ever cleaned) content, for reading only. */
  private async detail(kind: DeletedKind, id: string): Promise<Record<string, unknown>> {
    const one = async (sql: string) => (await this.pool.query(sql, [id])).rows[0] as Record<string, unknown>;
    switch (kind) {
      case 'note':
      case 'minutes':
      case 'summary':
        return one(`SELECT version_no AS "versionNo", text_content AS text FROM source_versions WHERE source_id = $1 ORDER BY version_no DESC LIMIT 1`);
      case 'task':
        return one(
          `SELECT t.status, to_char(t.due_on, 'YYYY-MM-DD') AS "dueOn", u.display_name AS assignee, t.parent_id AS "parentId"
             FROM tasks t JOIN users u ON u.id = t.assignee_id WHERE t.id = $1`,
        );
      case 'decision':
        return one(`SELECT status, rationale FROM decisions WHERE id = $1`);
      case 'question':
        return {
          ...(await one(`SELECT status FROM questions WHERE id = $1`)),
          answers: (
            await this.pool.query(
              `SELECT a.answer AS text, u.display_name AS author, a.at FROM question_answers a JOIN users u ON u.id = a.author_id WHERE a.question_id = $1 ORDER BY a.at, a.id`,
              [id],
            )
          ).rows,
        };
      case 'risk':
        return one(`SELECT status, severity, mitigation, to_char(review_on, 'YYYY-MM-DD') AS "reviewOn" FROM risks WHERE id = $1`);
      case 'message':
        return one(
          `SELECT v.body AS text, m.message_no AS no, m.thread_id AS "threadId", au.display_name AS author, m.created_at AS "createdAt"
             FROM discussion_messages m JOIN users au ON au.id = m.author_id
             JOIN LATERAL (SELECT body FROM message_versions WHERE message_id = m.id ORDER BY version_no DESC LIMIT 1) v ON true
            WHERE m.id = $1`,
        );
    }
  }
}
