import { Pool } from 'pg';
import { assertBenchDatabase, startApp, type Session } from '../analysis/bench-cli';
import { todayUtc8 } from '../projects/membership';

/**
 * Measured aims of sub-project 7 (dashboards spec section 14).
 *
 *   DATABASE_URL=postgres://.../kainow_bench npm run migrate && DATABASE_URL=... npm run bench-dashboards
 *   DATABASE_URL=postgres://.../kainow_smoke npm run migrate && DATABASE_URL=... node dist/dashboards/bench-cli.js --seed-only
 *
 * Seeds (set-based SQL, deterministic ids; skipped when already there) 200 people, 100 projects in 10 departments, 30,000
 * tasks (200 top-level and 100 subtasks per project, about 1% Deleted), 3,000 risks and a year of events (task events and
 * project transitions), then times through the real HTTP app on loopback, 5 warm-up requests not counted and 50 counted
 * (nearest-rank p95), and prints met or missed against the aims:
 *   GET /dashboard/me for the Administrator, who is in 10 projects (aim p95 < 300 ms);
 *   GET /projects/:id/dashboard (aim < 200 ms, one of the Administrator's projects);
 *   GET /admin/analytics?panel=progress|problems|system|trends, default filters (aim < 500 ms each); the fifth panel,
 *     AI usage, is a link to the sub-project 6 usage view and has no endpoint here;
 *   GET /dashboard/leadership for a holder of an organisation-scope grant (aim < 500 ms).
 *
 * `--seed-only` seeds and stops (nothing is deleted, nothing is timed), for a database used for a browser smoke test.
 * It accepts a database whose name ends in `_bench` or `_smoke`; the timed run accepts only `_bench`. The seed leaves the
 * organisation registered and the leadership grant in place, and prints the e-mail addresses to sign in with
 * (the sign-in code is shown by the app when LOG_SIGN_IN_CODES=true).
 *
 * All names are dummy. Seeded e-mails are at @example.org.
 */

const USERS = 200; // 0 is the Administrator, 199 is the leadership holder, 1..198 are members
const PROJECTS = 100;
const DEPARTMENTS = 10;
const TOP_TASKS = 200; // per project; every other one has a subtask, so 300 per project
const RISKS = 30; // per project
const ROUNDS = 50;
const WARM_UP = 5;
export const ADMIN_EMAIL = 'bench-admin@example.org';
export const LEADER_EMAIL = 'bench-leader@example.org';

/** Aims in ms, from spec section 14. */
const AIMS = { me: 300, project: 200, panel: 500, leadership: 500 } as const;

const percentile = (xs: number[], q: number): number => [...xs].sort((a, b) => a - b)[Math.ceil(q * xs.length) - 1];
const ms = (n: number): string => `${n.toFixed(1)} ms`;

export function assertSeedDatabase(databaseUrl: string): void {
  let name = '';
  try {
    name = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, ''));
  } catch {
    // fall through to the refusal; the URL (and its password) is never echoed
  }
  if (!/_(bench|smoke)$/.test(name)) throw new Error('Refusing to seed: the database name must end in _bench or _smoke.');
}

