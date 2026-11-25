import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { CLOCK, type AuthUser, type Clock } from '../auth/tokens';
import { PG_POOL } from '../db/database.module';
import { liveRecordSql } from '../history/deleted-sql';
import { ProjectAccess } from '../projects/access.service';
import type { ProjectStatus } from '../projects/matrix';
import { clipPeriods } from '../projects/stage-periods';
import { shown } from './project-dashboard.service';
import { type TimelineLine, daysBetween, groupByMonth, timelineRange } from './timeline';

export interface ProjectTimeline {
  range: { from: string; to: string };
  today: string;
  months: { month: string; lines: TimelineLine[] }[];
  /** Every stage period overlapping the window (D132), including one that began before it and is still open. */
  stagePeriods: StagePeriod[];
  computedAt: string;
}

export interface StagePeriod {
  stage: string;
  substage: string | null;
  startedOn: string;
  endedOn: string | null;
  /** What stopped it, when the project was deferred or closed while it ran (D138); `endedOn` is then that day. */
  stopped: 'deferred' | 'closed' | null;
}

const UTC8 = `'Asia/Kuala_Lumpur'`;
const dayOf = (column: string): string => `to_char(${column} AT TIME ZONE ${UTC8}, 'YYYY-MM-DD')`;
const STOPPED_LABEL = { deferred: 'stopped when deferred', closed: 'stopped when closed' } as const;
const STATUS_LABEL: Record<string, string> = { draft: 'Draft', planned: 'Planned', active: 'Active', deferred: 'Deferred', closed: 'Closed' };
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** The wording of a status change: leaving Deferred is "Resumed", leaving Closed is "Reopened". */
export function transitionLabel(from: string, to: string): string {
  if (from === 'closed') return 'Reopened';
  if (from === 'deferred' && to === 'active') return 'Resumed';
  return STATUS_LABEL[to] ?? to;
}

