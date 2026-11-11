import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Pool } from 'pg';
import type { AuthUser } from '../auth/tokens';
import { loadDatabaseConfig } from '../config';
import { uuidv7 } from '../common/uuid7';
import { runMigrations } from '../db/migrate';
import { ProjectAccess, canReadContent } from '../projects/access.service';
import type { ProjectRole } from '../projects/membership';
import { SKIP_NO_DB, resetPublicSchema, testDatabaseUrl } from '../testing/db';
import { seedProject, seedUser } from '../testing/projects';
import { type AudienceRow, audienceVisibleSql, inAudience } from './audience';
import { AudienceService } from './audience.service';

const migrationsDir = loadDatabaseConfig({ DATABASE_URL: 'x' }).migrationsDir;
// 12:00 on 2026-11-11 in UTC+8.
const NOW = new Date('2026-11-11T04:00:00Z');
const TODAY = '2026-11-11';

const asUser = (id: string, email: string): AuthUser => ({ id, email, displayName: email.split('@')[0], role: 'member' });

describe('audiences (database)', { skip: SKIP_NO_DB }, () => {
  let pool: Pool;
  let access: ProjectAccess;
  let service: AudienceService;
  let projectId: string;
  const people: Record<string, AuthUser> = {};

  before(() => {
    pool = new Pool({ connectionString: testDatabaseUrl() });
    access = new ProjectAccess(pool, () => NOW);
    service = new AudienceService(pool, () => NOW, access);
  });
  after(async () => {
    await pool.end();
  });

  async function person(key: string): Promise<AuthUser> {
    const email = `${key}@example.org`;
    people[key] = asUser(await seedUser(pool, email), email);
    return people[key];
  }

  async function audience(mode: 'project' | 'restricted', named: string[] = []): Promise<string> {
    const id = uuidv7();
    await pool.query(`INSERT INTO audiences (id, project_id, mode, created_at) VALUES ($1, $2, $3, now())`, [id, projectId, mode]);
    for (const u of named) {
      await pool.query(`INSERT INTO audience_members (audience_id, user_id, added_by, added_at) VALUES ($1, $2, $3, now())`, [id, u, people.pm.id]);
    }
    return id;
  }

  beforeEach(async () => {
    await resetPublicSchema(pool);
    await runMigrations(pool, migrationsDir);
    for (const k of Object.keys(people)) delete people[k];
    await person('pm');
    await person('owner');
    await person('sponsor');
    await person('deputy');
    await person('mem');
    await person('mem2');
    projectId = await seedProject(pool, {
      status: 'active',
      members: [
        { userId: people.pm.id, role: 'pm' },
        { userId: people.owner.id, role: 'owner' },
        { userId: people.sponsor.id, role: 'sponsor' },
        { userId: people.deputy.id, role: 'deputy_pm' },
        { userId: people.mem.id, role: 'member' },
        { userId: people.mem2.id, role: 'member' },
      ],
    });
  });

  test('audienceVisibleSql agrees with inAudience', async () => {
    const states = ['active', 'scheduled', 'expired', 'revoked', 'held', 'restored'] as const;
    const roles: ProjectRole[] = ['member', 'deputy_pm', 'owner'];
    const viewers: AuthUser[] = [];
    const named: string[] = [];
    // A second project gives the matrix people their own memberships without disturbing the base project.
    for (const role of roles) {
      for (const state of states) {
        for (const isNamed of [false, true]) {
          const u = await person(`${role}-${state}-${isNamed ? 'named' : 'plain'}`);
          await pool.query(
            `INSERT INTO memberships (id, project_id, user_id, role, starts_on, expires_on, revoked_at, revoked_by, held_at, held_by, restored_at, restored_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
            [
              uuidv7(), projectId, u.id, role,
              state === 'scheduled' ? '2026-11-12' : '2026-11-01',
              state === 'expired' ? '2026-11-10' : null,
              state === 'revoked' ? NOW : null, state === 'revoked' ? people.pm.id : null,
              state === 'held' || state === 'restored' ? '2026-11-05T00:00:00Z' : null, state === 'held' || state === 'restored' ? people.pm.id : null,
              state === 'restored' ? '2026-11-06T00:00:00Z' : null, state === 'restored' ? people.pm.id : null,
            ],
          );
          viewers.push(u);
          if (isNamed) named.push(u.id);
        }
      }
    }
    // Expires today: still active until 00:00 tomorrow.
    const lastDay = await person('last-day');
    await pool.query(`INSERT INTO memberships (id, project_id, user_id, role, starts_on, expires_on) VALUES ($1, $2, $3, 'owner', '2026-11-01', $4)`, [uuidv7(), projectId, lastDay.id, TODAY]);
    viewers.push(lastDay);
    // Grants: approved and valid (named and plain), expired, suspended, and one never approved.
    const grants: Array<[string, string, Record<string, unknown>]> = [
      ['grant-ok-plain', 'ok', {}],
      ['grant-ok-named', 'ok', {}],
      ['grant-expired-named', 'expired', {}],
      ['grant-suspended-named', 'suspended', {}],
      ['grant-requested-named', 'requested', {}],
    ];
    for (const [key, kind] of grants) {
      const u = await person(key);
      await pool.query(
        `INSERT INTO access_grants (id, project_id, user_id, kind, purpose, scope, starts_on, expires_on, requested_by, requested_at, decision, decided_by, decided_at, suspended_at, suspended_by)
         VALUES ($1, $2, $3, 'audit', 'Annual audit', 'Whole project', '2026-11-01', $4, $5, now(), $6, $7, $8, $9, $10)`,
        [
          uuidv7(), projectId, u.id, kind === 'expired' ? '2026-11-10' : '2026-11-30', people.pm.id,
          kind === 'requested' ? null : 'approved', kind === 'requested' ? null : people.owner.id, kind === 'requested' ? null : NOW,
          kind === 'suspended' ? NOW : null, kind === 'suspended' ? people.owner.id : null,
        ],
      );
      viewers.push(u);
      if (key.endsWith('named')) named.push(u.id);
    }
    const admin = asUser(await seedUser(pool, 'admin@example.org', 'enterprise_administrator'), 'admin@example.org');
    viewers.push(admin, people.pm, people.owner, people.sponsor, people.deputy, people.mem, people.mem2);
    named.push(admin.id, people.mem2.id);

    const restrictedId = await audience('restricted', named);
    const projectWideId = await audience('project');
    let compared = 0;
    let admitted = 0;
    let refused = 0;
    for (const id of [restrictedId, projectWideId]) {
      const a = await service.load(id);
      for (const v of viewers) {
        const ctx = await access.load(projectId, v, pool);
        assert.ok(ctx);
        const expected = inAudience(ctx, a);
        const { rows } = await pool.query(`SELECT ${audienceVisibleSql('a', '$1', '$2')} AS ok FROM audiences a WHERE a.id = $3`, [v.id, TODAY, id]);
        if (!canReadContent(ctx)) {
          // The SQL fragment assumes read access was established; the rule itself must already refuse. Unnamed, the
          // fragment's own role test must refuse too: a lapsed, held, scheduled or revoked role never counts.
          assert.equal(expected, false, `${v.email} cannot read the project`);
          if (a.mode === 'restricted' && !a.namedUserIds.includes(v.id)) assert.equal(rows[0].ok, false, `${v.email} role is not active`);
          continue;
        }
        assert.equal(rows[0].ok, expected, `${v.email} in ${a.mode} audience`);
        compared++;
        if (expected) admitted++;
        else refused++;
      }
    }
    assert.ok(compared >= 40, `compared ${compared}`);
    assert.ok(admitted > 15 && refused >= 4, `admitted ${admitted}, refused ${refused}`);
  });

  test('change records old and new settings with reason', async () => {
    const id = await audience('project');
    const out = await service.change(people.owner, id, { mode: 'restricted', namedUserIds: [people.mem.id] }, '  Contract terms  ');
    assert.equal(out.mode, 'restricted');
    assert.deepEqual(out.namedUserIds, [people.mem.id]);
    assert.deepEqual(await service.load(id), out);
    await service.change(people.sponsor, id, { mode: 'project', namedUserIds: [] }, 'Open again');
    const { rows } = await pool.query(
      `SELECT actor_id, from_mode, to_mode, from_named, to_named, reason FROM audience_events WHERE audience_id = $1 ORDER BY from_mode`,
      [id],
    );
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0], { actor_id: people.owner.id, from_mode: 'project', to_mode: 'restricted', from_named: [], to_named: [people.mem.id], reason: 'Contract terms' });
    assert.deepEqual(rows[1], { actor_id: people.sponsor.id, from_mode: 'restricted', to_mode: 'project', from_named: [people.mem.id], to_named: [], reason: 'Open again' });
    const audit = await pool.query(`SELECT detail FROM audit_events WHERE action = 'audience.changed'`);
    assert.equal(audit.rows.length, 2);
    assert.ok(!JSON.stringify(audit.rows).includes('Contract'), 'the reason text is not copied into the audit trail');
  });

  test('change by a Deputy is refused (403)', async () => {
    const id = await audience('project');
    await assert.rejects(service.change(people.deputy, id, { mode: 'restricted', namedUserIds: [] }, 'Why'), (e: { status?: number }) => e.status === 403);
    await assert.rejects(service.change(people.mem, id, { mode: 'restricted', namedUserIds: [] }, 'Why'), (e: { status?: number }) => e.status === 403);
    assert.equal((await service.load(id)).mode, 'project');
    const outsider = await person('outsider');
    await assert.rejects(service.change(outsider, id, { mode: 'restricted', namedUserIds: [] }, 'Why'), (e: { status?: number }) => e.status === 404);
  });

  test('change is refused while the project is Deferred', async () => {
    const id = await audience('project');
    await pool.query(`UPDATE projects SET status = 'deferred' WHERE id = $1`, [projectId]);
    await assert.rejects(service.change(people.pm, id, { mode: 'restricted', namedUserIds: [] }, 'Why'), (e: { status?: number }) => e.status === 403);
  });

  test('reason is required', async () => {
    const id = await audience('project');
    for (const reason of [undefined, '', '   ', 7, 'x'.repeat(501)]) {
      await assert.rejects(service.change(people.pm, id, { mode: 'restricted', namedUserIds: [] }, reason), (e: { status?: number }) => e.status === 400);
    }
    assert.equal((await service.load(id)).mode, 'project');
    assert.equal((await pool.query(`SELECT 1 FROM audience_events WHERE audience_id = $1`, [id])).rows.length, 0);
  });

  test('only people in this project can be named', async () => {
    const id = await audience('project');
    const outsider = await person('outsider');
    await assert.rejects(
      service.change(people.pm, id, { mode: 'restricted', namedUserIds: [outsider.id] }, 'Why'),
      (e: { status?: number; message?: string }) => e.status === 400 && e.message === 'Only people in this project can be named.',
    );
    assert.equal((await service.load(id)).mode, 'project');
  });

  test('create makes an audience with named people', async () => {
    const id = await service.create(pool, projectId, { mode: 'restricted', namedUserIds: [people.mem.id] }, people.pm);
    const a = await service.load(id);
    assert.deepEqual({ mode: a.mode, projectId: a.projectId, namedUserIds: a.namedUserIds }, { mode: 'restricted', projectId, namedUserIds: [people.mem.id] });
  });

  test('preview lists who gains and who loses', async () => {
    const id = await audience('restricted', [people.mem.id]);
    const a = await service.load(id);
    const ctx = await access.context(people.pm, projectId);
    // Project-wide: the other Member (not named) gains; nobody loses.
    const open = await service.preview(ctx, a, { mode: 'project', namedUserIds: [] });
    assert.deepEqual(open.gain.map((p) => p.id), [people.mem2.id]);
    assert.deepEqual(open.lose, []);
    // Restricted to nobody named: the named Member loses.
    const tight = await service.preview(ctx, a, { mode: 'restricted', namedUserIds: [] });
    assert.deepEqual(tight.lose.map((p) => p.id), [people.mem.id]);
    assert.deepEqual(tight.gain, []);
    // Swap the named Member.
    const swap = await service.preview(ctx, a, { mode: 'restricted', namedUserIds: [people.mem2.id] });
    assert.deepEqual(swap.gain.map((p) => p.id), [people.mem2.id]);
    assert.deepEqual(swap.lose.map((p) => p.id), [people.mem.id]);
  });

  test('forSource, forThread and assertReadable', async () => {
    const id = await audience('restricted');
    const sourceId = uuidv7();
    await pool.query(
      `INSERT INTO sources (id, title, project_id, kind, audience_id, created_by, created_at) VALUES ($1, 'Alpha notes', $2, 'notes', $3, $4, now())`,
      [sourceId, projectId, id, people.pm.id],
    );
    const a: AudienceRow = await service.forSource(sourceId);
    assert.equal(a.id, id);
    await assert.rejects(service.forSource(uuidv7()), (e: { status?: number }) => e.status === 404);
    service.assertReadable(await access.context(people.pm, projectId), a);
    const memCtx = await access.context(people.mem, projectId);
    assert.throws(() => service.assertReadable(memCtx, a), (e: { status?: number }) => e.status === 404);
    await assert.rejects(service.forThread('not-a-uuid'), (e: { status?: number }) => e.status === 404);
  });
});
