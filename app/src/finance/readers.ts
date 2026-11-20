import type { Pool, PoolClient } from 'pg';
import { grantGivesAccessSql, holdsActiveRoleSql } from '../projects/access-sql';
import type { ProjectContext } from '../projects/access.service';
import type { Currency } from './money';

/** A project's financial tracking settings (D94). Null thresholds inherit the organisation's (D93). */
export type ProjectFinanceSettings = {
  tracking: 'not_required' | 'enabled';
  currency: Currency | null;
  warnFirstPct: number | null;
  warnSecondPct: number | null;
  membersRead: boolean;
  grantsRead: boolean;
};

/** What a project with no settings row has: tracking Not Required, inherited thresholds, readers not widened. */
export const DEFAULT_FINANCE_SETTINGS: Readonly<ProjectFinanceSettings> = Object.freeze({
  tracking: 'not_required',
  currency: null,
  warnFirstPct: null,
  warnSecondPct: null,
  membersRead: false,
  grantsRead: false,
});

const ALWAYS = ['pm', 'deputy_pm', 'owner', 'sponsor'] as const;

/** The change kinds that are financial detail (spec 3.6). */
export const FINANCE_KINDS = ['set_budget', 'finance_adjustment'] as const;

/**
 * `finance.view` (spec 9): may this person read the project's financial detail? The PM, Deputies, the Owner and Sponsors
 * always; Members when the project widens reading to Members; Audit/Oversight holders when it widens reading to grant
 * holders. Administrator standing alone is not finance access (O14, spec 3.7). Checked on every finance surface.
 */
export function mayReadFinance(ctx: Pick<ProjectContext, 'roles' | 'grantKinds'>, s: ProjectFinanceSettings): boolean {
  if (ctx.roles.some((r) => (ALWAYS as readonly string[]).includes(r))) return true;
  if (s.membersRead && ctx.roles.includes('member')) return true;
  if (s.grantsRead && ctx.grantKinds.length > 0) return true;
  return false;
}

/** The project's settings, or the defaults when it has never had any saved. `lock` takes the row for the transaction. */
export async function loadProjectFinanceSettings(db: Pool | PoolClient, projectId: string, lock = false): Promise<ProjectFinanceSettings> {
  const { rows } = await db.query<ProjectFinanceSettings>(
    `SELECT tracking, currency, warn_first_pct AS "warnFirstPct", warn_second_pct AS "warnSecondPct",
            members_read AS "membersRead", grants_read AS "grantsRead"
       FROM project_finance_settings WHERE project_id = $1${lock ? ' FOR UPDATE' : ''}`,
    [projectId],
  );
  return rows[0] ? { ...rows[0] } : { ...DEFAULT_FINANCE_SETTINGS };
}

/** The warning thresholds in force: the project's own, or the organisation's when inherited (both null). */
export function effectiveThresholds(s: ProjectFinanceSettings, org: { warnFirstPct: number; warnSecondPct: number }): [number, number] {
  return s.warnFirstPct === null || s.warnSecondPct === null ? [org.warnFirstPct, org.warnSecondPct] : [s.warnFirstPct, s.warnSecondPct];
}

/**
 * SQL: the change request row `requestAlias` may be shown to the person `userParam` today (`todayParam`, UTC+8): true when
 * it is not a finance kind, or when they may read that project's financial detail. The SQL twin of `mayReadFinance`
 * over the context `ProjectAccess.load` builds (Active memberships, grants that give access, settings defaulting to
 * readers not widened). Used by every surface that lists or counts change requests (spec 3.6).
 */
export function financeRequestVisibleSql(requestAlias: string, userParam: string, todayParam: string): string {
  const r = requestAlias;
  const project = `${r}.project_id`;
  const setting = (column: string) => `COALESCE((SELECT fs.${column} FROM project_finance_settings fs WHERE fs.project_id = ${project}), false)`;
  return `(${r}.kind NOT IN (${FINANCE_KINDS.map((k) => `'${k}'`).join(', ')})
      OR ${holdsActiveRoleSql(project, userParam, todayParam, ALWAYS, 'frm')}
      OR (${setting('members_read')} AND ${holdsActiveRoleSql(project, userParam, todayParam, ['member'], 'fmm')})
      OR (${setting('grants_read')} AND ${grantGivesAccessSql(project, userParam, todayParam)}))`;
}
