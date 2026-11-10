import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { uuidv7 } from '../common/uuid7';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedProject, seedUser } from '../testing/projects';

describe('delivery history and email administration', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let admin: Client;
  let pm: Client;
  let ann: Client;
  let nudges = 0;
  const ids: Record<string, string> = {};
  let projectId: string;

  beforeEach(async () => {
    nudges = 0;
    t = await startTestApp(undefined, {
      emailNudge: {
        nudge: async () => {
          nudges += 1;
        },
      },
    });
    ids.admin = await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    for (const p of ['pm', 'ann', 'owner', 'stranger']) ids[p] = await seedUser(t.pool, `${p}@example.org`);
    projectId = await seedProject(t.pool, {
      status: 'active',
      members: [
        { userId: ids.pm, role: 'pm' },
        { userId: ids.owner, role: 'owner' },
        { userId: ids.ann, role: 'member' },
      ],
    });
    admin = await t.signIn('admin@example.org');
    pm = await t.signIn('pm@example.org');
    ann = await t.signIn('ann@example.org');
  });
  afterEach(async () => {
    await t?.close();
  });

  const row = async (status: string, opts: { to?: string; userId?: string | null; project?: string | null; at?: string; reason?: string } = {}) => {
    const id = uuidv7();
    await t.pool.query(
      `INSERT INTO email_outbox (id, to_user_id, to_address, subject, text_body, kind, project_id, initiated_by, status, attempts, last_reason, created_at)
       VALUES ($1, $2, $3, 'Subject', 'Body text', 'notice', $4, 'trigger', $5, 2, $6, $7)`,
      [id, opts.userId === undefined ? ids.ann : opts.userId, opts.to ?? 'ann@example.org', opts.project === undefined ? projectId : opts.project, status, opts.reason ?? null, opts.at ?? '2026-11-08T01:00:00Z'],
    );
    return id;
  };

  test('a Member is refused project deliveries; a PM sees them without bodies', async () => {
    const failed = await row('failed', { reason: 'Mailbox full' });
    assert.equal((await ann.request('GET', `/projects/${projectId}/deliveries`)).status, 403);
    const r = await pm.request('GET', `/projects/${projectId}/deliveries`);
    assert.equal(r.status, 200);
    assert.equal(r.body.items.length, 1);
    const d = r.body.items[0];
    assert.deepEqual(
      [d.id, d.recipientName, d.toAddress, d.kind, d.subject, d.status, d.attempts, d.lastReason, d.possibleDuplicate],
      [failed, 'ann', 'ann@example.org', 'notice', 'Subject', 'failed', 2, 'Mailbox full', false],
    );
    assert.ok(!JSON.stringify(r.body).includes('Body text'));
    const outsider = await t.signIn('stranger@example.org');
    assert.equal((await outsider.request('GET', `/projects/${projectId}/deliveries`)).status, 404);
  });

  test('the Administrator reads the organisation history; others cannot', async () => {
    await row('sent', { to: 'ext@example.org', userId: null, project: null, at: '2026-11-08T02:00:00Z' });
    await row('sent', { at: '2026-11-08T01:00:00Z' });
    const r = await admin.request('GET', '/deliveries');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.items.map((i: any) => i.recipientName), ['ext@example.org', 'ann']);
    assert.equal((await pm.request('GET', '/deliveries')).status, 403);
  });

  test('55 deliveries sharing one timestamp page through with no loss and no repeats', async () => {
    const all = new Set<string>();
    for (let i = 0; i < 55; i += 1) all.add(await row('sent', { at: '2026-11-08T01:00:00.654321Z' }));
    const seen: string[] = [];
    let before = '';
    for (let page = 0; page < 5; page += 1) {
      const r = await admin.request('GET', `/deliveries${before}`);
      seen.push(...r.body.items.map((i: any) => i.id));
      assert.ok(r.body.items.every((i: any) => !('cur' in i)));
      if (!r.body.more) break;
      before = `?before=${encodeURIComponent(r.body.next)}`;
    }
    assert.equal(seen.length, 55);
    assert.deepEqual(new Set(seen), all);
    assert.equal((await admin.request('GET', '/deliveries?before=bad')).status, 400);
  });

  test('resending a failed row queues a linked copy and nudges; a sent row is 409; unknown is 404', async () => {
    const failed = await row('failed');
    const sent = await row('sent');
    assert.equal((await pm.request('POST', `/deliveries/${failed}/resend`)).status, 403);
    const r = await admin.request('POST', `/deliveries/${failed}/resend`);
    assert.equal(r.status, 201);
    const copy = (await t.pool.query(`SELECT resend_of, status, initiated_by_user FROM email_outbox WHERE id = $1`, [r.body.id])).rows[0];
    assert.deepEqual([copy.resend_of, copy.status, copy.initiated_by_user], [failed, 'queued', ids.admin]);
    assert.equal(nudges, 1);
    assert.equal((await admin.request('POST', `/deliveries/${sent}/resend`)).status, 409);
    assert.equal((await admin.request('POST', `/deliveries/${uuidv7()}/resend`)).status, 404);
    const list = await admin.request('GET', '/deliveries');
    assert.equal(list.body.items.find((i: any) => i.id === r.body.id).resendOf, failed);
  });

  test('the test email is queued to the Administrator only', async () => {
    assert.equal((await pm.request('POST', '/email/test')).status, 403);
    const r = await admin.request('POST', '/email/test');
    assert.equal(r.status, 201);
    const rows = await t.outbox('admin@example.org');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, r.body.id);
    assert.equal(rows[0].kind, 'test');
    assert.ok(rows[0].subject.includes('Kainow test email'));
    assert.ok(rows[0].text_body.includes('This is a test email from Kainow. If you received it, email delivery works.'));
    const rel = (await t.pool.query(`SELECT relevance, initiated_by FROM email_outbox WHERE id = $1`, [r.body.id])).rows[0];
    assert.deepEqual([rel.relevance, rel.initiated_by], [{ kind: 'none', scope: 'account' }, 'person']);
    assert.equal(nudges, 1);
  });

  test('status shows the provider and the last outcome and never a secret', async () => {
    assert.equal((await pm.request('GET', '/email/status')).status, 403);
    const none = await admin.request('GET', '/email/status');
    assert.deepEqual(none.body, { provider: 'log', from: null, lastOutcome: null });
    await row('sent', { at: '2026-11-08T01:00:00Z' });
    await row('queued', { at: '2026-11-08T05:00:00Z' });
    const r = await admin.request('GET', '/email/status');
    assert.equal(r.body.lastOutcome.status, 'sent');
    assert.deepEqual(Object.keys(r.body).sort(), ['from', 'lastOutcome', 'provider']);
    assert.ok(!/secret|tenant|client|password/i.test(JSON.stringify(r.body)));
  });
});
