import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { type SeedMember, seedDepartment, seedProject, seedUser } from '../testing/projects';
import { GENERAL_TEMPLATE_ID, STARTER_TEMPLATES } from './stage-templates';

const RESEARCH = STARTER_TEMPLATES.find((x) => x.name === 'Research project')!;
const EVENT = STARTER_TEMPLATES.find((x) => x.name === 'Event')!;
const RESEARCH_STAGES = RESEARCH.stages.map((s) => s.name);
const GENERAL_STAGES = ['Initiation', 'Planning', 'Execution', 'Review & Acceptance', 'Closure'];
const reason = 'Agreed at the project board';

type Stage = { id: string; name: string; substages: string[]; status: 'active' | 'retired' };

describe("a project's own stages (D131)", { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let admin: Client;
  let pm: Client;
  let owner: Client;
  let member: Client;
  let full: SeedMember[];
  let dept: string;

  beforeEach(async () => {
    t = await startTestApp();
    await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    for (const p of ['pm', 'owner', 'member']) await seedUser(t.pool, `${p}@example.org`);
    admin = await t.signIn('admin@example.org');
    pm = await t.signIn('pm@example.org');
    owner = await t.signIn('owner@example.org');
    member = await t.signIn('member@example.org');
    full = [
      { userId: pm.userId, role: 'pm' },
      { userId: owner.userId, role: 'owner' },
      { userId: member.userId, role: 'member' },
    ];
    dept = await seedDepartment(t.pool, 'Registry');
  });
  afterEach(async () => {
    await t?.close();
  });

  const create = (c: Client, over: object = {}) =>
    c.request('POST', '/projects', { name: 'Coral survey', purpose: 'Survey the reef', owningDepartmentId: dept, ...over });
  const research = (status: 'active' | 'closed' | 'draft' = 'active') => seedProject(t.pool, { status, members: full, stageTemplateId: RESEARCH.id });
  const detail = async (id: string) => (await pm.request('GET', `/projects/${id}`)).body.project;
  const stages = async (id: string) => (await detail(id)).stages as Stage[];
  const names = (list: Stage[]) => list.map((s) => s.name);

  test('a project created from Research project starts in Proposal and lists its seven stages', async () => {
    const made = await create(admin, { stageTemplateId: RESEARCH.id });
    assert.equal(made.status, 201);
    const p = made.body.project;
    assert.equal(p.stage.stage, 'Proposal');
    assert.deepEqual(p.stageTemplate, { id: RESEARCH.id, name: 'Research project' });
    assert.deepEqual(names(p.stages), RESEARCH_STAGES);
    assert.ok(p.stages.every((s: Stage) => s.status === 'active' && Array.isArray(s.substages) && typeof s.id === 'string'));
  });

  test('without a choice a project takes General, with its substages', async () => {
    const made = await create(admin);
    assert.equal(made.status, 201);
    const p = made.body.project;
    assert.equal(p.stage.stage, 'Initiation');
    assert.deepEqual(p.stageTemplate, { id: GENERAL_TEMPLATE_ID, name: 'General' });
    assert.deepEqual(names(p.stages), GENERAL_STAGES);
    assert.deepEqual(p.stages[2].substages, ['In Progress', 'Monitoring & Follow-up']);
  });

  test('a retired or unknown template is refused', async () => {
    await t.pool.query(`UPDATE stage_templates SET status = 'retired' WHERE id = $1`, [EVENT.id]);
    for (const stageTemplateId of [EVENT.id, '00000000-0000-4000-8000-000000000000', 'not-an-id', 7]) {
      const r = await create(admin, { stageTemplateId });
      assert.equal(r.status, 400, String(stageTemplateId));
      assert.equal(r.body.message, 'Choose a type of project that is still offered.');
    }
    assert.equal((await t.pool.query(`SELECT count(*)::int AS n FROM projects`)).rows[0].n, 0);
  });

  test("changing the stage checks the project's own stages", async () => {
    const id = await research();
    const ok = await pm.request('POST', `/projects/${id}/stage`, { stage: 'Literature review' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.project.stage.stage, 'Literature review');
    const other = await pm.request('POST', `/projects/${id}/stage`, { stage: 'Execution' });
    assert.equal(other.status, 400);
    assert.equal(other.body.message, 'Choose a stage.');
    const sub = await pm.request('POST', `/projects/${id}/stage`, { stage: 'Analysis', substage: 'In Progress' });
    assert.equal(sub.status, 400);
    assert.equal(sub.body.message, 'Choose a substage of Analysis.');
  });

  test("reopening a Closed Research project accepts its stages and refuses others", async () => {
    const id = await research('closed');
    const wrong = await owner.request('POST', `/projects/${id}/transition`, { to: 'active', reason: 'More data', stage: 'Execution' });
    assert.equal(wrong.status, 409);
    assert.equal(wrong.body.message, 'Choose the stage to continue in.');
    const r = await owner.request('POST', `/projects/${id}/transition`, { to: 'active', reason: 'More data', stage: 'Data collection' });
    assert.equal(r.status, 200);
    assert.equal(r.body.project.stage.stage, 'Data collection');
  });

  test('the Project Manager adds a stage at a place in the order, recorded with the reason', async () => {
    const id = await research();
    const r = await pm.request('POST', `/projects/${id}/stages`, { name: ' Fieldwork ', substages: ['Site visits'], position: 4, reason });
    assert.equal(r.status, 200);
    assert.deepEqual(names(r.body.project.stages), [...RESEARCH_STAGES.slice(0, 3), 'Fieldwork', ...RESEARCH_STAGES.slice(3)]);
    assert.deepEqual(r.body.project.stages[3].substages, ['Site visits']);
    const audit = (await t.pool.query(`SELECT detail FROM audit_events WHERE action = 'project.stage_added' AND subject_id = $1`, [id])).rows;
    assert.equal(audit.length, 1);
    assert.equal(audit[0].detail.reason, reason);
    assert.equal(audit[0].detail.stage, 'Fieldwork');
    // The new stage may be chosen, with its substage.
    const moved = await pm.request('POST', `/projects/${id}/stage`, { stage: 'Fieldwork', substage: 'Site visits' });
    assert.equal(moved.status, 200);
    // The Owner may add one too, at the end.
    const end = await owner.request('POST', `/projects/${id}/stages`, { name: 'Archiving', position: 9, reason });
    assert.equal(end.status, 200);
    assert.equal(names(end.body.project.stages).at(-1), 'Archiving');
  });

  test('adding a stage is refused for a Member, a duplicate name, a bad place or no reason', async () => {
    const id = await research();
    const add = (c: Client, b: object) => c.request('POST', `/projects/${id}/stages`, { name: 'Fieldwork', position: 4, reason, ...b });
    assert.equal((await add(member, {})).status, 403);
    const dup = await add(pm, { name: 'literature REVIEW' });
    assert.equal(dup.status, 400);
    assert.equal(dup.body.message, 'This project already has a stage with that name.');
    for (const position of [0, 9, 2.5, '4']) assert.equal((await add(pm, { position })).status, 400, `position ${position}`);
    assert.equal((await add(pm, { reason: ' ' })).status, 400);
    assert.equal((await add(pm, { name: '' })).status, 400);
    assert.equal((await add(pm, { name: 'x'.repeat(81) })).status, 400);
    assert.deepEqual(names(await stages(id)), RESEARCH_STAGES);
  });

  test('stage changes are refused while the project is Closed', async () => {
    const id = await research('closed');
    const r = await owner.request('POST', `/projects/${id}/stages`, { name: 'Fieldwork', position: 4, reason });
    assert.equal(r.status, 403);
    const first = (await stages(id))[1];
    assert.equal((await owner.request('POST', `/projects/${id}/stages/${first.id}/retire`, { reason })).status, 403);
  });

  test('the current stage cannot be retired; a retired stage cannot be chosen and can be restored', async () => {
    const id = await research();
    const list = await stages(id);
    const current = list[0];
    const refused = await pm.request('POST', `/projects/${id}/stages/${current.id}/retire`, { reason });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.message, 'This is the current stage. Move to another stage first.');

    const analysis = list.find((s) => s.name === 'Analysis')!;
    const retired = await pm.request('POST', `/projects/${id}/stages/${analysis.id}/retire`, { reason });
    assert.equal(retired.status, 200);
    assert.equal(retired.body.project.stages.find((s: Stage) => s.id === analysis.id).status, 'retired');
    assert.deepEqual(names(retired.body.project.stages), RESEARCH_STAGES, 'a retired stage keeps its place');
    assert.equal((await pm.request('POST', `/projects/${id}/stages/${analysis.id}/retire`, { reason })).status, 409);
    const choose = await pm.request('POST', `/projects/${id}/stage`, { stage: 'Analysis' });
    assert.equal(choose.status, 400);
    assert.equal(choose.body.message, 'Choose a stage.');
    assert.equal((await member.request('POST', `/projects/${id}/stages/${analysis.id}/restore`, { reason })).status, 403);

    const restored = await owner.request('POST', `/projects/${id}/stages/${analysis.id}/restore`, { reason });
    assert.equal(restored.status, 200);
    assert.equal(restored.body.project.stages.find((s: Stage) => s.id === analysis.id).status, 'active');
    assert.equal((await pm.request('POST', `/projects/${id}/stage`, { stage: 'Analysis' })).status, 200);
    assert.equal((await pm.request('POST', `/projects/${id}/stages/${analysis.id}/restore`, { reason })).status, 409);
    assert.equal((await pm.request('POST', `/projects/${id}/stages/00000000-0000-4000-8000-000000000000/retire`, { reason })).status, 404);
    const actions = (await t.pool.query(`SELECT action, detail->>'reason' AS reason FROM audit_events WHERE subject_id = $1 AND action LIKE 'project.stage\\_%' ORDER BY action`, [id])).rows;
    assert.deepEqual(actions, [
      { action: 'project.stage_restored', reason },
      { action: 'project.stage_retired', reason },
    ]);
  });

  test('the stages are reordered with a full list of their ids', async () => {
    const id = await research();
    const list = await stages(id);
    const reversed = [...list].reverse().map((s) => s.id);
    const r = await pm.request('POST', `/projects/${id}/stages/order`, { ids: reversed, reason });
    assert.equal(r.status, 200);
    assert.deepEqual(names(r.body.project.stages), [...RESEARCH_STAGES].reverse());
    assert.equal(r.body.project.stage.stage, 'Proposal', 'the current stage does not change');
    const partial = await pm.request('POST', `/projects/${id}/stages/order`, { ids: reversed.slice(1), reason });
    assert.equal(partial.status, 400);
    assert.equal(partial.body.message, 'List every stage of the project once.');
    assert.equal((await pm.request('POST', `/projects/${id}/stages/order`, { ids: [...reversed.slice(1), reversed[1]], reason })).status, 400);
    assert.equal((await member.request('POST', `/projects/${id}/stages/order`, { ids: reversed, reason })).status, 403);
    const audit = (await t.pool.query(`SELECT detail FROM audit_events WHERE action = 'project.stages_reordered' AND subject_id = $1`, [id])).rows;
    assert.deepEqual(audit.map((a) => [a.detail.previous, a.detail.next, a.detail.reason]), [[RESEARCH_STAGES, [...RESEARCH_STAGES].reverse(), reason]]);
  });

  test("editing the template afterwards does not change the project's stages", async () => {
    const made = await create(admin, { stageTemplateId: RESEARCH.id });
    const id = made.body.project.id;
    const changed = await admin.request('PUT', `/stage-templates/${RESEARCH.id}`, {
      name: 'Research project',
      stages: [{ name: 'Idea', substages: [] }, { name: 'Study', substages: [] }],
      reason,
    });
    assert.equal(changed.status, 200);
    const p = (await admin.request('GET', `/projects/${id}`)).body.project;
    assert.deepEqual(names(p.stages), RESEARCH_STAGES);
    assert.equal(p.stage.stage, 'Proposal');
  });

  test('existing projects keep working with General', async () => {
    const id = await seedProject(t.pool, { status: 'active', members: full });
    const p = await detail(id);
    assert.deepEqual(p.stageTemplate, { id: GENERAL_TEMPLATE_ID, name: 'General' });
    assert.deepEqual(names(p.stages), GENERAL_STAGES);
    assert.equal((await pm.request('POST', `/projects/${id}/stage`, { stage: 'Planning', substage: 'Define Scope' })).status, 200);
  });
});
