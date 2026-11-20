/**
 * Whether Kainow is in protective read-only mode (spec 7.3, D114), read from the single `operations_state` row.
 * The API (AuthGuard) and the worker (every queue handler and tick) ask this before doing anything that changes data.
 * The answer is cached for at most 5 seconds, so a change made by another process (storage-check entering the mode,
 * Resume in the API) is seen within 5 seconds; `invalidate()` makes this process see its own change at once.
 * A plain class: the API registers it as a Nest provider (AuthModule), the worker constructs it with its pool.
 */
import type { Pool, PoolClient } from 'pg';

export const OPERATIONS_STATE_TTL_MS = 5_000;

export interface ProtectiveState {
  protective: boolean;
  reason: 'low_space' | 'restored_from_backup' | null;
  since: Date | null;
}

export class OperationsState {
  private cached: { at: number; value: ProtectiveState } | null = null;
  private loading: Promise<ProtectiveState> | null = null;
  /** Bumped by invalidate(), so a read that started before it neither fills the cache nor answers later callers. */
  private generation = 0;

  constructor(
    private readonly pool: Pick<Pool | PoolClient, 'query'>,
    private readonly ttlMs: number = OPERATIONS_STATE_TTL_MS,
    /** Monotonic-enough milliseconds; real time, not the application clock, because the cache is about freshness. */
    private readonly nowMs: () => number = Date.now,
  ) {}

  async isProtective(): Promise<boolean> {
    return (await this.current()).protective;
  }

  async current(): Promise<ProtectiveState> {
    const at = this.nowMs();
    if (this.cached && at - this.cached.at < this.ttlMs) return this.cached.value;
    // Callers arriving together share one query.
    if (!this.loading) {
      const generation = this.generation;
      const loading = this.load()
        .then((value) => {
          if (generation === this.generation) this.cached = { at: this.nowMs(), value };
          return value;
        })
        .finally(() => {
          if (this.loading === loading) this.loading = null;
        });
      this.loading = loading;
    }
    return this.loading;
  }

  /** Forgets the cached answer; the next question reads the table. */
  invalidate(): void {
    this.cached = null;
    this.loading = null;
    this.generation++;
  }

  private async load(): Promise<ProtectiveState> {
    const { rows } = await this.pool.query(`SELECT protective, reason, since FROM operations_state WHERE id`);
    const row = rows[0] as { protective: boolean; reason: ProtectiveState['reason']; since: Date | null } | undefined;
    return row ? { protective: row.protective, reason: row.reason, since: row.since } : { protective: false, reason: null, since: null };
  }
}
