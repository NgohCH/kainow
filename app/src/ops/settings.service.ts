import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { writeAudit } from '../audit/audit';
import { CLOCK, type Clock } from '../auth/tokens';
import { readReason } from '../common/reason';
import { uuidv7 } from '../common/uuid7';
import { PG_POOL } from '../db/database.module';
import { OPS_BOUNDS, OPS_DEFAULTS, OPS_KEYS, type OpsSettings, loadOpsSettings, validateOpsSettings } from './settings';

const REASON = 'Give a reason for the change (up to 1,000 characters).';
export const FLOOR_TOO_HIGH =
  'The safe floor must be lower than the free space on the database disk now, or Kainow would turn read-only at once.';
const GB = 1024 ** 3;
const FRESH_MS = 30 * 60_000;

/** Keeps only the known keys of a request body. */
function pick(body: unknown): Partial<OpsSettings> {
  const src = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const out: Record<string, unknown> = {};
  for (const k of OPS_KEYS) if (src[k] !== undefined) out[k] = src[k];
  return out as Partial<OpsSettings>;
}

@Injectable()
export class OpsSettingsService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly now: Clock,
  ) {}

  async get() {
    const { rows } = await this.pool.query(
      `SELECT h.id, h.at, h.reason, h.actor_id AS "actorId", u.display_name AS actor, h.previous, h.next
         FROM operations_settings_changes h JOIN users u ON u.id = h.actor_id
        ORDER BY h.at DESC, h.id DESC`,
    );
    return { settings: await loadOpsSettings(this.pool), defaults: OPS_DEFAULTS, bounds: OPS_BOUNDS, changes: rows };
  }

  /** The values after applying `body` to `previous`, refused with 400 when any is outside its bounds. */
  protected merge(previous: OpsSettings, body: unknown): OpsSettings {
    const value = { ...previous, ...pick(body) };
    const problems = validateOpsSettings(value);
    if (problems.length > 0) throw new BadRequestException(problems.join(' '));
    return value;
  }

  /**
   * R23: a safe floor at or above the database disk's free space would turn Kainow read-only at the next storage check,
   * and Resume could never pass while it stands (the settings change itself is refused in protective mode). Refused when
   * the latest database-disk reading is fresh (under 30 minutes); with no fresh reading there is nothing to compare.
   */
  private async checkFloor(db: Pick<PoolClient, 'query'>, floorGb: number, at: Date): Promise<void> {
    const r = (
      await db.query(
        `SELECT free_bytes::text AS free FROM storage_readings
          WHERE location = 'database_disk' AND NOT unavailable AND free_bytes IS NOT NULL AND at > $1
          ORDER BY at DESC, id DESC LIMIT 1`,
        [new Date(at.getTime() - FRESH_MS)],
      )
    ).rows[0] as { free: string } | undefined;
    if (r && floorGb * GB >= Number(r.free)) throw new BadRequestException(FLOOR_TOO_HIGH);
  }

  /** Writes the row, one history row and the audit event together. `body` holds any subset of the values and `reason`. */
  async update(actorId: string, body: unknown): Promise<OpsSettings> {
    const src = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const reason = readReason(src.reason, 'a reason', { refusal: REASON });
    const at = this.now();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const previous = await loadOpsSettings(client, true);
      const value = this.merge(previous, body);
      if (value.safeFloorGb !== previous.safeFloorGb) await this.checkFloor(client, value.safeFloorGb, at);
      try {
        await client.query(
          `UPDATE operations_settings SET backup_retention_days = $1, storage_warning_pct = $2, storage_critical_pct = $3,
                  safe_floor_gb = $4, diagnostic_retention_days = $5 WHERE id`,
          [value.backupRetentionDays, value.storageWarningPct, value.storageCriticalPct, value.safeFloorGb, value.diagnosticRetentionDays],
        );
      } catch (err) {
        // Validation runs first; a CHECK failure here is only a fallback.
        if ((err as { code?: string }).code === '23514') throw new BadRequestException('One of the values is outside its allowed range.');
        throw err;
      }
      await client.query(`INSERT INTO operations_settings_changes (id, actor_id, at, reason, previous, next) VALUES ($1, $2, $3, $4, $5, $6)`, [
        uuidv7(at.getTime()), actorId, at, reason, JSON.stringify(previous), JSON.stringify(value),
      ]);
      const fields = OPS_KEYS.filter((k) => previous[k] !== value[k]);
      await writeAudit(client, { at, action: 'ops.settings_changed', actorUserId: actorId, subjectType: 'operations', detail: { fields } });
      await client.query('COMMIT');
      return value;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}
