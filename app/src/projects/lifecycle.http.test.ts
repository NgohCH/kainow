import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { uuidv7 } from '../common/uuid7';
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
    assert.equal((await move(owner, id, { to: 'closed', reason: 'Done', outcome: 'delivered', objectivesMet: true })).status, 200);
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

  test('the project detail shows a stage stopped by a deferral or closure; what is stored and resuming are unchanged (D138)', async () => {
    const id = await seedProject(t.pool, { status: 'active', members: full });
    type P = { stage: string; endedAt: string | null; endedOn: string | null; stopped: string | null };
    const read = async (project = id) => (await pm.request('GET', `/projects/${project}`)).body.project as { stage: P; stagePeriods: P[] };
    const draft = await read(await seedProject(t.pool, { members: full }));
    assert.deepEqual([draft.stage.endedOn, draft.stage.stopped], [null, null]);

    await move(pm, id, { to: 'deferred', reason: 'Waiting for budget' });
    const deferredAt = (await t.pool.query(`SELECT at FROM project_transitions WHERE project_id = $1`, [id])).rows[0].at.toISOString();
    let p = await read();
    // The latest stage stays, so resuming can offer it; it is stopped, not current.
    assert.deepEqual([p.stage.stage, p.stage.endedAt, p.stage.endedOn, p.stage.stopped], ['Initiation', deferredAt, '2026-11-09', 'deferred']);
    assert.equal((await t.pool.query(`SELECT count(*)::int AS n FROM project_stage_periods WHERE project_id = $1 AND ended_at IS NULL`, [id])).rows[0].n, 1);
    // Resumed, then closed, the same day.
    assert.equal((await move(pm, id, { to: 'active', reason: 'Budget approved', stage: 'Execution' })).status, 200);
    p = await read();
    assert.deepEqual(p.stagePeriods.map((s) => [s.stage, s.endedOn, s.stopped]), [['Initiation', '2026-11-09', 'deferred'], ['Execution', null, null]]);
    assert.equal(p.stagePeriods[0].endedAt, deferredAt, 'it ends at the deferral, not at the resumption');
    await move(owner, id, { to: 'closed', reason: 'Done', outcome: 'delivered', objectivesMet: true });
    p = await read();
    assert.deepEqual(p.stagePeriods.map((s) => [s.stage, s.stopped]), [['Initiation', 'deferred'], ['Execution', 'closed']]);
    assert.equal(p.stage.stopped, 'closed');
    await move(owner, id, { to: 'active', reason: 'More work', stage: 'Execution' });
    p = await read();
    assert.deepEqual(p.stagePeriods.map((s) => [s.stage, s.stopped]), [['Initiation', 'deferred'], ['Execution', 'closed'], ['Execution', null]]);
    assert.deepEqual([p.stage.stage, p.stage.endedAt, p.stage.stopped], ['Execution', null, null]);
  });

  test('the project list says since when and why a project is Deferred, or with what outcome it closed, only to those who read it in the detail (D138)', async () => {
    const id = await seedProject(t.pool, { status: 'active', members: full });
    const other = await seedProject(t.pool, { status: 'active', members: full });
    const outsider = await seedUser(t.pool, 'out@example.org');
    const out = await t.signIn('out@example.org');
    const row = async (c: Client, project = id) =>
      (await c.request('GET', '/projects')).body.projects.find((x: { id: string }) => x.id === project) as { deferred: unknown; closed: unknown } | undefined;
    assert.deepEqual([(await row(member))?.deferred, (await row(member))?.closed], [null, null]);

    await move(pm, id, { to: 'deferred', reason: 'Waiting for the budget board' });
    const deferred = { on: '2026-11-09', reason: 'Waiting for the budget board' };
    for (const c of [pm, owner, member]) {
      assert.deepEqual([(await row(c))?.deferred, (await row(c))?.closed], [deferred, null]);
      assert.equal((await c.request('GET', `/projects/${id}`)).body.project.transitions.at(-1).reason, deferred.reason);
    }
    assert.equal((await row(member, other))?.deferred, null, 'another project in the same list');
    // Not to an outsider, and not in the administrator's list of every project.
    for (const c of [out, admin]) assert.ok(!JSON.stringify((await c.request('GET', '/projects')).body).includes(deferred.reason));
    assert.equal((await out.request('GET', `/projects/${id}`)).status, 404);
    // Nor on a leadership card, or to a member whose membership is On Hold.
    await t.pool.query(
      `INSERT INTO leadership_grants (id, user_id, scope_kind, starts_on, reason, granted_by, granted_at) VALUES ($1, $2, 'organisation', '2026-11-01', 'Oversight', $3, now())`,
      [uuidv7(), outsider, admin.userId],
    );
    const cards = await out.request('GET', '/dashboard/leadership');
    assert.equal(cards.body.cards.length, 2);
    assert.ok(!JSON.stringify(cards.body).includes(deferred.reason));
    await t.pool.query(`UPDATE memberships SET held_at = now(), hold_reason = 'Check' WHERE project_id = $1 AND user_id = $2`, [id, member.userId]);
    assert.equal(await row(member), undefined);
    await t.pool.query(`UPDATE memberships SET restored_at = now() WHERE project_id = $1 AND user_id = $2`, [id, member.userId]);

    await move(owner, id, { to: 'closed', reason: 'Not needed', outcome: 'abandoned' });
    assert.deepEqual([(await row(pm))?.deferred, (await row(pm))?.closed], [null, { on: '2026-11-09', outcome: 'abandoned' }]);
    await move(owner, id, { to: 'active', reason: 'Needed', stage: 'Execution' });
    assert.deepEqual([(await row(pm))?.deferred, (await row(pm))?.closed], [null, null]);
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
    assert.equal(r.body.message, 'The required roles are not all active yet. Still needed: a Member who is not the Project Manager.');
    const noOwner = await seedProject(t.pool, { members: [full[0], full[2]] });
    assert.equal((await move(pm, noOwner, { to: 'planned' })).body.message, 'The required roles are not all accepted yet. Still needed: an Owner or a Sponsor.');
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
