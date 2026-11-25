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
const SECRET = `ghp_${'a1B2c3D4e5F6'.repeat(3)}`;

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

  test('two stages whose names were cleaned to the same text can both still be chosen, by substage', async () => {
    const id = await research();
    const name = 'Trial [credential removed]';
    for (const [i, sub] of ['First pass', 'Second pass'].entries()) {
      await t.pool.query(
        `INSERT INTO project_stages (id, project_id, position, name, substages, added_at) VALUES (gen_random_uuid(), $1, $2, $3, $4, now())`,
        [id, 20 + i, name, [sub]],
      );
    }
    const cleaned = (await stages(id)).filter((s) => s.name === name);
    for (const s of cleaned) {
      const r = await pm.request('POST', `/projects/${id}/stage`, { stage: name, substage: s.substages[0] });
      assert.equal(r.status, 200, s.substages[0]);
    }
    // The test clock stands still, so the two events have no order: each stage is named once.
    const { rows } = await t.pool.query(`SELECT detail->>'stageId' AS id FROM audit_events WHERE action = 'project.stage' AND subject_id = $1`, [id]);
    assert.deepEqual(rows.map((r) => r.id).sort(), cleaned.map((s) => s.id).sort(), 'the audit names the stage that has the substage');
    assert.equal((await pm.request('POST', `/projects/${id}/stage`, { stage: name, substage: 'Third pass' })).status, 400);
    // While either is current neither can be retired; moving on frees both.
    assert.equal((await pm.request('POST', `/projects/${id}/stages/${cleaned[0].id}/retire`, { reason })).status, 409);
    assert.equal((await pm.request('POST', `/projects/${id}/stage`, { stage: 'Analysis' })).status, 200);
    assert.equal((await pm.request('POST', `/projects/${id}/stages/${cleaned[0].id}/retire`, { reason })).status, 200);
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
    const fieldwork = r.body.project.stages[3] as Stage;
    assert.deepEqual(audit.map((a) => a.detail), [{ stageId: fieldwork.id, position: 4 }], 'ids and counts only');
    const [change] = r.body.project.stageChanges;
    assert.deepEqual([change.kind, change.stage, change.reason, change.actor], ['added', 'Fieldwork', reason, 'pm']);
    assert.deepEqual(change.previous.map((s: Stage) => s.name), RESEARCH_STAGES);
    assert.deepEqual(change.next.map((s: Stage) => s.name), names(r.body.project.stages));
    assert.deepEqual(change.next[3], { name: 'Fieldwork', substages: ['Site visits'], status: 'active' });
    // The new stage may be chosen, with its substage.
    const moved = await pm.request('POST', `/projects/${id}/stage`, { stage: 'Fieldwork', substage: 'Site visits' });
    assert.equal(moved.status, 200);
    const stageAudit = (await t.pool.query(`SELECT detail FROM audit_events WHERE action = 'project.stage' AND subject_id = $1`, [id])).rows;
    assert.deepEqual(stageAudit.map((a) => a.detail), [{ stageId: fieldwork.id }]);
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

  test('a project can have at most 20 stages in use', async () => {
    const id = await research();
    for (let n = RESEARCH_STAGES.length; n < 20; n += 1) {
      assert.equal((await pm.request('POST', `/projects/${id}/stages`, { name: `Extra ${n}`, position: 1, reason })).status, 200);
    }
    const over = await pm.request('POST', `/projects/${id}/stages`, { name: 'One more', position: 1, reason });
    assert.equal(over.status, 400);
    assert.equal(over.body.message, 'A project can have at most 20 stages in use. Retire one first.');
    // A retired stage makes room; bringing it back then needs room too.
    const extra = (await stages(id))[0];
    assert.equal((await pm.request('POST', `/projects/${id}/stages/${extra.id}/retire`, { reason })).status, 200);
    assert.equal((await pm.request('POST', `/projects/${id}/stages`, { name: 'One more', position: 1, reason })).status, 200);
    const back = await pm.request('POST', `/projects/${id}/stages/${extra.id}/restore`, { reason });
    assert.equal(back.status, 400);
    assert.equal(back.body.message, 'A project can have at most 20 stages in use. Retire one first.');
  });

  test('a name the database takes as the same as another (dotted capital I) is refused in words', async () => {
    const id = await research();
    assert.ok((await t.pool.query(`SELECT lower($1::text) = lower('I') AS same`, ['\u0130'])).rows[0].same, 'the test database lowers both to i');
    assert.equal((await pm.request('POST', `/projects/${id}/stages`, { name: 'I', position: 1, reason })).status, 200);
    const r = await pm.request('POST', `/projects/${id}/stages`, { name: '\u0130', position: 1, reason });
    assert.equal(r.status, 400);
    assert.equal(r.body.message, 'This project already has a stage with that name.');
    assert.equal((await detail(id)).stageChanges.length, 1, 'nothing is recorded for a refused change');
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

    t.clock.advanceSeconds(1); // the test clock stands still; the history is ordered by time
    const restored = await owner.request('POST', `/projects/${id}/stages/${analysis.id}/restore`, { reason });
    assert.equal(restored.status, 200);
    assert.equal(restored.body.project.stages.find((s: Stage) => s.id === analysis.id).status, 'active');
    assert.equal((await pm.request('POST', `/projects/${id}/stage`, { stage: 'Analysis' })).status, 200);
    assert.equal((await pm.request('POST', `/projects/${id}/stages/${analysis.id}/restore`, { reason })).status, 409);
    assert.equal((await pm.request('POST', `/projects/${id}/stages/00000000-0000-4000-8000-000000000000/retire`, { reason })).status, 404);
    const actions = (await t.pool.query(`SELECT action, detail FROM audit_events WHERE subject_id = $1 AND action LIKE 'project.stage\\_%' ORDER BY action`, [id])).rows;
    assert.deepEqual(actions, [
      { action: 'project.stage_restored', detail: { stageId: analysis.id } },
      { action: 'project.stage_retired', detail: { stageId: analysis.id } },
    ]);
    // Newest first, readable by everyone who can see the project's stages.
    const seen = (await member.request('GET', `/projects/${id}`)).body.project.stageChanges;
    assert.deepEqual(
      seen.map((c: { kind: string; stage: string; actor: string; reason: string }) => [c.kind, c.stage, c.actor, c.reason]),
      [['restored', 'Analysis', 'owner', reason], ['retired', 'Analysis', 'pm', reason]],
    );
    const at = RESEARCH_STAGES.indexOf('Analysis');
    assert.deepEqual([seen[1].previous[at].status, seen[1].next[at].status], ['active', 'retired']);
    assert.ok(!Number.isNaN(Date.parse(seen[0].at)));
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
    assert.deepEqual(audit.map((a) => a.detail), [{ stages: 7 }]);
    const [change] = r.body.project.stageChanges;
    assert.deepEqual([change.kind, change.stage, change.reason, change.actor], ['reordered', null, reason, 'pm']);
    assert.deepEqual(change.previous.map((s: Stage) => s.name), RESEARCH_STAGES);
    assert.deepEqual(change.next.map((s: Stage) => s.name), [...RESEARCH_STAGES].reverse());
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

  const rename = (c: Client, id: string, stageId: string, name: unknown, why: unknown = reason) =>
    c.request('POST', `/projects/${id}/stages/${stageId}/rename`, { name, reason: why });
  const periodNames = async (id: string) =>
    (await t.pool.query(`SELECT stage FROM project_stage_periods WHERE project_id = $1 ORDER BY started_at, ended_at NULLS LAST`, [id])).rows.map((r) => r.stage as string);

  test('a stage is renamed everywhere, past and current periods included, with the old and new names in the history (D137)', async () => {
    const id = await research();
    const other = await research();
    const proposal = (await stages(id))[0];
    t.clock.advanceSeconds(1);
    assert.equal((await pm.request('POST', `/projects/${id}/stage`, { stage: 'Analysis' })).status, 200);
    t.clock.advanceSeconds(1);
    assert.equal((await pm.request('POST', `/projects/${id}/stage`, { stage: 'Proposal' })).status, 200);
    const r = await rename(pm, id, proposal.id, ' Bid ');
    assert.equal(r.status, 200);
    assert.deepEqual(names(r.body.project.stages), ['Bid', ...RESEARCH_STAGES.slice(1)]);
    assert.equal(r.body.project.stage.stage, 'Bid');
    assert.deepEqual(await periodNames(id), ['Bid', 'Analysis', 'Bid']);
    const [change] = r.body.project.stageChanges;
    assert.deepEqual([change.kind, change.stage, change.reason, change.actor], ['renamed', 'Bid', reason, 'pm']);
    assert.deepEqual([change.previous[0], change.next[0]].map((s: Stage) => s.name), ['Proposal', 'Bid']);
    const audit = (await t.pool.query(`SELECT detail FROM audit_events WHERE action = 'project.stage_renamed' AND subject_id = $1`, [id])).rows;
    assert.deepEqual(audit.map((a) => a.detail), [{ stageId: proposal.id }], 'ids only');
    // The old name may no longer be chosen, the new one may; the other project and the template keep theirs.
    assert.equal((await pm.request('POST', `/projects/${id}/stage`, { stage: 'Proposal' })).status, 400);
    assert.equal((await pm.request('POST', `/projects/${id}/stage`, { stage: 'Bid' })).status, 200);
    assert.deepEqual(names(await stages(other)), RESEARCH_STAGES);
    assert.deepEqual(await periodNames(other), ['Proposal']);
    const template = (await t.pool.query(`SELECT name FROM stage_template_stages WHERE template_id = $1 ORDER BY position`, [RESEARCH.id])).rows;
    assert.deepEqual(template.map((x) => x.name), RESEARCH_STAGES);
    // A retired stage keeps its state under its new name, and its past period follows.
    const analysis = (await stages(id)).find((s) => s.name === 'Analysis')!;
    assert.equal((await pm.request('POST', `/projects/${id}/stages/${analysis.id}/retire`, { reason })).status, 200);
    const again = await rename(owner, id, analysis.id, 'Findings');
    assert.equal(again.status, 200);
    assert.deepEqual(again.body.project.stages.find((s: Stage) => s.id === analysis.id), { ...analysis, name: 'Findings', status: 'retired' });
    const after = await periodNames(id);
    assert.ok(after.includes('Findings') && !after.includes('Analysis'));
  });

  test('only the letter case of a name may change; a taken, same, bad or credential name is refused', async () => {
    const id = await research();
    const [first, second] = await stages(id);
    const cased = await rename(pm, id, first.id, 'PROPOSAL');
    assert.equal(cased.status, 200);
    assert.equal(cased.body.project.stage.stage, 'PROPOSAL');
    const taken = await rename(pm, id, first.id, 'literature REVIEW');
    assert.deepEqual([taken.status, taken.body.message], [400, 'This project already has a stage with that name.']);
    // A retired stage's name is in use as well.
    assert.equal((await pm.request('POST', `/projects/${id}/stages/${second.id}/retire`, { reason })).status, 200);
    assert.equal((await rename(pm, id, first.id, second.name)).status, 400);
    // The database's own idea of the same name (dotted capital I) is refused in words.
    assert.equal((await pm.request('POST', `/projects/${id}/stages`, { name: 'I', position: 1, reason })).status, 200);
    const dotted = await rename(pm, id, first.id, 'İ');
    assert.deepEqual([dotted.status, dotted.body.message], [400, 'This project already has a stage with that name.']);
    const same = await rename(pm, id, first.id, 'PROPOSAL');
    assert.deepEqual([same.status, same.body.message], [400, 'Give the stage a different name.']);
    const before = (await detail(id)).stageChanges.length;
    for (const bad of ['', '  ', 'x'.repeat(81), 7, undefined]) assert.equal((await rename(pm, id, first.id, bad)).status, 400, String(bad));
    assert.equal((await rename(pm, id, first.id, SECRET)).status, 400);
    assert.equal((await rename(pm, id, first.id, 'Bid', SECRET)).status, 400);
    assert.equal((await rename(pm, id, first.id, 'Bid', ' ')).status, 400);
    assert.equal((await rename(member, id, first.id, 'Bid')).status, 403);
    for (const unknown of ['00000000-0000-4000-8000-000000000000', 'not-an-id']) assert.equal((await rename(pm, id, unknown, 'Bid')).status, 404);
    assert.equal((await detail(id)).stageChanges.length, before, 'nothing is recorded for a refused rename');
    assert.deepEqual(await periodNames(id), ['PROPOSAL']);
    assert.equal((await rename(pm, id, first.id, 'x'.repeat(80))).status, 200);
  });

  test('renaming is refused while the project is Deferred, Closed or archived', async () => {
    const deferred = await research();
    assert.equal((await pm.request('POST', `/projects/${deferred}/transition`, { to: 'deferred', reason })).status, 200);
    const closed = await research('closed');
    const archived = await research('closed');
    assert.equal((await owner.request('POST', `/projects/${archived}/archive`, { reason })).status, 200);
    for (const id of [deferred, closed, archived]) {
      const [first] = await stages(id);
      assert.equal((await rename(owner, id, first.id, 'Bid')).status, 403);
      assert.deepEqual(await periodNames(id), ['Proposal']);
    }
  });

  test('earlier entries in the change history keep the name the stage had then', async () => {
    const id = await research();
    const step = async (path: string, b: object) => {
      t.clock.advanceSeconds(1);
      const r = await pm.request('POST', `/projects/${id}/stages${path}`, { reason, ...b });
      assert.equal(r.status, 200, path);
      return r.body.project;
    };
    const made = (await step('', { name: 'Fieldwork', position: 4 })).stages[3] as Stage;
    await step(`/${made.id}/retire`, {});
    await step(`/${made.id}/restore`, {});
    await step('/order', { ids: (await stages(id)).reverse().map((s) => s.id) });
    await step(`/${made.id}/rename`, { name: 'Site work' });
    await step(`/${made.id}/retire`, {});
    const p = await step(`/${made.id}/rename`, { name: 'On site' });
    const shown = (list: Array<{ kind: string; stage: string | null }>) => list.map((c) => [c.kind, c.stage]);
    const expected = [
      ['renamed', 'On site'], ['retired', 'Site work'], ['renamed', 'Site work'], ['reordered', null],
      ['restored', 'Fieldwork'], ['retired', 'Fieldwork'], ['added', 'Fieldwork'],
    ];
    assert.deepEqual(shown(p.stageChanges), expected);
    assert.ok(p.stageChanges.every((c: { previous: object[]; next: object[] }) => [...c.previous, ...c.next].every((s) => !('id' in s))));
    // Entries recorded before renames existed hold no stage ids; their names come from what changed.
    await t.pool.query(
      `INSERT INTO project_stage_changes (id, project_id, kind, stage_id, actor_id, at, reason, previous, next)
       SELECT gen_random_uuid(), project_id, kind, stage_id, actor_id, at - interval '1 day', reason,
              (SELECT jsonb_agg(e - 'id' ORDER BY n) FROM jsonb_array_elements(previous) WITH ORDINALITY x (e, n)),
              (SELECT jsonb_agg(e - 'id' ORDER BY n) FROM jsonb_array_elements(next) WITH ORDINALITY x (e, n))
         FROM project_stage_changes WHERE project_id = $1`,
      [id],
    );
    assert.deepEqual(shown((await detail(id)).stageChanges), [...expected, ...expected]);
  });

  test('of two stages with the same stored name (after cleaning) only the one named is renamed, and no period', async () => {
    const id = await research();
    const name = 'Trial [credential removed]';
    for (const position of [20, 21]) {
      await t.pool.query(`INSERT INTO project_stages (id, project_id, position, name, added_at) VALUES (gen_random_uuid(), $1, $2, $3, now())`, [id, position, name]);
    }
    assert.equal((await pm.request('POST', `/projects/${id}/stage`, { stage: name })).status, 200);
    const [a, b] = (await stages(id)).filter((s) => s.name === name);
    const r = await rename(pm, id, b.id, 'Second trial');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.project.stages.slice(-2).map((s: Stage) => [s.id, s.name]), [[a.id, name], [b.id, 'Second trial']]);
    assert.equal(r.body.project.stage.stage, name);
    assert.equal(r.body.project.stageChanges[0].stage, 'Second trial');
    // The other is refused the name just given.
    assert.equal((await rename(pm, id, a.id, 'second TRIAL')).status, 400);
  });

  /** Runs `change` up to where it writes the stage periods, then a rename of Analysis, and lets both finish. */
  const renameDuring = async (id: string, change: () => Promise<{ status: number }>) => {
    const analysis = (await stages(id)).find((s) => s.name === 'Analysis')!;
    const other = await t.pool.connect();
    try {
      await other.query('BEGIN');
      await other.query(`SELECT 1 FROM project_stage_periods WHERE project_id = $1 AND ended_at IS NULL FOR UPDATE`, [id]);
      const changing = change();
      await new Promise((r) => setTimeout(r, 500)); // it has read the stages and waits for the open period
      let done = false;
      const renaming = rename(pm, id, analysis.id, 'Findings').finally(() => {
        done = true;
      });
      await new Promise((r) => setTimeout(r, 500));
      assert.equal(done, false, 'the rename waits for the change to finish');
      await other.query('COMMIT');
      assert.deepEqual([(await changing).status, (await renaming).status], [200, 200]);
    } finally {
      await other.query('ROLLBACK');
      other.release();
    }
    assert.equal((await periodNames(id)).at(-1), 'Findings');
    const p = await detail(id);
    assert.equal(p.stage.stage, 'Findings');
    assert.ok(names(p.stages).includes('Findings') && !names(p.stages).includes('Analysis'));
  };

  test('a rename during a change to that stage waits for it and renames the new period too', async () => {
    const id = await research();
    t.clock.advanceSeconds(1);
    await renameDuring(id, () => pm.request('POST', `/projects/${id}/stage`, { stage: 'Analysis' }));
  });

  test('a rename during a reopening into that stage waits for it and renames the new period too', async () => {
    const id = await research('closed');
    t.clock.advanceSeconds(1);
    await renameDuring(id, () => owner.request('POST', `/projects/${id}/transition`, { to: 'active', reason: 'More data', stage: 'Analysis' }));
  });

  test('a change to the old name that waits for a rename is refused; two renames at once leave one name', async () => {
    const id = await research();
    const analysis = (await stages(id)).find((s) => s.name === 'Analysis')!;
    const other = await t.pool.connect();
    try {
      await other.query('BEGIN');
      // The rename stops at its first write, holding the project.
      await other.query(`SELECT 1 FROM project_stages WHERE id = $1 FOR UPDATE`, [analysis.id]);
      const renaming = rename(pm, id, analysis.id, 'Findings');
      await new Promise((r) => setTimeout(r, 500));
      const changing = pm.request('POST', `/projects/${id}/stage`, { stage: 'Analysis' });
      await new Promise((r) => setTimeout(r, 500));
      await other.query('COMMIT');
      assert.equal((await renaming).status, 200);
      const refused = await changing;
      assert.deepEqual([refused.status, refused.body.message], [400, 'Choose a stage.']);
    } finally {
      await other.query('ROLLBACK');
      other.release();
    }
    assert.deepEqual(await periodNames(id), ['Proposal']);
    const proposal = (await stages(id))[0];
    const both = await Promise.all([rename(pm, id, proposal.id, 'Bid'), rename(owner, id, proposal.id, 'Tender')]);
    assert.deepEqual(both.map((r) => r.status), [200, 200]);
    const p = await detail(id);
    assert.ok(['Bid', 'Tender'].includes(p.stage.stage));
    assert.deepEqual([p.stages[0].name, ...(await periodNames(id))], [p.stage.stage, p.stage.stage]);
  });
});
