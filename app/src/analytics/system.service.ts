import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { readinessMany } from '../analysis/tick';
import { CLOCK, type Clock } from '../auth/tokens';
import { PG_POOL } from '../db/database.module';
import { sharingToRepair } from '../outputs/sharing';
import { PROTECTED_KEY, type ProtectedKey } from '../quarantine/protected-key';
import { BOSS_SCHEMA } from '../worker/queues';
import { type AnalyticsFilters, addDays } from './filters';

/** The jobs-waiting threshold: a job counts as waiting once it has waited longer than this. */
export const JOB_WAIT_MINUTES = 15;

export interface SystemPanel {
  emails: { failed: number; uncertain: number; retryWaiting: number };
  ai: { blockedByReason: Record<string, number>; keyRejected: number };
  jobs: { failedByQueue: Record<string, number>; waitingOver15m: number };
  security: { casesAwaitingReview: number; protectedKeyInstalled: boolean };
  /** External outputs (spec 12): counts only. */
  storageFailures: number;
  storageWaiting: number;
  withholdFailures: number;
  sharingToRepair: number;
  /** Existing hash routes where an Administrator can act on each line (null where no screen exists). */
  links: { emails: string; ai: string; jobs: string | null; security: string };
  computedAt: string;
}

/**
 * Dashboards spec 7.2 item 3. Organisation-wide: the department, status and ownership filters do not apply, only the period
 * (to "in the period" counts). Counts only: no names, ids or text. The pg-boss table is read, never written.
 */
@Injectable()
export class SystemService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PROTECTED_KEY) private readonly key: ProtectedKey | null,
  ) {}

  async problems(f: AnalyticsFilters): Promise<SystemPanel> {
    const now = this.clock();
    const start = new Date(`${f.from}T00:00:00+08:00`);
    const end = new Date(Math.min(Date.parse(`${addDays(f.to, 1)}T00:00:00+08:00`), now.getTime() + 1));
    return {
      emails: await this.emails(start, end),
      ai: await this.ai(now),
      jobs: await this.jobs(start, end, now),
      security: await this.security(),
      ...(await this.storage()),
      links: { emails: '#/deliveries', ai: '#/ai', jobs: null, security: '#/security/cases' },
      computedAt: now.toISOString(),
    };
  }

  private async emails(start: Date, end: Date) {
    // When an email reached its state: the same moment the delivery list shows.
    const r = (
      await this.pool.query(
        `SELECT count(*) FILTER (WHERE status = 'failed' AND at >= $1 AND at < $2)::int AS failed,
                count(*) FILTER (WHERE status = 'uncertain' AND at >= $1 AND at < $2)::int AS uncertain,
                count(*) FILTER (WHERE status = 'retry_wait')::int AS "retryWaiting"
           FROM (SELECT o.status, COALESCE(o.sent_at, (SELECT max(a.finished_at) FROM email_attempts a WHERE a.outbox_id = o.id), o.created_at) AS at
                   FROM email_outbox o WHERE o.status IN ('failed', 'uncertain', 'retry_wait')) e`,
        [start, end],
      )
    ).rows[0];
    return { failed: r.failed as number, uncertain: r.uncertain as number, retryWaiting: r.retryWaiting as number };
  }

  /** Active projects whose automatic analysis would be Blocked now, by the sub-project 6 reason; connections in Key rejected. */
  private async ai(now: Date) {
    const ids = (await this.pool.query(`SELECT id FROM projects WHERE status = 'active'`)).rows.map((r) => r.id as string);
    const ready = await readinessMany(this.pool, ids, now, this.key?.id ?? null);
    const blockedByReason: Record<string, number> = {};
    for (const r of ready.values()) if (r.blockedReason) blockedByReason[r.blockedReason] = (blockedByReason[r.blockedReason] ?? 0) + 1;
    const keyRejected = (await this.pool.query(`SELECT count(*)::int AS n FROM ai_connections WHERE state = 'key_rejected'`)).rows[0].n as number;
    return { blockedByReason, keyRejected };
  }

  private async jobs(start: Date, end: Date, now: Date) {
    const has = (await this.pool.query(`SELECT to_regclass('${BOSS_SCHEMA}.job') IS NOT NULL AS ok`)).rows[0].ok as boolean;
    if (!has) return { failedByQueue: {}, waitingOver15m: 0 };
    const failed = await this.pool.query(
      `SELECT name, count(*)::int AS n FROM ${BOSS_SCHEMA}.job WHERE state = 'failed' AND completed_on >= $1 AND completed_on < $2 GROUP BY name ORDER BY name`,
      [start, end],
    );
    // Waiting: queued or waiting to retry, and ready to run for longer than the threshold (a job delayed on purpose is not waiting).
    const waiting = await this.pool.query(
      `SELECT count(*)::int AS n FROM ${BOSS_SCHEMA}.job
        WHERE state IN ('created', 'retry') AND GREATEST(created_on, start_after) < $1::timestamptz - make_interval(mins => $2)`,
      [now, JOB_WAIT_MINUTES],
    );
    return { failedByQueue: Object.fromEntries(failed.rows.map((r) => [r.name as string, r.n as number])), waitingOver15m: waiting.rows[0].n as number };
  }

  /**
   * Stored files that failed, files waiting to be stored, held files whose removal from storage keeps failing (the
   * Administrators were told; "Still in storage"), and the sharing to repair on the Storage page (a grant that failed or
   * is not yet revoked, or an output whose files could not be moved): counts only, no names, paths or titles.
   */
  private async storage() {
    const r = (
      await this.pool.query(
        `SELECT count(*) FILTER (WHERE state = 'failed')::int AS "storageFailures",
                count(*) FILTER (WHERE state IN ('pending', 'storing'))::int AS "storageWaiting",
                count(*) FILTER (WHERE state = 'withheld' AND withhold_case_id IS NOT NULL AND removed_at IS NULL AND remove_notice_at IS NOT NULL)::int AS "withholdFailures"
           FROM stored_files WHERE state IN ('failed', 'pending', 'storing', 'withheld')`,
      )
    ).rows[0];
    const repair = await sharingToRepair(this.pool);
    return { storageFailures: r.storageFailures as number, storageWaiting: r.storageWaiting as number, withholdFailures: r.withholdFailures as number, sharingToRepair: repair.grants.length + repair.outputs.length };
  }

  /** A count only: open cases (held, or cleaned and still under review). No project, record or reason text. */
  private async security() {
    const n = (await this.pool.query(`SELECT count(*)::int AS n FROM quarantine_cases WHERE state IN ('held', 'cleaned')`)).rows[0].n as number;
    return { casesAwaitingReview: n, protectedKeyInstalled: this.key !== null };
  }
}
