import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedProject, seedUser } from '../testing/projects';
import { GENERAL_TEMPLATE_ID } from './stage-templates';

const STARTERS = ['General', 'Software development', 'Product sales', 'Research project', 'Syllabus development', 'Marketing campaign', 'Event'];
const reason = 'Agreed with the project office';
const BODY = {
  name: 'Grant application',
  description: 'For funding bids.',
  stages: [
    { name: 'Call review', substages: [] },
    { name: 'Drafting', substages: ['Budget', 'Narrative'] },
    { name: 'Submission', substages: [] },
  ],
  reason,
};

describe('stage templates over HTTP', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let admin: Client;
  let member: Client;
  let adminId: string;
  let memberId: string;

  const list = async (c: Client, path = '/stage-templates') => (await c.request('GET', path)).body.templates as any[];
  const byName = async (name: string) => (await list(admin, '/stage-templates?all=1')).find((x) => x.name === name);

  beforeEach(async () => {
    t = await startTestApp();
    adminId = await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    memberId = await seedUser(t.pool, 'ann@example.org');
    admin = await t.signIn('admin@example.org');
    member = await t.signIn('ann@example.org');
  });
  afterEach(async () => t.close());

  test('anyone signed in lists the active templates with their stages, in order; shipped ones are by Kainow', async () => {
    const res = await member.request('GET', '/stage-templates');
    assert.equal(res.status, 200);
    const templates = res.body.templates;
    assert.deepEqual(templates.map((x: any) => x.name), STARTERS);
    const general = templates[0];
    assert.equal(general.id, GENERAL_TEMPLATE_ID);
    assert.equal(general.status, 'active');
    assert.equal(general.createdBy, null);
    assert.equal(general.createdByName, 'Kainow');
    assert.deepEqual(general.stages.map((s: any) => s.name), ['Initiation', 'Planning', 'Execution', 'Review & Acceptance', 'Closure']);
    assert.deepEqual(general.stages[3].substages, ['Review Deliverables', 'Resolve Outstanding Items', 'Confirm Acceptance']);
    assert.deepEqual(templates[1].stages, ['Discovery', 'Design', 'Build', 'Testing', 'Rollout', 'Closure'].map((name) => ({ name, substages: [] })));
    assert.equal(general.projectsUsing, undefined, 'counts are for the Administrator');
    assert.equal((await t.anonymous('GET', '/stage-templates')).status, 401);
  });

  test("the Administrator's full list includes retired templates and how many projects use each", async () => {
    const p1 = await seedProject(t.pool, { members: [{ userId: memberId, role: 'pm' }] });
    const p2 = await seedProject(t.pool, { members: [{ userId: memberId, role: 'pm' }] });
    await t.pool.query(`UPDATE projects SET stage_template_id = $1 WHERE id = ANY($2)`, [GENERAL_TEMPLATE_ID, [p1, p2]]);
    const event = (await list(admin)).find((x) => x.name === 'Event');
    assert.equal((await admin.request('POST', `/stage-templates/${event.id}/retire`, { reason })).status, 200);

    assert.ok(!(await list(admin)).some((x) => x.name === 'Event'), 'not offered for a new project');
    const all = await list(admin, '/stage-templates?all=1');
    assert.deepEqual(all.map((x) => x.name), STARTERS);
    assert.equal(all.find((x) => x.name === 'Event').status, 'retired');
    assert.equal(all.find((x) => x.name === 'General').projectsUsing, 2);
    assert.equal(all.find((x) => x.name === 'Product sales').projectsUsing, 0);
    assert.equal((await member.request('GET', '/stage-templates?all=1')).status, 403);
  });

  test('the Administrator adds a template; it goes to the end, records who and why', async () => {
    const res = await admin.request('POST', '/stage-templates', { ...BODY, name: '  Grant application ', stages: [{ name: ' Call review ', substages: [' Eligibility '] }, ...BODY.stages.slice(1)] });
    assert.equal(res.status, 201);
    assert.equal(res.body.name, 'Grant application');
    assert.equal(res.body.position, 8);
    assert.equal(res.body.description, 'For funding bids.');
    assert.equal(res.body.createdBy, adminId);
    assert.equal(res.body.createdByName, 'admin');
    assert.deepEqual(res.body.stages, [{ name: 'Call review', substages: ['Eligibility'] }, ...BODY.stages.slice(1)]);
    assert.deepEqual((await list(member)).map((x) => x.name), [...STARTERS, 'Grant application']);

    const audit = (await t.pool.query(`SELECT action, actor_user_id, subject_id, detail FROM audit_events WHERE action LIKE 'stage_template.%'`)).rows;
    assert.equal(audit.length, 1);
    assert.equal(audit[0].action, 'stage_template.created');
    assert.equal(audit[0].actor_user_id, adminId);
    assert.equal(audit[0].subject_id, res.body.id);
    assert.equal(audit[0].detail.previous, null);
    assert.deepEqual(audit[0].detail.next, { name: 'Grant application', description: 'For funding bids.', stages: res.body.stages });
    assert.equal(audit[0].detail.reason, reason);
  });

  test("changing a template replaces its name, description and stages, never a project's copy; audit has both versions", async () => {
    const projectId = await seedProject(t.pool, { members: [{ userId: memberId, role: 'pm' }] });
    await t.pool.query(
      `INSERT INTO project_stages (id, project_id, position, name, substages, added_at) VALUES (gen_random_uuid(), $1, 1, 'Discovery', '{}', now())`,
      [projectId],
    );
    const software = await byName('Software development');
    const next = { name: 'Software delivery', description: '', stages: [{ name: 'Discovery', substages: ['Interviews'] }, { name: 'Build', substages: [] }], reason };
    const res = await admin.request('PUT', `/stage-templates/${software.id}`, next);
    assert.equal(res.status, 200);
    assert.equal(res.body.name, 'Software delivery');
    assert.equal(res.body.description, null);
    assert.equal(res.body.position, 2, 'keeps its place');
    assert.deepEqual(res.body.stages, next.stages);
    assert.equal(res.body.updatedBy, adminId);
    assert.deepEqual((await byName('Software delivery')).stages, next.stages);

    const audit = (await t.pool.query(`SELECT detail FROM audit_events WHERE action = 'stage_template.changed'`)).rows;
    assert.equal(audit.length, 1);
    assert.deepEqual(audit[0].detail.previous, { name: 'Software development', description: null, stages: software.stages });
    assert.deepEqual(audit[0].detail.next, { name: 'Software delivery', description: null, stages: next.stages });
    assert.equal(audit[0].detail.reason, reason);
    assert.deepEqual(
      (await t.pool.query(`SELECT name, substages FROM project_stages WHERE project_id = $1`, [projectId])).rows,
      [{ name: 'Discovery', substages: [] }],
      'the project keeps its copy',
    );
    assert.equal((await admin.request('PUT', `/stage-templates/00000000-0000-4000-8000-000000000000`, next)).status, 404);
    assert.equal((await admin.request('PUT', `/stage-templates/not-an-id`, next)).status, 404);
  });

  test('retiring and bringing back; audit has the previous and new status', async () => {
    const event = await byName('Event');
    const retired = await admin.request('POST', `/stage-templates/${event.id}/retire`, { reason });
    assert.equal(retired.status, 200);
    assert.equal(retired.body.status, 'retired');
    assert.equal((await admin.request('POST', `/stage-templates/${event.id}/retire`, { reason })).status, 400);
    t.clock.advanceSeconds(1);
    const restored = await admin.request('POST', `/stage-templates/${event.id}/restore`, { reason: 'Needed again' });
    assert.equal(restored.status, 200);
    assert.equal(restored.body.status, 'active');
    assert.equal((await admin.request('POST', `/stage-templates/${event.id}/restore`, { reason })).status, 400);

    const audit = (await t.pool.query(`SELECT action, detail FROM audit_events WHERE action LIKE 'stage_template.%' ORDER BY occurred_at, id`)).rows;
    assert.deepEqual(audit.map((a) => a.action), ['stage_template.retired', 'stage_template.restored']);
    assert.deepEqual([audit[0].detail.name, audit[0].detail.previous, audit[0].detail.next, audit[0].detail.reason], ['Event', { status: 'active' }, { status: 'retired' }, reason]);
    assert.deepEqual([audit[1].detail.previous, audit[1].detail.next, audit[1].detail.reason], [{ status: 'retired' }, { status: 'active' }, 'Needed again']);
  });

  test('refusals: each in plain words, nothing written', async () => {
    const refused = async (method: string, path: string, body: unknown, words: RegExp) => {
      const res = await admin.request(method, path, body);
      assert.equal(res.status, 400, `${JSON.stringify(body)} -> ${res.status}`);
      assert.match(res.body.message, words);
    };
    const stages = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `Stage ${i + 1}`, substages: [] }));
    await refused('POST', '/stage-templates', { ...BODY, name: 'general' }, /already an active template/i);
    await refused('POST', '/stage-templates', { ...BODY, stages: [{ name: 'Drafting', substages: [] }, { name: 'DRAFTING', substages: [] }] }, /stage names/i);
    await refused('POST', '/stage-templates', { ...BODY, stages: [] }, /at least one stage/i);
    await refused('POST', '/stage-templates', { ...BODY, stages: stages(21) }, /20 stages/);
    await refused('POST', '/stage-templates', { ...BODY, stages: [{ name: 'A', substages: Array.from({ length: 11 }, (_, i) => `S${i}`) }] }, /10 substages/);
    await refused('POST', '/stage-templates', { ...BODY, name: '   ' }, /1 to 80 characters/);
    await refused('POST', '/stage-templates', { ...BODY, name: 'x'.repeat(81) }, /1 to 80 characters/);
    await refused('POST', '/stage-templates', { ...BODY, stages: [{ name: 'x'.repeat(81), substages: [] }] }, /1 to 80 characters/);
    await refused('POST', '/stage-templates', { ...BODY, stages: [{ name: 'A', substages: [''] }] }, /1 to 80 characters/);
    await refused('POST', '/stage-templates', { ...BODY, description: 'x'.repeat(301) }, /300 characters/);
    await refused('POST', '/stage-templates', { ...BODY, reason: undefined }, /reason/i);
    await refused('POST', '/stage-templates', { ...BODY, reason: 'x'.repeat(501) }, /reason/i);
    assert.equal((await admin.request('POST', '/stage-templates', { ...BODY, name: 'x'.repeat(80), stages: stages(20), reason: 'x'.repeat(500) })).status, 201, 'the limits themselves are allowed');

    const sales = await byName('Product sales');
    await refused('PUT', `/stage-templates/${sales.id}`, { ...BODY, name: 'Event' }, /already an active template/i);
    assert.equal((await admin.request('PUT', `/stage-templates/${sales.id}`, { ...BODY, name: 'PRODUCT SALES' })).status, 200, 'its own name in another case');

    // A retired template cannot come back while an active one has its name.
    const event = await byName('Event');
    assert.equal((await admin.request('POST', `/stage-templates/${event.id}/retire`, { reason })).status, 200);
    assert.equal((await admin.request('POST', '/stage-templates', { ...BODY, name: 'event' })).status, 201, 'a retired name is free');
    await refused('POST', `/stage-templates/${event.id}/restore`, { reason }, /already an active template/i);
    await refused('POST', `/stage-templates/${event.id}/restore`, {}, /reason/i);

    // The last active template stays.
    const active = await list(admin);
    for (const x of active.slice(1)) assert.equal((await admin.request('POST', `/stage-templates/${x.id}/retire`, { reason })).status, 200, x.name);
    await refused('POST', `/stage-templates/${active[0].id}/retire`, { reason }, /at least one template/i);
    assert.equal((await list(admin)).length, 1);

    assert.equal((await t.pool.query(`SELECT count(*)::int AS n FROM stage_templates WHERE name IN ('general', 'Grant application')`)).rows[0].n, 0, 'refused adds wrote nothing');
  });

  test("a Member's writes get 403", async () => {
    const general = (await list(member))[0];
    assert.equal((await member.request('POST', '/stage-templates', BODY)).status, 403);
    assert.equal((await member.request('PUT', `/stage-templates/${general.id}`, BODY)).status, 403);
    assert.equal((await member.request('POST', `/stage-templates/${general.id}/retire`, { reason })).status, 403);
    assert.equal((await member.request('POST', `/stage-templates/${general.id}/restore`, { reason })).status, 403);
    assert.equal((await t.pool.query(`SELECT count(*)::int AS n FROM audit_events WHERE action LIKE 'stage_template.%'`)).rows[0].n, 0);
  });
});
