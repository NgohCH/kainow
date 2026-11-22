import 'reflect-metadata';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { DEFAULT_AUTH_SETTINGS } from '../config';
import { SKIP_NO_DB } from '../testing/db';
import { differentCode } from '../testing/fakes';
import { startTestApp, type TestApp } from '../testing/http';
import { UsersService } from '../users/users.service';

const { addressWindowMinutes, maxCodeRequestsPerAddress, maxFailedCodesPerAddress } = DEFAULT_AUTH_SETTINGS;

describe('sign-in limits per network address', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;

  beforeEach(async () => {
    t = await startTestApp();
  });
  afterEach(async () => {
    await t.close();
  });

  const post = (path: string, body: unknown) => t.anonymous('POST', path, body);

  test('wrong codes spread over many accounts stop at the address limit, and even a right code is then refused', async () => {
    const users = new UsersService(t.pool, t.clock.now);
    const emails = Array.from({ length: maxFailedCodesPerAddress + 1 }, (_, i) => `person${i}@example.org`);
    for (const [i, email] of emails.entries()) await users.create({ email, displayName: `Person ${i}` });

    // One wrong code on each account: no account reaches its own lock, but the address does.
    for (const email of emails.slice(0, maxFailedCodesPerAddress)) {
      assert.equal((await post('/auth/request-code', { email })).status, 202);
      assert.equal((await post('/auth/verify', { email, code: differentCode(t.sender.lastCode(email)) })).status, 401);
    }
    const last = emails[maxFailedCodesPerAddress];
    assert.equal((await post('/auth/request-code', { email: last })).status, 202);
    const refused = await post('/auth/verify', { email: last, code: t.sender.lastCode(last) });
    assert.equal(refused.status, 429);

    // The account itself was never locked: once the window has passed, it signs in normally.
    t.clock.advanceSeconds(addressWindowMinutes * 60);
    assert.equal((await post('/auth/request-code', { email: last })).status, 202);
    assert.equal((await post('/auth/verify', { email: last, code: t.sender.lastCode(last) })).status, 200);
  });

  test('successful sign-ins do not count against the address, so a shared office is not held back by them', async () => {
    const users = new UsersService(t.pool, t.clock.now);
    for (let i = 0; i < maxFailedCodesPerAddress + 2; i++) {
      const email = `staff${i}@example.org`;
      await users.create({ email, displayName: `Staff ${i}` });
      await t.signIn(email);
    }
  });

  test('too many code requests from one address are refused with the same answer whatever the account', async () => {
    for (let i = 0; i < maxCodeRequestsPerAddress; i++) {
      assert.equal((await post('/auth/request-code', { email: `nobody${i}@example.org` })).status, 202);
    }
    const refused = await post('/auth/request-code', { email: 'nobody-more@example.org' });
    assert.equal(refused.status, 429);
    assert.match(refused.body.message, /Too many sign-in attempts/);
    t.clock.advanceSeconds(addressWindowMinutes * 60);
    assert.equal((await post('/auth/request-code', { email: 'nobody-more@example.org' })).status, 202);
  });
});

describe('adding an Administrator after setup', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;

  beforeEach(async () => {
    t = await startTestApp();
  });
  afterEach(async () => {
    await t.close();
  });

  test('the address must be on one of the organisation email domains', async () => {
    const first = await new UsersService(t.pool, t.clock.now).create({ email: 'admin@example.org', displayName: 'Admin' });
    await t.pool.query(`INSERT INTO eligible_domains (id, domain, added_by, added_at) VALUES (gen_random_uuid(), 'example.org', $1, now())`, [first.id]);
    const admin = await t.signIn('admin@example.org');
    const outside = await admin.request('POST', '/users', { email: 'someone@webmail.example', displayName: 'Outside' });
    assert.equal(outside.status, 400);
    assert.match(outside.body.message, /email domains/);
    const inside = await admin.request('POST', '/users', { email: 'colleague@example.org', displayName: 'Colleague' });
    assert.equal(inside.status, 201);
  });
});
