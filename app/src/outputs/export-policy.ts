import type { Pool, PoolClient } from 'pg';
import { loadAccessSettings } from '../organisation/access-settings';
import { type ProjectContext, canReadContent } from '../projects/access.service';
import type { ProjectRole } from '../projects/membership';

/**
 * Who may export a project's records (D106, spec 7.1): one rule, used by the export itself and by the output settings
 * view that tells a screen whether to show "Export CSV". A leaf module: it imports neither exports.ts nor the settings service.
 */
export const EXPORT_ROLES = ['pm', 'deputy', 'owner', 'sponsor', 'member', 'audit', 'oversight'] as const;
export type ExportRole = (typeof EXPORT_ROLES)[number];
export const DEFAULT_EXPORT_ROLES: readonly ExportRole[] = ['pm', 'deputy', 'owner', 'sponsor'];

/** The stored export role value for a project role (the spec says "deputy"; the code's role is deputy_pm). */
export const exportRoleOf = (role: ProjectRole): ExportRole => (role === 'deputy_pm' ? 'deputy' : role);

export interface ExportPolicy {
  allowed: boolean;
  roles: string[];
}

/** The organisation's switch and the project's export roles (the default four when the project has none of its own). */
export async function loadExportPolicy(db: Pool | PoolClient, projectId: string): Promise<ExportPolicy> {
  const allowed = (await loadAccessSettings(db)).projectExportsAllowed;
  const own = (await db.query<{ roles: string[] }>(`SELECT export_roles AS roles FROM project_output_settings WHERE project_id = $1`, [projectId])).rows[0];
  return { allowed, roles: own?.roles ?? [...DEFAULT_EXPORT_ROLES] };
}

/**
 * Export allowed = project exports allowed AND the person may read the project's content AND one of their current
 * roles (or an Active Audit/Oversight grant's kind) is among the export roles (spec 7.1). Open to any project state:
 * exports only read.
 */
export function mayExport(ctx: ProjectContext, policy: ExportPolicy): boolean {
  if (!policy.allowed || !canReadContent(ctx)) return false;
  return ctx.roles.some((r) => policy.roles.includes(exportRoleOf(r))) || ctx.grantKinds.some((k) => policy.roles.includes(k));
}
