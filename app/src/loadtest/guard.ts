import type { Pool } from 'pg';

/** The seeded load-test organisation, and the check that a database is it (seed.ts makes it). Small, so the worker can import it. */

export const LOAD_ORGANISATION = 'Example Organisation';
export const LOAD_DOMAIN = 'example.org';
export const ADMIN_EMAIL = 'load-001@example.org';
/**
 * A run is allowed only on the seeded test organisation: its name and only domain are the seed's, the seeded
 * Administrator exists, and every account is a seeded load-NNN@example.org address.
 */
export async function assertLoadDatabase(pool: Pool): Promise<void> {
  const org = (await pool.query(`SELECT name FROM organisation WHERE id = 1`)).rows[0] as { name: string } | undefined;
  const domains = (await pool.query(`SELECT domain FROM eligible_domains ORDER BY domain`)).rows.map((r) => r.domain as string);
  const admin = (await pool.query(`SELECT 1 FROM users WHERE email = $1 AND role = 'enterprise_administrator'`, [ADMIN_EMAIL])).rows[0];
  const others = (await pool.query(`SELECT count(*)::int AS n FROM users WHERE email !~ '^load-[0-9]{3}@example\\.org$'`)).rows[0].n;
  if (!org || org.name !== LOAD_ORGANISATION || domains.join(',') !== LOAD_DOMAIN || !admin || others > 0) {
    throw new Error('Refusing to run: this database is not the seeded load-test organisation (run --seed on an empty test database first).');
  }
}
