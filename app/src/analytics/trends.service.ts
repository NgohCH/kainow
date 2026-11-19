import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { CLOCK, type Clock } from '../auth/tokens';
import { PG_POOL } from '../db/database.module';
import { liveRecordSql } from '../history/deleted-sql';
import { todayUtc8 } from '../projects/membership';
import { type AnalyticsFilters, STATUSES, addDays, weekStarts } from './filters';
import { selectProjects } from './scope';

export const TRENDS_NOTE = 'Trends are worked out from current records: changed due dates use the current date, and deleted records are left out of past weeks.';
export const TREND_KEYS = [
  'tasks_authorised', 'tasks_completed', 'tasks_became_overdue', 'proposals_authorised', 'proposals_rejected', 'projects_active', 'projects_deferred', 'projects_closed',
] as const;
export type TrendKey = (typeof TREND_KEYS)[number];

export interface TrendsPanel {
  weeks: string[];
  series: Record<TrendKey, number[]>;
  note: string;
  computedAt: string;
}

const TZ = 'Asia/Kuala_Lumpur';

/** Dashboards spec 7.2 item 4: weekly counts (Monday 00:00 UTC+8) worked out from current records, for the projects the filters select. */
@Injectable()
export class TrendsService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async weekly(f: AnalyticsFilters): Promise<TrendsPanel> {
    const now = this.clock();
    const today = todayUtc8(now);
    const weeks = weekStarts(f.from, f.to);
    // Trends are history: the status and archived filters describe current state, so they do not apply. Department and ownership do.
    const ids = (await selectProjects(this.pool, { ...f, statuses: [...STATUSES], includeArchived: true }, today)).map((p) => p.id);
    const series = Object.fromEntries(TREND_KEYS.map((k) => [k, weeks.map(() => 0)])) as Record<TrendKey, number[]>;
    if (weeks.length === 0 || ids.length === 0) return { weeks, series, note: TRENDS_NOTE, computedAt: now.toISOString() };
    const from = new Date(`${weeks[0]}T00:00:00+08:00`);
    const to = new Date(`${addDays(weeks[weeks.length - 1], 7)}T00:00:00+08:00`);
    const idx = new Map(weeks.map((w, i) => [w, i]));
    // Week start (a UTC+8 Monday) of a timestamp, as 'YYYY-MM-DD'.
    const wk = (col: string) => `to_char(date_trunc('week', ${col} AT TIME ZONE '${TZ}'), 'YYYY-MM-DD')`;
    const fill = async (key: TrendKey, sql: string, params: unknown[]) => {
      for (const r of (await this.pool.query(sql, params)).rows) {
        const i = idx.get(r.week as string);
        if (i !== undefined) series[key][i] += r.n as number;
      }
    };
    const base = [ids, from, to];
    await fill('tasks_authorised', `SELECT ${wk('t.authorised_at')} AS week, count(*)::int AS n FROM tasks t WHERE t.project_id = ANY($1::uuid[]) AND ${liveRecordSql('t')} AND t.authorised_at >= $2 AND t.authorised_at < $3 GROUP BY 1`, base);
    await fill('tasks_completed', `SELECT ${wk('t.completed_at')} AS week, count(*)::int AS n FROM tasks t WHERE t.project_id = ANY($1::uuid[]) AND ${liveRecordSql('t')} AND t.completed_at >= $2 AND t.completed_at < $3 GROUP BY 1`, base);
    // Became overdue: the day after due_on, if the task was not completed or cancelled before that day began, and that day has come.
    const dayAfter = `((t.due_on + 1)::timestamp AT TIME ZONE '${TZ}')`;
    await fill(
      'tasks_became_overdue',
      `SELECT to_char(date_trunc('week', t.due_on + 1), 'YYYY-MM-DD') AS week, count(*)::int AS n
         FROM tasks t
        WHERE t.project_id = ANY($1::uuid[]) AND ${liveRecordSql('t')}
          AND (t.due_on + 1) <= $4::date
          AND ${dayAfter} >= $2 AND ${dayAfter} < $3
          AND NOT (t.completed_at IS NOT NULL AND t.completed_at < ${dayAfter})
          AND NOT EXISTS (SELECT 1 FROM task_events e WHERE e.task_id = t.id AND e.kind = 'cancelled' AND e.at < ${dayAfter})
        GROUP BY 1`,
      [...base, today],
    );
    // A proposal is authorised when a record is made from it: one row per record that has an origin.
    const authorisedAt = ['tasks', 'decisions', 'questions', 'risks']
      .map((tbl) => `SELECT x.authorised_at AS at FROM ${tbl} x WHERE x.project_id = ANY($1::uuid[]) AND ${liveRecordSql('x')} AND (x.origin_item_id IS NOT NULL OR x.origin_proposal_id IS NOT NULL)`)
      .join(' UNION ALL ');
    await fill('proposals_authorised', `SELECT ${wk('a.at')} AS week, count(*)::int AS n FROM (${authorisedAt}) a WHERE a.at >= $2 AND a.at < $3 GROUP BY 1`, base);
    const rejectedAt = `SELECT h.reviewed_at AS at FROM human_proposals h WHERE h.project_id = ANY($1::uuid[]) AND h.review_status = 'rejected' AND h.held_case_id IS NULL
       UNION ALL
       SELECT x.reviewed_at FROM extraction_items x JOIN source_versions sv ON sv.id = x.source_version_id JOIN sources s ON s.id = sv.source_id
        WHERE s.project_id = ANY($1::uuid[]) AND x.review_status = 'rejected' AND x.held_case_id IS NULL AND s.status <> 'deleted' AND s.held_case_id IS NULL`;
    await fill('proposals_rejected', `SELECT ${wk('r.at')} AS week, count(*)::int AS n FROM (${rejectedAt}) r WHERE r.at >= $2 AND r.at < $3 GROUP BY 1`, base);
    for (const [key, status] of [['projects_active', 'active'], ['projects_deferred', 'deferred'], ['projects_closed', 'closed']] as const) {
      await fill(key, `SELECT ${wk('pt.at')} AS week, count(*)::int AS n FROM project_transitions pt WHERE pt.project_id = ANY($1::uuid[]) AND pt.to_status = '${status}' AND pt.at >= $2 AND pt.at < $3 GROUP BY 1`, base);
    }
    return { weeks, series, note: TRENDS_NOTE, computedAt: now.toISOString() };
  }
}
