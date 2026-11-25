import type { Pool, PoolClient } from 'pg';
import type { AuthUser } from '../auth/tokens';
import type { ProjectAccess } from './access.service';

/** Where a project or proposal was copied from, as one person may know it: the name only where they may open the original. */
export type CopiedFrom = { id: string; name: string } | { hidden: true } | null;

/** The originals by id as this person may know them, by the rule `ProjectAccess.context` applies to opening a project. */
export async function copiedFromViews(
  db: Pool | PoolClient,
  access: ProjectAccess,
  user: AuthUser,
  ids: ReadonlyArray<string | null>,
): Promise<(id: string | null) => CopiedFrom> {
  const known = new Map<string, CopiedFrom>();
  for (const id of new Set(ids.filter((x): x is string => x !== null))) {
    const ctx = await access.load(id, user, db);
    const opens = ctx !== null && (ctx.roles.length > 0 || ctx.isAdmin || ctx.grantKinds.length > 0);
    known.set(id, opens ? { id, name: (await db.query(`SELECT name FROM projects WHERE id = $1`, [id])).rows[0].name as string } : { hidden: true });
  }
  return (id) => (id === null ? null : (known.get(id) ?? { hidden: true }));
}
