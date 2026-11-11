import { Pool } from 'pg';
import { uuidv7 } from '../common/uuid7';
import { loadDatabaseConfig } from '../config';

/**
 * Demonstration data only: an empty database becomes "Example Organisation" at example.com, with the department
 * Operations and the Enterprise Administrator admin@example.com, already set up. No email is sent.
 */
export async function seedDemo(pool: Pool, at: Date): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const users = (await c.query(`SELECT count(*)::int AS n FROM users`)).rows[0].n;
    const orgs = (await c.query(`SELECT count(*)::int AS n FROM organisation`)).rows[0].n;
    if (users > 0 || orgs > 0) throw new Error('The demo seed needs an empty database.');
    const adminId = uuidv7(at.getTime());
    await c.query(
      `INSERT INTO users (id, email, display_name, role, status, created_at, updated_at) VALUES ($1, 'admin@example.com', 'Demo Administrator', 'enterprise_administrator', 'active', $2, $2)`,
      [adminId, at],
    );
    await c.query(`INSERT INTO eligible_domains (id, domain, added_by, added_at) VALUES ($1, 'example.com', $2, $3)`, [uuidv7(at.getTime()), adminId, at]);
    await c.query(`INSERT INTO departments (id, name, created_by, created_at) VALUES ($1, 'Operations', $2, $3)`, [uuidv7(at.getTime()), adminId, at]);
    await c.query(
      `INSERT INTO organisation (id, name, registered_by, registered_at, updated_by, updated_at) VALUES (1, 'Example Organisation', $1, $2, $1, $2)`,
      [adminId, at],
    );
    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
  }
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: loadDatabaseConfig().databaseUrl });
  try {
    await seedDemo(pool, new Date());
    console.log('Demo data only: "Example Organisation" (example.com) is set up. Sign in as admin@example.com.');
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