/** `GET /projects/:id/timeline` (spec 5.2): recorded dates only, for anyone with project.view. */
@Injectable()
export class TimelineService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly access: ProjectAccess,
  ) {}

  async get(user: AuthUser, projectId: string, query: { from?: string; to?: string }): Promise<ProjectTimeline> {
    const ctx = await this.access.authorize(user, 'project.view', projectId);
    const range = timelineRange(query, ctx.today);
    if ('error' in range) throw new BadRequestException(range.error);
    const { from, to } = range;
    const lines: TimelineLine[] = [];
    const stagePeriods: StagePeriod[] = [];

    const stages = (
      await this.pool.query<{ stage: string; substage: string | null; startedAt: Date; endedAt: Date | null; startedOn: string }>(
        `SELECT stage, substage, started_at AS "startedAt", ended_at AS "endedAt", ${dayOf('started_at')} AS "startedOn"
           FROM project_stage_periods WHERE project_id = $1 ORDER BY started_at, id`,
        [projectId],
      )
    ).rows;
    const transitions = (
      await this.pool.query<{ from_status: ProjectStatus; to: ProjectStatus; at: Date; day: string }>(
        `SELECT from_status, to_status AS "to", at, ${dayOf('at')} AS day FROM project_transitions WHERE project_id = $1 ORDER BY at, id`,
        [projectId],
      )
    ).rows;
    // The bars and the list read the same clipped periods, so they end a stage on the same day.
    for (const s of clipPeriods(stages, transitions)) {
      const base: StagePeriod = { stage: s.stage, substage: s.substage ?? null, startedOn: s.startedOn, endedOn: s.endedOn, stopped: s.stopped };
      if (base.startedOn <= to && (base.endedOn === null || base.endedOn >= from)) stagePeriods.push(base);
      lines.push({ day: s.startedOn, kind: 'stage', label: `${s.stage} started`, detail: base });
      if (s.endedOn) {
        lines.push({ day: s.endedOn, kind: 'stage', label: `${s.stage} ${s.stopped ? STOPPED_LABEL[s.stopped] : 'ended'}`, detail: { ...base, durationDays: daysBetween(s.startedOn, s.endedOn) } });
      }
    }

    for (const x of transitions) {
      lines.push({ day: x.day, kind: 'status', label: transitionLabel(x.from_status, x.to), detail: { from: x.from_status, to: x.to } });
    }

    const archives = (
      await this.pool.query(`SELECT kind, ${dayOf('at')} AS day FROM project_archive_events WHERE project_id = $1 ORDER BY at, id`, [projectId])
    ).rows;
    for (const a of archives) lines.push({ day: a.day, kind: 'archive', label: a.kind === 'archived' ? 'Archived' : 'Unarchived' });

    const planned = (await this.pool.query(`SELECT to_char(planned_end, 'YYYY-MM-DD') AS day FROM projects WHERE id = $1`, [projectId])).rows[0]?.day;
    if (planned) lines.push({ day: planned, kind: 'planned_end', label: 'Planned end' });

    // One line per due day: live tasks only; a Cancelled task is not due.
    const tasks = (
      await this.pool.query(
        `SELECT t.id, ${shown('t', 'task', 'title')} AS title, t.status, to_char(t.due_on, 'YYYY-MM-DD') AS day
           FROM tasks t
          WHERE t.project_id = $1 AND t.status <> 'cancelled' AND t.due_on BETWEEN $2::date AND $3::date AND ${liveRecordSql('t')}
          ORDER BY t.due_on, t.title, t.id`,
        [projectId, from, to],
      )
    ).rows;
    const byDay = new Map<string, typeof tasks>();
    for (const t of tasks) byDay.set(t.day, [...(byDay.get(t.day) ?? []), t]);
    for (const [day, list] of byDay) {
      lines.push({
        day,
        kind: 'tasks_due',
        label: `${plural(list.length, 'task', 'tasks')} due`,
        detail: { done: list.filter((t) => t.status === 'completed').length, tasks: list.map((t) => ({ id: t.id, title: t.title, status: t.status })) },
      });
    }

    const risks = (
      await this.pool.query(
        `SELECT r.id, ${shown('r', 'risk', 'description')} AS description, r.severity, to_char(r.review_on, 'YYYY-MM-DD') AS day
           FROM risks r
          WHERE r.project_id = $1 AND r.status IN ('open', 'mitigating', 'accepted') AND r.review_on IS NOT NULL AND ${liveRecordSql('r')}
          ORDER BY r.review_on, r.id`,
        [projectId],
      )
    ).rows;
    const riskDays = new Map<string, typeof risks>();
    for (const r of risks) riskDays.set(r.day, [...(riskDays.get(r.day) ?? []), r]);
    for (const [day, list] of riskDays) {
      lines.push({
        day,
        kind: 'risk_review',
        label: `${plural(list.length, 'risk review', 'risk reviews')} due`,
        detail: { risks: list.map((r) => ({ id: r.id, description: r.description, severity: r.severity })) },
      });
    }

    // Needed-by dates of resource lines in range; Cancelled lines are not needed.
    const needed = (
      await this.pool.query(
        `SELECT l.id, to_char(l.needed_by, 'YYYY-MM-DD') AS day, i.reference, i.name, l.description
           FROM resource_lines l LEFT JOIN resource_items i ON i.id = l.item_id
          WHERE l.project_id = $1 AND l.status <> 'cancelled' AND l.needed_by BETWEEN $2::date AND $3::date
          ORDER BY l.needed_by, coalesce(i.reference, l.description), l.created_at, l.id`,
        [projectId, from, to],
      )
    ).rows as { id: string; day: string; reference: string | null; name: string | null; description: string }[];
    for (const l of needed) {
      lines.push({ day: l.day, kind: 'resource_needed_by', label: `Needed by: ${l.reference !== null ? `${l.reference} ${l.name}` : l.description}`, detail: { lineId: l.id } });
    }

    return {
      range,
      today: ctx.today,
      months: groupByMonth(lines.filter((l) => l.day >= from && l.day <= to)),
      stagePeriods,
      computedAt: this.clock().toISOString(),
    };
  }
}
