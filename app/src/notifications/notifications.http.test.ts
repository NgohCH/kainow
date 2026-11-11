import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { uuidv7 } from '../common/uuid7';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedProject, seedUser } from '../testing/projects';

describe('notifications, email preferences and away periods', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let ann: Client;
  let bob: Client;
  const ids: Record<string, string> = {};
  let projectId: string;
  let otherProjectId: string;

  beforeEach(async () => {
    t = await startTestApp();
    for (const p of ['pm', 'ann', 'bob', 'owner']) ids[p] = await seedUser(t.pool, `${p}@example.org`);
    projectId = await seedProject(t.pool, {
      status: 'active',
      name: 'Harbour Works',
      members: [
        { userId: ids.pm, role: 'pm' },
        { userId: ids.owner, role: 'owner' },
        { userId: ids.ann, role: 'member' },
        { userId: ids.bob, role: 'member' },
      ],
    });
    otherProjectId = await seedProject(t.pool, {
      status: 'active',
      name: 'Lighthouse',
      members: [
        { userId: ids.owner, role: 'owner' },
        { userId: ids.pm, role: 'pm' },
      ],
    });
    ann = await t.signIn('ann@example.org');
    bob = await t.signIn('bob@example.org');
  });
  afterEach(async () => {
    await t?.close();
  });

  const notice = async (userId: string, project: string | null, createdAt: string, summary = 'Task is due', urgent = false) => {
    const id = uuidv7();
    await t.pool.query(
      `INSERT INTO notifications (id, user_id, project_id, kind, urgent, summary, link, created_at) VALUES ($1, $2, $3, 'due_soon', $4, $5, '/x', $6)`,
      [id, userId, project, urgent, summary, createdAt],
    );
    return id;
  };

  test('a person lists only their own notifications, newest first, with a cursor', async () => {
    const a1 = await notice(ids.ann, projectId, '2026-11-08T01:00:00Z', 'first');
    const a2 = await notice(ids.ann, projectId, '2026-11-08T02:00:00Z', 'second');
    await notice(ids.bob, projectId, '2026-11-08T03:00:00Z', 'bobs');
    const r = await ann.request('GET', '/notifications');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.items.map((i: any) => i.id), [a2, a1]);
    assert.equal(r.body.more, false);
    assert.equal(r.body.items[0].projectName, 'Harbour Works');
    assert.equal(r.body.items[0].noAccess, false);
    assert.equal(r.body.next, null);
    assert.equal((await ann.request('GET', '/notifications?before=nonsense')).status, 400);
    assert.equal((await ann.request('GET', '/notifications?before=2026-11-08T02:00:00Z')).status, 400);
  });

  test('pages hold 30 and say when there is more', async () => {
    for (let i = 0; i < 31; i += 1) await notice(ids.ann, projectId, new Date(Date.UTC(2026, 10, 8, 0, i)).toISOString());
    const r = await ann.request('GET', '/notifications');
    assert.equal(r.body.items.length, 30);
    assert.equal(r.body.more, true);
    const next = await ann.request('GET', `/notifications?before=${encodeURIComponent(r.body.next)}`);
    assert.equal(next.body.items.length, 1);
    assert.equal(next.body.more, false);
  });

  test('35 notifications sharing one timestamp page through with no loss and no repeats', async () => {
    const all = new Set<string>();
    for (let i = 0; i < 35; i += 1) all.add(await notice(ids.ann, projectId, '2026-11-08T01:00:00.123456Z'));
    const seen: string[] = [];
    let before = '';
    for (let page = 0; page < 5; page += 1) {
      const r = await ann.request('GET', `/notifications${before}`);
      seen.push(...r.body.items.map((i: any) => i.id));
      if (!r.body.more) break;
      before = `?before=${encodeURIComponent(r.body.next)}`;
    }
    assert.equal(seen.length, 35);
    assert.deepEqual(new Set(seen), all);
  });

  test('unread count, mark one read, mark all read; only own rows', async () => {
    const a1 = await notice(ids.ann, projectId, '2026-11-08T01:00:00Z');
    await notice(ids.ann, projectId, '2026-11-08T02:00:00Z');
    const b1 = await notice(ids.bob, projectId, '2026-11-08T03:00:00Z');
    assert.equal((await ann.request('GET', '/notifications/unread-count')).body.count, 2);
    assert.equal((await ann.request('POST', `/notifications/${b1}/read`)).status, 404);
    assert.equal((await ann.request('POST', `/notifications/${uuidv7()}/read`)).status, 404);
    assert.equal((await ann.request('POST', '/notifications/not-a-uuid/read')).status, 404);
    assert.equal((await ann.request('POST', `/notifications/${a1}/read`)).status, 200);
    assert.equal((await ann.request('GET', '/notifications/unread-count')).body.count, 1);
    const all = await ann.request('POST', '/notifications/read-all');
    assert.deepEqual([all.status, all.body.count], [200, 1]);
    assert.equal((await ann.request('GET', '/notifications/unread-count')).body.count, 0);
    assert.equal((await bob.request('GET', '/notifications/unread-count')).body.count, 1);
    const list = await ann.request('GET', '/notifications');
    assert.ok(list.body.items.every((i: any) => i.readAt !== null));
  });

  test('a notification for a project the person has left shows no access and hides its content', async () => {
    await notice(ids.ann, projectId, '2026-11-08T01:00:00Z', 'Visible task');
    await notice(ids.ann, otherProjectId, '2026-11-08T02:00:00Z', 'Hidden task');
    const r = await ann.request('GET', '/notifications');
    const gone = r.body.items.find((i: any) => i.projectId === otherProjectId);
    assert.deepEqual([gone.noAccess, gone.summary, gone.link, gone.projectName], [true, null, null, null]);
    const kept = r.body.items.find((i: any) => i.projectId === projectId);
    assert.deepEqual([kept.noAccess, kept.summary], [false, 'Visible task']);
    assert.ok(!JSON.stringify(gone).includes('Lighthouse'));
  });

  test("the Administrator's minimal fallback shows its summary and project name without a project role; other notices stay hidden", async () => {
    const adminId = await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    const trig = async (minimal: boolean) => {
      const id = uuidv7();
      await t.pool.query(
        `INSERT INTO notification_triggers (id, key, kind, project_id, record_kind, record_id, fire_at, decided_at, outcome, recipients, detail)
         VALUES ($1, $2, 'assignee_unavailable', $3, 'task', $4, '2026-11-08T01:00:00Z', '2026-11-08T01:00:00Z', 'sent', $5, $6)`,
        [id, `task:${uuidv7()}:assignee_unavailable:x:${id}`, projectId, uuidv7(), [adminId], minimal ? { minimal: true } : { title: 'Secret title' }],
      );
      return id;
    };
    const add = async (triggerId: string, summary: string, link: string | null, createdAt: string) =>
      t.pool.query(
        `INSERT INTO notifications (id, user_id, trigger_id, project_id, kind, urgent, summary, link, created_at)
         VALUES ($1, $2, $3, $4, 'assignee_unavailable', true, $5, $6, $7)`,
        [uuidv7(), adminId, triggerId, projectId, summary, link, createdAt],
      );
    await add(await trig(true), 'A task in Harbour Works needs reassignment.', null, '2026-11-08T02:00:00Z');
    await add(await trig(false), "'Secret title' needs a new assignee", '#/projects/x', '2026-11-08T01:00:00Z');
    const admin = await t.signIn('admin@example.org');
    const r = await admin.request('GET', '/notifications');
    assert.equal(r.status, 200);
    const [minimal, other] = r.body.items;
    assert.deepEqual(
      [minimal.noAccess, minimal.projectName, minimal.summary, minimal.link],
      [false, 'Harbour Works', 'A task in Harbour Works needs reassignment.', null],
    );
    assert.deepEqual([other.noAccess, other.summary, other.link, other.projectName], [true, null, null, null]);
    assert.ok(!JSON.stringify(r.body).includes('Secret title'));
    // A minimal notice reaching a person who is no longer an Administrator shows nothing.
    await t.pool.query(`UPDATE users SET role = 'member' WHERE id = $1`, [adminId]);
    const after = await (await t.signIn('admin@example.org')).request('GET', '/notifications');
    assert.equal(after.body.items[0].noAccess, true);
    assert.equal(after.body.items[0].summary, null);
  });

  test('preferences default, can be set and read back, and are refused without a role', async () => {
    const g = await ann.request('GET', '/email-preferences');
    assert.equal(g.status, 200);
    assert.deepEqual(g.body.projects, [{ projectId, name: 'Harbour Works', choice: 'daily_urgent_immediate', label: 'Daily, urgent immediately' }]);
    assert.deepEqual(g.body.away, []);
    assert.equal((await ann.request('PUT', `/email-preferences/${projectId}`, { choice: 'daily' })).status, 200);
    const again = await ann.request('GET', '/email-preferences');
    assert.deepEqual([again.body.projects[0].choice, again.body.projects[0].label], ['daily', 'Daily only']);
    await ann.request('PUT', `/email-preferences/${projectId}`, { choice: 'off' });
    assert.equal((await t.pool.query(`SELECT count(*)::int AS n FROM email_preferences`)).rows[0].n, 1);
    assert.equal((await ann.request('PUT', `/email-preferences/${projectId}`, { choice: 'sometimes' })).status, 400);
    assert.equal((await ann.request('PUT', `/email-preferences/${projectId}`, {})).status, 400);
    // Not readable at all: 404.
    assert.equal((await ann.request('PUT', `/email-preferences/${otherProjectId}`, { choice: 'off' })).status, 404);
  });

  test('a reader without a role gets 403 with the reason', async () => {
    const aud = await seedUser(t.pool, 'aud@example.org');
    await t.pool.query(
      `INSERT INTO access_grants (id, project_id, user_id, kind, purpose, scope, starts_on, expires_on, requested_by, requested_at, decision, decided_by, decided_at)
       VALUES ($1, $2, $3, 'audit', 'Review', 'All', '2026-11-01', '2026-12-31', $4, '2026-11-01T00:00:00Z', 'approved', $4, '2026-11-01T00:00:00Z')`,
      [uuidv7(), otherProjectId, aud, ids.owner],
    );
    const audit = await t.signIn('aud@example.org');
    const res = await audit.request('PUT', `/email-preferences/${otherProjectId}`, { choice: 'off' });
    assert.equal(res.status, 403);
    assert.equal(res.body.message, 'You have no role in this project.');
  });

  test('away periods are created, listed and removed; another person cannot remove them', async () => {
    const bad = await ann.request('POST', '/away-periods', { startsOn: '2026-12-10', endsOn: '2026-12-01' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.message, 'The end date cannot be before the start date.');
    assert.equal((await ann.request('POST', '/away-periods', { startsOn: '2026-02-30', endsOn: '2026-03-02' })).status, 400);
    assert.equal((await ann.request('POST', '/away-periods', { startsOn: '2026-12-01', endsOn: '2026-12-02', note: 'x'.repeat(201) })).status, 400);
    const later = await ann.request('POST', '/away-periods', { startsOn: '2026-12-20', endsOn: '2026-12-24', note: 'Leave' });
    assert.equal(later.status, 201);
    const sooner = await ann.request('POST', '/away-periods', { startsOn: '2026-12-01', endsOn: '2026-12-05' });
    // An already finished period is not listed.
    await ann.request('POST', '/away-periods', { startsOn: '2026-10-01', endsOn: '2026-10-05' });
    const list = await ann.request('GET', '/email-preferences');
    assert.deepEqual(list.body.away, [
      { id: sooner.body.id, startsOn: '2026-12-01', endsOn: '2026-12-05', note: null },
      { id: later.body.id, startsOn: '2026-12-20', endsOn: '2026-12-24', note: 'Leave' },
    ]);
    assert.equal((await bob.request('DELETE', `/away-periods/${later.body.id}`)).status, 404);
    assert.equal((await ann.request('DELETE', `/away-periods/${later.body.id}`)).status, 200);
    assert.equal((await ann.request('DELETE', `/away-periods/${later.body.id}`)).status, 404);
    assert.equal((await ann.request('GET', '/email-preferences')).body.away.length, 1);
    const row = (await t.pool.query(`SELECT removed_at FROM away_periods WHERE id = $1`, [later.body.id])).rows[0];
    assert.notEqual(row.removed_at, null);
    assert.equal((await bob.request('GET', '/email-preferences')).body.away.length, 0);
  });
});
