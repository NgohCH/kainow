import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, HttpCode, Inject, NotFoundException, Param, Post, Put, Query, Req } from '@nestjs/common';
import type { Pool } from 'pg';
import { AnySignedInUser } from '../auth/access';
import type { HttpRequest } from '../auth/auth.guard';
import { CLOCK, type AuthUser, type Clock } from '../auth/tokens';
import { cursorTime, parseCursor } from '../common/cursor';
import { UUID, uuidv7 } from '../common/uuid7';
import { PG_POOL } from '../db/database.module';
import { ProjectAccess, canReadContent } from '../projects/access.service';
import { todayUtc8 } from '../projects/membership';
import { escalationFlags } from './escalation-flags';

const PAGE = 30;
const CHOICES = ['daily_urgent_immediate', 'immediate', 'daily', 'off'] as const;
const LABELS: Record<(typeof CHOICES)[number], string> = {
  daily_urgent_immediate: 'Daily, urgent immediately',
  immediate: 'Every notice immediately',
  daily: 'Daily only',
  off: 'Off',
};
const NOTE_MAX = 200;
export const END_BEFORE_START = 'The end date cannot be before the start date.';
export const NO_ROLE = 'You have no role in this project.';

const who = (req: HttpRequest): AuthUser => {
  const user = req.auth?.user;
  if (!user) throw new NotFoundException();
  return user;
};
const body = (b: unknown): Record<string, unknown> => (b && typeof b === 'object' ? (b as Record<string, unknown>) : {});

/** A real calendar date written YYYY-MM-DD. */
function calendarDate(v: unknown, field: string): string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new BadRequestException(`${field} must be a date written YYYY-MM-DD.`);
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) throw new BadRequestException(`${field} must be a real date.`);
  return v;
}

/** Whether the person can read the project now: an Active role or a grant giving access (the rule search uses). */
const canRead = canReadContent;

