import type { PoolClient } from 'pg';
import { queueStorageJob } from '../storage/outbox';

/**
 * Queuing SharePoint sharing work (spec 5.5) inside the caller's transaction, so it exists exactly when the change
 * does. Kept apart from `sharing.ts` (which does the work) so that the project, grant and account services can call it
 * without importing the storage and output readers machinery.
 *
 * Kainow's own access check needs no SharePoint step: hiding in Kainow is immediate. These jobs bring SharePoint into
 * line. Anything that can take access away is urgent (spec 5.5: removal is urgent); collisions with a job already
 * queued for the same folder or output refresh it, due now, at the higher priority.
 */

export type SharingPriority = 'urgent' | 'normal';

/** Shared folders (project folders and output folders) of a project, in every destination. */
const PROJECT_FOLDERS = `SELECT id FROM storage_folders WHERE level IN ('project', 'output') AND split_part(key, '/', 2) = $1::text ORDER BY id`;

/**
 * Re-syncs every shared folder of the project: its project folder (who may read the project's content) and each output
 * folder (whose readers follow the project's). Call on membership, Audit/Oversight grant and source-audience changes.
 * Urgent unless the caller knows the change only adds access (a join, an approval, a restore, an extension).
 */
export async function queueProjectSharing(c: PoolClient, projectId: string, priority: SharingPriority = 'urgent'): Promise<void> {
  const { rows } = await c.query<{ id: string }>(PROJECT_FOLDERS, [projectId]);
  for (const r of rows) await queueStorageJob(c, 'share-sync', r.id, { priority });
}

/** Re-syncs one shared folder. */
export async function queueFolderSharing(c: PoolClient, folderId: string, priority: SharingPriority = 'urgent'): Promise<void> {
  await queueStorageJob(c, 'share-sync', folderId, { priority });
}

/**
 * Re-syncs every shared folder that concerns a person: those holding a live grant of theirs (so a disabled account
 * loses them) and those of every project they belong to or hold Audit/Oversight access in (so a re-enabled account
 * gets them back once its memberships are restored).
 */
export async function queueUserSharing(c: PoolClient, userId: string, priority: SharingPriority = 'urgent'): Promise<void> {
  const { rows } = await c.query<{ id: string }>(
    `SELECT DISTINCT f.id FROM storage_folders f
      WHERE f.level IN ('project', 'output')
        AND (EXISTS (SELECT 1 FROM storage_grants g WHERE g.folder_id = f.id AND g.user_id = $1 AND g.state <> 'revoked')
             OR split_part(f.key, '/', 2) IN (SELECT project_id::text FROM memberships WHERE user_id = $1
                                               UNION SELECT project_id::text FROM access_grants WHERE user_id = $1))
      ORDER BY f.id`,
    [userId],
  );
  for (const r of rows) await queueStorageJob(c, 'share-sync', r.id, { priority });
}

/**
 * Moves the output's files to where its readers need them (spec 5.5, `place-output`), then syncs its output folder.
 * `narrow`: its readers are fewer than before (audience narrowed, review required, withdrawn, deleted, held): urgent,
 * and the files leave the project folder before anything else. `widen`: they are more (audience widened, review
 * cleared, restored, released): the files move back first and no grant is removed before that.
 */
export async function queueOutputPlacement(c: PoolClient, outputId: string, direction: 'narrow' | 'widen'): Promise<void> {
  await queueStorageJob(c, 'place-output', outputId, { priority: direction === 'narrow' ? 'urgent' : 'normal' });
}
