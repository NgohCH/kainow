import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
import { loadDatabaseConfig } from '../config';
import { runMigrations } from '../db/migrate';
import { uuidv7 } from '../common/uuid7';
import { SKIP_NO_DB, resetPublicSchema, testDatabaseUrl } from '../testing/db';
import { UsersService } from './users.service';

describe('user management', { skip: SKIP_NO_DB }, () => {
  let pool: Pool;
  let users: UsersService;
  const migrationsDir = loadDatabaseConfig({ DATABASE_URL: 'x' }).migrationsDir;

  before(() => {
    pool = new Pool({ connectionString: testDatabaseUrl() });
  });
  after(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await resetPublicSchema(pool);
    await runMigrations(pool, migrationsDir);
    users = new UsersService(pool, () => new Date());
  });

  test('creates an Enterprise Administrator with a normalised email and records it', async () => {
    const user = await users.create({ email: '  Mixed.Case@Example.ORG ', displayName: '  Ngoh  ' });
    assert.equal(user.email, 'mixed.case@example.org');
    assert.equal(user.displayName, 'Ngoh');
    assert.equal(user.role, 'enterprise_administrator');
    const audit = await pool.query(`SELECT subject_id FROM audit_events WHERE action = 'user.created'`);
    assert.equal(audit.rows[0].subject_id, user.id);
  });

  test('rejects a missing or invalid email, and a missing or oversized name', async () => {
    for (const email of [undefined, '', 'not-an-email', 'a@b', 42]) {
      await assert.rejects(users.create({ email, displayName: 'X' }), BadRequestException);
    }
    for (const displayName of [undefined, '', '   ', 'x'.repeat(201), 5]) {
      await assert.rejects(users.create({ email: 'ok@example.org', displayName }), BadRequestException);
    }
  });

  test('refuses a second user with the same email, whatever the case', async () => {
    await users.create({ email: 'one@example.org', displayName: 'One' });
    await assert.rejects(users.create({ email: 'ONE@example.org', displayName: 'Again' }), ConflictException);
  });

  test('the last active administrator cannot be disabled', async () => {
    const only = await users.create({ email: 'only@example.org', displayName: 'Only' });
    await assert.rejects(users.disable(only.id, only.id), ConflictException);
    const row = await pool.query('SELECT status FROM users WHERE id = $1', [only.id]);
    assert.equal(row.rows[0].status, 'active');
  });

  test('disabling keeps the user, ends their sessions and unused codes, and is recorded', async () => {
    const a = await users.create({ email: 'a@example.org', displayName: 'A' });
    const b = await users.create({ email: 'b@example.org', displayName: 'B' });
    await pool.query(`INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES ($1, $2, 'h', now() + interval '1 hour')`, [uuidv7(), a.id]);
    await pool.query(`INSERT INTO login_codes (id, user_id, code_hash, expires_at) VALUES ($1, $2, 'h', now() + interval '1 hour')`, [uuidv7(), a.id]);

    await users.disable(a.id, b.id);

    assert.equal((await pool.query('SELECT status FROM users WHERE id = $1', [a.id])).rows[0].status, 'disabled');
    assert.equal((await pool.query('SELECT revoked_at FROM sessions WHERE user_id = $1', [a.id])).rows[0].revoked_at !== null, true);
    assert.equal((await pool.query('SELECT consumed_at FROM login_codes WHERE user_id = $1', [a.id])).rows[0].consumed_at !== null, true);
    const audit = await pool.query(`SELECT actor_user_id FROM audit_events WHERE action = 'user.disabled' AND subject_id = $1`, [a.id]);
    assert.equal(audit.rows[0].actor_user_id, b.id);
  });

  test('disabling twice is harmless, and the remaining administrator is then protected', async () => {
    const a = await users.create({ email: 'a@example.org', displayName: 'A' });
    const b = await users.create({ email: 'b@example.org', displayName: 'B' });
    await users.disable(a.id, b.id);
    await assert.doesNotReject(users.disable(a.id, b.id));
    await assert.rejects(users.disable(b.id, b.id), ConflictException);
  });

  test('an unknown or malformed id is not found', async () => {
    await users.create({ email: 'a@example.org', displayName: 'A' });
    await assert.rejects(users.disable(uuidv7(), null), NotFoundException);
    await assert.rejects(users.disable('not-a-uuid', null), NotFoundException);
    await assert.rejects(users.disable("'; DROP TABLE users; --", null), NotFoundException);
  });
});
