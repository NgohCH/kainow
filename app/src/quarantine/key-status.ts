// Which protected key each service started with (second review, G05 option A). Starting without the key stays allowed
// (a trial, or a key mounted later), but the go-live checklist cannot close until api and worker hold the same key.
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { PG_POOL } from '../db/database.module';
import { PROTECTED_KEY, type ProtectedKey } from './protected-key';

export type KeyService = 'api' | 'worker';

/** Records the key id this service started with, or null without a usable key. Never the key itself. */
export async function reportKeyStatus(db: Pool | PoolClient, service: KeyService, keyId: string | null): Promise<void> {
  await db.query(
    `INSERT INTO service_key_status (service, key_id, reported_at) VALUES ($1, $2, now())
     ON CONFLICT (service) DO UPDATE SET key_id = EXCLUDED.key_id, reported_at = EXCLUDED.reported_at`,
    [service, keyId],
  );
}

/** SQL for "api and worker both started with the same protected key", for use inside a larger SELECT. */
export const KEY_LOADED_EVERYWHERE_SQL = `(
  (SELECT count(*) FROM service_key_status WHERE key_id IS NOT NULL) = 2
  AND (SELECT count(DISTINCT key_id) FROM service_key_status) = 1)`;

/** The api's report, made once the application has started. A failure is logged, never fatal. */
@Injectable()
export class ApiKeyStatusReporter implements OnApplicationBootstrap {
  private readonly log = new Logger('ProtectedKey');

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(PROTECTED_KEY) private readonly key: ProtectedKey | null,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      await reportKeyStatus(this.pool, 'api', this.key?.id ?? null);
    } catch {
      this.log.warn('could not record whether the protected key is loaded; the go-live checklist will wait for it');
    }
  }
}
