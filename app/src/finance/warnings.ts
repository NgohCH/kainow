import type { PoolClient } from 'pg';
import { uuidv7 } from '../common/uuid7';
import { loadHolders } from '../notifications/recipients';
import { todayUtc8 } from '../projects/membership';
import { loadFigures } from './finance.service';
import { loadProjectFinanceSettings, mayReadFinance } from './readers';

/**
 * Decides budget-warning notices after a project-level change that can move the warning level (spec 3.6, D93): spending
 * recorded, an adjustment or budget approved, thresholds changed, tracking turned on. Runs inside the caller's
 * transaction. A notice goes out only when the level rises above the last notified level; the notified level then follows
 * the current level, so it also falls (and a later rise notifies again). One notice per evaluation, for the highest level.
 */
export async function evaluateFinanceWarnings(c: PoolClient, projectId: string, at: Date): Promise<void> {
  // Lock first, then compute, so a concurrent change committed while we waited is seen by the level we compare.
  // notified_level is not reset when tracking is turned off and on: the stale value is compared on re-enable, by design.
  await c.query(`INSERT INTO project_finance_state (project_id, notified_level) VALUES ($1, 0) ON CONFLICT (project_id) DO NOTHING`, [projectId]);
  const { rows } = await c.query<{ notified: number }>(`SELECT notified_level AS notified FROM project_finance_state WHERE project_id = $1 FOR UPDATE`, [projectId]);
  const notified = rows[0].notified;
  const figures = await loadFigures(c, projectId);
  if (figures === null) return;
  const level = figures.level;
  if (level === notified) return;
  await c.query(`UPDATE project_finance_state SET notified_level = $2 WHERE project_id = $1`, [projectId, level]);
  if (level < notified) return;

  const project = (await c.query<{ name: string }>(`SELECT name FROM projects WHERE id = $1`, [projectId])).rows[0];
  const text =
    level === 2 && figures.budget === 0n
      ? `${project.name}: recorded spending is over the approved budget (advisory).`
      : `${project.name}: recorded spending reached ${figures.warnThresholds[level - 1]}% of the approved budget (advisory).`;
  const settings = await loadProjectFinanceSettings(c, projectId);
  const recipients = (await loadHolders(c, projectId, todayUtc8(at)))
    .filter((h) => h.roles.some((r) => r === 'pm' || r === 'deputy_pm' || r === 'owner' || r === 'sponsor') && mayReadFinance({ roles: h.roles, grantKinds: [] }, settings))
    .map((h) => h.userId)
    .sort();
  for (const userId of recipients) {
    await c.query(
      `INSERT INTO notifications (id, user_id, project_id, kind, urgent, summary, link, created_at, email_off) VALUES ($1, $2, $3, 'budget_warning', false, $4, $5, $6, true)`,
      [uuidv7(at.getTime()), userId, projectId, text, `#/projects/${projectId}/resources`, at],
    );
  }
}
