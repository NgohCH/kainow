import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedProject, seedUser } from '../testing/projects';

/** The hub order of spec 7.8. */
const HUB_ORDER = [
  'organisation', 'administrators', 'departments', 'domains', 'leadership',
  'approvals', 'reminders', 'access', 'resources', 'reportTypes', 'stageTemplates',
  'ai', 'emailDelivery', 'storage',
  'operations', 'goLive', 'escalatedFeedback', 'securityReview',
];

const MODEL = {
  provider: 'openai',
  modelId: 'gpt-test-1',
  displayName: 'GPT Test One',
  inputUsdPerMillion: '2.00',
  cachedInputUsdPerMillion: '0.10',
  cacheWriteUsdPerMillion: '0',
  outputUsdPerMillion: '10.00',
  dataTerms: 'Not used for training; retained 30 days.',
  purposes: ['extraction'],
  restrictedOk: false,
  reason: 'Reviewed the provider terms',
};

describe('settings summary over HTTP', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let admin: Client;
  const PROJECT_NAME = 'Zebra Crossing Replacement Programme';

  beforeEach(async () => {
    t = await startTestApp();
    const adminId = await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    const memberId = await seedUser(t.pool, 'member@example.org', 'member');
    const pmId = await seedUser(t.pool, 'pm@example.org', 'member');
    await seedProject(t.pool, { status: 'active', name: PROJECT_NAME, members: [{ userId: pmId, role: 'pm' }, { userId: memberId, role: 'member' }, { userId: adminId, role: 'owner' }] });
    admin = await t.signIn('admin@example.org');
  });
  afterEach(async () => {
    await t.close();
  });

  test('an Administrator gets the 18 settings in hub order with distinct keys', async () => {
    const res = await admin.request('GET', '/admin/settings/summary');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.settings.map((s: any) => s.key), HUB_ORDER);
    assert.equal(new Set(res.body.settings.map((s: any) => s.key)).size, 18);
    assert.ok(!Number.isNaN(Date.parse(res.body.computedAt)));
    for (const s of res.body.settings) {
      assert.ok(['ok', 'attention', 'failing', 'off', 'unknown'].includes(s.state), `${s.key}: ${s.state}`);
      assert.ok(s.stateWord.length > 0);
      assert.ok(s.values.length <= 3);
      assert.notEqual(s.state, 'unknown', `${s.key} could not be read: ${s.note}`);
    }
    const byKey = Object.fromEntries(res.body.settings.map((s: any) => [s.key, s]));
    assert.deepEqual(byKey.stageTemplates.values, [{ label: 'Templates', value: 'General' }]);
    assert.equal(byKey.storage.state, 'off');
  });

  test('a Member and a Project Manager get 403, and a signed-out request 401', async () => {
    assert.equal((await (await t.signIn('member@example.org')).request('GET', '/admin/settings/summary')).status, 403);
    assert.equal((await (await t.signIn('pm@example.org')).request('GET', '/admin/settings/summary')).status, 403);
    assert.equal((await t.anonymous('GET', '/admin/settings/summary')).status, 401);
  });

  test('the AI entry names a seeded approved model', async () => {
    assert.equal((await admin.request('POST', '/ai/models', MODEL)).status, 201);
    const ai = (await admin.request('GET', '/admin/settings/summary')).body.settings.find((s: any) => s.key === 'ai');
    assert.equal(ai.state, 'ok');
    assert.ok(ai.values.some((v: any) => v.value.includes('gpt-test-1 (OpenAI)')));
  });

  test('email delivery is failing after an email failed in the last 24 hours, and ok once it is older', async () => {
    const insert = (createdAt: Date) =>
      t.pool.query(
        `INSERT INTO email_outbox (id, to_address, subject, text_body, kind, initiated_by, status, created_at)
         VALUES (gen_random_uuid(), 'x@example.org', 'S', 'B', 'k', 'system', 'failed', $1)`,
        [createdAt],
      );
    await insert(new Date(t.clock.now().getTime() - 2 * 86_400_000));
    const pick = async () => (await admin.request('GET', '/admin/settings/summary')).body.settings.find((s: any) => s.key === 'emailDelivery');
    assert.equal((await pick()).state, 'ok');
    await insert(new Date(t.clock.now().getTime() - 3_600_000));
    assert.equal((await pick()).state, 'failing');
  });

  test('no entry shows a project name (leak check)', async () => {
    const text = JSON.stringify((await admin.request('GET', '/admin/settings/summary')).body);
    assert.ok(!text.includes(PROJECT_NAME));
    assert.ok(!text.includes('Zebra'));
  });
});
