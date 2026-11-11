import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { uuidv7 } from '../common/uuid7';
import { loadConfig } from '../config';
import { SETUP_CLOSED, SetupService } from '../organisation/setup.service';
import { SKIP_NO_DB, testDatabaseUrl } from '../testing/db';
import { CaptureSender, testEnv } from '../testing/fakes';
import { type TestApp, startTestApp } from '../testing/http';
import { seedProject, seedUser } from '../testing/projects';
import { RECOVERY, parseRecoverArgs, recoverAdmin, runRecoverAdmin } from './recover-admin';

describe('recover-admin argument parsing', () => {
  test('reads the email, the name, the reason and --dry-run in any order', () => {
    assert.deepEqual(parseRecoverArgs(['a@example.org', 'Ana Admin', '--reason', 'Both locked out']), {
      email: 'a@example.org', displayName: 'Ana Admin', reason: 'Both locked out', dryRun: false,
    });
    assert.deepEqual(parseRecoverArgs(['--dry-run', 'a@example.org', '--reason', 'Test', 'Ana Admin']), {
      email: 'a@example.org', displayName: 'Ana Admin', reason: 'Test', dryRun: true,
    });
    assert.deepEqual(parseRecoverArgs(['a@example.org', 'Ana Admin']), { email: 'a@example.org', displayName: 'Ana Admin', reason: undefined, dryRun: false });
  });
});

