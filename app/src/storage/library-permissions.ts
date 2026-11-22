import type { Pool, PoolClient } from 'pg';
import type { PermissionInfo } from './types';

/**
 * The library permission rule (D103, spec 5.5), kept apart from the destinations service so the worker's daily checks
 * use the very same definition as approval without loading the Nest services.
 */

type Db = Pool | PoolClient;

/** Shown on a project using an output destination the daily check found open to others (names no one). */
export const PROJECT_LIBRARY_WARNING =
  'People beyond those Kainow shares with can open this project’s output library in SharePoint. The Administrators have been told.';

export interface LibraryAllowance {
  storageAdminUserEmails: string[];
  kainowGrantPermissionIds: Set<string>;
  /** A OneDrive destination's own account: its root lists the owner as a user. */
  oneDriveAccountEmail?: string | null;
}

/**
 * What the library permission check refuses (D103): everything except the site's owners group, Kainow's own application
 * and Kainow's own grants (for a OneDrive destination also its account; for the source area, storage Administrators).
 * The connector reports site collection administrators as site users, so they count as others until the real-tenant
 * probe confirms how they appear (`site_admin` is let through only once the connector can tell them apart).
 */
export function libraryPermissionProblems(perms: PermissionInfo[], allowed: LibraryAllowance): PermissionInfo[] {
  const admins = new Set(allowed.storageAdminUserEmails.map((e) => e.trim().toLowerCase()));
  return perms.filter((p) => {
    if (p.kind === 'owner_group' || p.kind === 'site_admin' || p.kind === 'app') return false;
    if (allowed.kainowGrantPermissionIds.has(p.id)) return false;
    if (p.kind === 'user' && admins.has(p.principal.trim().toLowerCase())) return false;
    if (p.kind === 'user' && allowed.oneDriveAccountEmail && p.principal.trim().toLowerCase() === allowed.oneDriveAccountEmail.trim().toLowerCase()) return false;
    return true;
  });
}

/**
 * What the library permission check allows on a destination: Kainow's own live grants there (never `external` ones),
 * and for the source area its designated storage Administrators. One definition for the approval check and the daily one.
 */
export async function libraryAllowance(
  db: Db, dest: { id: string; kind: string; purpose: string; account_email: string | null },
): Promise<LibraryAllowance> {
  return {
    oneDriveAccountEmail: dest.kind === 'onedrive' ? dest.account_email : null,
    storageAdminUserEmails: dest.purpose === 'source_area'
      ? (await db.query<{ email: string }>(
          `SELECT u.email FROM storage_admins a JOIN users u ON u.id = a.user_id WHERE a.ended_at IS NULL ORDER BY u.email`,
        )).rows.map((r) => r.email)
      : [],
    kainowGrantPermissionIds: new Set(
      (await db.query<{ permission_id: string }>(
        `SELECT g.permission_id FROM storage_grants g JOIN storage_folders f ON f.id = g.folder_id
          WHERE f.destination_id = $1 AND g.permission_id IS NOT NULL AND g.state IN ('pending', 'granted', 'revoking', 'failed')`,
        [dest.id],
      )).rows.map((r) => r.permission_id),
    ),
  };
}