@Controller()
export class NotificationsController {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly now: Clock,
    private readonly access: ProjectAccess,
  ) {}

  /**
   * Tasks shown with "No independent escalation recipient": anyone who can read the project's content (an Active role
   * or a read grant). Task titles are content, so an Administrator with no role gets 404 like other content routes.
   */
  @Get('projects/:id/escalation-flags')
  @AnySignedInUser()
  async flags(@Param('id') id: string, @Req() req: HttpRequest) {
    const user = who(req);
    if (!canRead(await this.access.load(id, user))) throw new NotFoundException();
    return escalationFlags(this.pool, id, todayUtc8(this.now()));
  }

  /**
   * The person's own notices, newest first; `before` is the `next` cursor of the previous page ("<created time>|<id>").
   * A notice for a project the person can no longer read shows no detail, except the minimal Administrator fallback
   * (project name and "A task in <project> needs reassignment."), which an Administrator always sees.
   */
  @Get('notifications')
  @AnySignedInUser()
  async list(@Query('before') before: string | undefined, @Req() req: HttpRequest) {
    const user = who(req);
    const cursor = parseCursor(before);
    const { rows } = await this.pool.query(
      `SELECT n.id, n.project_id AS "projectId", p.name AS "projectName", n.kind, n.urgent, n.summary, n.link,
              n.created_at AS "createdAt", n.read_at AS "readAt", ${cursorTime('n.created_at')} AS cur,
              COALESCE((tr.detail->>'minimal')::boolean, false) AS minimal
         FROM notifications n LEFT JOIN projects p ON p.id = n.project_id
         LEFT JOIN notification_triggers tr ON tr.id = n.trigger_id
        WHERE n.user_id = $1 AND ($2::timestamptz IS NULL OR (n.created_at, n.id) < ($2::timestamptz, $3::uuid))
        ORDER BY n.created_at DESC, n.id DESC LIMIT $4`,
      [user.id, cursor?.at ?? null, cursor?.id ?? null, PAGE + 1],
    );
    const readable = new Map<string, boolean>();
    for (const r of rows.slice(0, PAGE)) {
      if (r.projectId && !readable.has(r.projectId)) readable.set(r.projectId, canRead(await this.access.load(r.projectId, user)));
    }
    const isAdmin = user.role === 'enterprise_administrator';
    const items = rows.slice(0, PAGE).map((r) => {
      // The minimal fallback holds only the project name, and it is addressed to the Administrator role, not a project role.
      const adminFallback = r.minimal === true && isAdmin;
      const noAccess = r.projectId !== null && !adminFallback && readable.get(r.projectId) !== true;
      return {
        id: r.id,
        projectId: r.projectId,
        projectName: noAccess ? null : r.projectName,
        kind: r.kind,
        urgent: r.urgent,
        summary: noAccess ? null : r.summary,
        link: noAccess || r.minimal ? null : r.link,
        createdAt: r.createdAt,
        readAt: r.readAt,
        noAccess,
      };
    });
    const more = rows.length > PAGE;
    return { items, more, next: more ? `${rows[PAGE - 1].cur}|${rows[PAGE - 1].id}` : null };
  }

  @Get('notifications/unread-count')
  @AnySignedInUser()
  async unread(@Req() req: HttpRequest) {
    const { rows } = await this.pool.query(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL`, [who(req).id]);
    return { count: rows[0].n as number };
  }

  @Post('notifications/read-all')
  @HttpCode(200)
  @AnySignedInUser()
  async readAll(@Req() req: HttpRequest) {
    const r = await this.pool.query(`UPDATE notifications SET read_at = $2 WHERE user_id = $1 AND read_at IS NULL`, [who(req).id, this.now()]);
    return { count: r.rowCount ?? 0 };
  }

  @Post('notifications/:id/read')
  @HttpCode(200)
  @AnySignedInUser()
  async read(@Param('id') id: string, @Req() req: HttpRequest) {
    if (!UUID.test(id)) throw new NotFoundException();
    const r = await this.pool.query(`UPDATE notifications SET read_at = COALESCE(read_at, $3) WHERE id = $1 AND user_id = $2`, [id, who(req).id, this.now()]);
    if (r.rowCount === 0) throw new NotFoundException();
    return { id };
  }

  /** Projects where the person holds an Active role today with their choice, and their current away periods. */
  @Get('email-preferences')
  @AnySignedInUser()
  async preferences(@Req() req: HttpRequest) {
    const user = who(req);
    const projects: { projectId: string; name: string; choice: string; label: string }[] = [];
    for (const pid of await this.access.visibleProjectIds(user.id)) {
      const ctx = await this.access.load(pid, user);
      if (!ctx || ctx.roles.length === 0) continue;
      const r = (
        await this.pool.query(
          `SELECT p.name, COALESCE(e.choice, 'daily_urgent_immediate') AS choice
             FROM projects p LEFT JOIN email_preferences e ON e.project_id = p.id AND e.user_id = $2 WHERE p.id = $1`,
          [pid, user.id],
        )
      ).rows[0];
      projects.push({ projectId: pid, name: r.name, choice: r.choice, label: LABELS[r.choice as (typeof CHOICES)[number]] });
    }
    projects.sort((a, b) => a.name.localeCompare(b.name) || a.projectId.localeCompare(b.projectId));
    const away = (
      await this.pool.query(
        `SELECT id, to_char(starts_on, 'YYYY-MM-DD') AS "startsOn", to_char(ends_on, 'YYYY-MM-DD') AS "endsOn", note
           FROM away_periods WHERE user_id = $1 AND removed_at IS NULL AND ends_on >= $2::date ORDER BY starts_on, id`,
        [user.id, todayUtc8(this.now())],
      )
    ).rows;
    return { projects, away };
  }

  @Put('email-preferences/:projectId')
  @AnySignedInUser()
  async setPreference(@Param('projectId') projectId: string, @Body() b: unknown, @Req() req: HttpRequest) {
    const user = who(req);
    const choice = body(b).choice;
    if (typeof choice !== 'string' || !(CHOICES as readonly string[]).includes(choice)) {
      throw new BadRequestException('Choose one of: Daily, urgent immediately; Every notice immediately; Daily only; Off.');
    }
    const ctx = await this.access.load(projectId, user);
    if (!canRead(ctx)) throw new NotFoundException();
    if (ctx.roles.length === 0) throw new ForbiddenException(NO_ROLE);
    await this.pool.query(
      `INSERT INTO email_preferences (user_id, project_id, choice, updated_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, project_id) DO UPDATE SET choice = EXCLUDED.choice, updated_at = EXCLUDED.updated_at`,
      [user.id, projectId, choice, this.now()],
    );
    return { projectId, choice, label: LABELS[choice as (typeof CHOICES)[number]] };
  }

  /** { startsOn, endsOn, note? } */
  @Post('away-periods')
  @AnySignedInUser()
  async addAway(@Body() b: unknown, @Req() req: HttpRequest) {
    const user = who(req);
    const input = body(b);
    const startsOn = calendarDate(input.startsOn, 'The start date');
    const endsOn = calendarDate(input.endsOn, 'The end date');
    if (endsOn < startsOn) throw new BadRequestException(END_BEFORE_START);
    let note: string | null = null;
    if (input.note !== undefined && input.note !== null) {
      if (typeof input.note !== 'string') throw new BadRequestException('The note must be text.');
      note = input.note.trim() === '' ? null : input.note.trim();
      if (note !== null && [...note].length > NOTE_MAX) throw new BadRequestException(`The note can be at most ${NOTE_MAX} characters.`);
    }
    const id = uuidv7();
    await this.pool.query(`INSERT INTO away_periods (id, user_id, starts_on, ends_on, note, created_at) VALUES ($1, $2, $3, $4, $5, $6)`, [id, user.id, startsOn, endsOn, note, this.now()]);
    return { id, startsOn, endsOn, note };
  }

  @Delete('away-periods/:id')
  @AnySignedInUser()
  async removeAway(@Param('id') id: string, @Req() req: HttpRequest) {
    if (!UUID.test(id)) throw new NotFoundException();
    const r = await this.pool.query(`UPDATE away_periods SET removed_at = $3 WHERE id = $1 AND user_id = $2 AND removed_at IS NULL`, [id, who(req).id, this.now()]);
    if (r.rowCount === 0) throw new NotFoundException();
    return { id };
  }
}