function seedSql(now: Date): string[] {
  const NOW = `'${now.toISOString()}'::timestamptz`;
  const user = (expr: string) => `md5('dash-user-' || (${expr}))::uuid`;
  // The person in role k of project p. The Administrator is the Project Manager of projects 0..9 (all Active).
  const member = (p: string, k: string) => `(CASE WHEN ${k} = 0 AND ${p} < 10 THEN 0 ELSE 1 + (${p} * 8 + ${k}) % 198 END)`;
  const sql: string[] = [];

  sql.push(`INSERT INTO users (id, email, display_name, role)
    SELECT ${user('i')}, CASE i WHEN 0 THEN '${ADMIN_EMAIL}' WHEN ${USERS - 1} THEN '${LEADER_EMAIL}' ELSE 'bench-member-' || i || '@example.org' END,
           CASE i WHEN 0 THEN 'Bench Administrator' WHEN ${USERS - 1} THEN 'Bench Leader' ELSE 'Member ' || i END,
           CASE WHEN i = 0 THEN 'enterprise_administrator' ELSE 'member' END
      FROM generate_series(0, ${USERS - 1}) i`);
  sql.push(`INSERT INTO organisation (id, name, registered_at, updated_at) VALUES (1, 'Example Organisation', now(), now())
    ON CONFLICT (id) DO NOTHING`);
  sql.push(`INSERT INTO departments (id, name, created_by, created_at)
    SELECT md5('dash-dept-' || d)::uuid, 'Department ' || d, ${user('0')}, ${NOW} FROM generate_series(0, ${DEPARTMENTS - 1}) d`);
  // 0..69 Active, 70..79 Planned, 80..84 Draft, 85..89 Deferred, 90..99 Closed.
  sql.push(`INSERT INTO projects (id, name, purpose, owning_department_id, planned_end, status, closure_outcome, created_by, created_at)
    SELECT md5('dash-project-' || p)::uuid, 'Project ' || p, 'Purpose of project ' || p, md5('dash-dept-' || (p % ${DEPARTMENTS}))::uuid,
           (${NOW})::date + (30 + (p * 13) % 300), s.status, CASE WHEN s.status = 'closed' THEN 'delivered' END,
           ${user('0')}, ${NOW} - interval '380 days'
      FROM generate_series(0, ${PROJECTS - 1}) p
      CROSS JOIN LATERAL (SELECT CASE WHEN p < 70 THEN 'active' WHEN p < 80 THEN 'planned' WHEN p < 85 THEN 'draft'
                                      WHEN p < 90 THEN 'deferred' ELSE 'closed' END AS status) s`);
  // Contributing departments: each project also has one other department.
  sql.push(`INSERT INTO project_departments (project_id, department_id)
    SELECT md5('dash-project-' || p)::uuid, md5('dash-dept-' || ((p + 3) % ${DEPARTMENTS}))::uuid FROM generate_series(0, ${PROJECTS - 1}) p`);
  sql.push(`INSERT INTO project_stage_periods (id, project_id, stage, started_at, started_by)
    SELECT md5('dash-stage-' || p)::uuid, md5('dash-project-' || p)::uuid, CASE WHEN p % 3 = 0 THEN 'Execution' WHEN p % 3 = 1 THEN 'Planning' ELSE 'Initiation' END,
           ${NOW} - ((20 + p) * interval '1 day'), ${user('0')}
      FROM generate_series(0, ${PROJECTS - 1}) p`);
  // Eight people per project: PM, Owner, Deputy, Sponsor and four members.
  sql.push(`INSERT INTO memberships (id, project_id, user_id, role, starts_on, expires_on, revoked_at, revoked_by)
    SELECT md5('dash-mem-' || p || '-' || k)::uuid, md5('dash-project-' || p)::uuid, ${user(member('p', 'k'))},
           CASE k WHEN 0 THEN 'pm' WHEN 1 THEN 'owner' WHEN 2 THEN 'deputy_pm' WHEN 3 THEN 'sponsor' ELSE 'member' END,
           (${NOW})::date - 300, NULL, NULL, NULL
      FROM generate_series(0, ${PROJECTS - 1}) p CROSS JOIN generate_series(0, 7) k`);
  // A year of project transitions.
  sql.push(`INSERT INTO project_transitions (id, project_id, from_status, to_status, actor_id, reason, closure_outcome, at)
    SELECT md5('dash-trans-' || p || '-' || j)::uuid, md5('dash-project-' || p)::uuid, t.from_s, t.to_s, ${user('0')}, 'Bench', CASE WHEN t.to_s = 'closed' THEN 'delivered' END,
           ${NOW} - ((360 - (p * 7 + j * 40) % 340) * interval '1 day')
      FROM generate_series(0, ${PROJECTS - 1}) p
      JOIN LATERAL (VALUES (1, 'draft', 'planned'), (2, 'planned', 'active'), (3, 'active', 'deferred'), (4, 'deferred', 'active'), (5, 'active', 'closed')) AS t(j, from_s, to_s)
        ON (p >= 85 AND t.j = 1) OR (p < 80 AND p >= 70 AND t.j = 1) OR (p < 70 AND t.j <= 2) OR (p BETWEEN 85 AND 89 AND t.j <= 3) OR (p >= 90 AND t.j IN (2, 5))`);

  // Tasks. Top level: status by n % 10 (0-4 completed, 5-6 in progress, 7 blocked, 8 not started, 9 cancelled), due within +/- 30 days,
  // authorised across the last year. The assignee is a member of the project; for projects 0..9 every fifth task is the Administrator's.
  sql.push(`CREATE TEMP TABLE dash_tasks AS
    SELECT p, n, md5('dash-task-' || p || '-' || n)::uuid AS id, md5('dash-project-' || p)::uuid AS project_id,
           (${NOW})::date + ((n * 7 + p) % 61 - 30) AS due_on,
           CASE n % 10 WHEN 0 THEN 'completed' WHEN 1 THEN 'completed' WHEN 2 THEN 'completed' WHEN 3 THEN 'completed' WHEN 4 THEN 'completed'
                       WHEN 5 THEN 'in_progress' WHEN 6 THEN 'in_progress' WHEN 7 THEN 'blocked' WHEN 8 THEN 'not_started' ELSE 'cancelled' END AS status,
           ${NOW} - ((5 + (n * 37 + p * 11) % 355) * interval '1 day') AS authorised_at,
           CASE WHEN p < 10 AND n % 5 = 0 THEN 0 ELSE ${member('p', '4 + n % 4')} END AS assignee
      FROM generate_series(0, ${PROJECTS - 1}) p CROSS JOIN generate_series(0, ${TOP_TASKS - 1}) n`);
  sql.push(`INSERT INTO tasks (id, project_id, parent_id, depth, title, assignee_id, due_on, status, authorised_by, authorised_at, completed_at, deadline_review_required, deleted_at, deleted_by, delete_reason)
    SELECT id, project_id, NULL, 0, 'Task ' || p || '-' || n, ${user('assignee')}, due_on, status, ${user(member('p', '0'))}, authorised_at,
           CASE WHEN status = 'completed' THEN least(${NOW}, authorised_at + ((2 + n % 40) * interval '1 day')) END,
           status NOT IN ('completed', 'cancelled') AND n % 53 = 0,
           CASE WHEN n % 97 = 5 AND n % 2 = 1 THEN authorised_at + interval '1 day' END,
           CASE WHEN n % 97 = 5 AND n % 2 = 1 THEN ${user(member('p', '0'))} END,
           CASE WHEN n % 97 = 5 AND n % 2 = 1 THEN 'Entered in error' END
      FROM dash_tasks`);
  // One subtask under every second top-level task (never under a Deleted parent).
  sql.push(`INSERT INTO tasks (id, project_id, parent_id, depth, title, assignee_id, due_on, status, authorised_by, authorised_at, completed_at)
    SELECT md5('dash-subtask-' || p || '-' || n)::uuid, project_id, id, 1, 'Subtask ' || p || '-' || n, ${user('assignee')}, due_on,
           CASE WHEN status = 'completed' THEN 'completed' WHEN status = 'cancelled' THEN 'cancelled' ELSE CASE WHEN n % 4 = 0 THEN 'in_progress' ELSE 'not_started' END END,
           ${user(member('p', '0'))}, authorised_at,
           CASE WHEN status = 'completed' THEN least(${NOW}, authorised_at + ((1 + n % 30) * interval '1 day')) END
      FROM dash_tasks WHERE n % 2 = 0`);
  sql.push(`INSERT INTO task_events (id, task_id, kind, from_status, to_status, actor_id, at)
    SELECT md5('dash-tev-a-' || id)::uuid, id, 'authorised', NULL, 'not_started', authorised_by, authorised_at FROM tasks WHERE project_id IN (SELECT md5('dash-project-' || g)::uuid FROM generate_series(0, ${PROJECTS - 1}) g)`);
  sql.push(`INSERT INTO task_events (id, task_id, kind, from_status, to_status, actor_id, at)
    SELECT md5('dash-tev-c-' || id)::uuid, id, 'completed', 'in_progress', 'completed', authorised_by, completed_at FROM tasks WHERE completed_at IS NOT NULL`);
  sql.push(`INSERT INTO task_events (id, task_id, kind, from_status, to_status, actor_id, at)
    SELECT md5('dash-tev-x-' || id)::uuid, id, 'cancelled', 'not_started', 'cancelled', authorised_by, authorised_at + interval '3 days' FROM tasks WHERE status = 'cancelled'`);
  sql.push(`INSERT INTO task_events (id, task_id, kind, from_status, to_status, actor_id, at)
    SELECT md5('dash-tev-r-' || id)::uuid, id, 'review_required', NULL, NULL, authorised_by, ${NOW} - interval '2 days' FROM tasks WHERE deadline_review_required`);

  // Risks, each from an approved human proposal. Severity, status and review date vary.
  sql.push(`INSERT INTO human_proposals (id, project_id, kind, text, proposed_by, proposed_at, review_status, reviewed_by, reviewed_at)
    SELECT md5('dash-prop-' || p || '-' || r)::uuid, md5('dash-project-' || p)::uuid, 'risk', 'Risk ' || p || '-' || r, ${user(member('p', '4'))},
           ${NOW} - ((10 + (r * 11 + p) % 340) * interval '1 day'), 'approved', ${user(member('p', '0'))}, ${NOW} - ((9 + (r * 11 + p) % 340) * interval '1 day')
      FROM generate_series(0, ${PROJECTS - 1}) p CROSS JOIN generate_series(0, ${RISKS - 1}) r`);
  sql.push(`INSERT INTO risks (id, project_id, description, severity, responsible_id, review_on, status, origin_proposal_id, authorised_by, authorised_at)
    SELECT md5('dash-risk-' || p || '-' || r)::uuid, md5('dash-project-' || p)::uuid, 'Risk ' || p || '-' || r,
           (ARRAY['low', 'medium', 'high', 'critical'])[1 + r % 4], ${user(member('p', '4 + r % 4'))}, (${NOW})::date + ((r * 5 + p) % 90 - 45),
           (ARRAY['open', 'mitigating', 'resolved', 'accepted'])[1 + (r / 4) % 4], md5('dash-prop-' || p || '-' || r)::uuid, ${user(member('p', '0'))},
           ${NOW} - ((9 + (r * 11 + p) % 340) * interval '1 day')
      FROM generate_series(0, ${PROJECTS - 1}) p CROSS JOIN generate_series(0, ${RISKS - 1}) r`);
  return sql;
}

