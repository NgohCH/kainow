import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { SKIP_NO_DB } from '../testing/db';
import { type TestApp, startTestApp } from '../testing/http';
import { seedProject, seedUser } from '../testing/projects';
import { isEligible, loadHolders, loadUnreachable } from './recipients';

describe('recipient eligibility', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  const TODAY = '2026-11-10';
  let pmId: string;
  beforeEach(async () => {
    t = await startTestApp();
    pmId = await seedUser(t.pool, 'pm@example.org');
  });
  afterEach(async () => { await t.close(); });

  async function oneMember(m: { startsOn?: string; expiresOn?: string; revoked?: boolean }) {
    const u = await seedUser(t.pool, 'u@example.org');
    const project = await seedProject(t.pool, { status: 'active', members: [{ userId: pmId, role: 'pm' }, { userId: u, role: 'member', ...m }] });
    return { u, project };
  }

  test('Active member is eligible', async () => {
    const { u, project } = await oneMember({});
    assert.equal(await isEligible(t.pool, u, project, TODAY), true);
  });
  for (const [name, m] of [
    ['expired', { expiresOn: '2026-11-05' }],
    ['revoked', { revoked: true }],
    ['scheduled', { startsOn: '2026-12-01' }],
  ] as const) {
    test(`${name} is not eligible`, async () => {
      const { u, project } = await oneMember(m);
      assert.equal(await isEligible(t.pool, u, project, TODAY), false);
    });
  }
  test('On Hold is not eligible', async () => {
    const { u, project } = await oneMember({});
    await t.pool.query(`UPDATE memberships SET held_at = now(), hold_reason = 'investigation' WHERE user_id = $1`, [u]);
    assert.equal(await isEligible(t.pool, u, project, TODAY), false);
  });
  test('disabled account is not eligible and not a holder', async () => {
    const { u, project } = await oneMember({});
    await t.pool.query(`UPDATE users SET status = 'disabled' WHERE id = $1`, [u]);
    assert.equal(await isEligible(t.pool, u, project, TODAY), false);
    assert.deepEqual((await loadHolders(t.pool, project, TODAY)).map((x) => x.userId), [pmId]);
  });
  test('null project means an Active Administrator', async () => {
    const a = await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    assert.equal(await isEligible(t.pool, a, null, TODAY), true);
    assert.equal(await isEligible(t.pool, pmId, null, TODAY), false);
    await t.pool.query(`UPDATE users SET status = 'disabled' WHERE id = $1`, [a]);
    assert.equal(await isEligible(t.pool, a, null, TODAY), false);
  });
  test('unreachable: away today inclusive, removed ignored, preference off', async () => {
    const { u, project } = await oneMember({});
    const v = await seedUser(t.pool, 'v@example.org');
    const w = await seedUser(t.pool, 'w@example.org');
    const x = await seedUser(t.pool, 'x@example.org');
    const ins = (id: string, s: string, e: string, removed: boolean) =>
      t.pool.query(
        `INSERT INTO away_periods (id, user_id, starts_on, ends_on, created_at, removed_at) VALUES (gen_random_uuid(), $1, $2, $3, now(), $4)`,
        [id, s, e, removed ? new Date() : null],
      );
    await ins(u, '2026-11-10', '2026-11-12', false);
    await ins(v, '2026-11-01', '2026-11-09', false);
    await ins(w, '2026-11-01', '2026-11-30', true);
    await t.pool.query(`INSERT INTO email_preferences (user_id, project_id, choice, updated_at) VALUES ($1, $2, 'off', now())`, [x, project]);
    await t.pool.query(`INSERT INTO email_preferences (user_id, project_id, choice, updated_at) VALUES ($1, $2, 'daily', now())`, [v, project]);
    assert.deepEqual([...(await loadUnreachable(t.pool, project, TODAY))].sort(), [u, x].sort());
  });
});
