import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { Pool } from 'pg';
import { loadDatabaseConfig } from '../config';
import { runMigrations } from '../db/migrate';
import { SKIP_NO_DB, resetPublicSchema, testDatabaseUrl } from '../testing/db';
import { seedOrganisation, seedUser } from '../testing/projects';
import { assertLoadDatabase, seedLoad, type SeedSummary } from './seed';

const migrationsDir = loadDatabaseConfig({ DATABASE_URL: 'x' }).migrationsDir;

describe('load-test seed', { skip: SKIP_NO_DB }, () => {
  let pool: Pool;

  before(() => {
    pool = new Pool({ connectionString: testDatabaseUrl() });
  });
  after(async () => {
    await pool.end();
  });

  const fresh = async () => {
    await resetPublicSchema(pool);
    await runMigrations(pool, migrationsDir);
  };

  test('seed refuses a database that has an organisation not created by the seed', async () => {
    await fresh();
    await seedOrganisation(pool, 'Example Organisation');
    await assert.rejects(() => seedLoad(pool, { people: 200, projects: 40 }), /empty/);
    // A run is refused too: the organisation is not the seeded test organisation.
    await assert.rejects(() => assertLoadDatabase(pool), /not the seeded load-test organisation/);

    await fresh();
    await seedUser(pool, 'someone@example.net', 'enterprise_administrator');
    await assert.rejects(() => seedLoad(pool, { people: 200, projects: 40 }), /empty/);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM users`)).rows[0].n, 1, 'nothing was added');
  });

  test('seed makes 200 Active people at example.org and 40 projects each with PM, Owner and Sponsor', { timeout: 15 * 60_000 }, async () => {
    await fresh();
    const summary: SeedSummary = await seedLoad(pool, { people: 200, projects: 40 });
    assert.equal(summary.people, 200);
    assert.equal(summary.projects, 40);

    const people = (await pool.query(`SELECT email, status, role FROM users ORDER BY email`)).rows;
    assert.equal(people.length, 200);
    assert.ok(people.every((p) => p.status === 'active'));
    assert.ok(people.every((p) => /^load-\d{3}@example\.org$/.test(p.email)));
    assert.equal(people[0].email, 'load-001@example.org');
    assert.equal(people[199].email, 'load-200@example.org');
    assert.deepEqual(
      people.filter((p) => p.role === 'enterprise_administrator').map((p) => p.email),
      ['load-001@example.org'],
    );
    const org = (await pool.query(`SELECT name FROM organisation WHERE id = 1`)).rows[0];
    assert.equal(org.name, 'Example Organisation');
    assert.deepEqual((await pool.query(`SELECT domain FROM eligible_domains`)).rows.map((r) => r.domain), ['example.org']);

    const roles = (
      await pool.query(
        `SELECT p.id, count(*) FILTER (WHERE m.role = 'pm')::int AS pm, count(*) FILTER (WHERE m.role = 'owner')::int AS owner,
                count(*) FILTER (WHERE m.role = 'sponsor')::int AS sponsor, count(*) FILTER (WHERE m.role = 'member')::int AS member
           FROM projects p JOIN memberships m ON m.project_id = p.id AND m.revoked_at IS NULL
          GROUP BY p.id ORDER BY p.id`,
      )
    ).rows;
    assert.equal(roles.length, 40);
    for (const r of roles) {
      assert.equal(r.pm, 1);
      assert.equal(r.owner, 1);
      assert.equal(r.sponsor, 1);
      assert.ok(r.member >= 4 && r.member <= 12, `members ${r.member}`);
    }
    // The content the journeys read and change.
    assert.ok(summary.tasks >= 2900 && summary.tasks <= 3100, `tasks ${summary.tasks}`);
    assert.equal(summary.notes, 300);
    assert.ok(summary.pendingProposals > 0);
    assert.ok(summary.threads > 0 && summary.messages > 0);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM sources WHERE kind = 'notes'`)).rows[0].n, 300);

    // A seeded database is accepted for a run, and seeding it again is refused.
    await assertLoadDatabase(pool);
    await assert.rejects(() => seedLoad(pool, { people: 200, projects: 40 }), /empty/);
  });
});
