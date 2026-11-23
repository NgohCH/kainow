/**
 * The start-time grace from the ops sweep (D125, final review I1 and M2): an `approved` or `ready` update more than
 * 60 minutes past its start ends `failed_before_install` with `window_missed`, so a missing or stopped updater (no cron
 * line, server off) cannot leave a row open for ever, blocking other approvals. The updater itself ends such rows the
 * same way when it runs first (prepare, install's re-check). `preparing` and `installing` are left to the updater: a
 * preparing row has its own limit there, and an installing one must be finished or undone by the updater.
 */
import type { Pool } from 'pg';
import { uuidv7 } from '../common/uuid7';
import { notifyAdmins } from '../ops/notify';
import { auditUpdateFailed } from './audit';
import { mailUpdateEnded } from './people-mail';
import { FAILURE_TEXT, WINDOW_GRACE_MS } from './states';

const LINK = '#/admin/operations';

/** The Administrators' notice for an update that ended before installing with `window_missed`. */
export const windowMissedSummary = (tag: string): string =>
  `The update to ${tag} failed before installing; nothing changed. ${FAILURE_TEXT.window_missed}`;

/** Ends every approved or ready update more than 60 minutes past its start; returns how many. One transaction. */
export async function endMissedWindows(pool: Pool, now: Date): Promise<number> {
  const c = await pool.connect();
  let broken = false;
  try {
    await c.query('BEGIN');
    try {
      await c.query(`SELECT pg_advisory_xact_lock(hashtext('kainow.updates'))`);
      const rows = (
        await c.query(
          `SELECT id, tag, state FROM updates
            WHERE state IN ('approved', 'ready') AND starts_at < $1::timestamptz - make_interval(secs => $2::double precision)
            ORDER BY starts_at, id FOR UPDATE`,
          [now, WINDOW_GRACE_MS / 1000],
        )
      ).rows as Array<{ id: string; tag: string; state: string }>;
      for (const r of rows) {
        const from = r.state;
        await c.query(`UPDATE updates SET state = 'failed_before_install', failure_code = 'window_missed', finished_at = $2 WHERE id = $1`, [r.id, now]);
        await c.query(`INSERT INTO update_changes (id, update_id, at, action, actor_id, reason, detail) VALUES ($1, $2, $3, 'state_changed', NULL, NULL, $4)`, [
          uuidv7(now.getTime()),
          r.id,
          now,
          JSON.stringify({ from, to: 'failed_before_install', failureCode: 'window_missed' }),
        ]);
        await auditUpdateFailed(c, { at: now, actorUserId: null, subjectType: 'update', subjectId: r.id, detail: { tag: r.tag, failureCode: 'window_missed' } });
        await notifyAdmins(c, { kind: 'update_failed', summary: windowMissedSummary(r.tag), link: LINK, now, urgent: true });
        await mailUpdateEnded(c, r.id, now);
      }
      await c.query('COMMIT');
      return rows.length;
    } catch (err) {
      await c.query('ROLLBACK').catch(() => (broken = true));
      throw err;
    }
  } finally {
    c.release(broken);
  }
}
