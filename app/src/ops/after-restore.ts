/**
 * The post-steps of a real restore (spec 8.2 step 5, D112), run on the restored database in the caller's ONE transaction:
 * nothing that was queued or running when the backup was taken is sent or run again, and Kainow starts read-only.
 *
 * Every domain work table checked, and what happens to it (the task report lists the same):
 *   sessions               deleted (every one)
 *   login_codes            unused codes deleted; used ones kept as history
 *   setup_invitations      open setup and recovery links expired (expires_at = now)
 *   email_outbox           queued, retry_wait -> not_sent_restored ("Not sent — restored from backup");
 *                          sending -> uncertain with no automatic retry; uncertain loses its automatic retry
 *   ai_requests            (AI assist: answers, report drafts, summaries) queued, running -> failed restored_from_backup
 *   analysis_runs          queued, running -> failed restored_from_backup
 *   extraction_runs        queued, running -> failed restored_from_backup
 *   ai_spend_entries       reserved -> uncertain (kept in full, never released: D43)
 *   ai_call_slots          leases cleared (they belonged to the old installation's workers)
 *   backup_runs            the run that made this set -> succeeded from its backup.json; any other running -> failed interrupted
 *   restore_drills         running -> failed interrupted
 *   pgboss.job             created, retry, active -> cancelled (the worker re-creates its schedules when it starts)
 *   storage_outbox         Task 15 (sub-project 9's storage queue)
 * Not ended, with the reason in the task report: quarantine_cases waiting for the key (local and idempotent; ending it would
 * leave the secret uncleaned), digest_runs and sweep_runs (records of finished work, no queued state), project invitations.
 */
import type { PoolClient } from 'pg';
import { writeAudit } from '../audit/audit';
import { uuidv7 } from '../common/uuid7';
import type { BackupSummary } from './manifest';
import { notifyAdmins } from './notify';
import { BOSS_SCHEMA } from '../worker/queues';

export const RESTORED_CODE = 'restored_from_backup';
export const NOT_RUN = 'Not run — restored from backup';
export const NOT_SENT = 'Not sent — restored from backup';
const SPEND_NOTE = 'restored from backup; the outcome is not known';
const LINK = '#/admin/operations';

