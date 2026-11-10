import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { writeAudit } from '../audit/audit';
import { CLOCK, type AuthUser, type Clock } from '../auth/tokens';
import { UUID, uuidv7 } from '../common/uuid7';
import { PG_POOL } from '../db/database.module';
import { type ProjectContext, ProjectAccess } from '../projects/access.service';
import { type PlannedTrigger, planProject } from './planner';
import {
  EMPTY_PROJECT, GROUP_OF, MSG, NOT_ALLOWED, type OrgRow, type ProjectRow, applyProject, historyText, loadHolidayDates,
  loadOrgRow, loadProjectRow, loadRiskSnaps, loadTaskSnaps, parseOrgChanges, parseProjectChanges, resolveEffective, sameValue, snake,
} from './settings';

type Db = Pool | PoolClient;
const DAY_MS = 86_400_000;
const EDITORS = ['pm', 'owner', 'sponsor'];

export interface PreviewItem { recordKind: string; recordId: string; title: string; kind: string; from: string | null; to: string | null }
export interface Preview { moved: PreviewItem[]; added: PreviewItem[]; removed: PreviewItem[] }

const reasonOf = (v: unknown): string => {
  if (typeof v !== 'string' || v.trim() === '') throw new BadRequestException(MSG.reason);
  return v.trim();
};

const NOT_EDITOR = 'Only a Project Manager, Owner or Sponsor can change the project’s notification settings.';
type Proposal = { org: OrgRow; proj: ProjectRow; holidays?: ReadonlySet<string> };

function holidayDate(date: unknown): string {
  const ok = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(`${date}T00:00:00Z`)) && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;
  if (!ok) throw new BadRequestException('Choose the holiday date as YYYY-MM-DD.');
  return date as string;
}

function holidayInput(b: Record<string, unknown>): { date: string; name: string } {
  const date = holidayDate(b.date);
  if (typeof b.name !== 'string' || b.name.trim() === '') throw new BadRequestException('Give the holiday a name.');
  return { date, name: b.name.trim().slice(0, 200) };
}