describe('recover-admin', { skip: SKIP_NO_DB }, () => {
  const config = loadConfig(testEnv(testDatabaseUrl() as string));
  let t: TestApp;
  let sender: CaptureSender;
  let oldId: string;
  const email = 'old.admin@example.org';
  const reason = 'Every Administrator lost mailbox access';

  beforeEach(async () => {
    t = await startTestApp();
    sender = t.sender;
    // A former Administrator, now disabled, with project history, a membership on hold and a past audit row.
    oldId = await seedUser(t.pool, email, 'enterprise_administrator');
    await t.pool.query(`INSERT INTO eligible_domains (id, domain, added_by, added_at) VALUES ($1, 'example.org', $2, now())`, [uuidv7(), oldId]);
    await seedProject(t.pool, { status: 'active', members: [{ userId: oldId, role: 'pm' }] });
    await t.pool.query(`UPDATE memberships SET held_at = now(), held_by = $1, hold_reason = 'Review' WHERE user_id = $1`, [oldId]);
    await t.pool.query(`INSERT INTO audit_events (id, occurred_at, actor_user_id, action) VALUES ($1, now(), $2, 'auth.signed_in')`, [uuidv7(), oldId]);
    await t.pool.query(`UPDATE users SET status = 'disabled' WHERE id = $1`, [oldId]);
  });
  afterEach(async () => {
    await t?.close();
  });

  const now = () => new Date(t.clock.now());
  const run = (opts: Partial<{ email: string; displayName: string; reason: string; dryRun: boolean }>) =>
    recoverAdmin(t.pool, config, sender, now(), { email, displayName: 'Old Admin', reason, dryRun: false, ...opts });
  const message = async (p: Promise<unknown>): Promise<string> => p.then(() => 'succeeded', (e: Error) => e.message);
  const snapshot = async () => ({
    users: (await t.pool.query(`SELECT id, email, display_name, role, status FROM users ORDER BY id`)).rows,
    invitations: (await t.pool.query(`SELECT id, superseded_at, accepted_at FROM setup_invitations ORDER BY id`)).rows,
    audit: (await t.pool.query(`SELECT count(*)::int AS n FROM audit_events`)).rows[0].n,
    memberships: (await t.pool.query(`SELECT * FROM memberships ORDER BY id`)).rows,
    sent: sender.setupInvitations.length,
  });

  test('a missing or blank reason is refused first, and nothing changes', async () => {
    const before = await snapshot();
    for (const r of [undefined, '', '   ']) {
      assert.equal(await message(run({ reason: r as string })), 'Give a reason with --reason "<why>".');
      assert.equal(await message(run({ reason: r as string, dryRun: true })), 'Give a reason with --reason "<why>".');
    }
    assert.equal(RECOVERY.noReason, 'Give a reason with --reason "<why>".');
    assert.deepEqual(await snapshot(), before);
  });

  test('an organisation that is not registered is refused, and nothing changes', async () => {
    await t.pool.query(`UPDATE organisation SET registered_at = NULL`);
    const before = await snapshot();
    assert.equal(await message(run({})), 'Kainow is not set up yet; use golive-init or setup-invite instead.');
    assert.equal(await message(run({ dryRun: true })), 'Kainow is not set up yet; use golive-init or setup-invite instead.');
    await t.pool.query(`DELETE FROM organisation`);
    assert.equal(await message(run({})), 'Kainow is not set up yet; use golive-init or setup-invite instead.');
    assert.deepEqual({ ...(await snapshot()) }, before);
  });

  test('while an Administrator is active, recovery is refused and nothing changes', async () => {
    await seedUser(t.pool, 'still.here@example.org', 'enterprise_administrator');
    const before = await snapshot();
    assert.equal(await message(run({})), 'An Administrator is still active; recovery is only for when none is.');
    assert.deepEqual(await snapshot(), before);
  });

  test('an email outside the eligible domains is refused, and nothing changes', async () => {
    const before = await snapshot();
    for (const e of ['someone@elsewhere.test', 'not-an-email']) {
      assert.equal(await message(run({ email: e })), 'That email is not on an eligible domain.');
      assert.equal(await message(run({ email: e, dryRun: true })), 'That email is not on an eligible domain.');
    }
    await t.pool.query(`INSERT INTO eligible_domains (id, domain, added_by, added_at, removed_by, removed_at) VALUES ($1, 'example.net', $2, now(), $2, now())`, [uuidv7(), oldId]);
    assert.equal(await message(run({ email: 'old@example.net' })), 'That email is not on an eligible domain.', 'a removed domain is not current');
    const after = await snapshot();
    assert.deepEqual({ ...after }, before);
  });

  test('recovery reuses the disabled account: same id, history and memberships untouched, audited; signing in makes it an Active Administrator', async () => {
    const before = await snapshot();
    const lines = await run({});
    assert.deepEqual(lines, [
      'Recovery link sent to old.admin@example.org. It expires on 2026-11-16 02:00 UTC.',
      'When they sign in with it, they become an Enterprise Administrator. Their project roles are not restored.',
    ]);
    const user = (await t.pool.query(`SELECT id, role, status, display_name FROM users WHERE email = $1`, [email])).rows;
    assert.deepEqual(user, [{ id: oldId, role: 'enterprise_administrator', status: 'invited', display_name: 'Old Admin' }]);
    assert.equal(sender.setupInvitations.length, 1);
    assert.match(sender.setupInvitations[0].link, /\/#\/setup\/[A-Za-z0-9_-]{40,}$/);
    const audit = (await t.pool.query(`SELECT actor_user_id, subject_type, subject_id, detail FROM audit_events WHERE action = 'admin.recovery_issued'`)).rows;
    assert.deepEqual(audit, [{ actor_user_id: null, subject_type: 'user', subject_id: oldId, detail: { reason, userId: oldId, email } }]);
    assert.equal((await t.pool.query(`SELECT count(*)::int AS n FROM audit_events WHERE actor_user_id = $1 AND action = 'auth.signed_in'`, [oldId])).rows[0].n, 1, 'history still linked');
    assert.deepEqual((await snapshot()).memberships, before.memberships, 'memberships and holds untouched');

    await t.signIn(email);
    const after = (await t.pool.query(`SELECT id, role, status FROM users WHERE email = $1`, [email])).rows[0];
    assert.deepEqual(after, { id: oldId, role: 'enterprise_administrator', status: 'active' });
    assert.equal((await t.pool.query(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'setup.accepted' AND subject_id = $1`, [oldId])).rows[0].n, 1);
    assert.deepEqual((await snapshot()).memberships, before.memberships, 'no project access restored');
    assert.equal(await message(run({})), 'An Administrator is still active; recovery is only for when none is.');
  });

  test('the display name is kept unless one is given', async () => {
    await t.pool.query(`UPDATE users SET display_name = 'Kept Name' WHERE id = $1`, [oldId]);
    await recoverAdmin(t.pool, config, sender, now(), { email, reason, dryRun: false });
    assert.equal((await t.pool.query(`SELECT display_name FROM users WHERE id = $1`, [oldId])).rows[0].display_name, 'Kept Name');
  });

  test('recovery for an address with no account creates an Invited Administrator', async () => {
    const lines = await run({ email: 'new.admin@example.org', displayName: 'New Admin' });
    assert.equal(lines[0], 'Recovery link sent to new.admin@example.org. It expires on 2026-11-16 02:00 UTC.');
    const user = (await t.pool.query(`SELECT id, role, status, display_name FROM users WHERE email = 'new.admin@example.org'`)).rows[0];
    assert.deepEqual([user.role, user.status, user.display_name], ['enterprise_administrator', 'invited', 'New Admin']);
    const audit = (await t.pool.query(`SELECT detail FROM audit_events WHERE action = 'admin.recovery_issued'`)).rows[0];
    assert.deepEqual(audit.detail, { reason, userId: user.id, email: 'new.admin@example.org' });
    assert.equal((await t.pool.query(`SELECT status FROM users WHERE id = $1`, [oldId])).rows[0].status, 'disabled', 'the old account stays disabled');
  });

  test('a dry run changes nothing and sends nothing, in both states', async () => {
    const before = await snapshot();
    assert.deepEqual(await run({ dryRun: true }), ['Dry run: all checks passed; a recovery link would be sent to old.admin@example.org.']);
    assert.deepEqual(await snapshot(), before);

    await seedUser(t.pool, 'still.here@example.org', 'enterprise_administrator');
    const withAdmin = await snapshot();
    assert.deepEqual(await run({ dryRun: true }), ['Would be refused now: an Administrator is active. All other checks passed.']);
    assert.deepEqual(await snapshot(), withAdmin);
  });

  test('the command exits 0 on success and on a dry run, and 1 on a refusal', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const deps = { pool: t.pool, config, sender, now: now(), out: (s: string) => out.push(s), err: (s: string) => err.push(s) };
    assert.equal(await runRecoverAdmin([email, 'Old Admin', '--reason', reason, '--dry-run'], deps), 0);
    assert.deepEqual(out, ['Dry run: all checks passed; a recovery link would be sent to old.admin@example.org.']);
    assert.equal(await runRecoverAdmin([email, 'Old Admin'], deps), 1);
    assert.deepEqual(err, ['Give a reason with --reason "<why>".']);
    assert.equal(await runRecoverAdmin([email, 'Old Admin', '--reason', reason], deps), 0);
    assert.equal(out.at(-1), 'When they sign in with it, they become an Enterprise Administrator. Their project roles are not restored.');
  });

  test('when the email fails, the link stays recorded, the message says to run again, and the command exits non-zero; running again supersedes it', async () => {
    const failing = new CaptureSender();
    failing.sendSetupInvitation = async () => {
      throw new Error('535 authentication failed for secret-value-123');
    };
    const err: string[] = [];
    const code = await runRecoverAdmin([email, 'Old Admin', '--reason', reason], { pool: t.pool, config, sender: failing, now: now(), out: () => undefined, err: (s) => err.push(s) });
    assert.equal(code, 1);
    assert.deepEqual(err, [
      'The recovery link was recorded, but the email could not be sent: the email service did not accept it. Run the same command again to send a new link.',
    ]);
    assert.ok(!err.join('').includes('secret-value-123'), 'the cause is never printed');
    const first = (await t.pool.query(`SELECT id FROM setup_invitations`)).rows;
    assert.equal(first.length, 1, 'recorded');
    assert.equal((await t.pool.query(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'admin.recovery_issued'`)).rows[0].n, 1);

    t.clock.advanceSeconds(60);
    await run({});
    const rows = (await t.pool.query(`SELECT id, superseded_at FROM setup_invitations ORDER BY created_at, id`)).rows;
    assert.equal(rows.length, 2);
    assert.ok(rows[0].superseded_at, 'the first link is superseded');
    assert.equal(rows[1].superseded_at, null);
    assert.equal(sender.setupInvitations.length, 1);
  });

  test("setup-invite's own refusal is unchanged while an Administrator is active", async () => {
    await seedUser(t.pool, 'still.here@example.org', 'enterprise_administrator');
    const setup = new SetupService(t.pool, config, sender);
    assert.equal(await message(setup.issue({ email: 'first@example.org', displayName: 'First Admin' }, now())), SETUP_CLOSED);
    assert.equal(SETUP_CLOSED, 'Setup is closed: an Enterprise Administrator already exists. Add Administrators from the Administrators screen.');
  });
});
