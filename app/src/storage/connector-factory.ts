import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { CLOCK, type Clock } from '../auth/tokens';
import { PG_POOL } from '../db/database.module';
import { PROTECTED_KEY, type ProtectedKey } from '../quarantine/protected-key';
import type { StorageConnector } from './connector';
import { GraphConnector } from './connectors/graph';
import { LocalConnector } from './connectors/local';
import { loadStorageSettings } from './settings';
import { storageTokenSource } from './settings.service';
import { StorageError, type DestinationRef } from './types';

export const STORAGE_CONNECTORS = Symbol('STORAGE_CONNECTORS');

/** The protected key is not installed (or cannot open the saved secret's key): storage jobs wait instead of failing. */
export class StorageWaitingForKey extends Error {
  constructor() {
    super('Storage credentials cannot be used until the protected key is installed. See INSTALL.md.');
    this.name = 'StorageWaitingForKey';
  }
}

export type NewDestinationKind = 'sharepoint_library' | 'onedrive' | 'local';

/** The one way storage code gets a connector. Throws StorageError('invalid') when not configured, StorageWaitingForKey when the key is missing. */
export interface StorageConnectorFactory {
  forDestination(destinationId: string): Promise<{ connector: StorageConnector; dest: DestinationRef }>;
  forNew(kind: NewDestinationKind): Promise<StorageConnector>;
}

/** The local connector is for development and tests only: never in production, and only with its folder set. */
export function localStorageDir(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.NODE_ENV === 'production') return null;
  const dir = env.KAINOW_LOCAL_STORAGE_DIR?.trim();
  return dir ? dir : null;
}

interface DestinationRow {
  id: string; connector: 'graph' | 'local'; drive_id: string | null; root_item_id: string | null;
}

/** Builds a connector per call, so nothing secret outlives the token source it creates. */
@Injectable()
export class DbStorageConnectorFactory implements StorageConnectorFactory {
  /** Replaced in tests (the fake Graph's fetch). */
  fetchFn: typeof fetch = fetch;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PROTECTED_KEY) private readonly protectedKey: ProtectedKey | null,
  ) {}

  async forDestination(destinationId: string): Promise<{ connector: StorageConnector; dest: DestinationRef }> {
    const row = (
      await this.pool.query<DestinationRow>(`SELECT id, connector, drive_id, root_item_id FROM storage_destinations WHERE id = $1`, [destinationId])
    ).rows[0];
    if (!row || !row.drive_id || !row.root_item_id) throw new StorageError('invalid');
    const dest: DestinationRef = { id: row.id, connector: row.connector, driveId: row.drive_id, rootItemId: row.root_item_id };
    return { connector: row.connector === 'local' ? await this.local() : await this.graph(), dest };
  }

  async forNew(kind: NewDestinationKind): Promise<StorageConnector> {
    return kind === 'local' ? this.local() : this.graph();
  }

  private async local(): Promise<StorageConnector> {
    const dir = localStorageDir();
    if (!dir) throw new StorageError('invalid');
    // Development only: every known person counts as having an account.
    const people = (await this.pool.query<{ email: string }>(`SELECT email FROM users`)).rows;
    return new LocalConnector(dir, { lookup: Object.fromEntries(people.map((p) => [p.email, 'account' as const])) });
  }

  private async graph(): Promise<StorageConnector> {
    const s = await loadStorageSettings(this.pool);
    if (!s.tenantId || !s.clientId || !s.hasSecret) throw new StorageError('invalid');
    if (!this.protectedKey) throw new StorageWaitingForKey();
    const tokens = await storageTokenSource(this.pool, this.protectedKey, this.fetchFn, this.clock);
    if (!tokens) throw new StorageError('invalid'); // saved with another protected key: cannot be opened
    return new GraphConnector(tokens, {
      appClientId: s.clientId,
      lookup: s.directoryLookup,
      allowedDomains: async () =>
        (await this.pool.query<{ domain: string }>(`SELECT domain FROM eligible_domains WHERE removed_at IS NULL ORDER BY domain`)).rows.map((r) => r.domain),
      fetchFn: this.fetchFn,
    });
  }
}
