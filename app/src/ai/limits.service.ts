import { BadRequestException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { writeAudit } from '../audit/audit';
import { CLOCK, type AuthUser, type Clock } from '../auth/tokens';
import { readReason } from '../common/reason';
import { uuidv7 } from '../common/uuid7';
import { PG_POOL } from '../db/database.module';
import { ProjectAccess } from '../projects/access.service';
import { PROJECT_MATRIX, decide } from '../projects/matrix';
import { formatMicro } from '../spend/money';
import { type DailyRule, POLICY_BOUNDS, type ProjectCeiling, type UserRule, boundedInt, parseLimit, parseRule, readSettings } from '../spend/spend.settings';
import { DEFAULT_POLICY, effectivePolicy } from './policy';

type Db = Pool | PoolClient;

/** One project's own limits. A project with no row has none of these set: no allowance. */
export interface ProjectLimits {
  /** null is a blank: no allowance. */
  monthlyLimitMicroMyr: bigint | null;
  daily: DailyRule;
  userMonthly: UserRule;
  /** null: the organisation's value applies. */
  maxAttempts: number | null;
  timeoutSeconds: number | null;
}

interface LimitsRow {
  monthly: string | null;
  daily_mode: 'limit' | 'not_applied';
  daily_limit: string | null;
  user_mode: 'limit' | 'not_applied';
  user_limit: string | null;
  max_attempts: number | null;
  timeout_seconds: number | null;
}

const COLUMNS = `monthly_limit_micro_myr::text AS monthly, daily_mode, daily_limit_micro_myr::text AS daily_limit,
  user_monthly_mode AS user_mode, user_monthly_limit_micro_myr::text AS user_limit, max_attempts, timeout_seconds`;

const rule = (mode: 'limit' | 'not_applied', limit: string | null): DailyRule =>
  mode === 'not_applied' ? { mode: 'not_applied' } : { mode: 'limit', limitMicroMyr: limit === null ? null : BigInt(limit) };

/** Importable without Nest. Null when the project has never had limits saved (so it has no allowance). */
export async function readProjectLimits(db: Db, projectId: string, lock = false): Promise<ProjectLimits | null> {
  const { rows } = await db.query<LimitsRow>(`SELECT ${COLUMNS} FROM project_ai_limits WHERE project_id = $1${lock ? ' FOR UPDATE' : ''}`, [projectId]);
  const r = rows[0];
  if (!r) return null;
  return {
    monthlyLimitMicroMyr: r.monthly === null ? null : BigInt(r.monthly),
    daily: rule(r.daily_mode, r.daily_limit),
    userMonthly: rule(r.user_mode, r.user_limit),
    maxAttempts: r.max_attempts,
    timeoutSeconds: r.timeout_seconds,
  };
}

const NONE: ProjectLimits = { monthlyLimitMicroMyr: null, daily: { mode: 'not_applied' }, userMonthly: { mode: 'not_applied' }, maxAttempts: null, timeoutSeconds: null };

const ruleText = (r: DailyRule) =>
  r.mode === 'not_applied' ? { mode: 'not_applied' as const } : { mode: 'limit' as const, limitMyr: r.limitMicroMyr === null ? null : formatMicro(r.limitMicroMyr) };

/** Limits as plain text for the API and the event trail. */
export function describeLimits(l: ProjectLimits) {
  return {
    monthlyLimitMyr: l.monthlyLimitMicroMyr === null ? null : formatMicro(l.monthlyLimitMicroMyr),
    daily: ruleText(l.daily),
    userMonthly: ruleText(l.userMonthly),
    maxAttempts: l.maxAttempts,
    timeoutSeconds: l.timeoutSeconds,
  };
}

const sameRule = (a: DailyRule, b: DailyRule) => a.mode === b.mode && (a.mode === 'not_applied' || (b.mode === 'limit' && a.limitMicroMyr === b.limitMicroMyr));
const same = (a: ProjectLimits, b: ProjectLimits) =>
  a.monthlyLimitMicroMyr === b.monthlyLimitMicroMyr &&
  sameRule(a.daily, b.daily) &&
  sameRule(a.userMonthly, b.userMonthly) &&
  a.maxAttempts === b.maxAttempts &&
  a.timeoutSeconds === b.timeoutSeconds;

/** { monthlyLimitMyr, daily, userMonthly?, maxAttempts, timeoutSeconds, reason }. Every field but userMonthly must be given (null is a blank). */
export function parseLimitsBody(body: unknown): { limits: ProjectLimits; reason: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException('A limits object is required');
  const b = body as Record<string, unknown>;
  const has = (k: string) => Object.prototype.hasOwnProperty.call(b, k);
  if (!has('monthlyLimitMyr')) throw new BadRequestException('monthlyLimitMyr is required (send null for no allowance)');
  if (!b.daily) throw new BadRequestException('daily is required: { "mode": "not_applied" } or { "mode": "limit", "limitMyr": ... }');
  const optional = (field: 'maxAttempts' | 'timeoutSeconds', bounds: readonly [number, number]): number | null => {
    if (!has(field)) throw new BadRequestException(`${field} is required (send null to use the organisation's value)`);
    return b[field] === null ? null : boundedInt(b[field], field, bounds);
  };
  const reason = readReason(b.reason, 'a reason for the change');
  return {
    reason,
    limits: {
      monthlyLimitMicroMyr: parseLimit(b.monthlyLimitMyr, 'monthlyLimitMyr'),
      daily: parseRule(b.daily, 'daily'),
      userMonthly: has('userMonthly') ? parseRule(b.userMonthly, 'userMonthly') : { mode: 'not_applied' },
      maxAttempts: optional('maxAttempts', POLICY_BOUNDS.maxAttempts),
      timeoutSeconds: optional('timeoutSeconds', POLICY_BOUNDS.timeoutSeconds),
    },
  };
}

const NOT_DELEGATED = 'The Administrator has not allowed projects to set their own AI limits.';
const LIMITS_ACTION = 'ai.limits.manage';

export const ceilingMessage = (c: Extract<ProjectCeiling, { mode: 'limit' }>) =>
  `The Administrator's ceiling for a project's monthly AI limit is MYR ${formatMicro(c.limitMicroMyr)}.`;

@Injectable()
export class LimitsService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly access: ProjectAccess,
  ) {}

  /**
   * Anyone who sees the project's AI connections (Project Manager, Deputy, Owner, Sponsor) and the Enterprise Administrator
   * may read the limits. Anyone else with access to the project gets 403; a non-participant gets 404.
   */
  async get(projectId: string, user: AuthUser) {
    const ctx =
      user.role === 'enterprise_administrator'
        ? await this.access.context(user, projectId)
        : await this.access.authorize(user, 'ai.connections.view', projectId);
    const settings = await readSettings(this.pool);
    const own = await readProjectLimits(this.pool, projectId);
    const policy = await effectivePolicy(this.pool, projectId);
    const delegated = settings?.projectsMaySetLimits ?? false;
    const decided = decide({ action: LIMITS_ACTION, roles: ctx.roles, status: ctx.project.status });
    const stateOk = PROJECT_MATRIX[LIMITS_ACTION].states.includes(ctx.project.status);
    const ceiling: ProjectCeiling = settings?.projectCeiling ?? { mode: 'not_applied' };
    return {
      project: { saved: own !== null, ...describeLimits(own ?? NONE) },
      organisation: {
        maxAttempts: settings?.maxAttempts ?? DEFAULT_POLICY.maxAttempts,
        timeoutSeconds: settings?.timeoutSeconds ?? DEFAULT_POLICY.timeoutSeconds,
        concurrency: settings?.concurrency ?? DEFAULT_POLICY.concurrency,
        projectsMaySetLimits: delegated,
        projectsMayManageConnections: settings?.projectsMayManageConnections ?? false,
      },
      ceiling: ceiling.mode === 'not_applied' ? { mode: 'not_applied' as const } : { mode: 'limit' as const, limitMyr: formatMicro(ceiling.limitMicroMyr) },
      // Whether this person may save changes now: the Administrator always (in an open project); a delegate only while delegation is on.
      editable: stateOk && (ctx.isAdmin || (decided.allowed && delegated)),
      sources: policy.source,
    };
  }

  /** Saves the project's limits (a full replacement) and records who changed what and why. */
  async set(projectId: string, limits: ProjectLimits, reason: string, user: AuthUser): Promise<void> {
    await this.access.context(user, projectId); // a non-participant gets 404 first
    const at = this.clock();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const ctx = await this.access.context(user, projectId, client, true);
      const row = PROJECT_MATRIX[LIMITS_ACTION];
      if (!row.states.includes(ctx.project.status)) throw new ForbiddenException(row.refusal);
      const settings = await readSettings(client);
      const previous = await readProjectLimits(client, projectId, true);
      if (!ctx.isAdmin) {
        const verdict = decide({ action: LIMITS_ACTION, roles: ctx.roles, status: ctx.project.status });
        if (!verdict.allowed) throw new ForbiddenException(verdict.reason);
        if (!settings?.projectsMaySetLimits) throw new ForbiddenException(NOT_DELEGATED);
        // A delegate stays within the organisation's numbers and the ceiling. A value already saved above a number the Administrator
        // has since lowered stays in force (spec 7.1), but cannot be changed to anything else that is above it.
        const ceiling = settings.projectCeiling;
        const next = limits.monthlyLimitMicroMyr;
        if (ceiling.mode === 'limit' && next !== null && next > ceiling.limitMicroMyr && next !== (previous?.monthlyLimitMicroMyr ?? null)) {
          throw new ForbiddenException(ceilingMessage(ceiling));
        }
        if (limits.maxAttempts !== null && limits.maxAttempts > settings.maxAttempts && limits.maxAttempts !== previous?.maxAttempts) {
          throw new ForbiddenException(`A project cannot allow more attempts than the organisation's ${settings.maxAttempts}.`);
        }
        if (limits.timeoutSeconds !== null && limits.timeoutSeconds > settings.timeoutSeconds && limits.timeoutSeconds !== previous?.timeoutSeconds) {
          throw new ForbiddenException(`A project cannot allow a longer wait than the organisation's ${settings.timeoutSeconds} seconds.`);
        }
      }
      if (previous && same(previous, limits)) {
        await client.query('COMMIT');
        return;
      }
      await client.query(
        `INSERT INTO project_ai_limits
           (project_id, monthly_limit_micro_myr, daily_mode, daily_limit_micro_myr, user_monthly_mode, user_monthly_limit_micro_myr,
            max_attempts, timeout_seconds, updated_at, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (project_id) DO UPDATE SET
           monthly_limit_micro_myr = EXCLUDED.monthly_limit_micro_myr, daily_mode = EXCLUDED.daily_mode,
           daily_limit_micro_myr = EXCLUDED.daily_limit_micro_myr, user_monthly_mode = EXCLUDED.user_monthly_mode,
           user_monthly_limit_micro_myr = EXCLUDED.user_monthly_limit_micro_myr, max_attempts = EXCLUDED.max_attempts,
           timeout_seconds = EXCLUDED.timeout_seconds, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by`,
        [
          projectId,
          limits.monthlyLimitMicroMyr === null ? null : limits.monthlyLimitMicroMyr.toString(),
          limits.daily.mode,
          limits.daily.mode === 'limit' && limits.daily.limitMicroMyr !== null ? limits.daily.limitMicroMyr.toString() : null,
          limits.userMonthly.mode,
          limits.userMonthly.mode === 'limit' && limits.userMonthly.limitMicroMyr !== null ? limits.userMonthly.limitMicroMyr.toString() : null,
          limits.maxAttempts,
          limits.timeoutSeconds,
          at,
          user.id,
        ],
      );
      const detail = { previous: previous ? describeLimits(previous) : null, new: describeLimits(limits) };
      await client.query(`INSERT INTO project_ai_limit_events (id, project_id, actor_id, reason, detail, at) VALUES ($1, $2, $3, $4, $5, $6)`, [
        uuidv7(at.getTime()),
        projectId,
        user.id,
        reason,
        JSON.stringify(detail),
        at,
      ]);
      await writeAudit(client, { at, action: 'ai.project_limits_changed', actorUserId: user.id, subjectType: 'project', subjectId: projectId, detail });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}
