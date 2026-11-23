import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { SKIP_NO_DB } from '../testing/db';
import { type TestApp, startTestApp } from '../testing/http';
import { seedUser } from '../testing/projects';

/**
 * The header asks whether to show the Security review link. The answer is a plain yes or no for anyone signed in, so a
 * person who is not a reviewer is not answered with a refusal (which browsers log as an error on every page load).
 */
describe('GET /security/me', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await startTestApp();
  });
  afterEach(async () => {
    await t?.close();
  });

  test('says whether the signed-in person is a designated security reviewer', async () => {
    const reviewerId = await seedUser(t.pool, 'rev@example.org');
    await seedUser(t.pool, 'ada@example.org');
    await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    await t.pool.query(`UPDATE users SET security_reviewer = true WHERE id = $1`, [reviewerId]);

    for (const [email, reviewer] of [['rev@example.org', true], ['ada@example.org', false], ['admin@example.org', false]] as const) {
      const r = await (await t.signIn(email)).request('GET', '/security/me');
      assert.equal(r.status, 200, `${email}: ${JSON.stringify(r.body)}`);
      assert.deepEqual(r.body, { reviewer }, email);
    }
    assert.equal((await t.anonymous('GET', '/security/me')).status, 401);
  });
});
