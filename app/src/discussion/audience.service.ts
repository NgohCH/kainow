import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { onMaterialRemoved } from '../assist/removal';
import { writeAudit } from '../audit/audit';
import { CLOCK, type AuthUser, type Clock } from '../auth/tokens';
import { UUID, uuidv7 } from '../common/uuid7';
import { PG_POOL } from '../db/database.module';
import { type ProjectContext, ProjectAccess, canReadContent } from '../projects/access.service';
import { grantGivesAccess } from '../projects/grants';
import { effectiveRoles } from '../projects/membership';
import { type AudienceChange, type AudienceRow, type Person, RESTRICTED_ROLES, inAudience } from './audience';

type Db = Pool | PoolClient;

/** What decides whether a viewer may see one source: its kind, whether it is published, who submitted it, and its audience. */
export interface SourceAccessRow {
  id: string;
  projectId: string;
  kind: 'notes' | 'minutes' | 'discussion';
  publication: 'published' | 'submitted' | 'returned';
  submittedBy: string | null;
  audience: AudienceRow;
}

export const NAMED_OUTSIDE = 'Only people in this project can be named.';
const REASON_REQUIRED = 'A reason is required (up to 500 characters).';

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

/**
 * Whether a change takes access away from anyone by the audience itself: Project-wide becoming Restricted, or a named
 * person removed from a Restricted audience. Adding named people, or Restricted becoming Project-wide, does not.
 */
export function narrows(from: Pick<AudienceRow, 'mode' | 'namedUserIds'>, to: AudienceChange): boolean {
  if (to.mode === 'project') return false;
  if (from.mode === 'project') return true;
  return from.namedUserIds.some((id) => !to.namedUserIds.includes(id));
}

