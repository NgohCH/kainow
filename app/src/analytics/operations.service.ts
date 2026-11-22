import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { CLOCK, type Clock } from '../auth/tokens';
import { PG_POOL } from '../db/database.module';
import { type OperationsView, OperationsService } from '../ops/operations.service';
import { type AnalyticsFilters, addDays } from './filters';

export interface OperationsPanel {
  /** The Operations page's data without the run tables and drill lists. */
  status: {
    backups: Omit<OperationsView['backups'], 'runs'>;
    lastDrill: OperationsView['drills']['last'];
    storage: OperationsView['storage'];
    /** storage_daily over the chosen period. */
    growth: OperationsView['growth'];
    protective: OperationsView['protective'];
    health: OperationsView['health'];
    updates: OperationsView['updates'];
  };
  /** Counts in the chosen period. */
  period: {
    backups: { total: number; succeeded: number; failed: number };
    drills: { total: number; passed: number; failed: number };
    /** Updates whose start time falls in the period, by outcome (10b spec 11). Open: approved, preparing, ready, installing. */
    updates: { total: number; succeeded: number; failed: number; cancelled: number; open: number };
  };
  computedAt: string;
}

/** Administrator analytics, Operations panel: organisation-wide; only the period applies, to the counts. Read-only. */
@Injectable()
export class OperationsPanelService {
  constructor(
    private readonly operations: OperationsService,
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async forPeriod(f: AnalyticsFilters): Promise<OperationsPanel> {
    const now = this.clock();
    const start = new Date(`${f.from}T00:00:00+08:00`);
    const end = new Date(Math.min(Date.parse(`${addDays(f.to, 1)}T00:00:00+08:00`), now.getTime() + 1));
    const view = await this.operations.view();
    const growth = await this.operations.growth(now, { from: f.from, to: f.to });
    const { runs: _runs, ...backups } = view.backups;
    // A run still running after 6 hours counts as failed here too, as on the page.
    const b = (
      await this.pool.query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE outcome = 'succeeded')::int AS succeeded,
                count(*) FILTER (WHERE outcome = 'failed' OR (outcome = 'running' AND started_at < $3::timestamptz - interval '6 hours'))::int AS failed
           FROM backup_runs WHERE started_at >= $1 AND started_at < $2`,
        [start, end, now],
      )
    ).rows[0];
    const d = (
      await this.pool.query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE outcome IN ('passed', 'passed_over_target'))::int AS passed,
                count(*) FILTER (WHERE outcome = 'failed' OR (outcome = 'running' AND started_at < $3::timestamptz - interval '6 hours'))::int AS failed
           FROM restore_drills WHERE started_at >= $1 AND started_at < $2`,
        [start, end, now],
      )
    ).rows[0];
    // Failed: refused, failed before install, failed after migration, needing attention, and recovered (a failure undone).
    const u = (
      await this.pool.query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE state = 'succeeded')::int AS succeeded,
                count(*) FILTER (WHERE state IN ('refused', 'failed_before_install', 'failed_after_migration', 'failed_needs_attention', 'recovered'))::int AS failed,
                count(*) FILTER (WHERE state = 'cancelled')::int AS cancelled,
                count(*) FILTER (WHERE state IN ('approved', 'preparing', 'ready', 'installing'))::int AS open
           FROM updates WHERE starts_at >= $1 AND starts_at < $2`,
        [start, end],
      )
    ).rows[0];
    return {
      status: { backups, lastDrill: view.drills.last, storage: view.storage, growth, protective: view.protective, health: view.health, updates: view.updates },
      period: {
        backups: { total: b.total, succeeded: b.succeeded, failed: b.failed },
        drills: { total: d.total, passed: d.passed, failed: d.failed },
        updates: { total: u.total, succeeded: u.succeeded, failed: u.failed, cancelled: u.cancelled, open: u.open },
      },
      computedAt: now.toISOString(),
    };
  }
}
