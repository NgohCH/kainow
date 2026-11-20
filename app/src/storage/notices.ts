import type { Pool, PoolClient } from 'pg';
import type { AuthUser, Clock } from '../auth/tokens';
import { uuidv7 } from '../common/uuid7';
import { AudienceService } from '../discussion/audience.service';
import { loadAdmins } from '../notifications/recipients';
import { ProjectAccess } from '../projects/access.service';
import type { StorageNotice } from './jobs';
import { SOURCE_FILE_CHANGED, SOURCE_FILE_MISSING } from './source-files';

/**
 * The in-app notices storage work raises. Each kind is worded here; Task 13 and 17 add theirs. Storage notices go to the
 * Enterprise Administrators and to the storage Administrators (spec 8.4), in the app only.
 */
export type StorageNotify = (c: PoolClient, n: StorageNotice) => Promise<void>;

/** Active storage Administrators: designated and not ended, with an Active account. */
export async function loadStorageAdmins(c: Pool | PoolClient): Promise<string[]> {
  const { rows } = await c.query<{ user_id: string }>(
    `SELECT a.user_id FROM storage_admins a JOIN users u ON u.id = a.user_id
      WHERE a.ended_at IS NULL AND u.status = 'active' ORDER BY a.user_id`,
  );
  return rows.map((r) => r.user_id);
}

interface SourceFileRow {
  source_id: string; title: string; project_id: string; project_name: string; held: boolean;
}

export function makeStorageNotify(pool: Pool, clock: Clock): StorageNotify {
  const audiences = new AudienceService(pool, clock, new ProjectAccess(pool, clock));

  async function sourceFileChanged(c: PoolClient, n: StorageNotice, what: string): Promise<void> {
    const f = (
      await c.query<SourceFileRow>(
        `SELECT s.id AS source_id, s.title, p.id AS project_id, p.name AS project_name, s.held_case_id IS NOT NULL AS held
           FROM source_versions v
           JOIN sources s ON s.id = v.source_id
           JOIN projects p ON p.id = s.project_id
          WHERE v.original_stored_file_id = $1 OR v.text_stored_file_id = $1
          LIMIT 1`,
        [n.subjectId],
      )
    ).rows[0];
    if (!f) return;
    const recipients = [...new Set([...(await loadAdmins(c)), ...(await loadStorageAdmins(c))])].sort();
    const at = clock();
    for (const userId of recipients) {
      // The source's title is named only to people who may read the source today; everyone else hears of "a source".
      const user = (await c.query<{ id: string; email: string; display_name: string; role: string }>(
        `SELECT id, email, display_name, role FROM users WHERE id = $1`, [userId],
      )).rows[0];
      let readable = false;
      if (user && !f.held) {
        const who: AuthUser = { id: user.id, email: user.email, displayName: user.display_name, role: user.role };
        readable = await audiences.assertSourceReadable(who, f.source_id, c).then(() => true, () => false);
      }
      const text = readable
        ? `The file of source "${f.title}" in ${f.project_name} ${what}`
        : `A file of a source in ${f.project_name} ${what}`;
      await c.query(
        `INSERT INTO notifications (id, user_id, project_id, kind, urgent, summary, link, created_at, email_off)
         VALUES ($1, $2, $3, $4, false, $5, $6, $7, true)`,
        [uuidv7(at.getTime()), userId, f.project_id, n.kind, text, readable ? `#/notes/${f.source_id}` : `#/projects/${f.project_id}`, at],
      );
    }
  }

  return async (c, n) => {
    if (n.kind === SOURCE_FILE_CHANGED) {
      await sourceFileChanged(c, n, 'has changed in storage since Kainow recorded it. It has been flagged for the storage Administrators.');
    } else if (n.kind === SOURCE_FILE_MISSING) {
      await sourceFileChanged(c, n, 'is no longer in storage. It has been flagged for the storage Administrators.');
    }
    // Other kinds are worded by the features that raise them.
  };
}
