import type { Pool, PoolClient } from 'pg';

export type InputFormat = 'txt' | 'md' | 'docx' | 'pdf';
export type OutputFormat = 'md' | 'docx' | 'pdf' | 'csv';

export const INPUT_FORMATS: readonly InputFormat[] = ['txt', 'md', 'docx', 'pdf'];
export const OUTPUT_FORMATS: readonly OutputFormat[] = ['md', 'docx', 'pdf', 'csv'];

/** The non-secret storage settings. The client secret is never part of this. */
export interface StorageSettings {
  tenantId: string | null;
  clientId: string | null;
  hasSecret: boolean;
  approvedInputFormats: InputFormat[];
  approvedOutputFormats: OutputFormat[];
  projectsMayChangeFormats: boolean;
  projectsMayChooseDestination: boolean;
  projectsMaySetExportRoles: boolean;
  directoryLookup: boolean;
  scheduledChecks: boolean;
}

interface Row {
  tenant_id: string | null;
  client_id: string | null;
  approved_input_formats: string[];
  approved_output_formats: string[];
  projects_may_change_formats: boolean;
  projects_may_choose_destination: boolean;
  projects_may_set_export_roles: boolean;
  directory_lookup: boolean;
  scheduled_checks: boolean;
  has_secret: boolean;
}

export async function loadStorageSettings(db: Pool | PoolClient): Promise<StorageSettings> {
  const { rows } = await db.query<Row>(
    `SELECT s.tenant_id, s.client_id, s.approved_input_formats, s.approved_output_formats, s.projects_may_change_formats,
            s.projects_may_choose_destination, s.projects_may_set_export_roles, s.directory_lookup, s.scheduled_checks,
            EXISTS (SELECT 1 FROM storage_connection_secrets WHERE superseded_at IS NULL) AS has_secret
       FROM storage_settings s`,
  );
  const r = rows[0];
  return {
    tenantId: r.tenant_id,
    clientId: r.client_id,
    hasSecret: r.has_secret,
    approvedInputFormats: r.approved_input_formats as InputFormat[],
    approvedOutputFormats: r.approved_output_formats as OutputFormat[],
    projectsMayChangeFormats: r.projects_may_change_formats,
    projectsMayChooseDestination: r.projects_may_choose_destination,
    projectsMaySetExportRoles: r.projects_may_set_export_roles,
    directoryLookup: r.directory_lookup,
    scheduledChecks: r.scheduled_checks,
  };
}
