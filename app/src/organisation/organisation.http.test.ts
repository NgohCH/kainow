import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedUser } from '../testing/projects';

/** The organisation colour: set by an Enterprise Administrator, checked for contrast, shown in the branding. */
describe('organisation colour', { skip: SKIP_NO_DB }, () => {
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

  const put = (colour: unknown, reason: unknown = 'Brand refresh') => admin.request('PUT', '/organisation/colour', { colour, reason });
  const branding = async () => (await t.anonymous('GET', '/organisation/branding')).body;
  const audit = async () => (await t.pool.query(`SELECT detail FROM audit_events WHERE action = 'organisation.colour_changed' ORDER BY occurred_at`)).rows.map((r) => r.detail);

  test('the Administrator sets the colour, lower-cased, and branding shows it', async () => {
    assert.equal((await branding()).colour, null);
    const r = await put('#B0182E');
    assert.equal(r.status, 200);
    assert.equal(r.body.colour, '#b0182e');
    assert.equal((await branding()).colour, '#b0182e');
  });

  test('a member cannot set it', async () => {
    await seedUser(t.pool, 'member@example.org');
    const member = await t.signIn('member@example.org');
    assert.equal((await member.request('PUT', '/organisation/colour', { colour: '#b0182e', reason: 'Because' })).status, 403);
    assert.equal((await branding()).colour, null);
  });

  test('a reason is required', async () => {
    assert.equal((await admin.request('PUT', '/organisation/colour', { colour: '#b0182e' })).status, 400);
    for (const reason of [null, '', '   ']) assert.equal((await put('#b0182e', reason)).status, 400);
    assert.equal((await branding()).colour, null);
  });

  test('a colour too light for white text is refused with the reason', async () => {
    const r = await put('#ffd84a');
    assert.equal(r.status, 400);
    assert.equal(r.body.message, 'This colour is too light for white text on buttons. Choose a darker shade.');
    assert.equal((await put('blue')).status, 400);
    assert.equal((await audit()).length, 0);
  });

  test('null clears it', async () => {
    await put('#b0182e');
    assert.equal((await put(null, 'Back to the default')).status, 200);
    assert.equal((await branding()).colour, null);
  });

  test('each change is one audit row with the previous and new colour and the reason', async () => {
    await put('#b0182e', 'Brand refresh');
    await put('#b0182e', 'Same again');
    await put(null, 'Back to the default');
    assert.deepEqual(await audit(), [
      { from: null, to: '#b0182e', reason: 'Brand refresh' },
      { from: '#b0182e', to: null, reason: 'Back to the default' },
    ]);
  });
});