/** "2026-11-21 02:00 UTC": the set time as the operator and the administrators see it. */
export function setTimeText(d: Date): string {
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** The text printed for the operator and written in each administrator's urgent notice (spec 8.2). */
export function restoredText(setTime: Date): string {
  return `Kainow was restored from the backup taken at ${setTimeText(setTime)}. Everything after that time is lost, including access changes: check People, grants and Administrators before resuming. Queued emails and jobs were not sent.`;
}

export interface AfterRestoreInput {
  /** When the set's snapshot was taken (backup.json startedAt). */
  setTime: Date;
  setName: string;
  reason: string;
  now: Date;
  /** The set's backup.json, to record its own run (still 'running' in the dump) as the succeeded set it is. */
  summary?: BackupSummary;
}

export interface AfterRestoreResult {
  emails: number;
  jobs: number;
  work: Record<string, number>;
}

const WORK_TABLES = ['ai_requests', 'analysis_runs', 'extraction_runs'] as const;

export async function afterRestore(c: PoolClient, input: AfterRestoreInput): Promise<AfterRestoreResult> {
  const { now } = input;

  // Access: nobody stays signed in, no code or link issued before the backup works.
  await c.query('DELETE FROM sessions');
  await c.query('DELETE FROM login_codes WHERE consumed_at IS NULL');
  await c.query(
    `UPDATE setup_invitations SET expires_at = $1 WHERE accepted_at IS NULL AND superseded_at IS NULL AND expires_at > $1`,
    [now],
  );

  // Email: nothing queued is sent. A send that may have happened stays uncertain, for an Administrator, never retried.
  const emails =
    (
      await c.query(
        `UPDATE email_outbox SET status = 'not_sent_restored', next_attempt_at = NULL, last_reason = $1 WHERE status IN ('queued', 'retry_wait')`,
        [NOT_SENT],
      )
    ).rowCount ?? 0;
  await c.query(`UPDATE email_outbox SET status = 'uncertain', next_attempt_at = NULL WHERE status = 'sending'`);
  await c.query(`UPDATE email_outbox SET next_attempt_at = NULL WHERE status = 'uncertain' AND next_attempt_at IS NOT NULL`);

  // Domain work: each table's own failed state with the fixed reason.
  const work: Record<string, number> = {};
  for (const table of WORK_TABLES) {
    work[table] =
      (
        await c.query(
          `UPDATE ${table} SET status = 'failed', failure_code = $1, failure_detail = $2, finished_at = $3 WHERE status IN ('queued', 'running')`,
          [RESTORED_CODE, NOT_RUN, now],
        )
      ).rowCount ?? 0;
  }
  // Task 15: end sub-project 9's storage_outbox rows here, with the same reason.

  // AI spend: an open reservation may have reached the provider, so it stays counted as uncertain (D43), never released.
  await c.query(`UPDATE ai_spend_entries SET status = 'uncertain', note = $1, updated_at = $2 WHERE status = 'reserved'`, [SPEND_NOTE, now]);
  await c.query(`UPDATE ai_call_slots SET holder = NULL, leased_until = NULL WHERE holder IS NOT NULL OR leased_until IS NOT NULL`);

  // Ops runs: the set's own run was 'running' when it was dumped; any other run of the old installation never finished here.
  const s = input.summary;
  if (s) {
    await c.query(
      `UPDATE backup_runs SET outcome = 'succeeded', finished_at = $2, key_id = $3, kainow_version = $4, migration_level = $5,
              database_bytes = $6, source_area = $7, manifest_sha256 = $8, failure_code = NULL, failure_detail = NULL,
              files_total = COALESCE(files_total, $9), files_new = COALESCE(files_new, 0), files_new_bytes = COALESCE(files_new_bytes, 0),
              files_not_copied = COALESCE(files_not_copied, 0)
        WHERE id::text = $1 AND outcome = 'running'`,
      [s.runId, s.finishedAt, s.keyId, s.kainowVersion, s.migrationLevel, s.databaseBytes, s.sourceArea, s.files['manifest.json.enc'].sha256, s.fileCount ?? 0],
    );
  }
  await c.query(
    `UPDATE backup_runs SET outcome = 'failed', failure_code = 'interrupted', failure_detail = $2, finished_at = $1 WHERE outcome = 'running'`,
    [now, 'The run was interrupted before it finished.'],
  );
  await c.query(`UPDATE restore_drills SET outcome = 'failed', failure_code = 'interrupted', finished_at = $1 WHERE outcome = 'running'`, [now]);

  // Queued and active jobs are cancelled, so nothing repeats. Without a pg-boss schema there is nothing to cancel.
  let jobs = 0;
  if ((await c.query(`SELECT to_regclass('${BOSS_SCHEMA}.job') IS NOT NULL AS ok`)).rows[0].ok) {
    jobs =
      (await c.query(`UPDATE ${BOSS_SCHEMA}.job SET state = 'cancelled', completed_on = now() WHERE state IN ('created', 'retry', 'active')`)).rowCount ?? 0;
  }

  // Protective mode, whatever the dumped state was (a backup can run while the mode is on for low space).
  const detail = { setTime: input.setTime.toISOString(), setName: input.setName };
  await c.query(
    `UPDATE operations_state SET protective = true, reason = 'restored_from_backup', since = $1, detail = $2, changed_by = NULL`,
    [now, JSON.stringify(detail)],
  );
  await c.query(`INSERT INTO operations_state_changes (id, at, action, actor_id, reason, detail) VALUES ($1, $2, 'entered', NULL, $3, $4)`, [
    uuidv7(now.getTime()),
    now,
    RESTORED_CODE,
    JSON.stringify(detail),
  ]);
  await writeAudit(c, { at: now, action: 'ops.protective_entered', subjectType: 'operations_state', detail: { reason: RESTORED_CODE, ...detail } });
  await writeAudit(c, {
    at: now,
    action: 'ops.restored_from_backup',
    subjectType: 'backup_set',
    detail: { ...detail, reason: input.reason, emailsNotSent: emails, jobsCancelled: jobs, workEnded: work },
  });

  // Written last, so their own emails stay queued and go out once the worker starts.
  await notifyAdmins(c, { kind: 'restored_from_backup', summary: restoredText(input.setTime), link: LINK, now, urgent: true });

  return { emails, jobs, work };
}
