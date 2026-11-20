import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from '../db/database.module';
import { PROTECTED_KEY, type ProtectedKey } from '../quarantine/protected-key';
import { sharingToRepair } from '../outputs/sharing';
import { StorageAdminsService } from './admins.service';
import { type Destination, DestinationsService } from './destinations.service';
import { type SourceAreaMoveProgress, sourceAreaMoveProgress } from './relocate';
import { loadStorageSettings } from './settings';

export type SummaryConnection = 'connected' | 'not_configured' | 'protected_key_missing' | 'refused' | 'unreachable' | 'not_checked';

export interface SharingRepairRow {
  /** The project's name; "Source area" for access to the source area. */
  project: string;
  projectId: string | null;
  folder: string;
  /** The person whose access failed; null for an output whose files could not be moved. */
  person: string | null;
  kind: 'access' | 'output_move';
  state: 'failed' | 'revoking' | 'move_failed';
  since: string;
}

type Purpose = 'source_original' | 'source_text' | 'output';

export interface StorageSummary {
  connection: SummaryConnection;
  protectedKeyMissing: boolean;
  lastCheckedAt: string | null;
  destinations: Destination[];
  /** quotaBytes null means "Unavailable" (never 0). */
  sourceArea: { files: number; bytes: number; quotaBytes: number | null; warning: string | null };
  /** Files pending or being stored. */
  waiting: number;
  failed: number;
  withheld: number;
  /** Jobs queued for the storage provider and not yet sent (they wait here while the protected key is missing). */
  queuedJobs: number;
  byPurpose: Array<{ purpose: Purpose; files: number; bytes: number; waiting: number; failed: number; withheld: number }>;
  sharingToRepair: SharingRepairRow[];
  storageAdmins: Array<{ name: string; since: string }>;
  scheduledChecks: boolean;
  sourceAreaMove: SourceAreaMoveProgress | null;
}

const PURPOSES: readonly Purpose[] = ['source_original', 'source_text', 'output'];

@Injectable()
export class StorageSummaryService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(PROTECTED_KEY) private readonly protectedKey: ProtectedKey | null,
    private readonly destinations: DestinationsService,
    private readonly admins: StorageAdminsService,
  ) {}

  async summary(): Promise<StorageSummary> {
    const settings = await loadStorageSettings(this.pool);
    const rec = (await this.pool.query<{ state: string | null; at: Date | null }>(`SELECT last_check_state AS state, last_checked_at AS at FROM storage_settings`)).rows[0];
    const protectedKeyMissing = this.protectedKey === null;
    let connection: SummaryConnection;
    if (!settings.tenantId || !settings.clientId || !settings.hasSecret) connection = 'not_configured';
    else if (protectedKeyMissing) connection = 'protected_key_missing';
    else if (rec.state === 'connected' || rec.state === 'refused' || rec.state === 'unreachable') connection = rec.state;
    else connection = 'not_checked';

    const destinations = await this.destinations.list();
    const source = destinations.find((d) => d.purpose === 'source_area' && d.status === 'approved') ?? null;
    const counts = (
      await this.pool.query<{ purpose: Purpose; files: number; bytes: string; waiting: number; failed: number; withheld: number }>(
        `SELECT purpose,
                count(*) FILTER (WHERE state IN ('stored', 'relocating'))::int AS files,
                COALESCE(sum(size_bytes) FILTER (WHERE state IN ('stored', 'relocating')), 0)::bigint AS bytes,
                count(*) FILTER (WHERE state IN ('pending', 'storing'))::int AS waiting,
                count(*) FILTER (WHERE state = 'failed')::int AS failed,
                count(*) FILTER (WHERE state = 'withheld')::int AS withheld
           FROM stored_files GROUP BY purpose`,
      )
    ).rows;
    const byPurpose = PURPOSES.map((purpose) => {
      const r = counts.find((c) => c.purpose === purpose);
      return { purpose, files: r?.files ?? 0, bytes: Number(r?.bytes ?? 0), waiting: r?.waiting ?? 0, failed: r?.failed ?? 0, withheld: r?.withheld ?? 0 };
    });
    const at = source
      ? (
          await this.pool.query<{ files: number; bytes: string }>(
            `SELECT count(*)::int AS files, COALESCE(sum(size_bytes), 0)::bigint AS bytes FROM stored_files
              WHERE destination_id = $1 AND purpose IN ('source_original', 'source_text') AND state IN ('stored', 'relocating')`,
            [source.id],
          )
        ).rows[0]
      : { files: 0, bytes: '0' };
    const quota = source?.lastCheck?.quotaBytes;
    const warning = (source?.lastCheck as { sourceAreaWarning?: string } | null | undefined)?.sourceAreaWarning;

    const repair = await sharingToRepair(this.pool);
    const rows: SharingRepairRow[] = [
      ...repair.grants.map((g): SharingRepairRow => ({
        project: g.area === 'source' ? 'Source area' : (g.projectName ?? ''),
        projectId: g.projectId,
        folder: g.area === 'source' ? 'Source area' : 'Project folder',
        person: g.displayName,
        kind: 'access',
        state: g.state,
        since: new Date(g.since).toISOString(),
      })),
      ...repair.outputs.map((o): SharingRepairRow => ({
        project: o.projectName, projectId: o.projectId, folder: 'Outputs', person: null, kind: 'output_move', state: 'move_failed', since: new Date(o.since).toISOString(),
      })),
    ];
    const queuedJobs = (await this.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM storage_outbox WHERE sent_at IS NULL`)).rows[0].n;
    const admins = (await this.admins.list()).admins as Array<{ displayName: string; designatedAt: Date | string }>;
    return {
      connection,
      protectedKeyMissing,
      lastCheckedAt: rec.at ? rec.at.toISOString() : null,
      destinations,
      sourceArea: { files: at.files, bytes: Number(at.bytes), quotaBytes: typeof quota === 'number' ? quota : null, warning: warning ?? null },
      waiting: byPurpose.reduce((n, p) => n + p.waiting, 0),
      failed: byPurpose.reduce((n, p) => n + p.failed, 0),
      withheld: byPurpose.reduce((n, p) => n + p.withheld, 0),
      queuedJobs,
      byPurpose,
      sharingToRepair: rows,
      storageAdmins: admins.map((a) => ({ name: a.displayName, since: new Date(a.designatedAt).toISOString() })),
      scheduledChecks: settings.scheduledChecks,
      sourceAreaMove: await sourceAreaMoveProgress(this.pool),
    };
  }
}
