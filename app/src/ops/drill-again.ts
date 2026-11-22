/**
 * Go-live step 8 and the "Drill again" rule (spec 8.1). Kept apart from the drill command so the checklist and the
 * Operations page can read it without the pg tools.
 */
import type { Pool, PoolClient } from 'pg';

type Db = Pick<Pool | PoolClient, 'query'>;

export type DrillAgainReason = 'key_changed' | 'folder_changed' | 'source_area_new';

export const DRILL_AGAIN_TEXT: Record<DrillAgainReason, string> = {
  key_changed: 'Drill again: backups now use a different backup key.',
  folder_changed: 'Drill again: backups now go to a different backup folder.',
  source_area_new: 'Drill again: the source area came into use after the last drill.',
};

/**
 * Why the last passed full drill no longer counts, or null (also null when there is no such drill: there is nothing to
 * drill "again"; step 8 is simply not done). Compared with the latest successful backup:
 *   - key_changed: its key id differs from the drilled set's;
 *   - folder_changed: its backup folder label differs from the drilled set's;
 *   - source_area_new: it includes the source area, and the drill did not check source files.
 */
export async function drillAgainReason(db: Db): Promise<DrillAgainReason | null> {
  const drill = (
    await db.query(
      `SELECT key_id, folder_label,
              checks @> '[{"name": "source_files", "result": "passed"}]'::jsonb AS covered_sources
         FROM restore_drills
        WHERE outcome = 'passed' AND NOT sampled
        ORDER BY started_at DESC, id DESC
        LIMIT 1`,
    )
  ).rows[0] as { key_id: string | null; folder_label: string | null; covered_sources: boolean } | undefined;
  if (!drill) return null;
  const latest = (
    await db.query(
      `SELECT key_id, folder_label, source_area FROM backup_runs
        WHERE outcome = 'succeeded'
        ORDER BY finished_at DESC NULLS LAST, id DESC
        LIMIT 1`,
    )
  ).rows[0] as { key_id: string | null; folder_label: string | null; source_area: string | null } | undefined;
  if (!latest) return null;
  if (latest.key_id && drill.key_id && latest.key_id !== drill.key_id) return 'key_changed';
  if (latest.folder_label && drill.folder_label && latest.folder_label !== drill.folder_label) return 'folder_changed';
  if (latest.source_area === 'included' && !drill.covered_sources) return 'source_area_new';
  return null;
}

/** Step 8's condition: a passed full drill (not sampled, not over the target) of a successful set, and no reason to drill again. */
export async function backupsStepHolds(db: Db): Promise<boolean> {
  const passed = (
    await db.query(
      `SELECT EXISTS (
         SELECT 1 FROM restore_drills d LEFT JOIN backup_runs b ON b.id = d.backup_run_id
          WHERE d.outcome = 'passed' AND NOT d.sampled
            AND (d.backup_run_id IS NULL OR b.outcome = 'succeeded')) AS ok`,
    )
  ).rows[0].ok as boolean;
  return passed && (await drillAgainReason(db)) === null;
}
