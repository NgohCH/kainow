/**
 * Alert episodes (spec 9): one open row per kind and location in `ops_alerts`. The partial unique index makes opening
 * race-safe, and closing is a conditional update, so two sweeps running together notify at most once.
 */
import type { Pool, PoolClient } from 'pg';
import { uuidv7 } from '../common/uuid7';

type Db = Pick<Pool | PoolClient, 'query'>;

/** True only when this call opened a new episode. */
export async function openEpisode(db: Db, kind: string, location: string | null, now: Date): Promise<boolean> {
  const r = await db.query(
    `INSERT INTO ops_alerts (id, kind, location, opened_at) VALUES ($1, $2, $3, $4)
     ON CONFLICT (kind, coalesce(location, '')) WHERE closed_at IS NULL DO NOTHING`,
    [uuidv7(now.getTime()), kind, location, now],
  );
  return (r.rowCount ?? 0) > 0;
}

/** True only when this call closed an open episode. */
export async function closeEpisode(db: Db, kind: string, location: string | null, now: Date): Promise<boolean> {
  const r = await db.query(
    `UPDATE ops_alerts SET closed_at = $3
      WHERE kind = $1 AND coalesce(location, '') = coalesce($2::text, '') AND closed_at IS NULL`,
    [kind, location, now],
  );
  return (r.rowCount ?? 0) > 0;
}
