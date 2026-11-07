import { Pool } from 'pg';

/**
 * Database tests run only against a throwaway database named in KAINOW_TEST_DATABASE_URL.
 * Without it they skip cleanly and test nothing.
 */
export function testDatabaseUrl(): string | undefined {
  return process.env.KAINOW_TEST_DATABASE_URL || undefined;
}

export const SKIP_NO_DB = testDatabaseUrl() ? false : 'KAINOW_TEST_DATABASE_URL is not set';

/** Gives a test a clean public schema. Destroys everything in it, so test databases only. */
export async function resetPublicSchema(pool: Pool): Promise<void> {
  await pool.query('DROP SCHEMA public CASCADE');
  await pool.query('CREATE SCHEMA public');
}
