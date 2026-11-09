import type { Pool } from 'pg';
import { uuidv7 } from '../common/uuid7';
import type { ProjectRole } from '../projects/membership';
import type { ProjectStatus } from '../projects/matrix';

/** Inserts an account directly (no invitation), for tests. */
export async function seedUser(pool: Pool, email: string, role: 'enterprise_administrator' | 'member' = 'member'): Promise<string> {
  const id = uuidv7();
  await pool.query(`INSERT INTO users (id, email, display_name, role) VALUES ($1, $2, $3, $4)`, [id, email, email.split('@')[0], role]);
  return id;
}

export async function seedDepartment(pool: Pool, name = 'Registry'): Promise<string> {
  const id = uuidv7();
  const by = (await pool.query(`SELECT id FROM users ORDER BY id LIMIT 1`)).rows[0].id;
  await pool.query(`INSERT INTO departments (id, name, created_by, created_at) VALUES ($1, $2, $3, now())`, [id, name, by]);
  return id;
}

export interface SeedMember {
  userId: string;
  role: ProjectRole;
  startsOn?: string;
  expiresOn?: string;
  revoked?: boolean;
}

/**
 * Inserts a project with its memberships directly, for tests. Created on 2026-11-01 (UTC+8) in the
 * Initiation stage; memberships start that day unless given.
 */
export async function seedProject(
  pool: Pool,
  opts: { status?: ProjectStatus; members: SeedMember[]; name?: string; departmentId?: string },
): Promise<string> {
  const id = uuidv7();
  const status = opts.status ?? 'draft';
  const departmentId = opts.departmentId ?? (await seedDepartment(pool, `Dept ${id.slice(-6)}`));
  const by = opts.members[0]?.userId ?? (await pool.query(`SELECT id FROM users ORDER BY id LIMIT 1`)).rows[0].id;
  await pool.query(
    `INSERT INTO projects (id, name, purpose, owning_department_id, status, closure_outcome, created_by, created_at)
     VALUES ($1, $2, 'Purpose', $3, $4, $5, $6, '2026-10-31T16:00:00Z')`,
    [id, opts.name ?? 'Project', departmentId, status, status === 'closed' ? 'abandoned' : null, by],
  );
  await pool.query(
    `INSERT INTO project_stage_periods (id, project_id, stage, started_at, started_by) VALUES ($1, $2, 'Initiation', '2026-10-31T16:00:00Z', $3)`,
    [uuidv7(), id, by],
  );
  for (const m of opts.members) {
    await pool.query(
      `INSERT INTO memberships (id, project_id, user_id, role, starts_on, expires_on, revoked_at, revoked_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [uuidv7(), id, m.userId, m.role, m.startsOn ?? '2026-11-01', m.expiresOn ?? null, m.revoked ? new Date() : null, m.revoked ? by : null],
    );
  }
  return id;
}

/**
 * An Active project where `userId` is Project Manager and Owner, with a separate Member so no required role is
 * missing. For tests of note, extraction and review features that are not about project rules.
 */
export async function seedWorkingProject(pool: Pool, userId: string): Promise<string> {
  const other = await seedUser(pool, `member-${uuidv7().slice(-12)}@example.org`);
  return seedProject(pool, {
    status: 'active',
    members: [
      { userId, role: 'pm' },
      { userId, role: 'owner' },
      { userId: other, role: 'member' },
    ],
  });
}

/** Registers a finished organisation directly, as onboarding would; tests that exercise onboarding start without one. */
export async function seedOrganisation(pool: Pool, name = 'Example Organisation'): Promise<void> {
  await pool.query(
    `INSERT INTO organisation (id, name, registered_at, updated_at) VALUES (1, $1, now(), now())
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, registered_at = now()`,
    [name],
  );
}
