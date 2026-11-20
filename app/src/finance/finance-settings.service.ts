import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { writeAudit } from '../audit/audit';
import { CLOCK, type AuthUser, type Clock } from '../auth/tokens';
import { readReason } from '../common/reason';
import { uuidv7 } from '../common/uuid7';
import { PG_POOL } from '../db/database.module';
import { ProjectAccess } from '../projects/access.service';
import { PROJECT_MATRIX, decide } from '../projects/matrix';
import { type ResourceSettings, loadResourceSettings } from '../resources/settings.service';
import { CURRENCIES, type Currency } from './money';
import { type ProjectFinanceSettings, effectiveThresholds, loadProjectFinanceSettings, mayReadFinance } from './readers';
import { evaluateFinanceWarnings } from './warnings';

type Db = Pool | PoolClient;

const ACTION = 'finance.settings';
const KEYS = ['tracking', 'currency', 'warnFirstPct', 'warnSecondPct', 'membersRead', 'grantsRead'] as const;
const NOT_DELEGATED = "Your organisation's Administrator manages finance settings for projects.";
const FIXED = 'The reporting currency is fixed once figures exist.';
const REASON = 'Give a reason for the change (up to 1,000 characters).';
const PREVIEW_REFUSAL = "Only the project's finance readers or the Administrator can see this.";
const CURRENCY_ORDER = Object.keys(CURRENCIES) as Currency[];
const isCurrency = (v: unknown): v is Currency => typeof v === 'string' && Object.prototype.hasOwnProperty.call(CURRENCIES, v);

/**
 * The project's settings with the given fields replaced (fields left out keep their saved value), checked against D93,
 * D94 and the organisation's enabled currencies. A currency is checked as enabled only when it changes or tracking is
 * turned on, so one saved before the Administrator disabled it stays in force.
 */
export function mergeFinanceSettings(previous: ProjectFinanceSettings, input: unknown, org: ResourceSettings): ProjectFinanceSettings {
  const src = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const v: Record<string, unknown> = { ...previous };
  for (const k of KEYS) if (src[k] !== undefined) v[k] = src[k];
  if (v.tracking !== 'not_required' && v.tracking !== 'enabled') throw new BadRequestException('Financial tracking must be Not required or Enabled.');
  if (v.currency !== null && !isCurrency(v.currency)) throw new BadRequestException(`The reporting currency must be one of ${CURRENCY_ORDER.join(', ')}.`);
  if (v.tracking === 'enabled' && v.currency === null) throw new BadRequestException('Choose a reporting currency to turn on financial tracking.');
  const enabling = v.tracking === 'enabled' && previous.tracking !== 'enabled';
  if (v.currency !== null && (v.currency !== previous.currency || enabling) && !org.enabledCurrencies.includes(v.currency as Currency)) {
    throw new BadRequestException(`The reporting currency must be one of the enabled currencies: ${org.enabledCurrencies.join(', ')}.`);
  }
  const { warnFirstPct: a, warnSecondPct: b } = v;
  const whole = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 200;
  if (!(a === null && b === null) && !(whole(a) && whole(b) && a < b)) {
    throw new BadRequestException('Warning thresholds must be whole percentages from 1 to 200, the first below the second, or both inherited.');
  }
  if (typeof v.membersRead !== 'boolean' || typeof v.grantsRead !== 'boolean') throw new BadRequestException('Who may read financial detail must be yes or no.');
  return {
    tracking: v.tracking,
    currency: v.currency as Currency | null,
    warnFirstPct: a as number | null,
    warnSecondPct: b as number | null,
    membersRead: v.membersRead,
    grantsRead: v.grantsRead,
  };
}

/**
 * Any budget version, spending entry or pending budget request fixes the reporting currency (spec 8.2). The pending
 * request counts only when `seesRequests` (a finance reader or the Administrator, who may change the currency): to
 * anyone else it would announce a finance request they may not see (spec 3.6).
 */
