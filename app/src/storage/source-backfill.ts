import type { PoolClient } from 'pg';
import { queueStorageJob } from './outbox';

/**
 * Queues `backfill-sources` for the approved source area, if there is one, in the caller's transaction (spec 9.1): on
 * approval of the source area, when the storage connection is saved, and by the daily tick. Kept apart from sources.ts
 * so the settings service can call it without importing the connector factory (which imports the settings service).
 */
export async function queueSourceBackfill(c: PoolClient): Promise<void> {
  const area = (await c.query<{ id: string }>(`SELECT id FROM storage_destinations WHERE purpose = 'source_area' AND status = 'approved'`)).rows[0];
  if (area) await queueStorageJob(c, 'backfill-sources', area.id);
}
