import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { createApp } from '../bootstrap';
import { loadConfig } from '../config';
import { uuidv7 } from '../common/uuid7';
import { OrganisationProfileService } from '../organisation/organisation.service';
import { SKIP_NO_DB, testDatabaseUrl } from '../testing/db';
import { testEnv } from '../testing/fakes';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedProject, seedUser } from '../testing/projects';
import { PROTECTED_KEY, type ProtectedKey } from './protected-key';

describe('protected key status', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let admin: Client;
  beforeEach(async () => {
    t = await startTestApp();
    await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    admin = await t.signIn('admin@example.org');
  });
  afterEach(async () => {
    await t?.close();
  });

  test('without a key file the Administrator view warns, and /health stays plain', async () => {
    const org = (await admin.request('GET', '/organisation')).body;
    assert.deepEqual(org.protectedKey, { loaded: false, casesWaiting: 0, warning: 'Waiting for the protected key' });
    assert.deepEqual((await t.anonymous('GET', '/health')).body, { status: 'ok', database: 'up' });
  });

  test('cases waiting for the key are counted', async () => {
    const pm = await seedUser(t.pool, 'pm@example.org');
    const project = await seedProject(t.pool, { status: 'active', members: [{ userId: pm, role: 'pm' }] });
    await t.pool.query(
      `INSERT INTO quarantine_cases (id, project_id, item_kind, item_id, reporter_id, marked_length, waiting_for_key, reported_at) VALUES ($1, $2, 'source', $3, $4, 12, true, now())`,
      [uuidv7(), project, uuidv7(), pm],
    );
    const pk = (await admin.request('GET', '/organisation')).body.protectedKey;
    assert.equal(pk.casesWaiting, 1);
    assert.equal(pk.warning, 'Waiting for the protected key');
  });

  test('with a key file loaded there is no warning, and the key id is not in the view', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kainow-key-'));
    const path = join(dir, 'p.key');
    writeFileSync(path, randomBytes(32));
    const app = await createApp(loadConfig({ ...testEnv(testDatabaseUrl() as string), KAINOW_PROTECTED_KEY_FILE: path }), { logger: false });
    try {
      const key = app.get<ProtectedKey | null>(PROTECTED_KEY);
      assert.ok(key);
      const status = await app.get(OrganisationProfileService).protectedKeyStatus();
      assert.deepEqual(status, { loaded: true, casesWaiting: 0, warning: null });
      assert.ok(!JSON.stringify(status).includes(key.id));
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
