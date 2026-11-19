import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { uuidv7 } from '../common/uuid7';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedProject, seedUser } from '../testing/projects';

// 23:50 on 9 November 2026 in UTC+8: ten minutes before the day turns.
const START = Date.UTC(2026, 10, 9, 15, 50, 0);

describe('project resource lines over HTTP', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let pm: Client;
  let ann: Client;
  let outsider: Client;
  let ids: Record<string, string>;
  let projectId: string;
  let item: string;
  let retired: string;
  const url = (path = '') => `/projects/${projectId}/resources${path}`;
  const events = async (lineId: string) =>
    (await t.pool.query(`SELECT kind, actor_id, reason, detail FROM resource_line_events WHERE line_id = $1 ORDER BY at, id`, [lineId])).rows;

  beforeEach(async () => {
    t = await startTestApp(START);
    ids = {};
    for (const p of ['pm', 'owner', 'ann', 'ben', 'cleo', 'outsider']) ids[p] = await seedUser(t.pool, `${p}@example.org`);
    projectId = await seedProject(t.pool, {
      status: 'active',
      name: 'Harbour Survey',
      members: [
        { userId: ids.pm, role: 'pm' },
        { userId: ids.owner, role: 'owner' },
        { userId: ids.ann, role: 'member' },
        { userId: ids.ben, role: 'member', revoked: true },
        { userId: ids.cleo, role: 'member', startsOn: '2026-12-01' },
      ],
    });
    item = uuidv7();
    retired = uuidv7();
    await t.pool.query(
      `INSERT INTO resource_items (id, kind, reference, name, created_by, created_at, status) VALUES ($1, 'equipment', 'P-04', 'Dummy projector', $3, now(), 'active'),
              ($2, 'facility', 'R-01', 'Old room', $3, now(), 'retired')`,
      [item, retired, ids.pm],
    );
    pm = await t.signIn('pm@example.org');
    ann = await t.signIn('ann@example.org');
    outsider = await t.signIn('outsider@example.org');
  });
  afterEach(async () => {
    await t?.close();
  });

  const create = (who: Client, body: Record<string, unknown>) => who.request('POST', url('/lines'), body);
  const catalogueLine = { itemId: '', quantity: '2', unit: 'items', startsOn: '2026-12-03', endsOn: '2026-12-14', neededBy: '2026-12-01', notes: 'For the site walk' };

  test('a Member lists but cannot create; an outsider gets 404', async () => {
    const list = await ann.request('GET', url());
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.deepEqual(list.body.lines, []);
    assert.deepEqual(list.body.counts, { needed: 0, arranged: 0, in_use: 0, finished: 0, cancelled: 0 });
    assert.equal(typeof list.body.computedAt, 'string');
    assert.equal((await create(ann, { ...catalogueLine, itemId: item })).status, 403);
    assert.equal((await outsider.request('GET', url())).status, 404);
    assert.equal((await create(outsider, { ...catalogueLine, itemId: item })).status, 404);
  });

  test('a PM creates, edits, sets status and cancels with a reason; every change writes an event', async () => {
    const made = await create(pm, { ...catalogueLine, itemId: item });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const line = made.body.line;
    assert.deepEqual(line.item, { id: item, kind: 'equipment', reference: 'P-04', name: 'Dummy projector', category: null, retired: false });
    assert.equal(line.quantity, '2.00');
    assert.equal(line.unit, 'items');
    assert.equal(line.startsOn, '2026-12-03');
    assert.equal(line.endsOn, '2026-12-14');
    assert.equal(line.neededBy, '2026-12-01');
    assert.equal(line.status, 'needed');
    assert.equal(line.oneOffKind, null);
    assert.deepEqual(line.overlap, { named: [], others: 0 });
    assert.equal(line.neededByPassed, false);

    t.clock.advanceSeconds(1);
    const edited = await pm.request('PUT', url(`/lines/${line.id}`), { quantity: '3.5', endsOn: null });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(edited.body.line.quantity, '3.50');
    assert.equal(edited.body.line.endsOn, null);

    t.clock.advanceSeconds(1);
    const moved = await pm.request('POST', url(`/lines/${line.id}/status`), { status: 'arranged' });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.equal(moved.body.line.status, 'arranged');
    t.clock.advanceSeconds(1);
    const back = await pm.request('POST', url(`/lines/${line.id}/status`), { status: 'needed' });
    assert.equal(back.body.line.status, 'needed');

    const viaStatus = await pm.request('POST', url(`/lines/${line.id}/status`), { status: 'cancelled' });
    assert.equal(viaStatus.status, 400);
    assert.equal(viaStatus.body.message, 'Use Cancel to cancel a line.');
    assert.equal((await pm.request('POST', url(`/lines/${line.id}/cancel`), { reason: '  ' })).status, 400);
    t.clock.advanceSeconds(1);
    const cancelled = await pm.request('POST', url(`/lines/${line.id}/cancel`), { reason: 'Booked by mistake' });
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    assert.equal(cancelled.body.line.status, 'cancelled');

    const again = await pm.request('PUT', url(`/lines/${line.id}`), { notes: 'Too late' });
    assert.equal(again.status, 409);
    assert.equal(again.body.message, 'This line is cancelled.');
    assert.equal((await pm.request('POST', url(`/lines/${line.id}/status`), { status: 'arranged' })).status, 409);

    const rows = await events(line.id);
    assert.deepEqual(rows.map((r) => r.kind), ['created', 'edited', 'status_changed', 'status_changed', 'cancelled']);
    assert.ok(rows.every((r) => r.actor_id === ids.pm));
    assert.equal(rows[0].detail.previous, null);
    assert.equal(rows[0].detail.next.quantity, '2.00');
    assert.deepEqual(rows[1].detail, { previous: { quantity: '2.00', endsOn: '2026-12-14' }, next: { quantity: '3.50', endsOn: null } });
    assert.deepEqual(rows[2].detail, { previous: { status: 'needed' }, next: { status: 'arranged' } });
    assert.deepEqual(rows[4].detail, { previous: { status: 'needed' }, next: { status: 'cancelled' } });
    assert.equal(rows[4].reason, 'Booked by mistake');

    const history = await ann.request('GET', url(`/lines/${line.id}/history`));
    assert.equal(history.status, 200);
    assert.deepEqual(history.body.events.map((e: { kind: string }) => e.kind), ['created', 'edited', 'status_changed', 'status_changed', 'cancelled']);
    assert.equal(history.body.events[0].actor, 'pm');

    const list = await ann.request('GET', url());
    assert.equal(list.body.counts.cancelled, 1);
    assert.equal(list.body.lines[0].status, 'cancelled');
  });

  test('one-off lines, the retired item and the field rules', async () => {
    const oneOff = await create(pm, { oneOffKind: 'other', description: 'Hired survey drone', startsOn: '2027-01-05' });
    assert.equal(oneOff.status, 201, JSON.stringify(oneOff.body));
    assert.equal(oneOff.body.line.item, null);
    assert.equal(oneOff.body.line.oneOffKind, 'other');
    assert.equal(oneOff.body.line.description, 'Hired survey drone');
    assert.equal(oneOff.body.line.quantity, null);
    assert.equal(oneOff.body.line.overlap, null);

    const refuse = async (body: Record<string, unknown>, message: string) => {
      const r = await create(pm, body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.body.message, message);
    };
    await refuse({ itemId: retired }, 'Choose an active catalogue item.');
    await refuse({ itemId: uuidv7() }, 'Choose an active catalogue item.');
    await refuse({ itemId: item, quantity: '2' }, 'Enter both a quantity and a unit, or neither.');
    await refuse({ itemId: item, unit: 'items' }, 'Enter both a quantity and a unit, or neither.');
    await refuse({ itemId: item, quantity: '0', unit: 'items' }, 'Enter a quantity above 0 with at most 2 decimal places.');
    await refuse({ itemId: item, quantity: '1.234', unit: 'items' }, 'Enter a quantity above 0 with at most 2 decimal places.');
    await refuse({ itemId: item, quantity: '2', unit: 'crates' }, 'Choose a unit from the list.');
    await refuse({ itemId: item, startsOn: '2026-12-10', endsOn: '2026-12-09' }, 'The end date cannot be before the start date.');
    await refuse({ oneOffKind: 'other', description: '' }, 'Enter a description of 1 to 200 characters.');
    await refuse({ oneOffKind: 'other', description: 'x'.repeat(201) }, 'Enter a description of 1 to 200 characters.');
    await refuse({ itemId: item, notes: 'x'.repeat(2001) }, 'Notes can be up to 2,000 characters.');
    const key = `sk-${'a1B2c3D4e5'.repeat(3)}`;
    for (const body of [{ oneOffKind: 'other', description: `Use ${key}` }, { itemId: item, notes: key }]) {
      const secret = await create(pm, body);
      assert.equal(secret.status, 400);
      assert.match(secret.body.message, /API secret key/);
    }

    const made = (await create(pm, { itemId: item })).body.line;
    const toRetired = await pm.request('PUT', url(`/lines/${made.id}`), { itemId: retired });
    assert.equal(toRetired.status, 400);
    assert.equal(toRetired.body.message, 'Choose an active catalogue item.');
    // A line whose item was retired later still shows it and can still be edited otherwise.
    await t.pool.query(`UPDATE resource_items SET status = 'retired' WHERE id = $1`, [item]);
    const kept = await pm.request('PUT', url(`/lines/${made.id}`), { notes: 'Still fine' });
    assert.equal(kept.status, 200, JSON.stringify(kept.body));
    assert.equal(kept.body.line.item.retired, true);
  });

  test('Deferred is read-only', async () => {
    const made = (await create(pm, { ...catalogueLine, itemId: item })).body.line;
    await t.pool.query(`UPDATE projects SET status = 'deferred' WHERE id = $1`, [projectId]);
    assert.equal((await pm.request('GET', url())).status, 200);
    assert.equal((await create(pm, { ...catalogueLine, itemId: item })).status, 403);
    assert.equal((await pm.request('PUT', url(`/lines/${made.id}`), { notes: 'x' })).status, 403);
    assert.equal((await pm.request('POST', url(`/lines/${made.id}/status`), { status: 'arranged' })).status, 403);
    assert.equal((await pm.request('POST', url(`/lines/${made.id}/cancel`), { reason: 'x' })).status, 403);
  });

  test('neededByPassed flips at the UTC+8 day boundary', async () => {
    await create(pm, { oneOffKind: 'equipment', description: 'Spare laptop', neededBy: '2026-11-09' });
    const before = await ann.request('GET', url());
    assert.equal(before.body.lines[0].neededByPassed, false);
    t.clock.advanceMinutes(11); // 00:01 on 10 November in UTC+8
    const afterTurn = await ann.request('GET', url());
    assert.equal(afterTurn.body.lines[0].neededByPassed, true);
    await pm.request('POST', url(`/lines/${afterTurn.body.lines[0].id}/status`), { status: 'arranged' });
    assert.equal((await ann.request('GET', url())).body.lines[0].neededByPassed, false);
  });

  test('lines are ordered by needed-by, start, reference or description, then creation', async () => {
    await create(pm, { oneOffKind: 'other', description: 'Zeta no dates' });
    t.clock.advanceSeconds(1);
    await create(pm, { oneOffKind: 'other', description: 'Alpha no dates' });
    t.clock.advanceSeconds(1);
    await create(pm, { itemId: item, startsOn: '2026-12-01' });
    t.clock.advanceSeconds(1);
    await create(pm, { oneOffKind: 'other', description: 'Needed late', neededBy: '2026-12-20' });
    t.clock.advanceSeconds(1);
    await create(pm, { oneOffKind: 'other', description: 'Needed soon', neededBy: '2026-12-02' });
    const list = await ann.request('GET', url());
    assert.deepEqual(
      list.body.lines.map((l: { description: string; item: { reference: string } | null }) => l.item?.reference ?? l.description),
      ['Needed soon', 'Needed late', 'P-04', 'Alpha no dates', 'Zeta no dates'],
    );
  });

  test('People count only open live tasks, for Active memberships only', async () => {
    const task = async (assignee: string, status: string, dueOn: string, deleted = false) =>
      t.pool.query(
        `INSERT INTO tasks (id, project_id, depth, title, assignee_id, due_on, status, completed_at, authorised_by, authorised_at, deleted_at, deleted_by, delete_reason)
         VALUES ($1, $2, 0, 'Task', $3, $4, $5, $6, $7, now(), $8, $9, $10)`,
        [uuidv7(), projectId, assignee, dueOn, status, status === 'completed' ? new Date() : null, ids.pm,
          deleted ? new Date() : null, deleted ? ids.pm : null, deleted ? 'Duplicate' : null],
      );
    await task(ids.ann, 'not_started', '2026-11-30');
    await task(ids.ann, 'in_progress', '2026-11-01'); // overdue
    await task(ids.ann, 'blocked', '2026-11-08'); // overdue
    await task(ids.ann, 'completed', '2026-11-01');
    await task(ids.ann, 'cancelled', '2026-11-01');
    await task(ids.ann, 'not_started', '2026-11-01', true); // deleted
    await task(ids.ben, 'not_started', '2026-11-30'); // revoked membership
    const list = await ann.request('GET', url());
    assert.deepEqual(list.body.people, [
      { userId: ids.ann, name: 'ann', department: null, roles: ['member'], openTasks: 3, overdue: 2 },
      { userId: ids.owner, name: 'owner', department: null, roles: ['owner'], openTasks: 0, overdue: 0 },
      { userId: ids.pm, name: 'pm', department: null, roles: ['pm'], openTasks: 0, overdue: 0 },
    ]);
  });
});
