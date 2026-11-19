import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { uuidv7 } from '../common/uuid7';
import { LEADERSHIP_FIELD_KEYS, LEADERSHIP_FIXED_FIELDS } from '../dashboards/preferences';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedDepartment, seedProject, seedUser } from '../testing/projects';
import { LEADERSHIP_FIELDS } from './leadership-fields';

// The test clock starts at 2026-11-09T02:00Z: today is 2026-11-09 (UTC+8).
type Card = Record<string, any> & { id: string; link: boolean };

describe('leadership summary', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let admin: Client;
  let leader: Client;
  let leaderId: string;
  let pmId: string;
  let deptA: string;
  let deptB: string;
  let deptC: string;
  let pa: string;
  let pb: string;
  let pc: string;

  beforeEach(async () => {
    t = await startTestApp();
    await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    leaderId = await seedUser(t.pool, 'leader@example.org');
    pmId = await seedUser(t.pool, 'pm@example.org');
    deptA = await seedDepartment(t.pool, 'Alpha Unit');
    deptB = await seedDepartment(t.pool, 'Beta Unit');
    deptC = await seedDepartment(t.pool, 'Gamma Unit');
    pa = await seedProject(t.pool, { status: 'active', name: 'Alpha works', departmentId: deptA, members: [{ userId: pmId, role: 'pm' }] });
    pb = await seedProject(t.pool, { status: 'active', name: 'Beta works', departmentId: deptB, members: [{ userId: pmId, role: 'pm' }] });
    pc = await seedProject(t.pool, { status: 'planned', name: 'Gamma works', departmentId: deptC, members: [{ userId: pmId, role: 'pm' }] });
    admin = await t.signIn('admin@example.org');
    leader = await t.signIn('leader@example.org');
  });
  afterEach(async () => {
    await t?.close();
  });

  const grant = (scope: Record<string, unknown>, userId = leaderId) =>
    admin.request('POST', '/admin/leadership-grants', { userId, scope, startsOn: '2026-11-09', reason: 'Oversight' });
  const summary = async (query = '', who: Client = leader) => who.request('GET', `/dashboard/leadership${query}`);
  const cards = async (query = '') => {
    const r = await summary(query);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.cards as Card[];
  };
  async function risk(projectId: string, description: string, severity: string, reviewOn = '2026-12-01'): Promise<string> {
    const proposal = uuidv7();
    await t.pool.query(
      `INSERT INTO human_proposals (id, project_id, kind, text, proposed_by, proposed_at, review_status, reviewed_by, reviewed_at)
       VALUES ($1, $2, 'risk', 'Proposed', $3, now(), 'approved', $3, now())`,
      [proposal, projectId, pmId],
    );
    const id = uuidv7();
    await t.pool.query(
      `INSERT INTO risks (id, project_id, description, severity, review_on, origin_proposal_id, authorised_by, authorised_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())`,
      [id, projectId, description, severity, reviewOn, proposal, pmId],
    );
    return id;
  }

  test('the catalogue is the single source of the field keys', () => {
    assert.deepEqual(LEADERSHIP_FIELDS.map((f) => f.key), [...LEADERSHIP_FIELD_KEYS]);
    assert.deepEqual(LEADERSHIP_FIELDS.filter((f) => f.required).map((f) => f.key), [...LEADERSHIP_FIXED_FIELDS]);
    assert.ok(LEADERSHIP_FIELDS.every((f) => f.label.length > 0));
  });

  test('holder sees in-scope projects only', async () => {
    assert.equal((await grant({ kind: 'departments', departmentIds: [deptA, deptC] })).status, 201);
    const r = await summary();
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.cards.map((c: Card) => c.id).sort(), [pa, pc].sort());
    assert.deepEqual(r.body.departments.map((d: { name: string }) => d.name), ['Alpha Unit', 'Gamma Unit']);
    assert.equal(r.body.computedAt, t.clock.now().toISOString());
    const a = r.body.cards.find((c: Card) => c.id === pa);
    assert.equal(a.name, 'Alpha works');
    assert.equal(a.owningDepartment, 'Alpha Unit');
    assert.equal(a.projectManager, 'pm');
    assert.equal(a.status, 'active');
    assert.equal(a.link, false);
    assert.equal(a.refresh, t.clock.now().toISOString());
    // The department filter narrows within scope; a department outside scope shows nothing.
    assert.deepEqual((await cards(`?department=${deptC}`)).map((c) => c.id), [pc]);
    assert.deepEqual(await cards(`?department=${deptB}`), []);
  });

  test('status filter defaults to Planned, Active and Deferred; Draft and Closed are options', async () => {
    const draft = await seedProject(t.pool, { status: 'draft', name: 'Draft works', departmentId: deptA, members: [{ userId: pmId, role: 'pm' }] });
    const closed = await seedProject(t.pool, { status: 'closed', name: 'Closed works', departmentId: deptA, members: [{ userId: pmId, role: 'pm' }] });
    await grant({ kind: 'organisation' });
    assert.deepEqual((await cards()).map((c) => c.id).sort(), [pa, pb, pc].sort());
    assert.deepEqual((await cards('?status=draft')).map((c) => c.id), [draft]);
    assert.ok((await cards('?status=planned,active,draft,closed')).map((c) => c.id).includes(closed));
    assert.equal((await summary('?status=bogus')).status, 400);
  });

  test('holder gets 404 from GET /projects/:id, records, notes and discussion of an in-scope project', async () => {
    await grant({ kind: 'projects', projectIds: [pa] });
    assert.equal((await summary()).status, 200);
    for (const path of [`/projects/${pa}`, `/projects/${pa}/records`, `/projects/${pa}/notes`, `/projects/${pa}/discussion`, `/projects/${pa}/dashboard`]) {
      assert.equal((await leader.request('GET', path)).status, 404, path);
    }
  });

  test('risk description cut at 120 with ellipsis', async () => {
    await grant({ kind: 'organisation' });
    const long = 'x'.repeat(121);
    const exact = 'y'.repeat(120);
    await risk(pa, long, 'high');
    await risk(pa, exact, 'critical', '2026-12-05');
    await risk(pa, 'Minor matter', 'low');
    const a = (await cards()).find((c) => c.id === pa) as Card;
    assert.equal(a.significantRisks.count, 2);
    const items = a.significantRisks.items as Array<{ description: string; severity: string; reviewOn: string }>;
    assert.equal(items.length, 2);
    const cut = items.find((i) => i.description.startsWith('x')) as (typeof items)[number];
    const whole = items.find((i) => i.description.startsWith('y')) as (typeof items)[number];
    assert.equal(cut.description, `${'x'.repeat(120)}…`);
    assert.equal(whole.description, exact);
    assert.deepEqual(Object.keys(cut).sort(), ['description', 'reviewOn', 'severity']);
    assert.equal(cut.severity, 'high');
    assert.equal(cut.reviewOn, '2026-12-01');
  });

  test('Deleted risk absent; a cleaned held risk shows the cleaned label; an uncleaned one is absent', async () => {
    await grant({ kind: 'organisation' });
    const gone = await risk(pa, 'Deleted risk text', 'critical');
    await t.pool.query(`UPDATE risks SET deleted_at = now(), deleted_by = $2, delete_reason = 'Entered in error' WHERE id = $1`, [gone, pmId]);
    const cleaned = await risk(pa, 'Secret risk text', 'high');
    const held = await risk(pa, 'Held risk text', 'high');
    for (const [id, state] of [[cleaned, 'cleaned'], [held, 'held']] as const) {
      const caseId = uuidv7();
      await t.pool.query(
        `INSERT INTO quarantine_cases (id, project_id, item_kind, item_id, reason, marked_length, state, waiting_for_key, reported_at, cleaned_at)
         VALUES ($1, $2, 'risk', $3, 'test', 8, $4, $5, now(), CASE WHEN $4 = 'cleaned' THEN now() END)`,
        [caseId, pa, id, state, state === 'held'],
      );
      await t.pool.query(`UPDATE risks SET held_case_id = $2 WHERE id = $1`, [id, caseId]);
    }
    const a = (await cards()).find((c) => c.id === pa) as Card;
    assert.equal(a.significantRisks.count, 1);
    assert.deepEqual(a.significantRisks.items.map((i: { description: string }) => i.description), ['Credential removed — under review']);
    assert.ok(!JSON.stringify(a).includes('Deleted risk text'));
    assert.ok(!JSON.stringify(a).includes('Held risk text'));
  });

  test('no grant is 404, and the menu flag follows the grant', async () => {
    assert.equal((await summary()).status, 404);
    assert.deepEqual((await leader.request('GET', '/leadership/me')).body, { hasGrant: false });
    await grant({ kind: 'organisation' });
    assert.deepEqual((await leader.request('GET', '/leadership/me')).body, { hasGrant: true });
    assert.equal((await summary()).status, 200);
    assert.equal((await t.anonymous('GET', '/dashboard/leadership')).status, 401);
    assert.equal((await t.anonymous('GET', '/leadership/me')).status, 401);
  });

  test("participant leader's card has link true", async () => {
    await t.pool.query(`INSERT INTO memberships (id, project_id, user_id, role, starts_on) VALUES ($1, $2, $3, 'member', '2026-11-01')`, [uuidv7(), pa, leaderId]);
    await grant({ kind: 'organisation' });
    const all = await cards();
    assert.equal(all.find((c) => c.id === pa)?.link, true);
    assert.equal(all.find((c) => c.id === pb)?.link, false);
  });

  test("the card shows the viewer's chosen fields; required fields cannot be hidden", async () => {
    await grant({ kind: 'organisation' });
    const full = (await cards()).find((c) => c.id === pa) as Card;
    for (const k of LEADERSHIP_FIELD_KEYS) assert.ok(k in full, k);
    const save = await leader.request('PUT', '/me/preferences', {
      leadership: { fields: { order: ['status', 'name'], hidden: ['projectManager', 'overdue', 'blocked', 'name', 'refresh', 'attentionFlags'] } },
    });
    assert.equal(save.status, 200);
    const r = await summary();
    const a = r.body.cards.find((c: Card) => c.id === pa) as Card;
    for (const k of ['projectManager', 'overdue', 'blocked']) assert.ok(!(k in a), k);
    for (const k of ['name', 'refresh', 'attentionFlags', 'status']) assert.ok(k in a, k);
    assert.equal(r.body.fields[0].key, 'status');
    assert.ok(!r.body.fields.some((f: { key: string }) => f.key === 'projectManager'));
    assert.ok(r.body.fields.every((f: { label: string }) => f.label.length > 0));
  });

  test('measures and attention flags come from the shared measures', async () => {
    await grant({ kind: 'organisation' });
    const a = (await cards()).find((c) => c.id === pa) as Card;
    assert.equal(a.stage.stage, 'Initiation');
    assert.equal(a.attentionFlags.missingRole, true);
    assert.equal(a.attentionFlags.deadlineReview, false);
    assert.equal(a.overdue, 0);
    assert.equal(a.blocked, 0);
    assert.deepEqual(a.nextDates, { nextTaskDue: null, nextRiskReview: null });
  });
});
