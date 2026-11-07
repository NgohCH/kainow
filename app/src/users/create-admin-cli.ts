import { Pool } from 'pg';
import { loadDatabaseConfig } from '../config';
import { UsersService } from './users.service';

/** Usage: npm run create-admin -- person@example.org "Display Name" */
async function main(): Promise<void> {
  const [email, displayName] = process.argv.slice(2);
  if (!email || !displayName) {
    throw new Error('Usage: npm run create-admin -- <email> "<display name>"');
  }
  const pool = new Pool({ connectionString: loadDatabaseConfig().databaseUrl });
  try {
    const user = await new UsersService(pool, () => new Date()).create({ email, displayName });
    console.log(`Created Enterprise Administrator ${user.email} (${user.id})`);
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
