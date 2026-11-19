import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { CLOCK, type AuthUser, type Clock } from '../auth/tokens';
import { PG_POOL } from '../db/database.module';
import { liveRecordSql } from '../history/deleted-sql';
import { ProjectAccess } from '../projects/access.service';
import { POSSIBLE_COPY_TEXT, UNDER_REVIEW_TEXT, possibleCopySql } from '../quarantine/labels';
import { COVERAGE_NOTE, type ProjectMeasures, loadProjectMeasures } from './measures';

/** Roles that see who has been invited (the others see the count). */
const NAME_ROLES = ['pm', 'deputy_pm', 'owner', 'sponsor'];

/** The text a dashboard shows for a record: a cleaned held record shows the existing label, never its text. */
export const shown = (alias: string, kind: 'decision' | 'question' | 'risk' | 'task', column: string): string =>
  `CASE WHEN ${alias}.held_case_id IS NOT NULL THEN '${UNDER_REVIEW_TEXT}'
        WHEN ${possibleCopySql(kind, `${alias}.id`)} THEN '${POSSIBLE_COPY_TEXT}'
        ELSE ${alias}.${column} END`;

export interface ProjectDashboard {
  measures: ProjectMeasures;
  invitations: { count: number; names?: string[] };
  decisions: { active: number; recent: { id: string; title: string; at: string }[] };
  questions: { oldestOpen: { id: string; text: string; at: string }[] };
  risks: { significant: { id: string; description: string; severity: string; reviewOn: string | null }[] };
  computedAt: string;
  coverage: string;
}

/** `GET /projects/:id/dashboard` (spec 5.1): the shared measures plus the short lists, for anyone with project.view. */
@Injectable()
export class ProjectDashboardService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly access: ProjectAccess,
  ) {}

  async get(user: AuthUser, projectId: string): Promise<ProjectDashboard> {
    const ctx = await this.access.authorize(user, 'project.view', projectId);
    const now = this.clock();
    const measures = (await loadProjectMeasures(this.pool, [projectId], ctx.today, now)).get(projectId) as ProjectMeasures;

    const decisions = (
      await this.pool.query(
        `SELECT d.id, ${shown('d', 'decision', 'statement')} AS title, d.authorised_at AS at
           FROM decisions d WHERE d.project_id = $1 AND d.status = 'active' AND ${liveRecordSql('d')}
          ORDER BY d.authorised_at DESC, d.id DESC LIMIT 5`,
        [projectId],
      )
    ).rows;
    const activeDecisions = Number(
      (await this.pool.query(`SELECT count(*) AS n FROM decisions d WHERE d.project_id = $1 AND d.status = 'active' AND ${liveRecordSql('d')}`, [projectId])).rows[0].n,
    );
    const questions = (
      await this.pool.query(
        `SELECT q.id, ${shown('q', 'question', 'text')} AS text, q.authorised_at AS at
           FROM questions q WHERE q.project_id = $1 AND q.status = 'open' AND ${liveRecordSql('q')}
          ORDER BY q.authorised_at, q.id LIMIT 5`,
        [projectId],
      )
    ).rows;
    const risks = (
      await this.pool.query(
        `SELECT r.id, ${shown('r', 'risk', 'description')} AS description, r.severity,
                to_char(r.review_on, 'YYYY-MM-DD') AS "reviewOn"
           FROM risks r
          WHERE r.project_id = $1 AND r.status IN ('open', 'mitigating') AND r.severity IN ('high', 'critical') AND ${liveRecordSql('r')}
          ORDER BY CASE r.severity WHEN 'critical' THEN 0 ELSE 1 END, r.review_on NULLS LAST, r.id`,
        [projectId],
      )
    ).rows;

    const invitations: ProjectDashboard['invitations'] = { count: measures.pendingInvitations };
    if (ctx.roles.some((r) => NAME_ROLES.includes(r))) {
      const names = (
        await this.pool.query(
          `SELECT coalesce(nullif(btrim(display_name), ''), email) AS name FROM invitations
            WHERE project_id = $1 AND status = 'invited' AND expires_at > $2 ORDER BY issued_at, id`,
          [projectId, now],
        )
      ).rows;
      invitations.names = names.map((r) => r.name);
    }

    return {
      measures,
      invitations,
      decisions: { active: activeDecisions, recent: decisions.map((d) => ({ id: d.id, title: d.title, at: new Date(d.at).toISOString() })) },
      questions: { oldestOpen: questions.map((q) => ({ id: q.id, text: q.text, at: new Date(q.at).toISOString() })) },
      risks: { significant: risks },
      computedAt: now.toISOString(),
      coverage: COVERAGE_NOTE,
    };
  }
}
