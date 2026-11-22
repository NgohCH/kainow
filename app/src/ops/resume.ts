/**
 * Resume from protective read-only mode (spec 7.3, D114, D116). Only an Enterprise Administrator (`operations.manage`),
 * with a reason, and only when every check passes:
 *   reading_fresh      the latest database_disk reading is younger than 10 minutes;
 *   space_above_floor  its free space is at or above the safe floor (1 GB = 1024^3 bytes, as storage-check);
 *   database           the database answers;
 *   migrations_current the applied migration level matches the code;
 *   no_backup_running  no backup run is 'running'.
 * Otherwise it refuses with 409 and names each failing check. The mode never ends by itself; this is the only way out.
 * The HTTP route (POST admin/operations/resume) belongs to the operations controller (Task 11), which calls `resume`
 * with the API's OperationsState so this process sees the change at once (other processes within its 5 s cache).
 */
import { ConflictException, ForbiddenException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { writeAudit } from '../audit/audit';
import { can } from '../auth/permissions';
import { readReason } from '../common/reason';
import { uuidv7 } from '../common/uuid7';
import { codeMigrationLevel, currentMigrationLevel } from './common';
import { notifyAdmins } from './notify';
import { type OpsSettings, loadOpsSettings } from './settings';

type Db = Pick<Pool | PoolClient, 'query'>;

export type ResumeCheckName = 'reading_fresh' | 'space_above_floor' | 'database' | 'migrations_current' | 'no_backup_running';
export interface ResumeCheck {
  name: ResumeCheckName;
  ok: boolean;
}

/** A reading must be strictly younger than this for Resume (D114). */
export const RESUME_READING_MAX_AGE_MS = 10 * 60_000;
const GB = 1024 ** 3;
const LINK = '#/admin/operations';

export const RESUME_TEXT = {
  notProtective: 'Kainow is not in protective mode.',
  checksFailed: 'Kainow cannot resume normal use yet: some checks did not pass.',
  resumed: 'Kainow is back to normal use: an Enterprise Administrator ended protective read-only mode.',
} as const;

/** Runs a check; a check that cannot be made fails, never throws. */
async function check(name: ResumeCheckName, fn: () => Promise<boolean>): Promise<ResumeCheck> {
  try {
    return { name, ok: await fn() };
  } catch {
    return { name, ok: false };
  }
}

/** The five Resume checks, in a fixed order. `codeLevel` is the highest migration the code ships (tests may pass one). */
export async function resumeChecks(db: Db, now: Date, settings: OpsSettings, codeLevel: string = codeMigrationLevel()): Promise<ResumeCheck[]> {
  const reading = await db
    .query(
      `SELECT at, free_bytes::text AS free, unavailable FROM storage_readings
        WHERE location = 'database_disk' ORDER BY at DESC, id DESC LIMIT 1`,
    )
    .then((r) => r.rows[0] as { at: Date; free: string | null; unavailable: boolean } | undefined)
    .catch(() => undefined);
  return [
    await check('reading_fresh', async () => reading !== undefined && now.getTime() - reading.at.getTime() < RESUME_READING_MAX_AGE_MS),
    await check('space_above_floor', async () => reading !== undefined && !reading.unavailable && reading.free !== null && Number(reading.free) >= settings.safeFloorGb * GB),
    await check('database', async () => (await db.query('SELECT 1 AS ok')).rows[0]?.ok === 1),
    await check('migrations_current', async () => (await currentMigrationLevel(db)) === codeLevel),
    await check('no_backup_running', async () => (await db.query(`SELECT 1 FROM backup_runs WHERE outcome = 'running' LIMIT 1`)).rows.length === 0),
  ];
}

export interface ResumeOptions {
  /** The API's cached state, cleared after the change commits. */
  state?: { invalidate(): void };
  /** For tests: the migration level the code ships. */
  codeLevel?: string;
}

/**
 * Ends protective mode. 403 unless the actor is an Active Enterprise Administrator, 400 without a reason (or with
 * one that looks like a credential), 409 when the mode is not on, and 409 `{ code: 'resume_checks_failed', message, failing: [check names] }` when a check fails.
 * The change, its state-change row, the audit event and the notices to the other administrators commit together,
 * under the ops lock that storage-check holds while it records a reading, so Resume never misses a reading below the
 * floor written at the same moment.
 */
export async function resume(pool: Pool, actorId: string, reasonIn: unknown, now: Date, opts: ResumeOptions = {}): Promise<{ resumed: true; at: Date }> {
  const actor = (await pool.query(`SELECT role, status FROM users WHERE id = $1`, [actorId])).rows[0] as { role: string; status: string } | undefined;
  if (!actor || actor.status !== 'active' || !can(actor.role, 'operations.manage')) throw new ForbiddenException();
  const reason = readReason(reasonIn);

  const client = await pool.connect();
  let broken = false;
  try {
    await client.query('BEGIN');
    try {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('kainow.ops-sweep'))`);
      const state = (await client.query(`SELECT protective, reason, since FROM operations_state WHERE id FOR UPDATE`)).rows[0] as
        | { protective: boolean; reason: string | null; since: Date | null }
        | undefined;
      if (!state?.protective) throw new ConflictException({ code: 'not_protective', message: RESUME_TEXT.notProtective });
      const checks = await resumeChecks(client, now, await loadOpsSettings(client), opts.codeLevel);
      const failing = checks.filter((c) => !c.ok).map((c) => c.name);
      if (failing.length > 0) throw new ConflictException({ code: 'resume_checks_failed', message: RESUME_TEXT.checksFailed, failing });

      await client.query(`UPDATE operations_state SET protective = false, reason = NULL, since = NULL, detail = NULL, changed_by = $1 WHERE id`, [actorId]);
      const detail = { previousReason: state.reason, since: state.since };
      await client.query(`INSERT INTO operations_state_changes (id, at, action, actor_id, reason, detail) VALUES ($1, $2, 'resumed', $3, $4, $5)`, [
        uuidv7(now.getTime()),
        now,
        actorId,
        reason,
        JSON.stringify(detail),
      ]);
      await writeAudit(client, { at: now, action: 'ops.protective_resumed', actorUserId: actorId, subjectType: 'operations_state', detail: { reason, previousReason: state.reason } });
      await notifyAdmins(client, { kind: 'protective_mode_resumed', summary: RESUME_TEXT.resumed, link: LINK, now, urgent: true, except: actorId });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => (broken = true));
      throw err;
    }
  } finally {
    client.release(broken);
  }
  opts.state?.invalidate();
  return { resumed: true, at: now };
}
