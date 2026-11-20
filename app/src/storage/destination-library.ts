import { uuidv7 } from '../common/uuid7';
import { loadAdmins } from '../notifications/recipients';
import { type StorageDeps, registerStorageDailyTask } from './jobs';
import { libraryAllowance, libraryPermissionProblems } from './library-permissions';
import { loadStorageAdmins } from './notices';
import { openToNames } from './source-area-access';
import type { PermissionInfo } from './types';

/**
 * The daily check of each approved (or retiring) output destination's library permissions (D103, spec 5.5): the same
 * rule as approval (`libraryPermissionProblems(libraryAllowance(...))`), applied to the destination root's permissions.
 * The result is recorded on the destination's last check (`libraryWarning` for the Storage page and the projects using
 * it, `libraryProblemIds` to remember what was already told). Each permission newly found open to others raises one
 * in-app notice to the Enterprise and storage Administrators; the same problem is not told again the next day. Filing
 * continues, and Kainow never removes those permissions itself.
 */

export const DESTINATION_LIBRARY_OPEN = 'destination_library_open';

/** Shown on the Storage page for the destination (the approval refusal's words, for a library already in use). */
export const libraryOpenWarning = (who: string): string => `Others can open everything in this library: ${who}. Limit the library to site owners.`;

/** The Administrator notice for a newly found problem. */
export const libraryOpenNotice = (label: string, who: string): string =>
  `Others can open everything in the output library "${label}": ${who}. Limit the library to site owners.`;

export { PROJECT_LIBRARY_WARNING } from './library-permissions';

interface DestRow { id: string; kind: string; purpose: string; account_email: string | null; label: string; known: string[] | null }

export async function dailyDestinationLibrary(deps: StorageDeps): Promise<void> {
  const dests = (
    await deps.pool.query<DestRow>(
      `SELECT id, kind, purpose, account_email, label,
              ARRAY(SELECT jsonb_array_elements_text(COALESCE(last_check->'libraryProblemIds', '[]'::jsonb))) AS known
         FROM storage_destinations
        WHERE purpose = 'outputs' AND status IN ('approved', 'retiring')
        ORDER BY created_at, id`,
    )
  ).rows;
  let failed = false;
  for (const d of dests) {
    let problems: PermissionInfo[];
    try {
      const { connector, dest } = await deps.connectors.forDestination(d.id);
      const perms = await connector.listPermissions(dest, dest.rootItemId);
      problems = libraryPermissionProblems(perms, await libraryAllowance(deps.pool, d))
        .sort((a, b) => a.principal.localeCompare(b.principal) || a.id.localeCompare(b.id));
    } catch {
      // A listing that fails leaves the last result as it was; the others are still checked.
      failed = true;
      continue;
    }
    const known = new Set(d.known ?? []);
    const fresh = problems.filter((p) => !known.has(p.id));
    const record = {
      libraryProblemIds: problems.map((p) => p.id),
      ...(problems.length ? { libraryWarning: libraryOpenWarning(openToNames(problems)) } : {}),
    };
    const c = await deps.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(
        `UPDATE storage_destinations
            SET last_check = (COALESCE(last_check, '{}'::jsonb) - 'libraryWarning' - 'libraryProblemIds') || $2::jsonb
          WHERE id = $1`,
        [d.id, JSON.stringify(record)],
      );
      if (fresh.length) {
        const at = deps.clock();
        const recipients = [...new Set([...(await loadAdmins(c)), ...(await loadStorageAdmins(c))])].sort();
        for (const p of fresh) {
          for (const userId of recipients) {
            await c.query(
              `INSERT INTO notifications (id, user_id, project_id, kind, urgent, summary, link, created_at, email_off)
               VALUES ($1, $2, NULL, $3, false, $4, '#/storage', $5, true)`,
              [uuidv7(at.getTime()), userId, DESTINATION_LIBRARY_OPEN, libraryOpenNotice(d.label, openToNames([p])), at],
            );
          }
        }
      }
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
  }
  if (failed) throw new Error('An output library could not be checked.');
}
registerStorageDailyTask('destination-library', dailyDestinationLibrary);
