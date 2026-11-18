import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { Pool } from 'pg';
import { MVP_SPEND_SETTINGS } from '../spend/mvp-settings';
import { SpendSettingsService } from '../spend/spend.settings';
import { SKIP_NO_DB } from '../testing/db';
import { type TestApp, startTestApp } from '../testing/http';
import { seedProject, seedUser } from '../testing/projects';
import { POLICY_BOUNDS, effectivePolicy } from './policy';

describe('effective AI policy', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let pool: Pool;
  let projectId: string;
  let adminId: string;

  beforeEach(async () => {
    t = await startTestApp();
    pool = t.pool;
    adminId = await seedUser(pool, 'admin@example.org', 'enterprise_administrator');
    const pm = await seedUser(pool, 'pm@example.org');
    projectId = await seedProject(pool, { status: 'active', members: [{ userId: pm, role: 'pm' }] });
  });
  afterEach(async () => {
    await t?.close();
  });

  const org = (patch: Partial<typeof MVP_SPEND_SETTINGS> = {}) => new SpendSettingsService(pool, t.clock.now).apply({ ...MVP_SPEND_SETTINGS, ...patch }, adminId);
  const own = (attempts: number | null, timeout: number | null) =>
    pool.query(
      `INSERT INTO project_ai_limits (project_id, monthly_limit_micro_myr, daily_mode, max_attempts, timeout_seconds, updated_at)
       VALUES ($1, 1, 'not_applied', $2, $3, now()) ON CONFLICT (project_id) DO UPDATE SET max_attempts = $2, timeout_seconds = $3`,
      [projectId, attempts, timeout],
    );

  test('the bounds are the agreed ones', () => {
    assert.deepEqual(POLICY_BOUNDS, { maxAttempts: [1, 5], timeoutSeconds: [30, 300], concurrency: [1, 10] });
  });

  test('with no settings saved the defaults apply', async () => {
    const p = await effectivePolicy(pool, projectId);
    assert.deepEqual(p, { maxAttempts: 3, timeoutMs: 120_000, concurrency: 2, source: { maxAttempts: 'organisation', timeoutSeconds: 'organisation' } });
  });

  test('the organisation value applies when the project has none', async () => {
    await org({ maxAttempts: 4, timeoutSeconds: 90, concurrency: 6 });
    await own(null, null);
    const p = await effectivePolicy(pool, projectId);
    assert.deepEqual(p, { maxAttempts: 4, timeoutMs: 90_000, concurrency: 6, source: { maxAttempts: 'organisation', timeoutSeconds: 'organisation' } });
  });

  test('the project value applies when it is lower', async () => {
    await org({ maxAttempts: 4, timeoutSeconds: 90 });
    await own(2, 60);
    const p = await effectivePolicy(pool, projectId);
    assert.deepEqual([p.maxAttempts, p.timeoutMs, p.source], [2, 60_000, { maxAttempts: 'project', timeoutSeconds: 'project' }]);
  });

  test('the organisation value applies when the Administrator lowered it below the project value', async () => {
    await org({ maxAttempts: 5, timeoutSeconds: 200 });
    await own(4, 150);
    await org({ maxAttempts: 2, timeoutSeconds: 60 });
    const p = await effectivePolicy(pool, projectId);
    assert.deepEqual([p.maxAttempts, p.timeoutMs, p.source], [2, 60_000, { maxAttempts: 'organisation', timeoutSeconds: 'organisation' }]);
  });
});
