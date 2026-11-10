import assert from 'node:assert/strict';
import { after, beforeEach, describe, test } from 'node:test';
import { Pool } from 'pg';
import { loadConfig } from '../config';
import { SKIP_NO_DB, resetPublicSchema, testDatabaseUrl } from '../testing/db';
import { CaptureSender, testEnv } from '../testing/fakes';
import { seedUser } from '../testing/projects';
import { GOLIVE_INIT_REFUSAL, goliveInit } from './golive-init';

describe('golive-init', { skip: SKIP_NO_DB }, () => {
  const config = loadConfig(testEnv(testDatabaseUrl() as string));
  const pool = new Pool({ connectionString: config.databaseUrl });
  const person = { email: 'first.admin@example.org', displayName: 'First Admin' };
  const now = new Date('2026-12-01T02:00:00Z');
  let sender: CaptureSender;

  beforeEach(async () => {
    await resetPublicSchema(pool);
    sender = new CaptureSender();
  });
  after(async () => {
    await pool.end();
  });

  const counts = async () => ({
    users: (await pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n,
    projects: (await pool.query('SELECT count(*)::int AS n FROM projects')).rows[0].n,
  });

  test('refuses a database that already holds a user and changes nothing', async () => {
    const { runMigrations } = await import('../db/migrate');
    await runMigrations(pool, config.migrationsDir);
    await seedUser(pool, 'someone@example.org');
    const before = await counts();
    await assert.rejects(goliveInit(pool, config, sender, config.migrationsDir, now, person), {
      message: 'This database already holds users or projects. golive-init only prepares a new, empty database.',
    });
    assert.equal(GOLIVE_INIT_REFUSAL, 'This database already holds users or projects. golive-init only prepares a new, empty database.');
    assert.deepEqual(await counts(), before);
    assert.equal(sender.setupInvitations.length, 0);
  });

  test('prepares an empty database: migrations, notices start, one setup invitation; a second run is refused', async () => {
    const sent = await goliveInit(pool, config, sender, config.migrationsDir, now, person);
    assert.equal(sent.email, person.email);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM golive_steps')).rows[0].n, 11);
    const nf = (await pool.query('SELECT notices_from FROM notification_settings WHERE id = 1')).rows[0].notices_from;
    assert.equal(new Date(nf).getTime(), now.getTime());
    assert.equal(sender.setupInvitations.length, 1);
    assert.equal(sender.setupInvitations[0].email, person.email);
    assert.equal((await counts()).users, 1);

    await assert.rejects(goliveInit(pool, config, sender, config.migrationsDir, now, person), { message: GOLIVE_INIT_REFUSAL });
    assert.equal(sender.setupInvitations.length, 1);
    assert.equal((await counts()).users, 1);
  });
});
