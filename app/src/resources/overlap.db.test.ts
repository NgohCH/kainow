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

  test('names exactly the projects ProjectAccess.context admits: held, revoked, expired, scheduled memberships and lapsed grants are counted', async () => {
    const mine = await line(a);
    const cases: Record<string, string> = {};
    const member = async (name: string, extra: Partial<{ startsOn: string; expiresOn: string; revoked: boolean }>) => {
      const id = await seedProject(pool, { status: 'active', name, members: [{ userId: pm, role: 'pm' }, { userId: viewerId, role: 'member', ...extra }] });
      await line(id);
      cases[name] = id;
      return id;
    };
    await member('Active Member', {});
    await member('Revoked Member', { revoked: true });
    await member('Expired Member', { expiresOn: '2026-11-10' });
    await member('Scheduled Member', { startsOn: '2026-12-01' });
    const held = await member('Held Member', {});
    await pool.query(`UPDATE memberships SET held_at = now(), hold_reason = 'Checking' WHERE project_id = $1 AND user_id = $2`, [held, viewerId]);
    const restored = await member('Restored Member', {});
    await pool.query(`UPDATE memberships SET held_at = now() - interval '2 days', restored_at = now() - interval '1 day' WHERE project_id = $1 AND user_id = $2`, [restored, viewerId]);
    const grant = async (name: string, cols: { expiresOn?: string; suspended?: boolean; decision?: string }) => {
      const id = await project(name);
      await line(id);
      await pool.query(
        `INSERT INTO access_grants (id, project_id, user_id, kind, purpose, scope, starts_on, expires_on, requested_by, requested_at, decision, decided_by, decided_at, suspended_at)
         VALUES ($1, $2, $3, 'audit', 'Annual audit', 'Everything', '2026-11-01', $4, $5, now(), $6, $5, now(), $7)`,
        [uuidv7(), id, viewerId, cols.expiresOn ?? '2026-11-30', pm, cols.decision ?? 'approved', cols.suspended ? new Date() : null],
      );
      cases[name] = id;
    };
    await grant('Valid Grant', {});
    await grant('Expired Grant', { expiresOn: '2026-11-10' });
    await grant('Suspended Grant', { suspended: true });
    await grant('Declined Grant', { decision: 'declined' });
    const admitted: string[] = [];
    for (const [name, id] of Object.entries(cases)) {
      if (await access.context(viewer, id).then(() => true, () => false)) admitted.push(name);
    }
    const got = await overlapOf(mine);
    assert.ok(got);
    assert.deepEqual(got.named.map((n) => n.name).sort(), admitted.sort());
    assert.deepEqual(admitted.sort(), ['Active Member', 'Restored Member', 'Valid Grant']);
    assert.equal(got.others, Object.keys(cases).length - admitted.length);
  });

  test('a fixed number of queries however many projects overlap', async () => {
    const mine = await line(a);
    for (let i = 0; i < 12; i += 1) {
      const id = await project(`Project ${String(i).padStart(2, '0')}`, { viewerIn: i % 2 === 0 });
      await line(id);
    }
    const { rows } = await pool.query(`SELECT id, item_id AS "itemId", to_char(starts_on, 'YYYY-MM-DD') AS "startsOn" FROM resource_lines WHERE id = $1`, [mine]);
    let queries = 0;
    const counting = new Proxy(pool, {
      get(target, prop, receiver) {
        if (prop === 'query') return (...args: unknown[]) => { queries += 1; return (target.query as (...a: unknown[]) => unknown).apply(target, args); };
        if (prop === 'connect') throw new Error('overlapsFor must not take extra connections');
        return Reflect.get(target, prop, receiver);
      },
    });
    const got = (await overlapsFor(counting, access, viewer, rows)).get(mine);
    assert.equal(got?.named.length, 6);
    assert.equal(got?.others, 6);
    assert.ok(queries <= 4, `ran ${queries} queries`);
  });

  test('one-off lines and lines with no start have no overlap', async () => {
    const b = await project('Bravo Works', { viewerIn: true });
    await line(b);
    assert.equal(await overlapOf(await line(a, { item: null })), null);
    assert.equal(await overlapOf(await line(a, { startsOn: null, endsOn: null })), null);
  });
});
