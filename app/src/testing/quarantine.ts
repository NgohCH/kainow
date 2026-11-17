import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { AudienceService } from '../discussion/audience.service';
import { ProjectAccess } from '../projects/access.service';
import { CasesService } from '../quarantine/cases.service';
import { loadProtectedKey } from '../quarantine/protected-key';

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
