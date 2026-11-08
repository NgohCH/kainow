import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { type SeedMember, seedProject, seedUser } from '../testing/projects';

describe('project lifecycle', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let admin: Client;
  let pm: Client;
  let owner: Client;
  let member: Client;
  let full: SeedMember[];

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
  });
  afterEach(async () => {
    await t?.close();
  });

  // Each step a minute later, as people do; history is ordered by time.
  const move = (c: Client, id: string, b: object) => {
    t.clock.advanceSeconds(60);
    return c.request('POST', `/projects/${id}/transition`, b);
  };
  const status = async (id: string) => (await t.pool.query(`SELECT status, closure_outcome FROM projects WHERE id = $1`, [id])).rows[0];

  test('a full lifecycle through the API, with history and stage periods', async () => {
    const id = await seedProject(t.pool, { members: full });
    assert.equal((await move(pm, id, { to: 'planned' })).status, 200);
    assert.equal((await move(owner, id, { to: 'active' })).status, 200);
    assert.equal((await move(pm, id, { to: 'deferred', reason: 'Waiting for budget' })).status, 200);
    const resumed = await move(admin, id, { to: 'active', reason: 'Budget approved', stage: 'Execution' });
    assert.equal(resumed.status, 200);
    assert.equal(resumed.body.project.stage.stage, 'Execution');
    assert.equal((await move(owner, id, { to: 'closed', reason: 'Done', outcome: 'delivered' })).status, 200);
    assert.deepEqual(await status(id), { status: 'closed', closure_outcome: 'delivered' });
    assert.equal((await move(owner, id, { to: 'active', reason: 'More work', stage: 'Review & Acceptance' })).status, 200);
    assert.deepEqual(await status(id), { status: 'active', closure_outcome: null });

    const history = (await pm.request('GET', `/projects/${id}`)).body.project;
    assert.deepEqual(history.transitions.map((x: { from: string; to: string }) => `${x.from}>${x.to}`), [
      'draft>planned', 'planned>active', 'active>deferred', 'deferred>active', 'active>closed', 'closed>active',
    ]);
    assert.deepEqual(history.stagePeriods.map((s: { stage: string; endedAt: string | null }) => [s.stage, s.endedAt === null]), [
      ['Initiation', false], ['Execution', false], ['Review & Acceptance', true],
    ]);
    assert.equal((await t.pool.query(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'project.transition'`)).rows[0].n, 6);
  });

  test('the fast track is recorded, and refusals give the reason', async () => {
    const id = await seedProject(t.pool, { members: full });
    const noReason = await move(pm, id, { to: 'active' });
    assert.equal(noReason.status, 409);
    assert.equal(noReason.body.message, 'A reason is required.');
    const wrongActor = await move(owner, id, { to: 'active', reason: 'Quick' });
    assert.equal(wrongActor.status, 403);
    assert.equal(wrongActor.body.message, 'Only the Project Manager can fast-track the project to Active.');
    assert.equal((await move(pm, id, { to: 'active', reason: 'Urgent' })).status, 200);
    assert.equal((await t.pool.query(`SELECT fast_track FROM project_transitions WHERE project_id = $1`, [id])).rows[0].fast_track, true);
    const bad = await move(owner, id, { to: 'planned' });
    assert.equal(bad.status, 409);
    assert.equal(bad.body.message, 'That status change is not allowed.');
  });

  test('gates: required roles must be accepted for Planned and active for Active', async () => {
    const scheduled = await seedProject(t.pool, { members: [...full.slice(0, 2), { userId: member.userId, role: 'member', startsOn: '2026-12-01' }] });
    assert.equal((await move(pm, scheduled, { to: 'planned' })).status, 200, 'a scheduled Member counts as accepted');
    const r = await move(pm, scheduled, { to: 'active' });
    assert.equal(r.status, 409);
    assert.equal(r.body.message, 'The required roles are not all active yet.');
    const noOwner = await seedProject(t.pool, { members: [full[0], full[2]] });
    assert.equal((await move(pm, noOwner, { to: 'planned' })).body.message, 'The required roles are not all accepted yet.');
  });

  test('an administrator without a role may resume a Deferred project but sees nothing else of it', async () => {
    const id = await seedProject(t.pool, { status: 'active', members: full });
    assert.equal((await move(admin, id, { to: 'deferred', reason: 'x' })).status, 403);
    await move(pm, id, { to: 'deferred', reason: 'Pause' });
    assert.equal((await move(admin, id, { to: 'closed', reason: 'x', outcome: 'abandoned' })).status, 403);
    assert.equal((await move(admin, id, { to: 'active', reason: 'Go', stage: 'Execution' })).status, 200);
  });

  test('a non-participant gets not found for a transition', async () => {
    const id = await seedProject(t.pool, { members: full.slice(0, 2) });
    const outsider = await seedUser(t.pool, 'out@example.org');
    assert.ok(outsider);
    const out = await t.signIn('out@example.org');
    assert.equal((await move(out, id, { to: 'planned' })).status, 404);
  });

  test('a Deferred project is read-only: no edits, no stage changes', async () => {
    const id = await seedProject(t.pool, { status: 'deferred', members: full });
    assert.equal((await pm.request('POST', `/projects/${id}/edit`, { name: 'x' })).status, 403);
    assert.equal((await pm.request('POST', `/projects/${id}/stage`, { stage: 'Planning' })).status, 403);
  });

  test('the Project Manager changes the stage while Active, with a valid substage', async () => {
    const id = await seedProject(t.pool, { status: 'active', members: full });
    const r = await pm.request('POST', `/projects/${id}/stage`, { stage: 'Planning', substage: 'Define Scope' });
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.project.stage.stage, r.body.project.stage.substage], ['Planning', 'Define Scope']);
    const bad = await pm.request('POST', `/projects/${id}/stage`, { stage: 'Planning', substage: 'Handover' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.message, 'Choose a substage of Planning.');
    assert.equal((await owner.request('POST', `/projects/${id}/stage`, { stage: 'Execution' })).status, 403);
  });

  test('missing accountability is flagged on an Active project when a required role expires', async () => {
    const id = await seedProject(t.pool, {
      status: 'active',
      members: [full[0], { userId: owner.userId, role: 'owner', expiresOn: '2026-11-08' }, full[2]],
    });
    const p = (await pm.request('GET', `/projects/${id}`)).body.project;
    assert.equal(p.missingAccountability, true);
    assert.deepEqual(p.missingRoles, ['an Owner or a Sponsor']);
  });
});
