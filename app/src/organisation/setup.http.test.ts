import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { SKIP_NO_DB } from '../testing/db';
import { type TestApp, startTestApp } from '../testing/http';
import { seedUser } from '../testing/projects';
import { seedDemo } from '../users/seed-demo-cli';
import { SetupService } from './setup.service';

const CLOSED = 'Setup is closed: an Enterprise Administrator already exists. Add Administrators from the Administrators screen.';

/** The one-time setup invitation that creates the first Enterprise Administrator. */
describe('setup invitation', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let setup: SetupService;

  beforeEach(async () => {
    t = await startTestApp(undefined, { organisation: false });
    setup = t.app.get(SetupService);
  });
  afterEach(async () => {
    await t?.close();
  });

  const tokenOf = (link: string) => link.split('/#/setup/')[1];
  const status = async (link: string) => (await t.anonymous('GET', `/setup/${tokenOf(link)}`)).body;
  const issue = (email: string, displayName = 'First Admin') => setup.issue({ email, displayName }, new Date(t.clock.now()));
  const refusal = async (p: Promise<unknown>) => {
    try {
      await p;
      return 'issued';
    } catch (e) {
      return (e as Error).message;
    }
  };

  test('the first setup invitation is sent, and its link is valid', async () => {
    const { link } = await issue('first@example.org');
    assert.match(link, /^http:\/\/localhost:3000\/#\/setup\/[A-Za-z0-9_-]{40,}$/);
    assert.equal(t.sender.setupInvitations.at(-1)?.link, link);
    assert.deepEqual(await status(link), { state: 'valid', email: 'first@example.org' });
    const user = (await t.pool.query(`SELECT role, status FROM users WHERE email = 'first@example.org'`)).rows[0];
    assert.deepEqual(user, { role: 'enterprise_administrator', status: 'invited' });
    assert.equal((await t.pool.query(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'setup.invitation_issued'`)).rows[0].n, 1);
  });

  test('signing in through it closes setup for good', async () => {
    const { link } = await issue('first@example.org');
    await t.signIn('first@example.org');
    assert.deepEqual(await status(link), { state: 'used', email: null });
    assert.equal(await refusal(issue('second@example.org')), CLOSED);
    assert.equal((await t.pool.query(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'setup.accepted'`)).rows[0].n, 1);
  });

  test('running the command again before acceptance supersedes the old link', async () => {
    const first = await issue('first@example.org');
    t.clock.advanceSeconds(60);
    const again = await issue('first@example.org');
    assert.equal((await status(first.link)).state, 'superseded');
    assert.equal((await status(again.link)).state, 'valid');
    assert.equal((await t.pool.query(`SELECT count(*)::int AS n FROM users WHERE email = 'first@example.org'`)).rows[0].n, 1, 'the account is reused');
    t.clock.advanceSeconds(60);
    const typo = await issue('second@example.org');
    assert.equal((await status(again.link)).state, 'superseded');
    assert.equal((await status(typo.link)).state, 'valid');
    const old = (await t.pool.query(`SELECT status FROM users WHERE email = 'first@example.org'`)).rows[0].status;
    assert.equal(old, 'disabled', 'the account made for the mistaken address is disabled');
  });

  test('an expired link says so', async () => {
    const { link } = await issue('first@example.org');
    t.clock.advanceSeconds(7 * 24 * 3600 + 1);
    assert.deepEqual(await status(link), { state: 'expired', email: null });
    assert.deepEqual((await t.anonymous('GET', '/setup/not-a-real-token')).body, { state: 'expired', email: null });
  });

  test('setup is closed once any Administrator is active', async () => {
    await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    assert.equal(await refusal(issue('first@example.org')), CLOSED);
  });

  test('the demo seed refuses a database that is not empty', async () => {
    await seedUser(t.pool, 'someone@example.org');
    assert.equal(await refusal(seedDemo(t.pool, new Date(t.clock.now()))), 'The demo seed needs an empty database.');
  });

  test('the demo seed sets up Example Organisation on an empty database', async () => {
    await seedDemo(t.pool, new Date(t.clock.now()));
    const org = (await t.pool.query(`SELECT name, registered_at FROM organisation`)).rows[0];
    assert.equal(org.name, 'Example Organisation');
    assert.ok(org.registered_at);
    const admin = (await t.pool.query(`SELECT role, status FROM users WHERE email = 'admin@example.com'`)).rows[0];
    assert.deepEqual(admin, { role: 'enterprise_administrator', status: 'active' });
  });
});
