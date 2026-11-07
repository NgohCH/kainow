import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, mock, test } from 'node:test';
import { Pool } from 'pg';
import { loadConfig } from '../config';
import { runMigrations } from '../db/migrate';
import { SKIP_NO_DB, resetPublicSchema, testDatabaseUrl } from '../testing/db';
import { CaptureSender, FakeClock, differentCode, testEnv } from '../testing/fakes';
import { UsersService } from '../users/users.service';
import { AuthService } from './auth.service';

const EMAIL = 'admin@example.org';

describe('passwordless sign-in', { skip: SKIP_NO_DB }, () => {
  let pool: Pool;
  let sender: CaptureSender;
  let clock: FakeClock;
  let service: AuthService;
  let users: UsersService;
  const config = loadConfig(testEnv(testDatabaseUrl() ?? 'postgres://unused'));

  before(() => {
    pool = new Pool({ connectionString: testDatabaseUrl() });
  });
  after(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await resetPublicSchema(pool);
    await runMigrations(pool, config.migrationsDir);
    sender = new CaptureSender();
    clock = new FakeClock(Date.UTC(2026, 10, 9, 2, 0, 0));
    service = new AuthService(pool, config, sender, clock.now);
    users = new UsersService(pool, clock.now);
    await users.create({ email: EMAIL, displayName: 'Admin' });
  });
  afterEach(() => mock.restoreAll());

  const lockedUntil = async (): Promise<Date | null> =>
    (await pool.query('SELECT locked_until FROM users WHERE email = $1', [EMAIL])).rows[0].locked_until;
  const failedCount = async (): Promise<number> =>
    (await pool.query('SELECT failed_code_attempts AS n FROM users WHERE email = $1', [EMAIL])).rows[0].n;

  test('a correct code gives a session, and the code works only once', async () => {
    await service.requestCode(EMAIL);
    const code = sender.lastCode(EMAIL);
    assert.match(code, /^\d{6}$/);
    assert.equal(sender.sent[0].validForMinutes, 10);

    const result = await service.verifyCode(EMAIL, code);
    assert.ok(result);
    assert.equal(result.user.email, EMAIL);
    assert.equal(result.user.role, 'enterprise_administrator');
    assert.equal((await service.resolveSession(result.token))?.user.id, result.user.id);

    assert.equal(await service.verifyCode(EMAIL, code), null);
  });

  test('the address is matched without regard to case or spaces', async () => {
    await service.requestCode('  Admin@Example.ORG ');
    assert.equal(sender.sent.length, 1);
    assert.ok(await service.verifyCode(' ADMIN@example.org', sender.lastCode(EMAIL)));
  });

  test('an unknown address sends nothing and gives no sign of whether an account exists', async () => {
    await assert.doesNotReject(service.requestCode('nobody@example.org'));
    assert.equal(sender.sent.length, 0);
    assert.equal(await service.verifyCode('nobody@example.org', '123456'), null);
    const detail = (await pool.query(`SELECT string_agg(detail::text, ' ') AS d FROM audit_events`)).rows[0].d;
    assert.doesNotMatch(detail, /nobody@example\.org/);
  });

  test('a disabled account cannot sign in and its sessions stop working', async () => {
    const second = await users.create({ email: 'second@example.org', displayName: 'Second' });
    await service.requestCode(EMAIL);
    const session = await service.verifyCode(EMAIL, sender.lastCode(EMAIL));
    assert.ok(session);

    await users.disable(session.user.id, second.id);
    assert.equal(await service.resolveSession(session.token), null);

    clock.advanceMinutes(5);
    await service.requestCode(EMAIL);
    assert.equal(sender.sent.length, 1, 'no new code for a disabled account');
    assert.equal(await service.verifyCode(EMAIL, sender.lastCode(EMAIL)), null);
  });

  test('a code is valid for 10 minutes and not a second longer', async () => {
    await service.requestCode(EMAIL);
    const code = sender.lastCode(EMAIL);
    clock.advanceSeconds(10 * 60 - 1);
    assert.ok(await service.verifyCode(EMAIL, code), 'valid at 9:59');

    await resetPublicSchema(pool);
    await runMigrations(pool, config.migrationsDir);
    await users.create({ email: EMAIL, displayName: 'Admin' });
    await service.requestCode(EMAIL);
    const code2 = sender.lastCode(EMAIL);
    clock.advanceMinutes(10);
    assert.equal(await service.verifyCode(EMAIL, code2), null, 'expired at exactly 10:00');
  });

  test('five wrong codes lock the account for 30 minutes and the right code no longer works', async () => {
    await service.requestCode(EMAIL);
    const code = sender.lastCode(EMAIL);
    for (let i = 0; i < 5; i++) {
      assert.equal(await service.verifyCode(EMAIL, differentCode(code)), null);
    }
    assert.equal((await lockedUntil())?.getTime(), clock.ms + 30 * 60_000);
    assert.equal(await service.verifyCode(EMAIL, code), null, 'even the right code is refused');

    const before = sender.sent.length;
    clock.advanceMinutes(2);
    await service.requestCode(EMAIL);
    assert.equal(sender.sent.length, before, 'no code is sent during the lockout');

    clock.advanceMinutes(28);
    clock.advanceSeconds(1);
    await service.requestCode(EMAIL);
    assert.equal(sender.sent.length, before + 1);
    assert.ok(await service.verifyCode(EMAIL, sender.lastCode(EMAIL)), 'works after the lockout ends');
  });

  test('requesting new codes does not give extra guesses', async () => {
    await service.requestCode(EMAIL);
    for (let i = 0; i < 4; i++) {
      await service.verifyCode(EMAIL, differentCode(sender.lastCode(EMAIL)));
    }
    clock.advanceSeconds(61);
    await service.requestCode(EMAIL);
    assert.equal(sender.sent.length, 2);
    assert.equal(await lockedUntil(), null);
    await service.verifyCode(EMAIL, differentCode(sender.lastCode(EMAIL)));
    assert.notEqual(await lockedUntil(), null, 'the fifth wrong code in total locks the account');
  });

  test('guesses made at the same moment are still counted one by one', async () => {
    await service.requestCode(EMAIL);
    const wrong = differentCode(sender.lastCode(EMAIL));
    const results = await Promise.all(Array.from({ length: 8 }, () => service.verifyCode(EMAIL, wrong)));
    assert.ok(results.every((r) => r === null));
    assert.notEqual(await lockedUntil(), null);
  });

  test('a successful sign-in clears earlier wrong guesses', async () => {
    await service.requestCode(EMAIL);
    const code = sender.lastCode(EMAIL);
    for (let i = 0; i < 4; i++) {
      await service.verifyCode(EMAIL, differentCode(code));
    }
    assert.equal(await failedCount(), 4);
    assert.ok(await service.verifyCode(EMAIL, code));
    assert.equal(await failedCount(), 0);
  });

  test('a wrong guess does not use up the code', async () => {
    await service.requestCode(EMAIL);
    const code = sender.lastCode(EMAIL);
    assert.equal(await service.verifyCode(EMAIL, differentCode(code)), null);
    assert.ok(await service.verifyCode(EMAIL, code));
  });

  test('a code that is not six digits is refused without counting as a guess', async () => {
    await service.requestCode(EMAIL);
    for (const bad of ['abc', '12345', '1234567', '', '12 456']) {
      assert.equal(await service.verifyCode(EMAIL, bad), null);
    }
    assert.equal(await service.verifyCode(EMAIL, undefined), null);
    assert.equal(await failedCount(), 0);
  });

  test('a second request within 60 seconds is ignored; a later one replaces the earlier code', async () => {
    await service.requestCode(EMAIL);
    await service.requestCode(EMAIL);
    assert.equal(sender.sent.length, 1);

    const first = sender.lastCode(EMAIL);
    clock.advanceSeconds(61);
    await service.requestCode(EMAIL);
    assert.equal(sender.sent.length, 2);
    const second = sender.lastCode(EMAIL);
    if (first !== second) {
      assert.equal(await service.verifyCode(EMAIL, first), null, 'the older code no longer works');
    }
    assert.ok(await service.verifyCode(EMAIL, second));
  });

  test('a session lasts 12 hours', async () => {
    await service.requestCode(EMAIL);
    const session = await service.verifyCode(EMAIL, sender.lastCode(EMAIL));
    assert.ok(session);
    assert.equal(session.expiresAt.getTime(), clock.ms + 12 * 3_600_000);

    clock.advanceMinutes(12 * 60 - 1);
    assert.ok(await service.resolveSession(session.token), 'valid at 11:59');
    clock.advanceMinutes(2);
    assert.equal(await service.resolveSession(session.token), null, 'expired after 12:00');
  });

  test('signing out ends the session', async () => {
    await service.requestCode(EMAIL);
    const session = await service.verifyCode(EMAIL, sender.lastCode(EMAIL));
    assert.ok(session);
    const auth = await service.resolveSession(session.token);
    assert.ok(auth);
    await service.signOut(auth);
    assert.equal(await service.resolveSession(session.token), null);
  });

  test('an unknown session token is refused', async () => {
    assert.equal(await service.resolveSession('not-a-real-token'), null);
    assert.equal(await service.resolveSession(''), null);
  });

  test('only hashes are stored, never the code or the session token', async () => {
    await service.requestCode(EMAIL);
    const code = sender.lastCode(EMAIL);
    const session = await service.verifyCode(EMAIL, code);
    assert.ok(session);

    const stored = await pool.query('SELECT code_hash FROM login_codes');
    assert.match(stored.rows[0].code_hash, /^[0-9a-f]{64}$/);
    assert.notEqual(stored.rows[0].code_hash, code);
    const sessions = await pool.query('SELECT token_hash FROM sessions');
    assert.match(sessions.rows[0].token_hash, /^[0-9a-f]{64}$/);
    assert.notEqual(sessions.rows[0].token_hash, session.token);
  });

  test('the audit trail records sign-in events without codes or tokens', async () => {
    await service.requestCode(EMAIL);
    const code = sender.lastCode(EMAIL);
    await service.verifyCode(EMAIL, differentCode(code));
    const session = await service.verifyCode(EMAIL, code);
    assert.ok(session);

    const actions = (await pool.query('SELECT action FROM audit_events ORDER BY occurred_at, id')).rows.map((r) => r.action);
    for (const expected of ['user.created', 'auth.code_requested', 'auth.sign_in_failed', 'auth.signed_in']) {
      assert.ok(actions.includes(expected), `missing ${expected}`);
    }
    const everything = (await pool.query(`SELECT string_agg(detail::text, ' ') AS d FROM audit_events`)).rows[0].d;
    assert.ok(!everything.includes(session.token));
  });

  test('if the code cannot be delivered the caller sees nothing different, and it is recorded', async () => {
    mock.method(console, 'error', () => undefined);
    sender.failNext = true;
    await assert.doesNotReject(service.requestCode(EMAIL));
    const { rows } = await pool.query(`SELECT 1 FROM audit_events WHERE action = 'auth.code_send_failed'`);
    assert.equal(rows.length, 1);
  });
});
