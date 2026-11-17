import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { AudienceService } from '../discussion/audience.service';
import { ProjectAccess } from '../projects/access.service';
import { CasesService } from '../quarantine/cases.service';
import { loadProtectedKey } from '../quarantine/protected-key';
import { TEXT_COLUMNS } from '../quarantine/registry';

/** A CasesService outside Nest, for tests that build runners from a bare pool; with a fresh protected key unless `withKey` is false. */
export function standaloneCases(pool: Pool, clock: () => Date, withKey = true): CasesService {
  let key = null;
  if (withKey) {
    const dir = mkdtempSync(join(tmpdir(), 'kainow-key-'));
    try {
      const file = join(dir, 'key');
      writeFileSync(file, randomBytes(32));
      key = loadProtectedKey(file);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const access = new ProjectAccess(pool, clock);
  return new CasesService(pool, clock, key, { appUrl: 'http://localhost' } as never, { nudge: async () => undefined }, access, new AudienceService(pool, clock, access));
}

/**
 * The registered columns (table.column) of the project holding `text` anywhere: every row of the project, items and
 * rows that belong to no item alike. JSON and arrays are searched in their text form. For the C1 race tests.
 */
export async function projectHolding(pool: Pool, projectId: string, text: string): Promise<string[]> {
  const out: string[] = [];
  for (const col of TEXT_COLUMNS) {
    if (col.binary) continue;
    const { rowCount } = await pool.query(`SELECT 1 FROM (${col.projectSql}) q WHERE strpos(q.value::text, $2) > 0 LIMIT 1`, [projectId, text]);
    if (rowCount) out.push(`${col.table}.${col.column}`);
  }
  return out;
}
