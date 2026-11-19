import type { Pool, PoolClient } from 'pg';
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
