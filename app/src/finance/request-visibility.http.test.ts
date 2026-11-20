import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { uuidv7 } from '../common/uuid7';
import { ProjectAccess } from '../projects/access.service';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedProject, seedUser } from '../testing/projects';
import { financeRequestVisibleSql, loadProjectFinanceSettings, mayReadFinance } from './readers';

// 10:00 on 20 November 2026 in UTC+8.
const START = Date.UTC(2026, 10, 20, 2, 0, 0);
const BUDGET = '123456.78';
const CORRECTION = '4321.09';
/** Anything that would show a finance request's terms or its kind. */
const LEAKS = [BUDGET, '123,456.78', CORRECTION, '4,321.09', 'set_budget', 'finance_adjustment', 'Set the budget', 'Adjust a spending entry'];

type Req = { id: string; kind: string };

describe('finance requests are visible to finance readers only (spec 3.6)', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let people: Record<string, Client>;
  let ids: Record<string, string>;
  let projectId: string;
  let budgetId: string;
  let adjustmentId: string;
  const readers = (membersRead: boolean, grantsRead = false) =>
    t.pool.query(`UPDATE project_finance_settings SET members_read = $2, grants_read = $3 WHERE project_id = $1`, [projectId, membersRead, grantsRead]);
  const tracking = (on: boolean) => t.pool.query(`UPDATE project_finance_settings SET tracking = $2 WHERE project_id = $1`, [projectId, on ? 'enabled' : 'not_required']);
  const list = async (who: string, query = '') => {
    const r = await people[who].request('GET', `/projects/${projectId}/changes${query}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r;
  };
  const financeIds = (body: { requests: Req[] }) => body.requests.filter((r) => r.id === budgetId || r.id === adjustmentId).map((r) => r.kind).sort();
  const noLeak = (body: unknown, where: string) => {
    const text = JSON.stringify(body);
    for (const s of LEAKS) assert.ok(!text.includes(s), `${where} shows "${s}": ${text}`);
  };

  beforeEach(async () => {
    t = await startTestApp(START);
    ids = { admin: await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator') };
    for (const p of ['pm', 'deputy', 'owner', 'sponsor', 'ann', 'auditor']) ids[p] = await seedUser(t.pool, `${p}@example.org`);
    projectId = await seedProject(t.pool, {
      status: 'active',
      name: 'Harbour Survey',
      members: [
        { userId: ids.pm, role: 'pm' },
        { userId: ids.deputy, role: 'deputy_pm' },
        { userId: ids.owner, role: 'owner' },
        { userId: ids.sponsor, role: 'sponsor' },
        { userId: ids.ann, role: 'member' },
      ],
    });
    await t.pool.query(
      `INSERT INTO access_grants (id, project_id, user_id, kind, purpose, scope, starts_on, expires_on, requested_by, requested_at, decision, decided_by, decided_at)
       VALUES ($1, $2, $3, 'audit', 'Annual audit', 'Everything', '2026-11-01', '2026-11-30', $4, now(), 'approved', $5, now())`,
      [uuidv7(), projectId, ids.auditor, ids.pm, ids.admin],
    );
    await t.pool.query(
      `INSERT INTO project_finance_settings (project_id, tracking, currency, members_read, grants_read) VALUES ($1, 'enabled', 'MYR', false, false)`,
      [projectId],
    );
    people = {};
    for (const p of ['admin', 'pm', 'deputy', 'owner', 'sponsor', 'ann', 'auditor']) people[p] = await t.signIn(`${p}@example.org`);

    const b = await people.pm.request('POST', `/projects/${projectId}/finance/budget`, { amount: BUDGET, reason: 'Approved scope for phase one' });
    assert.equal(b.status, 201, JSON.stringify(b.body));
    budgetId = b.body.request.id;
    const e = await people.pm.request('POST', `/projects/${projectId}/finance/spending`, {
      spentOn: '2026-11-18', amount: '100.00', currency: 'MYR', description: 'Survey pegs', reference: 'INV-0001',
    });
    assert.equal(e.status, 201, JSON.stringify(e.body));
    t.clock.advanceSeconds(60);
    const a = await people.pm.request('POST', `/projects/${projectId}/finance/spending/${e.body.entry.id}/adjust`, {
      type: 'correction', amount: CORRECTION, reason: 'Invoice checked',
    });
    assert.equal(a.status, 201, JSON.stringify(a.body));
    adjustmentId = a.body.request.id;
  });
  afterEach(async () => {
    await t?.close();
  });

  test('a Member with membersRead off sees neither request, nor a count, on the list (all and pending) or the Reviews data', async () => {
    for (const q of ['', '?status=pending']) {
      const r = await list('ann', q);
      assert.deepEqual(financeIds(r.body), [], `list${q}`);
      assert.equal(r.body.requests.length, 0, 'no count either: the list holds nothing else');
      noLeak(r.body, `list${q}`);
    }
    // A grant holder, likewise, while grantsRead is off.
    assert.deepEqual(financeIds((await list('auditor')).body), []);
    noLeak((await list('auditor')).body, 'auditor list');
  });

  test('the single-request routes answer 404 to a non-reader, as if the request did not exist', async () => {
    for (const id of [budgetId, adjustmentId]) {
      for (const [path, body] of [
        ['approve', { version: 1 }],
        ['reject', { reason: 'Not now' }],
        ['withdraw', { reason: 'Not now' }],
        ['revise', { terms: { amount: '1.00', reason: 'x' }, reason: 'Smaller' }],
      ] as const) {
        for (const who of ['ann', 'auditor', 'admin']) {
          const r = await people[who].request('POST', `/changes/${id}/${path}`, body);
          assert.equal(r.status, 404, `${who} ${path}: ${JSON.stringify(r.body)}`);
          noLeak(r.body, `${who} ${path}`);
        }
      }
    }
    // Nothing changed: both are still waiting.
    assert.deepEqual(financeIds((await list('pm', '?status=pending')).body), ['finance_adjustment', 'set_budget']);
  });

  test('the personal dashboard, notices, emails, project dashboard, timeline and history show the Member nothing of them', async () => {
    const me = await people.ann.request('GET', '/dashboard/me');
    assert.equal(me.status, 200);
    assert.deepEqual(me.body.needsYou.filter((n: { kind: string }) => n.kind === 'approval'), []);
    noLeak(me.body, 'personal dashboard');
    const notes = await people.ann.request('GET', '/notifications');
    assert.equal(notes.status, 200);
    noLeak(notes.body, 'notifications');
    const unread = await people.ann.request('GET', '/notifications/unread-count');
    assert.equal(unread.status, 200);
    noLeak(unread.body, 'unread count');
    for (const path of ['dashboard', 'timeline', 'history/deletions']) {
      const r = await people.ann.request('GET', `/projects/${projectId}/${path}`);
      assert.equal(r.status, 200, `${path}: ${JSON.stringify(r.body)}`);
      noLeak(r.body, path);
    }
    for (const mail of await t.outbox('ann@example.org')) noLeak(mail, 'email');
  });

  test("the finance settings' currencyFixed does not announce a pending budget to a non-reader", async () => {
    const other = await seedProject(t.pool, {
      status: 'active',
      name: 'Quay Repairs',
      members: [
        { userId: ids.pm, role: 'pm' },
        { userId: ids.owner, role: 'owner' },
        { userId: ids.ann, role: 'member' },
      ],
    });
    await t.pool.query(`INSERT INTO project_finance_settings (project_id, tracking, currency) VALUES ($1, 'enabled', 'MYR')`, [other]);
    const fixed = async (who: string) => {
      const r = await people[who].request('GET', `/projects/${other}/settings/finance`);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      return r.body.currencyFixed as boolean;
    };
    assert.equal(await fixed('ann'), false);
    assert.equal((await people.pm.request('POST', `/projects/${other}/finance/budget`, { amount: BUDGET, reason: 'Scope' })).status, 201);
    assert.equal(await fixed('pm'), true);
    assert.equal(await fixed('admin'), true);
    assert.equal(await fixed('ann'), false, 'a Member who may not read finance learns nothing of the pending budget');
    await t.pool.query(`UPDATE project_finance_settings SET members_read = true WHERE project_id = $1`, [other]);
    assert.equal(await fixed('ann'), true);
  });

  test('with membersRead on, the Member sees both; with grantsRead on, the grant holder does', async () => {
    await readers(true);
    assert.deepEqual(financeIds((await list('ann')).body), ['finance_adjustment', 'set_budget']);
    assert.deepEqual(financeIds((await list('auditor')).body), []);
    await readers(false, true);
    assert.deepEqual(financeIds((await list('ann')).body), []);
    assert.deepEqual(financeIds((await list('auditor')).body), ['finance_adjustment', 'set_budget']);
  });

  test('the PM, Deputy, Owner and Sponsor always see them', async () => {
    for (const who of ['pm', 'deputy', 'owner', 'sponsor']) {
      assert.deepEqual(financeIds((await list(who)).body), ['finance_adjustment', 'set_budget'], who);
    }
  });

  test("the Owner's Needs-you lists them only while they can be approved (tracking on), by the list's own check", async () => {
    const approvals = async () =>
      ((await people.owner.request('GET', '/dashboard/me')).body.needsYou as Array<{ kind: string; label: string }>)
        .filter((n) => n.kind === 'approval')
        .map((n) => n.label)
        .sort();
    assert.deepEqual(await approvals(), ['Adjust a spending entry', 'Set the budget']);
    await tracking(false);
    assert.deepEqual(await approvals(), [], 'tracking off: not approvable, so not in Needs you');
    const listed = (await list('owner')).body.requests.filter((r: Req & { mayApprove: boolean }) => r.id === budgetId || r.id === adjustmentId);
    assert.deepEqual(listed.map((r: { mayApprove: boolean }) => r.mayApprove), [false, false]);
  });

  test('financeRequestVisibleSql agrees with mayReadFinance for every role, policy and access state', async () => {
    const access = new ProjectAccess(t.pool, t.clock.now);
    // People in odd states: held, expired, scheduled, revoked memberships; suspended, expired, revoked, future grants; a
    // grant holder whose membership is on hold; a Member who also holds a grant.
    const extra: Record<string, string> = {};
    for (const p of ['held', 'expired', 'scheduled', 'revoked', 'gsusp', 'gexp', 'grev', 'gfuture', 'gheld', 'membergrant', 'nobody']) {
      extra[p] = await seedUser(t.pool, `${p}@example.org`);
    }
    const member = (userId: string, role: string, over: { startsOn?: string; expiresOn?: string | null; revoked?: boolean; held?: boolean } = {}) =>
      t.pool.query(
        `INSERT INTO memberships (id, project_id, user_id, role, starts_on, expires_on, revoked_at, revoked_by, held_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [uuidv7(), projectId, userId, role, over.startsOn ?? '2026-11-01', over.expiresOn ?? null, over.revoked ? new Date() : null, over.revoked ? ids.pm : null, over.held ? new Date() : null],
      );
    const grant = (userId: string, over: { startsOn?: string; expiresOn?: string; suspended?: boolean; revoked?: boolean } = {}) =>
      t.pool.query(
        `INSERT INTO access_grants (id, project_id, user_id, kind, purpose, scope, starts_on, expires_on, requested_by, requested_at, decision, decided_by, decided_at, suspended_at, revoked_at)
         VALUES ($1, $2, $3, 'oversight', 'Review', 'Everything', $4, $5, $6, now(), 'approved', $7, now(), $8, $9)`,
        [uuidv7(), projectId, userId, over.startsOn ?? '2026-11-01', over.expiresOn ?? '2026-11-30', ids.pm, ids.admin, over.suspended ? new Date() : null, over.revoked ? new Date() : null],
      );
    await member(extra.held, 'owner', { held: true });
    await member(extra.expired, 'sponsor', { expiresOn: '2026-11-19' });
    await member(extra.scheduled, 'deputy_pm', { startsOn: '2026-11-21' });
    await member(extra.revoked, 'owner', { revoked: true });
    await grant(extra.gsusp, { suspended: true });
    await grant(extra.gexp, { expiresOn: '2026-11-19' });
    await grant(extra.grev, { revoked: true });
    await grant(extra.gfuture, { startsOn: '2026-11-21' });
    await grant(extra.gheld);
    await member(extra.gheld, 'member', { held: true });
    await member(extra.membergrant, 'member');
    await grant(extra.membergrant);
    // A held membership restored later is active again.
    await t.pool.query(`UPDATE memberships SET restored_at = held_at + interval '1 minute' WHERE user_id = $1`, [extra.held]);
    await member(extra.held, 'member', { held: true });

    const everyone = { ...ids, ...extra };
    const today = '2026-11-20';
    const users = (await t.pool.query(`SELECT id, role FROM users WHERE id = ANY($1::uuid[])`, [Object.values(everyone)])).rows as Array<{ id: string; role: string }>;
    let compared = 0;
    for (const [membersRead, grantsRead] of [[false, false], [true, false], [false, true], [true, true]]) {
      await readers(membersRead, grantsRead);
      const settings = await loadProjectFinanceSettings(t.pool, projectId);
      for (const [name, userId] of Object.entries(everyone)) {
        const user = users.find((u) => u.id === userId) as { id: string; role: string };
        const ctx = await access.load(projectId, { id: userId, role: user.role } as never);
        const expected = ctx ? mayReadFinance(ctx, settings) : false;
        const { rows } = await t.pool.query(
          `SELECT r.kind, ${financeRequestVisibleSql('r', '$2', '$3')} AS visible FROM change_requests r WHERE r.project_id = $1 ORDER BY r.kind`,
          [projectId, userId, today],
        );
        assert.deepEqual(
          rows.map((r) => [r.kind, r.visible]),
          [['finance_adjustment', expected], ['set_budget', expected]],
          `${name} membersRead=${membersRead} grantsRead=${grantsRead}`,
        );
        compared++;
      }
    }
    assert.equal(compared, 4 * Object.keys(everyone).length);
  });
});