@Injectable()
export class NotificationSettingsService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly now: Clock,
    private readonly access: ProjectAccess,
  ) {}

  private async tx<T>(work: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const out = await work(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  private async history(projectId: string | null) {
    const { rows } = await this.pool.query(
      `SELECT h.id, h.field, h.old_value AS "oldValue", h.new_value AS "newValue", h.reason, u.display_name AS actor, h.actor_id AS "actorId", h.at
         FROM notification_settings_changes h JOIN users u ON u.id = h.actor_id
        WHERE h.project_id IS NOT DISTINCT FROM $1
        ORDER BY h.at DESC, h.id DESC`,
      [projectId],
    );
    return rows;
  }

  private async holidayList(projectId: string | null) {
    const { rows } = await this.pool.query(
      `SELECT id, to_char(on_date, 'YYYY-MM-DD') AS date, name, added_at AS "addedAt", removed_at AS "removedAt"
         FROM holidays WHERE project_id IS NOT DISTINCT FROM $1 ORDER BY on_date, added_at`,
      [projectId],
    );
    return rows;
  }

  // ---- Organisation ----

  async organisationView() {
    return { ...(await loadOrgRow(this.pool)), holidays: await this.holidayList(null), history: await this.history(null) };
  }

  /** { changes: {...}, reason } by the Administrator. */
  async setOrganisation(user: AuthUser, b: Record<string, unknown>): Promise<void> {
    const changes = parseOrgChanges(b.changes);
    const reason = reasonOf(b.reason);
    const at = this.now();
    await this.tx(async (c) => {
      const old = await loadOrgRow(c, true);
      const next: OrgRow = { ...old, ...changes };
      const changed = (Object.keys(changes) as (keyof OrgRow)[]).filter((k) => !sameValue(old[k], next[k]));
      if (changed.length === 0) return;
      for (const k of changed) await this.log(c, null, k, old[k], next[k], reason, user.id, at);
      await c.query(
        `UPDATE notification_settings SET day_counting = $1, weekdays = $2::smallint[], lead_days = $3::smallint[], escalation_days = $4, sweep_minutes = $5,
                projects_may_change_calendar = $6, projects_may_change_timings = $7, projects_may_change_digest = $8, updated_by = $9, updated_at = $10
          WHERE id = 1`,
        [next.dayCounting, next.weekdays, next.leadDays, next.escalationDays, next.sweepMinutes,
          next.projectsMayChangeCalendar, next.projectsMayChangeTimings, next.projectsMayChangeDigest, user.id, at],
      );
      await writeAudit(c, {
        at, action: 'notification_settings.changed', actorUserId: user.id, subjectType: 'organisation',
        detail: { fields: changed.map(snake) },
      });
    });
  }

  private async log(c: Db, projectId: string | null, field: string, from: unknown, to: unknown, reason: string, actorId: string, at: Date) {
    await c.query(
      `INSERT INTO notification_settings_changes (id, scope, project_id, field, old_value, new_value, reason, actor_id, at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [uuidv7(at.getTime()), projectId ? 'project' : 'organisation', projectId, snake(field), historyText(from), historyText(to), reason, actorId, at],
    );
  }

  // ---- Holidays ----

  private async addHoliday(c: Db, projectId: string | null, b: Record<string, unknown>, user: AuthUser, at: Date) {
    const { date, name } = holidayInput(b);
    const reason = reasonOf(b.reason);
    const dupe = await c.query(
      `SELECT 1 FROM holidays WHERE project_id IS NOT DISTINCT FROM $1 AND on_date = $2::date AND removed_at IS NULL`,
      [projectId, date],
    );
    if (dupe.rowCount) throw new ConflictException('That date is already a holiday.');
    const id = uuidv7(at.getTime());
    try {
      await c.query(`INSERT INTO holidays (id, project_id, on_date, name, added_by, added_at) VALUES ($1, $2, $3::date, $4, $5, $6)`, [id, projectId, date, name, user.id, at]);
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw new ConflictException('That date is already a holiday.');
      throw err;
    }
    await this.log(c, projectId, 'holiday', null, `${date} ${name}`, reason, user.id, at);
    await writeAudit(c, {
      at, action: 'notification_holiday.added', actorUserId: user.id,
      subjectType: projectId ? 'project' : 'organisation', subjectId: projectId ?? undefined, detail: { holidayId: id, date },
    });
  }

  private async removeHoliday(c: Db, projectId: string | null, id: string, b: Record<string, unknown>, user: AuthUser, at: Date) {
    const reason = reasonOf(b.reason);
    if (!UUID.test(id)) throw new NotFoundException();
    const r = await c.query(
      `UPDATE holidays SET removed_by = $3, removed_at = $4
        WHERE id = $1 AND project_id IS NOT DISTINCT FROM $2 AND removed_at IS NULL RETURNING to_char(on_date, 'YYYY-MM-DD') AS date, name`,
      [id, projectId, user.id, at],
    );
    if (!r.rows[0]) throw new NotFoundException();
    await this.log(c, projectId, 'holiday', `${r.rows[0].date} ${r.rows[0].name}`, null, reason, user.id, at);
    await writeAudit(c, {
      at, action: 'notification_holiday.removed', actorUserId: user.id,
      subjectType: projectId ? 'project' : 'organisation', subjectId: projectId ?? undefined, detail: { holidayId: id, date: r.rows[0].date, reason },
    });
  }

  async listHolidays(): Promise<unknown> {
    return { holidays: await this.holidayList(null) };
  }
  async addOrgHoliday(user: AuthUser, b: Record<string, unknown>): Promise<void> {
    const at = this.now();
    await this.tx((c) => this.addHoliday(c, null, b, user, at));
  }
  async removeOrgHoliday(user: AuthUser, id: string, b: Record<string, unknown>): Promise<void> {
    const at = this.now();
    await this.tx((c) => this.removeHoliday(c, null, id, b, user, at));
  }

  async projectHolidays(user: AuthUser, projectId: string) {
    await this.access.context(user, projectId);
    return { holidays: await this.holidayList(projectId), organisationHolidays: (await this.holidayList(null)).filter((h) => !h.removedAt) };
  }
  async addProjectHoliday(user: AuthUser, projectId: string, b: Record<string, unknown>): Promise<void> {
    const at = this.now();
    await this.tx(async (c) => {
      await this.editContext(user, projectId, c, ['calendar']);
      await this.addHoliday(c, projectId, b, user, at);
    });
  }
  async removeProjectHoliday(user: AuthUser, projectId: string, id: string, b: Record<string, unknown>): Promise<void> {
    const at = this.now();
    await this.tx(async (c) => {
      await this.editContext(user, projectId, c, ['calendar']);
      await this.removeHoliday(c, projectId, id, b, user, at);
    });
  }

  // ---- Project ----

  private canEditRole(ctx: ProjectContext): boolean {
    return ctx.roles.some((r) => EDITORS.includes(r));
  }

  /** A project's Project Manager, Owner or Sponsor, when the Administrator allows each group touched. */
  private async editContext(user: AuthUser, projectId: string, c: Db, groups: ('calendar' | 'timings' | 'digest')[]): Promise<ProjectContext> {
    const ctx = await this.access.context(user, projectId, c, true);
    if (!this.canEditRole(ctx)) throw new ForbiddenException(NOT_EDITOR);
    const org = await loadOrgRow(c, true);
    const allowed = { calendar: org.projectsMayChangeCalendar, timings: org.projectsMayChangeTimings, digest: org.projectsMayChangeDigest };
    if (groups.some((g) => !allowed[g])) throw new ForbiddenException(NOT_ALLOWED);
    return ctx;
  }

  async projectView(user: AuthUser, projectId: string) {
    const ctx = await this.access.context(user, projectId);
    const org = await loadOrgRow(this.pool);
    const own = await loadProjectRow(this.pool, projectId);
    const eff = resolveEffective(org, own, await loadHolidayDates(this.pool, projectId));
    const role = this.canEditRole(ctx);
    return {
      dayCounting: eff.cal.dayCounting,
      weekdays: eff.cal.weekdays,
      leadDays: eff.timings.leadDays,
      escalationDays: eff.timings.escalationDays,
      sweepMinutes: eff.sweepMinutes,
      sources: eff.sources,
      delegation: eff.delegation,
      digest: eff.digest,
      own,
      canEdit: { calendar: role && eff.delegation.calendar, timings: role && eff.delegation.timings, digest: role && eff.delegation.digest },
      history: await this.history(projectId),
    };
  }

  /** { changes: {...}, reason }; null clears an override. */
  async setProject(user: AuthUser, projectId: string, b: Record<string, unknown>): Promise<void> {
    await this.access.context(user, projectId); // a non-reader gets 404 before anything about the body is said
    const changes = parseProjectChanges(b.changes);
    const reason = reasonOf(b.reason);
    const at = this.now();
    await this.tx(async (c) => {
      const groups = [...new Set((Object.keys(changes) as (keyof ProjectRow)[]).map((k) => GROUP_OF[k]))];
      // The Administrator may always clear overrides (only null values), without a project role or the switch.
      const clearing = user.role === 'enterprise_administrator' && Object.values(changes).every((v) => v === null);
      if (clearing) await this.access.context(user, projectId, c, true);
      else await this.editContext(user, projectId, c, groups);
      await c.query(
        `INSERT INTO project_notification_settings (project_id, updated_at) VALUES ($1, $2) ON CONFLICT (project_id) DO NOTHING`,
        [projectId, at],
      );
      const old = await loadProjectRow(c, projectId, true);
      const next = applyProject(old, changes);
      const fields = (Object.keys(EMPTY_PROJECT) as (keyof ProjectRow)[]).filter((k) => !sameValue(old[k], next[k]));
      if (fields.length === 0) return;
      for (const k of fields) await this.log(c, projectId, k, old[k], next[k], reason, user.id, at);
      await c.query(
        `UPDATE project_notification_settings SET day_counting = $2, weekdays = $3::smallint[], lead_days = $4::smallint[], escalation_days = $5,
                digest_enabled = $6, digest_frequency = $7, digest_weekday = $8, digest_time = $9::time, updated_by = $10, updated_at = $11
          WHERE project_id = $1`,
        [projectId, next.dayCounting, next.weekdays, next.leadDays, next.escalationDays,
          next.digestEnabled, next.digestFrequency, next.digestWeekday, next.digestTime, user.id, at],
      );
      await writeAudit(c, {
        at, action: 'notification_settings.project_changed', actorUserId: user.id, subjectType: 'project', subjectId: projectId,
        detail: { fields: fields.map(snake) },
      });
    });
  }

  // ---- Preview ----

  /** Triggers in the next 30 days that the proposed change would move, add or remove (those already recorded are left out). */
  private async preview(
    projectIds: string[],
    propose: (cur: { org: OrgRow; proj: ProjectRow; projectId: string }) => Proposal | Promise<Proposal>,
  ): Promise<Preview> {
    const now = this.now();
    const from = now.getTime();
    const to = from + 30 * DAY_MS;
    const inWindow = (t: PlannedTrigger) => t.fireAt.getTime() >= from && t.fireAt.getTime() <= to;
    const out: Preview = { moved: [], added: [], removed: [] };
    const org = await loadOrgRow(this.pool);
    for (const projectId of projectIds) {
      const proj = await loadProjectRow(this.pool, projectId);
      const next = await propose({ org, proj, projectId });
      const holidays = await loadHolidayDates(this.pool, projectId);
      const tasks = await loadTaskSnaps(this.pool, projectId);
      const risks = await loadRiskSnaps(this.pool, projectId);
      const recorded = new Set((await this.pool.query(`SELECT key FROM notification_triggers WHERE project_id = $1`, [projectId])).rows.map((r) => r.key as string));
      const plan = (o: OrgRow, p: ProjectRow, h: ReadonlySet<string>) => {
        const e = resolveEffective(o, p, h);
        return planProject({ cal: e.cal, timings: e.timings, tasks, risks });
      };
      const before = new Map(this.matchKeys(plan(org, proj, holidays)).filter(([, t]) => !recorded.has(t.key)));
      const after = new Map(this.matchKeys(plan(next.org, next.proj, next.holidays ?? holidays)).filter(([, t]) => !recorded.has(t.key)));
      const item = (t: PlannedTrigger, f: PlannedTrigger | null, g: PlannedTrigger | null): PreviewItem => ({
        recordKind: t.recordKind, recordId: t.recordId,
        title: String(t.detail.title ?? t.detail.description ?? ''), kind: t.kind,
        from: f ? f.fireAt.toISOString() : null, to: g ? g.fireAt.toISOString() : null,
      });
      for (const [k, a] of before) {
        const b = after.get(k);
        if (!b) { if (inWindow(a)) out.removed.push(item(a, a, null)); continue; }
        if (a.fireAt.getTime() !== b.fireAt.getTime() && (inWindow(a) || inWindow(b))) out.moved.push(item(b, a, b));
      }
      for (const [k, b] of after) if (!before.has(k) && inWindow(b)) out.added.push(item(b, null, b));
    }
    return out;
  }

  /** Reminders are matched by their rank (longest lead first) so changing 7 to 5 days reads as a move, not a removal and an addition. */
  private matchKeys(plan: PlannedTrigger[]): [string, PlannedTrigger][] {
    const reminders = new Map<string, PlannedTrigger[]>();
    const out: [string, PlannedTrigger][] = [];
    for (const t of plan) {
      if (t.kind !== 'reminder') { out.push([t.key, t]); continue; }
      const prefix = t.key.replace(/:reminder:\d+:/, ':reminder:');
      reminders.set(prefix, [...(reminders.get(prefix) ?? []), t]);
    }
    for (const [prefix, list] of reminders) {
      list.sort((x, y) => Number(y.detail.lead) - Number(x.detail.lead));
      list.forEach((t, i) => out.push([`${prefix}#${i}`, t]));
    }
    return out;
  }

  async previewOrganisation(b: Record<string, unknown>): Promise<Preview> {
    const changes = parseOrgChanges(b.changes);
    const ids = (await this.pool.query(`SELECT id FROM projects WHERE status = 'active' ORDER BY id`)).rows.map((r) => r.id as string);
    return this.preview(ids, ({ org, proj }) => ({ org: { ...org, ...changes }, proj }));
  }

  async previewProject(user: AuthUser, projectId: string, b: Record<string, unknown>): Promise<Preview> {
    const ctx = await this.access.context(user, projectId);
    if (!this.canEditRole(ctx)) throw new ForbiddenException(NOT_EDITOR);
    const changes = parseProjectChanges(b.changes);
    if (ctx.project.status !== 'active') return { moved: [], added: [], removed: [] };
    return this.preview([projectId], ({ org, proj }) => ({ org, proj: applyProject(proj, changes) }));
  }

  /** The holidays that would apply to a project after adding a date and/or removing a current holiday. */
  private async holidaysAfter(projectId: string, add: string | null, removeId: string | null): Promise<Set<string>> {
    const { rows } = await this.pool.query(
      `SELECT id, to_char(on_date, 'YYYY-MM-DD') AS d FROM holidays WHERE removed_at IS NULL AND (project_id IS NULL OR project_id = $1)`,
      [projectId],
    );
    const out = new Set<string>(rows.filter((r) => r.id !== removeId).map((r) => r.d as string));
    if (add) out.add(add);
    return out;
  }

  private holidayProposal(b: Record<string, unknown>): { add: string | null; removeId: string | null } {
    const add = b.add && typeof b.add === 'object' ? holidayDate((b.add as Record<string, unknown>).date) : null;
    const removeId = typeof b.removeId === 'string' && UUID.test(b.removeId) ? b.removeId : null;
    if (!add && !removeId) throw new BadRequestException('Choose a holiday to add or remove.');
    return { add, removeId };
  }

  async previewOrganisationHoliday(b: Record<string, unknown>): Promise<Preview> {
    const { add, removeId } = this.holidayProposal(b);
    const ids = (await this.pool.query(`SELECT id FROM projects WHERE status = 'active' ORDER BY id`)).rows.map((r) => r.id as string);
    return this.preview(ids, async ({ org, proj, projectId }) => ({ org, proj, holidays: await this.holidaysAfter(projectId, add, removeId) }));
  }

  async previewProjectHoliday(user: AuthUser, projectId: string, b: Record<string, unknown>): Promise<Preview> {
    const ctx = await this.access.context(user, projectId);
    if (!this.canEditRole(ctx)) throw new ForbiddenException(NOT_EDITOR);
    const { add, removeId } = this.holidayProposal(b);
    if (ctx.project.status !== 'active') return { moved: [], added: [], removed: [] };
    return this.preview([projectId], async ({ org, proj }) => ({ org, proj, holidays: await this.holidaysAfter(projectId, add, removeId) }));
  }
}