/** The audience of a source or thread (spec 6): loading it, checking it, previewing and recording changes to it. */
@Injectable()
export class AudienceService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly now: Clock,
    private readonly access: ProjectAccess,
  ) {}

  private async row(db: Db, join: string, id: string, lock = false): Promise<AudienceRow> {
    if (!UUID.test(id)) throw new NotFoundException();
    const { rows } = await db.query(
      `SELECT a.id, a.project_id AS "projectId", a.mode,
              COALESCE((SELECT array_agg(am.user_id ORDER BY am.user_id) FROM audience_members am WHERE am.audience_id = a.id), ARRAY[]::uuid[]) AS "namedUserIds"
         FROM audiences a ${join} ${lock ? 'FOR UPDATE OF a' : ''}`,
      [id],
    );
    if (!rows[0]) throw new NotFoundException();
    return rows[0] as AudienceRow;
  }

  load(id: string, db: Db = this.pool): Promise<AudienceRow> {
    return this.row(db, 'WHERE a.id = $1', id);
  }

  forSource(sourceId: string, db: Db = this.pool): Promise<AudienceRow> {
    return this.row(db, 'JOIN sources s ON s.audience_id = a.id WHERE s.id = $1', sourceId);
  }

  forThread(threadId: string, db: Db = this.pool): Promise<AudienceRow> {
    return this.row(db, 'JOIN discussion_threads t ON t.audience_id = a.id WHERE t.id = $1', threadId);
  }

  /** When the audience was last changed (the latest audience_events row), or null if it never was. */
  async changedAt(audienceId: string, db: Db = this.pool): Promise<string | null> {
    const { rows } = await db.query(`SELECT max(at) AS at FROM audience_events WHERE audience_id = $1`, [audienceId]);
    return rows[0]?.at ? (rows[0].at as Date).toISOString() : null;
  }

  /** Outside the audience the item does not exist (404), like other hidden content. */
  assertReadable(ctx: ProjectContext, a: AudienceRow): void {
    if (!inAudience(ctx, a)) throw new NotFoundException();
  }

  /**
   * A published source follows its audience. A submission (or a returned one) is for its submitter and for people
   * holding PM, Deputy, Owner or Sponsor today, whatever audience is intended (spec 5.4).
   */
  canSeeSource(ctx: ProjectContext, user: AuthUser, row: SourceAccessRow): boolean {
    if (row.publication === 'published') return inAudience(ctx, row.audience);
    if (!canReadContent(ctx)) return false;
    return row.submittedBy === user.id || ctx.roles.some((r) => RESTRICTED_ROLES.includes(r));
  }

  /**
   * The one check every route that reaches a source goes through: a participant or grant holder of the source's
   * project, who may see this source. Anyone else, and sources from before projects existed, find nothing (404).
   */
  async assertSourceReadable(user: AuthUser, sourceId: string, db: Db = this.pool): Promise<{ ctx: ProjectContext; row: SourceAccessRow }> {
    const projectId = await this.access.projectOfSource(sourceId, db);
    const ctx = await this.access.authorize(user, 'note.view', projectId, db);
    const { rows } = await db.query(
      `SELECT id, project_id AS "projectId", kind, publication, submitted_by AS "submittedBy", audience_id AS "audienceId" FROM sources WHERE id = $1`,
      [sourceId],
    );
    if (!rows[0]) throw new NotFoundException();
    const { audienceId, ...rest } = rows[0];
    const row: SourceAccessRow = { ...rest, audience: await this.load(audienceId, db) };
    if (!this.canSeeSource(ctx, user, row)) throw new NotFoundException();
    return { ctx, row };
  }

  /** Named people must hold a valid membership or a grant giving access in the project today. */
  private assertNamable(ctx: ProjectContext, change: AudienceChange): void {
    for (const id of change.namedUserIds) {
      const member = effectiveRoles(ctx.rows, id, ctx.today).length > 0;
      const granted = ctx.grants.some((g) => g.userId === id && grantGivesAccess(g, ctx.today, ctx.rows));
      if (!member && !granted) throw new BadRequestException(NAMED_OUTSIDE);
    }
  }

  /** Creates an audience for a new meeting, thread or source; `actor` is recorded as who named the people. */
  async create(db: Db, projectId: string, change: AudienceChange, actor: AuthUser): Promise<string> {
    const ctx = await this.access.context(actor, projectId, db);
    this.assertNamable(ctx, change);
    const at = this.now();
    const id = uuidv7(at.getTime());
    await db.query(`INSERT INTO audiences (id, project_id, mode, created_at) VALUES ($1, $2, $3, $4)`, [id, projectId, change.mode, at]);
    for (const userId of change.namedUserIds) {
      await db.query(`INSERT INTO audience_members (audience_id, user_id, added_by, added_at) VALUES ($1, $2, $3, $4)`, [id, userId, actor.id, at]);
    }
    return id;
  }

  /**
   * The audience a request is about, for someone who may see it: its project's context, with 404 for anyone outside
   * the project or the audience (before any 403, so a restricted audience's existence is not revealed).
   */
  async visibleTo(user: AuthUser, audienceId: string): Promise<{ ctx: ProjectContext; audience: AudienceRow }> {
    const audience = await this.load(audienceId);
    if (!audience.projectId) throw new NotFoundException();
    const ctx = await this.access.context(user, audience.projectId);
    this.assertReadable(ctx, audience);
    return { ctx, audience };
  }

  /** Who would gain and who would lose access if `a` became `change`, among the project's current readers. */
  async preview(ctx: ProjectContext, a: AudienceRow, change: AudienceChange): Promise<{ gain: Person[]; lose: Person[] }> {
    const ids = new Set<string>();
    for (const r of ctx.rows) ids.add(r.userId);
    for (const g of ctx.grants) ids.add(g.userId);
    const { rows: people } = await this.pool.query(
      `SELECT id, display_name AS "displayName" FROM users WHERE id = ANY($1::uuid[]) ORDER BY display_name, id`,
      [[...ids]],
    );
    const next: AudienceRow = { ...a, mode: change.mode, namedUserIds: change.namedUserIds };
    const gain: Person[] = [];
    const lose: Person[] = [];
    for (const p of people as Person[]) {
      const asThem: ProjectContext = {
        ...ctx,
        viewerId: p.id,
        isAdmin: false,
        roles: effectiveRoles(ctx.rows, p.id, ctx.today),
        grantKinds: [...new Set(ctx.grants.filter((g) => g.userId === p.id && grantGivesAccess(g, ctx.today, ctx.rows)).map((g) => g.kind))],
      };
      const before = inAudience(asThem, a);
      const after = inAudience(asThem, next);
      if (!before && after) gain.push(p);
      if (before && !after) lose.push(p);
    }
    return { gain, lose };
  }

  async people(ids: string[], db: Db = this.pool): Promise<Person[]> {
    if (ids.length === 0) return [];
    const { rows } = await db.query(`SELECT id, display_name AS "displayName" FROM users WHERE id = ANY($1::uuid[]) ORDER BY display_name, id`, [ids]);
    return rows as Person[];
  }

  /** PM, Owner or Sponsor (not a Deputy) in a Draft, Planned or Active project, with a reason; recorded in audience_events. */
  async change(user: AuthUser, audienceId: string, change: AudienceChange, reason: unknown): Promise<AudienceRow> {
    await this.visibleTo(user, audienceId);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const current = await this.load(audienceId, client);
      if (!current.projectId) throw new NotFoundException();
      const ctx = await this.access.authorize(user, 'audience.change', current.projectId, client, true);
      const locked = await this.row(client, 'WHERE a.id = $1', audienceId, true);
      const text = typeof reason === 'string' ? reason.trim() : '';
      if (text === '' || text.length > 500) throw new BadRequestException(REASON_REQUIRED);
      const talk = await client.query(
        `SELECT 1 FROM discussion_threads WHERE audience_id = $1 AND kind = 'discussion'
         UNION ALL SELECT 1 FROM sources WHERE audience_id = $1 AND kind = 'discussion' LIMIT 1`,
        [audienceId],
      );
      if (talk.rowCount) throw new BadRequestException('The audience of a discussion cannot be changed. Only a meeting and its minutes can have theirs changed.');
      this.assertNamable(ctx, change);
      const at = this.now();
      await client.query(`UPDATE audiences SET mode = $2 WHERE id = $1`, [audienceId, change.mode]);
      await client.query(`DELETE FROM audience_members WHERE audience_id = $1 AND NOT (user_id = ANY($2::uuid[]))`, [audienceId, change.namedUserIds]);
      for (const userId of change.namedUserIds.filter((id) => !locked.namedUserIds.includes(id))) {
        await client.query(`INSERT INTO audience_members (audience_id, user_id, added_by, added_at) VALUES ($1, $2, $3, $4)`, [audienceId, userId, user.id, at]);
      }
      await client.query(
        `INSERT INTO audience_events (id, audience_id, actor_id, from_mode, to_mode, from_named, to_named, reason, at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [uuidv7(at.getTime()), audienceId, user.id, locked.mode, change.mode, locked.namedUserIds, change.namedUserIds, text, at],
      );
      await writeAudit(client, {
        at,
        action: 'audience.changed',
        actorUserId: user.id,
        subjectType: 'audience',
        subjectId: audienceId,
        detail: { from: locked.mode, to: change.mode, named: change.namedUserIds.length, unchanged: locked.mode === change.mode && sameSet(locked.namedUserIds, change.namedUserIds) },
      });
      // Narrowing (Project-wide to Restricted, or a named person removed) sends AI answers and drafts built on material
      // with this audience through the removal hook (4b spec 5.5), in this transaction. Widening never does.
      if (narrows(locked, change)) await onMaterialRemoved(client, { audienceId }, 'audience_tightened', at);
      await client.query('COMMIT');
      return { ...locked, mode: change.mode, namedUserIds: [...change.namedUserIds] };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}
