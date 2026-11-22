import type { Pool, PoolClient } from 'pg';
import { type StorageDeps, registerStorageHandler } from '../storage/jobs';
import { StorageError } from '../storage/types';
import { moveNamed, recordedFolderPath, versionFileName } from './filing';
import { MAX_NAME, safeName } from './naming';

/**
 * The `rename-output` job (spec 4.7, 5.4; controller ruling for Task 17): names in storage follow the output's title,
 * so when a quarantine case cleans the title (a hold, a masked or confirmed copy) or a false-alarm release restores it,
 * the output's own folder and each of its filed files are renamed in storage to names derived from the title as it is
 * now, with the usual ` (n)` rules. What is recorded is always the name Kainow gave; the provider's own answer only
 * refreshes the link and change tags. An output whose title may still hold the secret (held by a case waiting for the
 * protected key) is left alone: nothing is ever named from an uncleaned title; the job is queued again when it is
 * cleaned. Withheld files are renamed by the withhold job as it moves them, and then removed.
 */

type Db = Pool | PoolClient;
const tailOf = (n: number): string => (n > 1 ? ` (${n})` : '');

/** Whether the output's title may still hold a secret: it is held for a case still waiting for the protected key. */
export async function titleUncleaned(db: Db, outputId: string): Promise<boolean> {
  const r = await db.query(
    `SELECT 1 FROM outputs o JOIN quarantine_cases qc ON qc.id = o.held_case_id WHERE o.id = $1 AND qc.waiting_for_key`,
    [outputId],
  );
  return (r.rowCount ?? 0) > 0;
}

/** One worker at a time per output, shared with placement (both move the output's files). */
async function exclusively(deps: StorageDeps, outputId: string, work: () => Promise<void>): Promise<void> {
  const lock = await deps.pool.connect();
  let broken: Error | undefined;
  try {
    const got = (await lock.query<{ ok: boolean }>(`SELECT pg_try_advisory_lock(hashtext('place-output'), hashtext($1)) AS ok`, [outputId])).rows[0].ok;
    if (!got) throw new StorageError('throttled', { retryAfterMs: 60_000 });
    try {
      await work();
    } finally {
      try {
        await lock.query(`SELECT pg_advisory_unlock(hashtext('place-output'), hashtext($1))`, [outputId]);
      } catch (err) {
        broken = err instanceof Error ? err : new Error('unlock failed');
      }
    }
  } finally {
    lock.release(broken);
  }
}

export async function renameOutput(deps: StorageDeps, outputId: string): Promise<void> {
  await exclusively(deps, outputId, async () => {
    const o = (await deps.pool.query<{ title: string; project_id: string }>(`SELECT title, project_id FROM outputs WHERE id = $1`, [outputId])).rows[0];
    if (!o || (await titleUncleaned(deps.pool, outputId))) return;

    // The output's own folders (one per destination it was filed in).
    const folders = (
      await deps.pool.query<{ id: string; destination_id: string; item_id: string; name: string; key: string }>(
        `SELECT id, destination_id, item_id, name, key FROM storage_folders WHERE level = 'output' AND split_part(key, '/', 4) = $1::text ORDER BY id`,
        [outputId],
      )
    ).rows;
    for (const f of folders) {
      const { connector, dest } = await deps.connectors.forDestination(f.destination_id);
      let item;
      try {
        item = await connector.getItem(dest, f.item_id);
      } catch (err) {
        if (err instanceof StorageError && err.code === 'not_found') continue;
        throw err;
      }
      const prefix = f.key.slice(0, f.key.lastIndexOf('/') + 1);
      for (let n = 1; n <= 20; n++) {
        const name = `${safeName(o.title, MAX_NAME - tailOf(n).length)}${tailOf(n)}`;
        // Another output folder of the project already recorded with the name is skipped without asking the provider.
        const taken = await deps.pool.query(
          `SELECT 1 FROM storage_folders WHERE destination_id = $1 AND level = 'output' AND key LIKE $2 AND id <> $3 AND lower(name) = lower($4)`,
          [f.destination_id, `${prefix}%`, f.id, name],
        );
        if (taken.rowCount) continue;
        if (item.name !== name) {
          try {
            await connector.move(dest, f.item_id, item.parentId, name);
          } catch (err) {
            if (err instanceof StorageError && err.code === 'conflict') continue;
            throw err;
          }
        }
        if (f.name !== name) await deps.pool.query(`UPDATE storage_folders SET name = $2 WHERE id = $1`, [f.id, name]);
        break;
      }
    }

    // Its filed files, in Kainow's folders.
    const files = (
      await deps.pool.query<{ id: string; destination_id: string; item_id: string; folder_id: string; name: string; path: string | null; version_no: number; format: string }>(
        `SELECT f.id, f.destination_id, f.item_id, f.folder_id, f.name, f.path, v.version_no, v.format
           FROM output_versions v JOIN stored_files f ON f.id = v.stored_file_id
          WHERE v.output_id = $1 AND f.state = 'stored' AND f.item_id IS NOT NULL AND f.destination_id IS NOT NULL AND f.folder_id IS NOT NULL
          ORDER BY v.version_no`,
        [outputId],
      )
    ).rows;
    for (const f of files) {
      const folderPath = await recordedFolderPath(deps.pool, f.folder_id);
      if (!folderPath) continue;
      const { connector, dest } = await deps.connectors.forDestination(f.destination_id);
      let item;
      try {
        item = await connector.getItem(dest, f.item_id);
      } catch (err) {
        if (err instanceof StorageError && err.code === 'not_found') continue; // left to the file checks
        throw err;
      }
      const wanted = versionFileName(folderPath, o.title, f.version_no, f.format);
      let name = item.name;
      let ref = item;
      if (item.name !== wanted) ({ ref, name } = await moveNamed(connector, dest, f.item_id, item.parentId, wanted));
      else name = wanted;
      const path = [...folderPath, name].join('/');
      if (name === f.name && path === f.path && ref === item) continue;
      await deps.pool.query(`UPDATE stored_files SET name = $2, path = $3, etag = $4, ctag = $5, web_url = $6 WHERE id = $1 AND state = 'stored'`, [
        f.id, name, path, ref.etag, ref.ctag, ref.webUrl,
      ]);
    }
  });
}

registerStorageHandler('rename-output', (deps, outputId) => renameOutput(deps, outputId));