async function analyse(pool: Pool): Promise<void> {
  for (const t of ['users', 'projects', 'memberships', 'tasks', 'task_events', 'risks', 'human_proposals', 'project_transitions', 'project_departments']) {
    await pool.query(`ANALYZE ${t}`);
  }
}

/** Seeds the data set into an empty migrated database (skipped when the bench people are already there). */
export async function seedDashboards(pool: Pool, log: (m: string) => void = console.log): Promise<void> {
  if ((await pool.query(`SELECT 1 FROM users WHERE email = $1`, [ADMIN_EMAIL])).rows[0]) {
    log('already seeded; using what is there');
    return;
  }
  if ((await pool.query(`SELECT count(*)::int AS n FROM users`)).rows[0].n > 0) throw new Error('The database already holds users; use an empty migrated database.');
  const started = Date.now();
  const now = new Date();
  now.setMilliseconds(0);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const statement of seedSql(now)) await client.query(statement);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  await analyse(pool);
  log(`seeded in ${((Date.now() - started) / 1000).toFixed(1)} s`);
}

/** The organisation-scope leadership grant, made as the Administrator through the app (a person cannot grant to themselves). */
async function ensureGrant(pool: Pool, admin: Session): Promise<void> {
  const leader = (await pool.query(`SELECT id FROM users WHERE email = $1`, [LEADER_EMAIL])).rows[0].id as string;
  if ((await pool.query(`SELECT 1 FROM leadership_grants WHERE user_id = $1 AND revoked_at IS NULL`, [leader])).rows[0]) return;
  const r = await admin.request('POST', '/admin/leadership-grants', {
    userId: leader,
    scope: { kind: 'organisation' },
    startsOn: todayUtc8(new Date()),
    reason: 'Bench: oversight of the whole organisation',
  });
  if (r.status !== 201) throw new Error(`The leadership grant answered ${r.status}: ${r.text.slice(0, 200)}`);
}

