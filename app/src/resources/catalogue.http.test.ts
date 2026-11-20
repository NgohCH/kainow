import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedUser, seedWorkingProject } from '../testing/projects';
import { uuidv7 } from '../common/uuid7';

const CAT = '/resources/catalogue';

describe('organisation resource catalogue', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let admin: Client;
  let adminId: string;
  let member: Client;
  let memberId: string;
  let keeper: Client;

  beforeEach(async () => {
    t = await startTestApp();
    adminId = await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    memberId = await seedUser(t.pool, 'plain@example.org');
    const keeperId = await seedUser(t.pool, 'keeper@example.org');
    await t.pool.query(`INSERT INTO resource_catalogue_maintainers (user_id, added_by, added_at, reason) VALUES ($1, $2, now(), 'Looks after rooms')`, [keeperId, adminId]);
    admin = await t.signIn('admin@example.org');
    member = await t.signIn('plain@example.org');
    keeper = await t.signIn('keeper@example.org');
  });
  afterEach(async () => {
    await t?.close();
  });

  const category = async (name = 'Rooms') => (await admin.request('POST', `${CAT}/categories`, { name })).body.category.id as string;
  const item = async (categoryId: string, over: Record<string, unknown> = {}) =>
    admin.request('POST', `${CAT}/items`, { kind: 'facility', reference: 'P-04', name: 'Print room', categoryId, description: 'Second floor', ...over });
  const tick = () => t.clock.advanceSeconds(1);
  const events = async () => (await t.pool.query(`SELECT * FROM resource_catalogue_events WHERE subject_kind IN ('item','category') ORDER BY at, id`)).rows;

  test('GET /me tells the menu whether to show the catalogue: Administrator and listed maintainer yes, others no', async () => {
    assert.equal((await t.anonymous('GET', `${CAT}/me`)).status, 401);
    assert.deepEqual((await admin.request('GET', `${CAT}/me`)).body, { maintainer: true });
    assert.deepEqual((await keeper.request('GET', `${CAT}/me`)).body, { maintainer: true });
    assert.deepEqual((await member.request('GET', `${CAT}/me`)).body, { maintainer: false });
  });

  test('anonymous gets 401; a member cannot write but can list active entries', async () => {
    assert.equal((await t.anonymous('GET', CAT)).status, 401);
    const cat = await category();
    const created = await item(cat);
    assert.equal(created.status, 201);
    assert.equal((await member.request('POST', `${CAT}/categories`, { name: 'Labs' })).status, 403);
    assert.equal((await member.request('POST', `${CAT}/items`, { kind: 'facility', reference: 'X-1', name: 'X', categoryId: cat })).status, 403);
    assert.equal((await member.request('PUT', `${CAT}/items/${created.body.item.id}`, { name: 'Y' })).status, 403);
    assert.equal((await member.request('POST', `${CAT}/items/${created.body.item.id}/retire`, { reason: 'x' })).status, 403);
    assert.equal((await member.request('PUT', `${CAT}/categories/${cat}`, { name: 'Y' })).status, 403);
    assert.equal((await member.request('POST', `${CAT}/categories/${cat}/retire`, { reason: 'x' })).status, 403);
    const list = await member.request('GET', CAT);
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.items.map((i: { reference: string }) => i.reference), ['P-04']);
    assert.equal(list.body.items[0].categoryName, 'Rooms');
    assert.equal('projectsWithLines' in list.body.items[0], false);
    assert.equal((await member.request('GET', `${CAT}?all=1`)).status, 403);
  });

  test('a maintainer adds, renames and retires; events record actor and detail', async () => {
    const cat = await category();
    const created = await item(cat);
    assert.equal(created.status, 201);
    const id = created.body.item.id;
    tick();
    const k = await keeper.request('PUT', `${CAT}/items/${id}`, { reference: 'P-05' });
    assert.equal(k.status, 200);
    assert.equal(k.body.item.reference, 'P-05');
    tick();
    assert.equal((await keeper.request('PUT', `${CAT}/items/${id}`, { description: 'Third floor' })).status, 200);
    assert.equal((await keeper.request('POST', `${CAT}/items/${id}/retire`, {})).status, 400);
    tick();
    assert.equal((await keeper.request('POST', `${CAT}/items/${id}/retire`, { reason: 'Moved out' })).status, 200);
    const kinds = (await events()).filter((e) => e.subject_kind === 'item');
    assert.deepEqual(kinds.map((e) => e.kind), ['added', 'renamed', 'edited', 'retired']);
    assert.equal(kinds[0].actor_id, adminId);
    assert.deepEqual(kinds[1].detail, { previous: { reference: 'P-04' }, next: { reference: 'P-05' } });
    assert.deepEqual(kinds[2].detail, { previous: { description: 'Second floor' }, next: { description: 'Third floor' } });
    assert.equal(kinds[3].reason, 'Moved out');
    assert.equal(kinds[1].actor_id, kinds[3].actor_id);
    assert.notEqual(kinds[1].actor_id, adminId);
    assert.equal((await admin.request('PUT', `${CAT}/items/${id}`, { name: 'Z' })).status, 409);
    assert.equal((await admin.request('PUT', `${CAT}/items/${id}`, { name: 'Z' })).body.message, 'This item is retired.');
  });

  test('retired items are absent by default and present with all=1; the reference can be reused', async () => {
    const cat = await category();
    const first = await item(cat);
    assert.equal((await item(cat, { reference: 'p-04' })).status, 409);
    assert.equal((await item(cat, { reference: 'p-04' })).body.message, 'A current item already uses this reference.');
    await admin.request('POST', `${CAT}/items/${first.body.item.id}/retire`, { reason: 'Replaced' });
    assert.deepEqual((await member.request('GET', CAT)).body.items, []);
    const all = await admin.request('GET', `${CAT}?all=1`);
    assert.equal(all.body.items.length, 1);
    assert.equal(all.body.items[0].status, 'retired');
    assert.equal((await item(cat)).status, 201);
    assert.equal((await admin.request('GET', `${CAT}?all=1`)).body.items.length, 2);
    // Editing onto a current reference is refused too.
    const other = await item(cat, { reference: 'P-09', name: 'Other' });
    assert.equal((await admin.request('PUT', `${CAT}/items/${other.body.item.id}`, { reference: 'P-04' })).status, 409);
  });

  test('an item needs an active category', async () => {
    const cat = await category();
    assert.equal((await item(uuidv7())).status, 400);
    assert.equal((await item(uuidv7())).body.message, 'Choose an active category.');
    assert.equal((await item(undefined as unknown as string)).status, 400);
    const ok = await item(cat);
    await admin.request('POST', `${CAT}/categories/${cat}/retire`, { reason: 'Obsolete' });
    assert.equal((await item(cat, { reference: 'P-07' })).body.message, 'Choose an active category.');
    const other = await category('Labs');
    assert.equal((await admin.request('PUT', `${CAT}/items/${ok.body.item.id}`, { categoryId: cat })).status, 200); // unchanged
    assert.equal((await admin.request('PUT', `${CAT}/items/${ok.body.item.id}`, { categoryId: other })).status, 200);
    assert.equal((await admin.request('PUT', `${CAT}/items/${ok.body.item.id}`, { categoryId: cat })).status, 400);
  });

  test('categories: ordered by name, unique among active, rename and retire recorded', async () => {
    const b = await category('beta');
    tick();
    await category('Alpha');
    assert.equal((await admin.request('POST', `${CAT}/categories`, { name: 'BETA' })).status, 409);
    const names = (r: { body: { categories: { name: string }[] } }) => r.body.categories.map((c) => c.name);
    assert.deepEqual(names(await member.request('GET', CAT)), ['Alpha', 'beta']);
    tick();
    assert.equal((await keeper.request('PUT', `${CAT}/categories/${b}`, { name: 'Gamma' })).status, 200);
    assert.equal((await admin.request('POST', `${CAT}/categories/${b}/retire`, { reason: ' ' })).status, 400);
    tick();
    assert.equal((await admin.request('POST', `${CAT}/categories/${b}/retire`, { reason: 'Merged' })).status, 200);
    assert.deepEqual(names(await member.request('GET', CAT)), ['Alpha']);
    assert.deepEqual(names(await admin.request('GET', `${CAT}?all=1`)), ['Alpha', 'Gamma']);
    assert.equal((await admin.request('PUT', `${CAT}/categories/${b}`, { name: 'Delta' })).status, 409);
    const ev = (await events()).filter((e) => e.subject_kind === 'category');
    assert.deepEqual(ev.map((e) => e.kind), ['added', 'added', 'renamed', 'retired']);
    assert.deepEqual(ev[2].detail, { previous: { name: 'beta' }, next: { name: 'Gamma' } });
  });

  test('list order: kind, then reference ignoring case', async () => {
    const cat = await category();
    await item(cat, { kind: 'facility', reference: 'b-1', name: 'B' });
    await item(cat, { kind: 'equipment', reference: 'Z-1', name: 'Z' });
    await item(cat, { kind: 'equipment', reference: 'a-2', name: 'A' });
    const refs = (await member.request('GET', CAT)).body.items.map((i: { reference: string }) => i.reference);
    assert.deepEqual(refs, ['a-2', 'Z-1', 'b-1']);
  });

  test('text limits', async () => {
    const cat = await category();
    assert.equal((await item(cat, { reference: 'R'.repeat(31) })).status, 400);
    assert.equal((await item(cat, { reference: '  ' })).status, 400);
    assert.equal((await item(cat, { name: 'N'.repeat(121) })).status, 400);
    assert.equal((await item(cat, { description: 'D'.repeat(1001) })).status, 400);
    assert.equal((await item(cat, { kind: 'other' })).status, 400);
    assert.equal((await admin.request('POST', `${CAT}/categories`, { name: 'C'.repeat(81) })).status, 400);
    assert.equal((await item(cat, { reference: 'R'.repeat(30), name: 'N'.repeat(120), description: 'D'.repeat(1000) })).status, 201);
  });

  test('typed text is checked for credentials', async () => {
    const cat = await category();
    const key = `sk-${'a1B2c3D4e5'.repeat(3)}`;
    for (const over of [{ description: `Use ${key}` }, { name: key }, { reference: key }]) {
      const r = await item(cat, over);
      assert.equal(r.status, 400);
      assert.match(r.body.message, /API secret key/);
      assert.ok(!JSON.stringify(r.body).includes(key));
    }
    const ok = await item(cat);
    assert.equal((await admin.request('PUT', `${CAT}/items/${ok.body.item.id}`, { description: key })).status, 400);
    assert.equal((await admin.request('POST', `${CAT}/categories`, { name: key })).status, 400);
    assert.equal((await admin.request('POST', `${CAT}/items/${ok.body.item.id}/retire`, { reason: key })).status, 400);
    assert.equal((await t.pool.query(`SELECT count(*)::int AS n FROM resource_items`)).rows[0].n, 1);
  });

  test('projectsWithLines counts distinct projects with current or future lines, for maintainers only', async () => {
    const cat = await category();
    const id = (await item(cat)).body.item.id as string;
    const p1 = await seedWorkingProject(t.pool, memberId);
    const p2 = await seedWorkingProject(t.pool, memberId);
    const p3 = await seedWorkingProject(t.pool, memberId);
    const p4 = await seedWorkingProject(t.pool, memberId);
    const day = (n: number) => new Date(t.clock.ms + 8 * 3600_000 + n * 86400_000).toISOString().slice(0, 10);
    const today = day(0);
    const line = (project: string, status: string, starts: string | null, ends: string | null) =>
      t.pool.query(
        `INSERT INTO resource_lines (id, project_id, item_id, starts_on, ends_on, status, created_by, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, now(), now())`,
        [uuidv7(), project, id, starts, ends, status, memberId],
      );
    await line(p1, 'needed', day(-10), day(5)); // current
    await line(p1, 'arranged', day(10), null); // future, same project
    await line(p2, 'needed', day(-20), day(-1)); // ended
    await line(p2, 'cancelled', day(1), day(2)); // cancelled
    await line(p3, 'in_use', null, null); // no period, not finished
    await line(p4, 'finished', null, null); // no period, finished
    await line(p4, 'needed', day(-5), today); // ends today counts
    const count = async (c: Client) => (await c.request('GET', CAT)).body.items.find((i: { id: string }) => i.id === id).projectsWithLines;
    assert.equal(await count(admin), 3);
    assert.equal(await count(keeper), 3);
    await t.pool.query(`UPDATE resource_lines SET status = 'finished' WHERE project_id = $1 AND starts_on IS NULL`, [p3]);
    assert.equal(await count(admin), 2);
    const body = (await member.request('GET', CAT)).body;
    assert.equal(JSON.stringify(body).includes('projectsWithLines'), false);
  });
});
