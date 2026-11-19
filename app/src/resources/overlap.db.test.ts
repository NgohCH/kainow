import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Pool } from 'pg';
import type { AuthUser } from '../auth/tokens';
import { uuidv7 } from '../common/uuid7';
import { loadDatabaseConfig } from '../config';
import { runMigrations } from '../db/migrate';
import { ProjectAccess } from '../projects/access.service';
import { SKIP_NO_DB, resetPublicSchema, testDatabaseUrl } from '../testing/db';
import { seedProject, seedUser } from '../testing/projects';
import { type Overlap, overlapsFor } from './lines.service';

const migrationsDir = loadDatabaseConfig({ DATABASE_URL: 'x' }).migrationsDir;
const NOW = new Date(Date.UTC(2026, 10, 20, 2, 0, 0));

describe('overlapsFor (D91)', { skip: SKIP_NO_DB }, () => {
  let pool: Pool;
  let access: ProjectAccess;
  let pm: string;
  let viewerId: string;
  let viewer: AuthUser;
  let item: string;
  let otherItem: string;
  let a: string;

  before(() => {
    pool = new Pool({ connectionString: testDatabaseUrl() });
    access = new ProjectAccess(pool, () => NOW);
  });
  after(async () => {
    await pool.end();
  });

  const user = (id: string, email: string, role = 'member'): AuthUser => ({ id, email, displayName: email.split('@')[0], role });

  const project = (name: string, opts: { status?: 'active' | 'closed'; viewerIn?: boolean } = {}) =>
    seedProject(pool, {
      status: opts.status ?? 'active',
      name,
      members: [{ userId: pm, role: 'pm' }, { userId: pm, role: 'owner' }, ...(opts.viewerIn ? [{ userId: viewerId, role: 'member' as const }] : [])],
    });

  async function line(projectId: string, opts: { item?: string | null; startsOn?: string | null; endsOn?: string | null; status?: string } = {}): Promise<string> {
    const id = uuidv7();
    const itemId = opts.item === undefined ? item : opts.item;
    await pool.query(
      `INSERT INTO resource_lines (id, project_id, item_id, one_off_kind, description, quantity, unit, starts_on, ends_on, notes, status, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 3, 'items', $6, $7, 'Private notes', $8, $9, now(), now())`,
      [id, projectId, itemId, itemId ? null : 'other', itemId ? '' : 'Hired drone', opts.startsOn === undefined ? '2026-12-03' : opts.startsOn,
        opts.endsOn === undefined ? '2026-12-14' : opts.endsOn, opts.status ?? 'needed', pm],
    );
    return id;
  }

  async function overlapOf(id: string, who: AuthUser = viewer): Promise<Overlap | null> {
    const { rows } = await pool.query(`SELECT id, item_id AS "itemId", to_char(starts_on, 'YYYY-MM-DD') AS "startsOn", status FROM resource_lines WHERE id = $1`, [id]);
    const map = await overlapsFor(pool, access, who, rows);
    return map.get(id) ?? null;
  }

  beforeEach(async () => {
    await resetPublicSchema(pool);
    await runMigrations(pool, migrationsDir);
    pm = await seedUser(pool, 'pm@example.org');
    viewerId = await seedUser(pool, 'viewer@example.org');
    viewer = user(viewerId, 'viewer@example.org');
    item = uuidv7();
    otherItem = uuidv7();
    await pool.query(
      `INSERT INTO resource_items (id, kind, reference, name, created_by, created_at) VALUES ($1, 'equipment', 'P-04', 'Dummy projector', $3, now()),
              ($2, 'equipment', 'P-05', 'Dummy screen', $3, now())`,
      [item, otherItem, pm],
    );
    a = await project('Alpha Base', { viewerIn: true });
  });

  test('a Cancelled line is left out and a Finished line counts', async () => {
    const mine = await line(a);
    const b = await project('Bravo Works', { viewerIn: true });
    const c = await project('Charlie Yard', { viewerIn: true });
    await line(b, { status: 'cancelled' });
    await line(c, { status: 'finished' });
    assert.deepEqual(await overlapOf(mine), { named: [{ projectId: c, name: 'Charlie Yard' }], others: 0 });
  });

  test("a Closed project's line counts", async () => {
    const mine = await line(a);
    const d = await project('Delta Closed', { status: 'closed' });
    await line(d, { startsOn: '2026-12-14', endsOn: null });
    assert.deepEqual(await overlapOf(mine), { named: [], others: 1 });
  });

  test('one project with two overlapping lines counts once', async () => {
    const mine = await line(a);
    const c = await project('Charlie Yard');
    await line(c);
    await line(c, { startsOn: '2026-12-10', endsOn: '2026-12-20' });
    assert.deepEqual(await overlapOf(mine), { named: [], others: 1 });
  });

  test('the viewer sees in A and B: B is named, C is counted', async () => {
    const mine = await line(a);
    const b = await project('Bravo Works', { viewerIn: true });
    const c = await project('Charlie Yard');
    await line(b);
    await line(c);
    assert.deepEqual(await overlapOf(mine), { named: [{ projectId: b, name: 'Bravo Works' }], others: 1 });
  });

  test('a grant holder in C sees C named', async () => {
    const mine = await line(a);
    const c = await project('Charlie Yard');
    await line(c);
    await pool.query(
      `INSERT INTO access_grants (id, project_id, user_id, kind, purpose, scope, starts_on, expires_on, requested_by, requested_at, decision, decided_by, decided_at)
       VALUES ($1, $2, $3, 'audit', 'Annual audit', 'Everything', '2026-11-01', '2026-11-30', $4, now(), 'approved', $4, now())`,
      [uuidv7(), c, viewerId, pm],
    );
    assert.deepEqual(await overlapOf(mine), { named: [{ projectId: c, name: 'Charlie Yard' }], others: 0 });
  });

  test('an Administrator sees every project named, ordered by name', async () => {
    const adminId = await seedUser(pool, 'admin@example.org', 'enterprise_administrator');
    const mine = await line(a);
    const c = await project('Charlie Yard');
    const b = await project('Bravo Works');
    await line(c);
    await line(b);
    assert.deepEqual(await overlapOf(mine, user(adminId, 'admin@example.org', 'enterprise_administrator')), {
      named: [
        { projectId: b, name: 'Bravo Works' },
        { projectId: c, name: 'Charlie Yard' },
      ],
      others: 0,
    });
  });

  test('never carries quantity, notes or status of another project', async () => {
    const mine = await line(a);
    const b = await project('Bravo Works', { viewerIn: true });
    await line(b);
    const got = await overlapOf(mine);
    assert.ok(got);
    assert.deepEqual(Object.keys(got).sort(), ['named', 'others']);
    for (const n of got.named) assert.deepEqual(Object.keys(n).sort(), ['name', 'projectId']);
    assert.equal(JSON.stringify(got).includes('Private notes'), false);
  });

  test('the SQL mirrors spansOverlap: inclusive ends, open ends, no start, other items and the same project', async () => {
    const mine = await line(a); // 3–14 Dec
    const touching = await project('Echo Touch');
    const before = await project('Foxtrot Before');
    const open = await project('Golf Open');
    const noStart = await project('Hotel Nostart');
    const other = await project('India Other');
    await line(touching, { startsOn: '2026-12-14', endsOn: '2026-12-31' }); // touches the end: overlaps
    await line(before, { startsOn: '2026-11-01', endsOn: '2026-12-02' }); // ends the day before: no
    await line(open, { startsOn: '2026-01-01', endsOn: null }); // open end runs forever: overlaps
    await line(noStart, { startsOn: null, endsOn: null }); // no period: no
    await line(other, { item: otherItem }); // another item: no
    await line(a); // another line in the same project: not counted
    assert.deepEqual(await overlapOf(mine), { named: [], others: 2 });

    const openMine = await line(a, { startsOn: '2027-06-01', endsOn: null });
    assert.deepEqual(await overlapOf(openMine), { named: [], others: 1 }); // only Golf Open runs that far
  });

  test('one-off lines and lines with no start have no overlap', async () => {
    const b = await project('Bravo Works', { viewerIn: true });
    await line(b);
    assert.equal(await overlapOf(await line(a, { item: null })), null);
    assert.equal(await overlapOf(await line(a, { startsOn: null, endsOn: null })), null);
  });
});