async function currencyFixed(db: Db, projectId: string, seesRequests = true): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT EXISTS (SELECT 1 FROM budget_versions WHERE project_id = $1)
         OR EXISTS (SELECT 1 FROM expenditures WHERE project_id = $1)
         OR ($2::boolean AND EXISTS (SELECT 1 FROM change_requests WHERE project_id = $1 AND kind = 'set_budget' AND status = 'pending')) AS fixed`,
    [projectId, seesRequests],
  );
  return rows[0].fixed as boolean;
}

@Injectable()
export class FinanceSettingsService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly now: Clock,
    private readonly access: ProjectAccess,
  ) {}

  /**
   * Participants, grant holders and the Administrator read the settings (a non-participant gets 404). `editable`: the
   * Administrator always in an open project (spec 3.7); the PM, Owner or a Sponsor only while delegation is on (D94).
   */
  async get(user: AuthUser, projectId: string) {
    const ctx = await this.access.context(user, projectId);
    const settings = await loadProjectFinanceSettings(this.pool, projectId);
    const org = await loadResourceSettings(this.pool);
    const delegated = org.projectsMayManageFinance;
    const stateOk = PROJECT_MATRIX[ACTION].states.includes(ctx.project.status);
    const allowed = decide({ action: ACTION, roles: ctx.roles, status: ctx.project.status }).allowed;
    // The change history carries free-text reasons and earlier settings: finance readers and the Administrator only.
    const seesFinance = ctx.isAdmin || mayReadFinance(ctx, settings);
    const changes = seesFinance
      ? (
          await this.pool.query(
            `SELECT h.id, h.at, h.reason, h.actor_id AS "actorId", u.display_name AS actor, h.previous, h.next
               FROM project_finance_changes h JOIN users u ON u.id = h.actor_id
              WHERE h.project_id = $1
              ORDER BY h.at DESC, h.id DESC`,
            [projectId],
          )
        ).rows
      : [];
    return {
      settings,
      effective: { thresholds: effectiveThresholds(settings, org), inherited: settings.warnFirstPct === null },
      organisation: { defaultCurrency: org.defaultCurrency, enabledCurrencies: org.enabledCurrencies, warnFirstPct: org.warnFirstPct, warnSecondPct: org.warnSecondPct },
      editable: stateOk && (ctx.isAdmin || (allowed && delegated)),
      delegated,
      currencyFixed: await currencyFixed(this.pool, projectId, seesFinance),
      changes,
    };
  }

  /** Saves the changed fields and records the previous and new settings with the reason, in one transaction. */
  async set(user: AuthUser, projectId: string, next: unknown, reasonInput: unknown): Promise<void> {
    await this.access.context(user, projectId); // a non-participant gets 404 first
    const reason = readReason(reasonInput, 'a reason', { refusal: REASON });
    const at = this.now();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const ctx = await this.access.context(user, projectId, client, true);
      const row = PROJECT_MATRIX[ACTION];
      if (!row.states.includes(ctx.project.status)) throw new ForbiddenException(row.refusal);
      const org = await loadResourceSettings(client);
      if (!ctx.isAdmin) {
        const verdict = decide({ action: ACTION, roles: ctx.roles, status: ctx.project.status });
        if (!verdict.allowed) throw new ForbiddenException(verdict.reason);
        if (!org.projectsMayManageFinance) throw new ForbiddenException(NOT_DELEGATED);
      }
      const previous = await loadProjectFinanceSettings(client, projectId, true);
      const value = mergeFinanceSettings(previous, next, org);
      if (value.currency !== previous.currency && (await currencyFixed(client, projectId))) throw new ConflictException(FIXED);
      const fields = KEYS.filter((k) => previous[k] !== value[k]);
      if (fields.length === 0) throw new BadRequestException('Nothing to change.');
      await client.query(
        `INSERT INTO project_finance_settings (project_id, tracking, currency, warn_first_pct, warn_second_pct, members_read, grants_read)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (project_id) DO UPDATE SET
           tracking = EXCLUDED.tracking, currency = EXCLUDED.currency, warn_first_pct = EXCLUDED.warn_first_pct,
           warn_second_pct = EXCLUDED.warn_second_pct, members_read = EXCLUDED.members_read, grants_read = EXCLUDED.grants_read`,
        [projectId, value.tracking, value.currency, value.warnFirstPct, value.warnSecondPct, value.membersRead, value.grantsRead],
      );
      await client.query(`INSERT INTO project_finance_changes (id, project_id, actor_id, at, reason, previous, next) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [
        uuidv7(at.getTime()), projectId, user.id, at, reason, JSON.stringify(previous), JSON.stringify(value),
      ]);
      await writeAudit(client, { at, action: 'finance.project_settings_changed', actorUserId: user.id, subjectType: 'project', subjectId: projectId, detail: { fields } });
      const enabling = value.tracking === 'enabled' && previous.tracking !== 'enabled';
      if (enabling || fields.includes('warnFirstPct') || fields.includes('warnSecondPct')) await evaluateFinanceWarnings(client, projectId, at);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** Counts only, never amounts, for the turn-off wording (spec 3.7, 8.2): to finance readers and the Administrator. */
  async preview(user: AuthUser, projectId: string): Promise<{ entries: number; budgetVersions: number; pending: number }> {
    const ctx = await this.access.context(user, projectId);
    const settings = await loadProjectFinanceSettings(this.pool, projectId);
    if (!ctx.isAdmin && !mayReadFinance(ctx, settings)) throw new ForbiddenException(PREVIEW_REFUSAL);
    const { rows } = await this.pool.query(
      `SELECT (SELECT count(*)::int FROM expenditures WHERE project_id = $1) AS entries,
              (SELECT count(*)::int FROM budget_versions WHERE project_id = $1) AS "budgetVersions",
              (SELECT count(*)::int FROM change_requests WHERE project_id = $1 AND kind IN ('set_budget', 'finance_adjustment') AND status = 'pending') AS pending`,
      [projectId],
    );
    return rows[0];
  }
}
