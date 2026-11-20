import { Inject, Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { toCsv, utc8Minute } from '../analytics/csv';
import { writeAudit } from '../audit/audit';
import { type AuthUser, CLOCK, type Clock } from '../auth/tokens';
import { PG_POOL } from '../db/database.module';
import { isWholeProject } from '../outputs/readers';
import { todayUtc8 } from '../projects/membership';

/**
 * The storage manifest (spec 9.4, migrate-out): a CSV of every stored file with its provider-neutral references, for
 * backup, restore and moving to another provider. No content. Output paths carry titles, so the path of any output not
 * readable by the whole project (restricted, in review, held, withdrawn, deleted, not yet registered) and of any
 * withheld file is shown as "Restricted item" (design call); source paths are made of ids only and are always shown.
 */

type Db = Pool | PoolClient;

export const MANIFEST_COLUMNS = [
  'Purpose', 'Project id', 'Project name', 'Source or output id', 'Version', 'Destination label', 'Connector', 'Drive id', 'Item id',
  'Path', 'Size', 'SHA-256', 'Provider hash', 'State', 'Last check',
] as const;
export const RESTRICTED_ITEM = 'Restricted item';
const PURPOSE_LABEL: Record<string, string> = { source_original: 'source original', source_text: 'source text', output: 'output' };

interface Row {
  purpose: string; project_id: string; project_name: string; owner_id: string | null; output_id: string | null; version_no: number | null;
  label: string | null; connector: string | null; drive_id: string | null; item_id: string | null; path: string | null;
  size_bytes: string | null; sha256: string | null; provider_hash: string | null; state: string; check_status: string; last_checked_at: Date | null;
}

/** The manifest as CSV bytes (BOM, `#` lines, formula-guarded cells), ordered by project name, purpose, item and version. */
export async function buildManifest(db: Db, at: Date = new Date()): Promise<Buffer> {
  const { rows } = await db.query<Row>(
    `SELECT f.purpose, f.project_id, p.name AS project_name,
            COALESCE(so.source_id, st.source_id, ov.output_id) AS owner_id, ov.output_id,
            COALESCE(so.version_no, st.version_no, ov.version_no) AS version_no,
            d.label, f.connector, f.drive_id, f.item_id, f.path, f.size_bytes, f.sha256, f.provider_hash, f.state, f.check_status, f.last_checked_at
       FROM stored_files f
       JOIN projects p ON p.id = f.project_id
       LEFT JOIN storage_destinations d ON d.id = f.destination_id
       LEFT JOIN source_versions so ON so.original_stored_file_id = f.id
       LEFT JOIN source_versions st ON st.text_stored_file_id = f.id
       LEFT JOIN output_versions ov ON ov.stored_file_id = f.id
      ORDER BY lower(p.name), p.id, f.purpose, owner_id, version_no, f.created_at, f.id`,
  );
  const whole = new Map<string, boolean>();
  const shown = async (r: Row): Promise<boolean> => {
    if (r.state === 'withheld') return false;
    if (r.purpose !== 'output') return true;
    if (!r.output_id) return false;
    if (!whole.has(r.output_id)) whole.set(r.output_id, await isWholeProject(db, r.output_id, at));
    return whole.get(r.output_id) as boolean;
  };
  const table: unknown[][] = [];
  for (const r of rows) {
    table.push([
      PURPOSE_LABEL[r.purpose] ?? r.purpose, r.project_id, r.project_name, r.owner_id, r.version_no, r.label, r.connector, r.drive_id, r.item_id,
      r.path === null ? null : (await shown(r)) ? r.path : RESTRICTED_ITEM,
      r.size_bytes === null ? null : Number(r.size_bytes), r.sha256, r.provider_hash, r.state,
      r.last_checked_at ? `${r.check_status} ${utc8Minute(r.last_checked_at.toISOString())}` : r.check_status,
    ]);
  }
  const meta = {
    Manifest: 'Kainow storage manifest',
    'Computed at': utc8Minute(at.toISOString()),
    Files: String(rows.length),
    Note: `References only, no file content. Paths of items not readable by the whole project show "${RESTRICTED_ITEM}".`,
  };
  return Buffer.from(toCsv(meta, [...MANIFEST_COLUMNS], table, { bom: true }), 'utf8');
}

@Injectable()
export class ManifestService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Builds the manifest for an Enterprise Administrator and records the download (never the data). */
  async download(user: AuthUser): Promise<{ filename: string; csv: Buffer }> {
    const at = this.clock();
    const csv = await buildManifest(this.pool, at);
    const files = (await this.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM stored_files`)).rows[0].n;
    await writeAudit(this.pool, { at, action: 'storage.manifest_downloaded', actorUserId: user.id, subjectType: 'storage_manifest', detail: { files } });
    return { filename: `kainow-storage-manifest-${todayUtc8(at)}.csv`, csv };
  }
}