export interface Row {
  label: string;
  aimMs: number;
  n: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  met: boolean;
}

export async function runDashboardsBench(databaseUrl: string, opts: { seedOnly?: boolean } = {}, log: (m: string) => void = console.log): Promise<Row[]> {
  if (opts.seedOnly) assertSeedDatabase(databaseUrl);
  else assertBenchDatabase(databaseUrl);
  const pool = new Pool({ connectionString: databaseUrl, max: 10 });
  try {
    await seedDashboards(pool, log);
    const leaderId = (await pool.query(`SELECT id FROM users WHERE email = $1`, [LEADER_EMAIL])).rows[0].id as string;
    const granted = !!(await pool.query(`SELECT 1 FROM leadership_grants WHERE user_id = $1 AND revoked_at IS NULL`, [leaderId])).rows[0];
    const { app, signIn } = await startApp(databaseUrl);
    try {
      const admin = opts.seedOnly && granted ? (undefined as unknown as Session) : await signIn(ADMIN_EMAIL);
      if (!granted) await ensureGrant(pool, admin);
      if (opts.seedOnly) {
        log('');
        log('Seeded. Sign in with (the code is logged by the app when LOG_SIGN_IN_CODES=true):');
        log(`  Administrator, in 10 projects: ${ADMIN_EMAIL}`);
        log(`  Leadership holder (organisation scope): ${LEADER_EMAIL}`);
        log(`  Members (no special access): bench-member-1@example.org ...`);
        return [];
      }
      const leader = await signIn(LEADER_EMAIL);
      const counts: string[] = [];
      for (const [label, table] of [['users', 'users'], ['projects', 'projects'], ['tasks', 'tasks'], ['risks', 'risks'], ['task events', 'task_events'], ['project transitions', 'project_transitions']]) {
        counts.push(`${(await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n} ${label}`);
      }
      log(`data: ${counts.join(', ')}`);
      const projectId = (await pool.query(`SELECT md5('dash-project-3')::uuid::text AS id`)).rows[0].id as string;
      const inTen = (await pool.query(`SELECT count(DISTINCT project_id)::int AS n FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = $1`, [ADMIN_EMAIL])).rows[0].n;
      log(`the timed person is in ${inTen} projects`);

      const measure = async (label: string, aimMs: number, who: Session, path: string): Promise<Row> => {
        const once = async (): Promise<number> => {
          const t0 = performance.now();
          const r = await who.request('GET', path);
          const took = performance.now() - t0;
          if (r.status !== 200) throw new Error(`GET ${path} answered ${r.status}: ${r.text.slice(0, 200)}`);
          return took;
        };
        for (let i = 0; i < WARM_UP; i++) await once();
        const xs: number[] = [];
        for (let i = 0; i < ROUNDS; i++) xs.push(await once());
        const p95Ms = percentile(xs, 0.95);
        const row: Row = { label, aimMs, n: xs.length, p50Ms: percentile(xs, 0.5), p95Ms, maxMs: Math.max(...xs), met: p95Ms < aimMs };
        log(`${label}: p50 ${ms(row.p50Ms)}, p95 ${ms(p95Ms)}, max ${ms(row.maxMs)} (aim < ${aimMs} ms): ${row.met ? 'met' : 'MISSED'}`);
        return row;
      };
      const rows: Row[] = [];
      rows.push(await measure('GET /dashboard/me', AIMS.me, admin, '/dashboard/me'));
      rows.push(await measure('GET /projects/:id/dashboard', AIMS.project, admin, `/projects/${projectId}/dashboard`));
      for (const panel of ['progress', 'problems', 'system', 'trends']) {
        rows.push(await measure(`GET /admin/analytics?panel=${panel}`, AIMS.panel, admin, `/admin/analytics?panel=${panel}`));
      }
      rows.push(await measure('GET /dashboard/leadership (organisation scope)', AIMS.leadership, leader, '/dashboard/leadership'));
      log('');
      log('| Request | Aim p95 | p50 | p95 | max | Result |');
      log('|---|---|---|---|---|---|');
      for (const r of rows) log(`| ${r.label} | < ${r.aimMs} ms | ${ms(r.p50Ms)} | ${ms(r.p95Ms)} | ${ms(r.maxMs)} | ${r.met ? 'met' : 'missed'} |`);
      return rows;
    } finally {
      await app.close();
    }
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('Set DATABASE_URL to a migrated database whose name ends in _bench (or _smoke with --seed-only).');
    process.exit(1);
  }
  runDashboardsBench(url, { seedOnly: process.argv.includes('--seed-only') }).then(
    () => process.exit(0),
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
