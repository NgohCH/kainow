import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { uuidv7 } from '../common/uuid7';
import { loadConfig } from '../config';
import { SETUP_REGISTERED, SetupService } from '../organisation/setup.service';
import { SKIP_NO_DB, testDatabaseUrl } from '../testing/db';
import { CaptureSender, testEnv } from '../testing/fakes';
import { type TestApp, startTestApp } from '../testing/http';
import { seedProject, seedUser } from '../testing/projects';
import { RECOVERY, parseRecoverArgs, recoverAdmin, runRecoverAdmin } from './recover-admin';

const ACTIVE_REFUSAL =
  'An Administrator is still active; recovery is only for when none is. If no Administrator can sign in, add --disable-active-administrators to disable them first.';

describe('recover-admin argument parsing', () => {
  test('reads the email, the name, the reason, --dry-run and --disable-active-administrators in any order', () => {
    assert.deepEqual(parseRecoverArgs(['a@example.org', 'Ana Admin', '--reason', 'Both locked out']), {
      email: 'a@example.org', displayName: 'Ana Admin', reason: 'Both locked out', dryRun: false, disableActive: false,
    });
    assert.deepEqual(parseRecoverArgs(['--dry-run', 'a@example.org', '--reason', 'Test', 'Ana Admin', '--disable-active-administrators']), {
      email: 'a@example.org', displayName: 'Ana Admin', reason: 'Test', dryRun: true, disableActive: true,
    });
    assert.deepEqual(parseRecoverArgs(['a@example.org', 'Ana Admin']), {
      email: 'a@example.org', displayName: 'Ana Admin', reason: undefined, dryRun: false, disableActive: false,
    });
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
  type Opts = Partial<{ email: string; displayName: string; reason: string; dryRun: boolean; disableActive: boolean }>;
  const run = (opts: Opts, nudge?: { nudge(): Promise<void> }) =>
    recoverAdmin(t.pool, config, sender, now(), { email, displayName: 'Old Admin', reason, dryRun: false, disableActive: false, ...opts }, nudge);
  const message = async (p: Promise<unknown>): Promise<string> => p.then(() => 'succeeded', (e: Error) => e.message);
  const snapshot = async () => ({
    users: (await t.pool.query(`SELECT id, email, display_name, role, status FROM users ORDER BY id`)).rows,
    invitations: (await t.pool.query(`SELECT id, superseded_at, accepted_at FROM setup_invitations ORDER BY id`)).rows,
    audit: (await t.pool.query(`SELECT count(*)::int AS n FROM audit_events`)).rows[0].n,
    memberships: (await t.pool.query(`SELECT * FROM memberships ORDER BY id`)).rows,
    sessions: (await t.pool.query(`SELECT id, revoked_at FROM sessions ORDER BY id`)).rows,
    outbox: (await t.pool.query(`SELECT count(*)::int AS n FROM email_outbox`)).rows[0].n,
    sent: sender.setupInvitations.length,
  });
  const userRow = async (address: string) => (await t.pool.query(`SELECT id, role, status FROM users WHERE email = $1`, [address])).rows[0];
  const auditRows = async (action: string) =>
    (await t.pool.query(`SELECT actor_user_id, subject_id, detail FROM audit_events WHERE action = $1 ORDER BY occurred_at, id`, [action])).rows;
  /** Signs in through the HTTP flow and gives the verify answer (status and body), without the test helper's assertion. */
  const verify = async (address: string) => {
    await t.anonymous('POST', '/auth/request-code', { email: address });
    const reply = await t.anonymous('POST', '/auth/verify', { email: address, code: sender.lastCode(address) });
    t.clock.advanceSeconds(61);
    return reply;
  };

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

  test('while an Administrator is active, recovery without the flag is refused with how to proceed, and nothing changes', async () => {
    await seedUser(t.pool, 'still.here@example.org', 'enterprise_administrator');
    const before = await snapshot();
    assert.equal(await message(run({})), ACTIVE_REFUSAL);
    assert.equal(RECOVERY.adminActive, ACTIVE_REFUSAL);
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

  test('a new person needs a display name, in a dry run as in a real run, and nothing changes', async () => {
    const before = await snapshot();
    const msg = 'A display name of 1 to 200 characters is required for a new person.';
    assert.equal(await message(run({ email: 'new.admin@example.org', displayName: undefined })), msg);
    assert.equal(await message(run({ email: 'new.admin@example.org', displayName: undefined, dryRun: true })), msg);
    assert.equal(await message(run({ email: 'new.admin@example.org', displayName: '   ', dryRun: true })), msg);
    assert.deepEqual(await snapshot(), before);
  });

  test('real recovery end to end: refused, dry run, both Administrators disabled through the shared path, link accepted at sign-in, one re-enabled', async () => {
    // Two Active Administrators who can no longer be reached; Ana is the Project Manager of a project with a Sponsor.
    const anaId = await seedUser(t.pool, 'ana.admin@example.org', 'enterprise_administrator');
    const benId = await seedUser(t.pool, 'ben.admin@example.org', 'enterprise_administrator');
    const sponsorId = await seedUser(t.pool, 'sponsor@example.org');
    const projectId = await seedProject(t.pool, { status: 'active', name: 'Harbour', members: [{ userId: anaId, role: 'pm' }, { userId: sponsorId, role: 'sponsor' }] });
    const ana = await t.signIn('ana.admin@example.org');
    assert.equal((await ana.request('GET', '/auth/me')).status, 200);
    const recipientMemberships = (await t.pool.query(`SELECT * FROM memberships WHERE user_id = $1 ORDER BY id`, [oldId])).rows;

    // 1. Without the flag: refused, nothing changes.
    const before = await snapshot();
    assert.equal(await message(run({})), ACTIVE_REFUSAL);
    assert.deepEqual(await snapshot(), before);

    // 2. Dry runs list who would be disabled and change nothing.
    assert.deepEqual(await run({ dryRun: true }), [
      'Dry run: these Administrators would be disabled first: ana.admin ana.admin@example.org, ben.admin ben.admin@example.org',
      'Would be refused now: an Administrator is active. All other checks passed.',
      'With --disable-active-administrators, they would be disabled first and a recovery link would be sent to old.admin@example.org.',
    ]);
    assert.deepEqual(await run({ dryRun: true, disableActive: true }), [
      'Dry run: these Administrators would be disabled first: ana.admin ana.admin@example.org, ben.admin ben.admin@example.org',
      'Dry run: all checks passed; a recovery link would be sent to old.admin@example.org.',
    ]);
    assert.deepEqual(await snapshot(), before);

    // 3. The real run with the flag.
    let nudged = 0;
    const lines = await run({ disableActive: true }, { nudge: async () => void (nudged += 1) });
    assert.deepEqual(lines, [
      'These Administrators were disabled first: ana.admin ana.admin@example.org, ben.admin ben.admin@example.org',
      // Ana's sign-in above moved the test clock on by 61 seconds.
      'Recovery link sent to old.admin@example.org. It expires on 2026-11-16 02:01 UTC.',
      'When they sign in with it, they become an Enterprise Administrator. Their project roles are not restored.',
    ]);
    assert.equal(nudged, 1, 'the email worker is nudged once, after commit');
    assert.deepEqual(await userRow('ana.admin@example.org'), { id: anaId, role: 'enterprise_administrator', status: 'disabled' });
    assert.deepEqual(await userRow('ben.admin@example.org'), { id: benId, role: 'enterprise_administrator', status: 'disabled' });
    assert.equal((await ana.request('GET', '/auth/me')).status, 401, 'sessions revoked');
    const held = (await t.pool.query(`SELECT held_at, held_by, hold_reason FROM memberships WHERE user_id = $1`, [anaId])).rows;
    assert.equal(held.length, 1);
    assert.ok(held[0].held_at);
    assert.deepEqual([held[0].held_by, held[0].hold_reason], [null, 'Account disabled']);
    const outbox = await t.outbox();
    const alerts = outbox.filter((r) => r.kind === 'hold_alert');
    assert.deepEqual(alerts.map((r) => [r.to_address, r.project_id]), [['sponsor@example.org', projectId]]);
    const notices = outbox.filter((r) => r.kind === 'recovery_notice');
    assert.deepEqual(notices.map((r) => [r.to_address, r.subject]), [
      ['ana.admin@example.org', 'Your Kainow Administrator access was disabled'],
      ['ben.admin@example.org', 'Your Kainow Administrator access was disabled'],
    ]);
    for (const n of notices) {
      assert.ok(
        n.text_body.includes(
          'Your Kainow Administrator account was disabled on Mon 9 Nov 2026, 10:01 (UTC+8) so that Administrator access could be restored. ' +
            'Reason given: Every Administrator lost mailbox access. If you did not expect this, contact your organisation\'s recovery custodian.',
        ),
        n.text_body,
      );
      assert.ok(!n.text_body.includes('/#/setup/'), 'never the recovery link');
      assert.ok(!n.text_body.includes(n.to_address), "never the recipient's address");
      assert.ok(!n.text_body.includes(email), 'never the recovery address');
    }
    const notRow = (await t.pool.query(`SELECT to_user_id, relevance FROM email_outbox WHERE kind = 'recovery_notice'`)).rows;
    assert.deepEqual(notRow, [{ to_user_id: null, relevance: null }, { to_user_id: null, relevance: null }], 'no eligibility scope');
    const disabledAudits = await auditRows('user.disabled');
    assert.deepEqual(disabledAudits, [
      { actor_user_id: null, subject_id: anaId, detail: { heldProjects: 1, by: 'recovery', reason } },
      { actor_user_id: null, subject_id: benId, detail: { heldProjects: 0, by: 'recovery', reason } },
    ]);
    const invitation = (await t.pool.query(`SELECT user_id, kind, prior_role, prior_status FROM setup_invitations`)).rows;
    assert.deepEqual(invitation, [{ user_id: oldId, kind: 'recovery', prior_role: 'enterprise_administrator', prior_status: 'disabled' }]);
    assert.deepEqual(await auditRows('admin.recovery_issued'), [
      {
        actor_user_id: null,
        subject_id: oldId,
        detail: { reason, userId: oldId, email, priorRole: 'enterprise_administrator', priorStatus: 'disabled', disabledAdministrators: [anaId, benId] },
      },
    ]);
    assert.equal(sender.setupInvitations.length, 1);
    assert.equal(sender.setupInvitations[0].kind, 'recovery');
    const token = sender.setupInvitations[0].link.split('/#/setup/')[1];
    assert.deepEqual((await t.anonymous('GET', `/setup/${token}`)).body, { state: 'valid', email, kind: 'recovery' });

    // 4. The recipient signs in through the HTTP flow and becomes an Active Enterprise Administrator.
    const recovered = await t.signIn(email);
    assert.deepEqual(await userRow(email), { id: oldId, role: 'enterprise_administrator', status: 'active' });
    assert.equal((await auditRows('admin.recovery_accepted')).length, 1);
    assert.equal((await auditRows('setup.accepted')).length, 0);
    assert.deepEqual((await t.pool.query(`SELECT * FROM memberships WHERE user_id = $1 ORDER BY id`, [oldId])).rows, recipientMemberships, 'own memberships unchanged');

    // 5. The new Administrator re-enables Ana through the existing endpoint.
    assert.equal((await recovered.request('POST', `/users/${anaId}/enable`)).status, 204);
    assert.equal((await userRow('ana.admin@example.org')).status, 'active');
  });

  test('the recovery link cannot go to an Administrator who is being disabled, and nothing changes', async () => {
    await seedUser(t.pool, 'ana.admin@example.org', 'enterprise_administrator');
    const before = await snapshot();
    const msg = 'The recovery link cannot go to an Administrator who is being disabled.';
    assert.equal(await message(run({ email: 'ana.admin@example.org', disableActive: true })), msg);
    assert.equal(await message(run({ email: 'ana.admin@example.org', disableActive: true, dryRun: true })), msg);
    assert.deepEqual(await snapshot(), before);
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
    assert.deepEqual(await auditRows('admin.recovery_issued'), [
      {
        actor_user_id: null,
        subject_id: oldId,
        detail: { reason, userId: oldId, email, priorRole: 'enterprise_administrator', priorStatus: 'disabled', disabledAdministrators: [] },
      },
    ]);
    assert.equal((await t.pool.query(`SELECT count(*)::int AS n FROM audit_events WHERE actor_user_id = $1 AND action = 'auth.signed_in'`, [oldId])).rows[0].n, 1, 'history still linked');
    assert.deepEqual((await snapshot()).memberships, before.memberships, 'memberships and holds untouched');

    await t.signIn(email);
    assert.deepEqual(await userRow(email), { id: oldId, role: 'enterprise_administrator', status: 'active' });
    assert.equal((await auditRows('admin.recovery_accepted')).filter((r) => r.subject_id === oldId).length, 1);
    assert.deepEqual((await snapshot()).memberships, before.memberships, 'no project access restored');
    assert.equal(await message(run({})), ACTIVE_REFUSAL);
  });

  test('an Active member who is the recipient keeps their role and status until they accept', async () => {
    const miaId = await seedUser(t.pool, 'mia@example.org');
    await seedProject(t.pool, { status: 'active', members: [{ userId: miaId, role: 'member' }] });
    const memberships = (await t.pool.query(`SELECT * FROM memberships WHERE user_id = $1 ORDER BY id`, [miaId])).rows;
    await run({ email: 'mia@example.org', displayName: undefined });
    assert.deepEqual(await userRow('mia@example.org'), { id: miaId, role: 'member', status: 'active' }, 'unchanged on issue');
    const detail = (await auditRows('admin.recovery_issued'))[0].detail;
    assert.deepEqual([detail.priorRole, detail.priorStatus], ['member', 'active']);
    await t.signIn('mia@example.org');
    assert.deepEqual(await userRow('mia@example.org'), { id: miaId, role: 'enterprise_administrator', status: 'active' });
    assert.equal((await auditRows('admin.recovery_accepted')).length, 1);
    assert.deepEqual((await t.pool.query(`SELECT * FROM memberships WHERE user_id = $1 ORDER BY id`, [miaId])).rows, memberships);
  });

  test('a superseded or expired recovery link restores the reused account it changed; an account the link created is disabled', async () => {
    const zoeId = await seedUser(t.pool, 'zoe@example.org');
    await t.pool.query(`UPDATE users SET status = 'disabled' WHERE id = $1`, [zoeId]);
    await run({ email: 'zoe@example.org', displayName: undefined });
    assert.deepEqual(await userRow('zoe@example.org'), { id: zoeId, role: 'member', status: 'invited' }, 'invited to sign in, role kept');
    t.clock.advanceSeconds(60);
    await run({ email: 'zoe@example.org', displayName: undefined });
    assert.deepEqual(await userRow('zoe@example.org'), { id: zoeId, role: 'member', status: 'invited' }, 'the same address again keeps it invited');
    t.clock.advanceSeconds(60);
    await run({ email: 'new.admin@example.org', displayName: 'New Admin' });
    assert.deepEqual(await userRow('zoe@example.org'), { id: zoeId, role: 'member', status: 'disabled' }, 'restored, not merely disabled');

    // Found expired at the next run: the account the link created is disabled.
    t.clock.advanceSeconds(7 * 24 * 3600 + 1);
    await run({});
    const created = await userRow('new.admin@example.org');
    assert.deepEqual([created.role, created.status], ['enterprise_administrator', 'disabled']);
    assert.equal((await userRow(email)).status, 'invited');

    // And an expired link for a reused account is restored at the next run.
    t.clock.advanceSeconds(7 * 24 * 3600 + 1);
    await run({ email: 'new.admin@example.org' });
    assert.deepEqual(await userRow(email), { id: oldId, role: 'enterprise_administrator', status: 'disabled' });
  });

  test('acceptance is refused once an Administrator is active again, and the link is superseded', async () => {
    await run({});
    await seedUser(t.pool, 'late.admin@example.org', 'enterprise_administrator');
    const reply = await verify(email);
    assert.equal(reply.status, 409);
    assert.equal((reply.body as { message: string }).message, 'This recovery link can no longer be used: an Administrator is active.');
    assert.ok((await t.pool.query(`SELECT superseded_at FROM setup_invitations`)).rows[0].superseded_at, 'superseded');
    assert.deepEqual(await userRow(email), { id: oldId, role: 'enterprise_administrator', status: 'disabled' }, 'restored');
    assert.equal((await auditRows('admin.recovery_accepted')).length, 0);
    assert.equal((await t.pool.query(`SELECT count(*)::int AS n FROM sessions WHERE user_id = $1`, [oldId])).rows[0].n, 0, 'no session');
  });

  test('an Active member refused at acceptance can still sign in as before, without becoming an Administrator', async () => {
    const miaId = await seedUser(t.pool, 'mia@example.org');
    await run({ email: 'mia@example.org', displayName: undefined });
    await seedUser(t.pool, 'late.admin@example.org', 'enterprise_administrator');
    assert.equal((await verify('mia@example.org')).status, 409);
    assert.equal((await verify('mia@example.org')).status, 200);
    assert.deepEqual(await userRow('mia@example.org'), { id: miaId, role: 'member', status: 'active' });
  });

  test('an address with no account gets a new Invited Administrator', async () => {
    const lines = await run({ email: 'new.admin@example.org', displayName: 'New Admin' });
    assert.equal(lines[0], 'Recovery link sent to new.admin@example.org. It expires on 2026-11-16 02:00 UTC.');
    const user = (await t.pool.query(`SELECT id, role, status, display_name FROM users WHERE email = 'new.admin@example.org'`)).rows[0];
    assert.deepEqual([user.role, user.status, user.display_name], ['enterprise_administrator', 'invited', 'New Admin']);
    assert.deepEqual((await auditRows('admin.recovery_issued'))[0].detail, {
      reason, userId: user.id, email: 'new.admin@example.org', priorRole: null, priorStatus: null, disabledAdministrators: [],
    });
    assert.equal((await t.pool.query(`SELECT status FROM users WHERE id = $1`, [oldId])).rows[0].status, 'disabled', 'the old account stays disabled');
  });

  test('the display name is kept unless one is given', async () => {
    await t.pool.query(`UPDATE users SET display_name = 'Kept Name' WHERE id = $1`, [oldId]);
    await recoverAdmin(t.pool, config, sender, now(), { email, reason, dryRun: false, disableActive: false });
    assert.equal((await t.pool.query(`SELECT display_name FROM users WHERE id = $1`, [oldId])).rows[0].display_name, 'Kept Name');
  });

  test('a dry run with no Administrator active changes nothing and sends nothing', async () => {
    const before = await snapshot();
    assert.deepEqual(await run({ dryRun: true }), ['Dry run: all checks passed; a recovery link would be sent to old.admin@example.org.']);
    assert.deepEqual(await snapshot(), before);
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
    assert.equal((await userRow(email)).status, 'invited', 'the prior state was carried over, so the account is still the one invited');
  });

  test('setup-invite refuses once the organisation is registered, even with no Administrator active', async () => {
    const setup = new SetupService(t.pool, config, sender);
    const before = await snapshot();
    assert.equal(await message(setup.issue({ email: 'first@example.org', displayName: 'First Admin' }, now())), SETUP_REGISTERED);
    assert.equal(SETUP_REGISTERED, 'Kainow is already set up. To restore Administrator access, use recover-admin.');
    await seedUser(t.pool, 'still.here@example.org', 'enterprise_administrator');
    assert.equal(await message(setup.issue({ email: 'first@example.org', displayName: 'First Admin' }, now())), SETUP_REGISTERED);
    const after = await snapshot();
    assert.equal(after.invitations.length, before.invitations.length);
    assert.equal(after.sent, before.sent);
  });
});
