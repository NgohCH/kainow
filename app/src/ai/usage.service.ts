import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { CLOCK, type AuthUser, type Clock } from '../auth/tokens';
import { PG_POOL } from '../db/database.module';
import { ProjectAccess } from '../projects/access.service';
import { formatMicro } from '../spend/money';
import { type Period, dayPeriod, monthPeriod } from '../spend/periods';
import { type PeriodSummary, SpendService } from '../spend/spend.service';
import { NOTE_BAD_RESPONSE, NOTE_RATE_LIMITED } from './chooser';

/*
 * What a usage view may contain: names, labels, purposes and amounts. Never a prompt, question, title, answer text or key.
 * Every amount object carries confirmedMyr, uncertainMyr and reservedMyr apart; usedMyr is their sum (what counts against limits).
 */

/** An attempt is a row that was sent: a reservation released as "never sent" never reached a provider. */
const SENT = `NOT (e.status = 'released' AND e.note = 'never sent')`;
/** Failed: the outcome is unknown, the provider asked to slow down or answered badly, or the provider showed it did not charge. */
const FAILED = `(e.status = 'uncertain' OR e.note IN ('${NOTE_RATE_LIMITED}', '${NOTE_BAD_RESPONSE}') OR (e.status = 'released' AND e.note IS DISTINCT FROM 'never sent'))`;

/** The amount and count columns every grouping shares. */
const FIGURES = `
  COALESCE(SUM(e.amount_micro_myr) FILTER (WHERE e.status = 'confirmed'), 0)::text AS confirmed,
  COALESCE(SUM(e.amount_micro_myr) FILTER (WHERE e.status = 'uncertain'), 0)::text AS uncertain,
  COALESCE(SUM(e.amount_micro_myr) FILTER (WHERE e.status = 'reserved'), 0)::text AS reserved,
  COUNT(DISTINCT e.request_id) FILTER (WHERE ${SENT})::int AS requests,
  COUNT(*) FILTER (WHERE ${SENT})::int AS attempts`;

interface FigureRow {
  confirmed: string;
  uncertain: string;
  reserved: string;
  requests: number;
  attempts: number;
}

const ZERO: FigureRow = { confirmed: '0', uncertain: '0', reserved: '0', requests: 0, attempts: 0 };

const figures = (r: FigureRow = ZERO) => ({
  confirmedMyr: formatMicro(BigInt(r.confirmed)),
  uncertainMyr: formatMicro(BigInt(r.uncertain)),
  reservedMyr: formatMicro(BigInt(r.reserved)),
  usedMyr: formatMicro(BigInt(r.confirmed) + BigInt(r.uncertain) + BigInt(r.reserved)),
  requests: r.requests,
  attempts: r.attempts,
});

const period = (p: Period) => ({ start: p.start.toISOString(), end: p.end.toISOString() });

/** The limit and what is left, as reserve() sees them (from SpendService.summary). Null limit: no allowance (or none applied). */
const limitView = (s: PeriodSummary | null) =>
  s ? { limitMyr: s.limitMicroMyr === null ? null : formatMicro(s.limitMicroMyr), remainingMyr: formatMicro(s.remainingMicroMyr) } : { limitMyr: null, remainingMyr: null };

