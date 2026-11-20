import type { PoolClient } from 'pg';
import { uuidv7 } from '../common/uuid7';
import { noticeHeldLink } from '../storage/notices';
import { queueWithhold } from '../storage/withhold';
import { endOutputApprovalRequests } from './approval-handler';
import { queueOutputPlacement } from './sharing-queue';

/**
 * Holds on outputs (spec 4.7, 8.5; D80–D82). Called in the transaction that sets or clears an output's `held_case_id`
 * (the quarantine cases service), after the rows are held or released.
 *
 * Held: hidden at once (the readers rule); its pending approval requests end (CF8); every file of it in storage is
 * withheld (moved out of any shared folder first, then encrypted under the protected key and removed permanently);
 * its own folder's grants are removed (an urgent placement, which syncs them to nobody). A linked version's document
 * was not created by Kainow and is never deleted: it is hidden in Kainow only and the Administrators, the storage
 * Administrators and the PM are told it is still in storage. A version still being filed is dealt with when its upload
 * is confirmed (filing rechecks the hold).
 *
 * Released: its readers come back, so its files (those not withheld) go back to where they belong. Withheld files come
 * back only with a false-alarm release (the quarantine engine queues `restore-withheld`); otherwise the PM or a Deputy
 * replaces them with a new version.
 */
export async function outputHeld(c: PoolClient, outputId: string, caseId: string, actorId: string | null, at: Date): Promise<void> {
  await c.query(`INSERT INTO output_events (id, output_id, kind, actor_id, at, detail) VALUES ($1, $2, 'held', $3, $4, $5)`, [
    uuidv7(at.getTime()), outputId, actorId, at, JSON.stringify({ caseId }),
  ]);
  await endOutputApprovalRequests(c, outputId, actorId, at);
  const files = (
    await c.query<{ id: string; state: string }>(
      `SELECT f.id, f.state FROM output_versions v JOIN stored_files f ON f.id = v.stored_file_id WHERE v.output_id = $1 ORDER BY v.version_no`,
      [outputId],
    )
  ).rows;
  await queueWithhold(c, files.filter((f) => f.state === 'stored').map((f) => f.id), caseId);
  if (files.some((f) => f.state === 'linked')) await noticeHeldLink(c, outputId, at);
  await queueOutputPlacement(c, outputId, 'narrow');
}

export async function outputReleased(c: PoolClient, outputId: string, caseId: string, at: Date): Promise<void> {
  await c.query(`INSERT INTO output_events (id, output_id, kind, actor_id, at, detail) VALUES ($1, $2, 'released', NULL, $3, $4)`, [
    uuidv7(at.getTime()), outputId, at, JSON.stringify({ caseId }),
  ]);
  const status = (await c.query<{ status: string }>(`SELECT status FROM outputs WHERE id = $1`, [outputId])).rows[0]?.status;
  if (status === 'registered') await queueOutputPlacement(c, outputId, 'widen');
}