@Injectable()
export class UsageService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly access: ProjectAccess,
    private readonly spend: SpendService,
  ) {}

  private async total(p: Period, where = 'TRUE', args: unknown[] = []): Promise<FigureRow> {
    const { rows } = await this.pool.query<FigureRow>(
      `SELECT ${FIGURES} FROM ai_spend_entries e WHERE e.created_at >= $1 AND e.created_at < $2 AND ${where}`,
      [p.start, p.end, ...args],
    );
    return rows[0] ?? ZERO;
  }

  /** One person's own usage this month, by project, with the personal allowance left at each level that applies. */
  async mine(user: AuthUser) {
    const month = monthPeriod(this.clock());
    const { rows } = await this.pool.query<FigureRow & { project_id: string; name: string }>(
      `SELECT e.project_id, p.name, ${FIGURES}
         FROM ai_spend_entries e JOIN projects p ON p.id = e.project_id
        WHERE e.actor_user_id = $1 AND e.ruled AND e.created_at >= $2 AND e.created_at < $3
        GROUP BY e.project_id, p.name ORDER BY p.name, e.project_id`,
      [user.id, month.start, month.end],
    );
    const projects = [];
    for (const r of rows) {
      const s = await this.spend.summary(user.id, r.project_id);
      const remaining: { organisationPersonal?: string; projectPersonal?: string } = {};
      if (s.mine) remaining.organisationPersonal = formatMicro(s.mine.remainingMicroMyr);
      if (s.projectMine) remaining.projectPersonal = formatMicro(s.projectMine.remainingMicroMyr);
      projects.push({ projectId: r.project_id, name: r.name, month: period(month), ...figures(r), remaining });
    }
    return { projects };
  }

  /** Project Manager, Owner or Sponsor (matrix action ai.usage.view). Anyone else: 403 for a participant, 404 for an outsider. */
  async project(projectId: string, user: AuthUser) {
    await this.access.authorize(user, 'ai.usage.view', projectId);
    const now = this.clock();
    const month = monthPeriod(now);
    const day = dayPeriod(now);
    const summary = await this.spend.summary(undefined, projectId);

    const byPerson = await this.pool.query<FigureRow & { user_id: string; name: string }>(
      `SELECT e.actor_user_id AS user_id, u.display_name AS name, ${FIGURES}
         FROM ai_spend_entries e JOIN users u ON u.id = e.actor_user_id
        WHERE e.project_id = $1 AND e.created_at >= $2 AND e.created_at < $3
        GROUP BY e.actor_user_id, u.display_name ORDER BY u.display_name, e.actor_user_id`,
      [projectId, month.start, month.end],
    );
    const system = await this.pool.query<FigureRow & { purpose: string }>(
      `SELECT e.purpose, ${FIGURES}
         FROM ai_spend_entries e
        WHERE e.project_id = $1 AND e.actor_user_id IS NULL AND e.created_at >= $2 AND e.created_at < $3
        GROUP BY e.purpose ORDER BY e.purpose`,
      [projectId, month.start, month.end],
    );
    return {
      day: { period: period(day), ...figures(await this.total(day, 'e.project_id = $3', [projectId])), ...limitView(summary.projectDaily), dailyLimitApplies: summary.projectDaily !== null },
      month: { period: period(month), ...figures(await this.total(month, 'e.project_id = $3', [projectId])), ...limitView(summary.project) },
      byPerson: byPerson.rows.map((r) => ({ userId: r.user_id, name: r.name, ...figures(r) })),
      system: system.rows.map((r) => ({ purpose: r.purpose, ...figures(r) })),
      byConnection: await this.byConnection(month, projectId),
    };
  }

  /** The Enterprise Administrator: organisation totals against the organisation limits, by project, by person, and entries from before projects. */
  async organisation() {
    const now = this.clock();
    const month = monthPeriod(now);
    const day = dayPeriod(now);
    const summary = await this.spend.summary();
    const byProject = await this.pool.query<FigureRow & { project_id: string; name: string }>(
      `SELECT e.project_id, p.name, ${FIGURES}
         FROM ai_spend_entries e JOIN projects p ON p.id = e.project_id
        WHERE e.ruled AND e.created_at >= $1 AND e.created_at < $2
        GROUP BY e.project_id, p.name ORDER BY p.name, e.project_id`,
      [month.start, month.end],
    );
    const byPerson = await this.pool.query<FigureRow & { user_id: string; name: string }>(
      `SELECT e.actor_user_id AS user_id, u.display_name AS name, ${FIGURES}
         FROM ai_spend_entries e JOIN users u ON u.id = e.actor_user_id
        WHERE e.created_at >= $1 AND e.created_at < $2
        GROUP BY e.actor_user_id, u.display_name ORDER BY u.display_name, e.actor_user_id`,
      [month.start, month.end],
    );
    return {
      configured: summary.configured,
      month: { period: period(month), ...figures(await this.total(month)), ...limitView(summary.monthly) },
      day: { period: period(day), ...figures(await this.total(day)), ...limitView(summary.daily), dailyLimitApplies: summary.daily !== null },
      byProject: byProject.rows.map((r) => ({ projectId: r.project_id, name: r.name, ...figures(r) })),
      byPerson: byPerson.rows.map((r) => ({ userId: r.user_id, name: r.name, ...figures(r) })),
      byConnection: await this.byConnection(month),
      // Entries from before projects: inside the organisation totals above, in no project's figures.
      beforeProjects: figures(await this.total(month, 'NOT e.ruled')),
    };
  }

  /**
   * Attempts by connection: failures (see FAILED), fallbacks (an attempt after the first of its request, on a connection other
   * than the first attempt's) and charged failures (failures that still cost something: uncertain or a bad response).
   */
  private async byConnection(month: Period, projectId?: string) {
    const { rows } = await this.pool.query<
      FigureRow & { connection_id: string; label: string; project_id: string; project_name: string; provider: string; model_id: string; failures: number; fallbacks: number; charged: number }
    >(
      `SELECT e.connection_id, c.label, c.project_id, p.name AS project_name, e.provider, e.model_id, ${FIGURES},
              COUNT(*) FILTER (WHERE ${SENT} AND ${FAILED})::int AS failures,
              COUNT(*) FILTER (WHERE ${SENT} AND e.attempt_no > 1 AND f.connection_id IS NOT NULL AND e.connection_id IS DISTINCT FROM f.connection_id)::int AS fallbacks,
              COUNT(*) FILTER (WHERE ${SENT} AND ${FAILED} AND e.amount_micro_myr > 0)::int AS charged
         FROM ai_spend_entries e
         JOIN ai_connections c ON c.id = e.connection_id
         JOIN projects p ON p.id = c.project_id
         LEFT JOIN ai_spend_entries f ON f.request_id = e.request_id AND f.attempt_no = 1
        WHERE e.created_at >= $1 AND e.created_at < $2 AND ($3::uuid IS NULL OR e.project_id = $3::uuid)
        GROUP BY e.connection_id, c.label, c.project_id, p.name, e.provider, e.model_id
        ORDER BY p.name, c.label, e.connection_id`,
      [month.start, month.end, projectId ?? null],
    );
    return rows.map((r) => ({
      connectionId: r.connection_id,
      label: r.label,
      ...(projectId ? {} : { projectId: r.project_id, projectName: r.project_name }),
      provider: r.provider,
      modelId: r.model_id,
      failures: r.failures,
      fallbacks: r.fallbacks,
      chargedFailures: r.charged,
      ...figures(r),
    }));
  }
}
