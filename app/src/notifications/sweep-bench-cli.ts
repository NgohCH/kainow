// Measures the notification sweep on a realistic seeded dataset (spec §12.3).
// Seeds INTO the throwaway test database only (it resets the public schema), then runs Sweep.run() cold and warm and
// prints timings, counts and EXPLAIN (ANALYZE, BUFFERS) of the main sweep queries. All names are fictitious.
//
//   KAINOW_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55432/kainow_test node dist/notifications/sweep-bench-cli.js
import { join } from 'node:path';
import { Pool } from 'pg';
import { runMigrations } from '../db/migrate';
import { resetPublicSchema, testDatabaseUrl } from '../testing/db';
import { Sweep } from './sweep';

/** Tue 10 Nov 2026, 09:30 UTC+8: the 09:00 slot work happens. */
const NOW_MS = Date.UTC(2026, 10, 10, 1, 30);
const USERS = 200;
const PROJECTS = 300;
const TASKS = 30_000;
const SUBTASKS = 6_000; // of the 30,000 (the rest are top-level)
const RISKS = 3_000;

function guardDatabase(): string {
  const url = testDatabaseUrl();
  if (!url) throw new Error('Set KAINOW_TEST_DATABASE_URL to the throwaway test database.');
  const name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  if (name !== 'kainow_test') throw new Error('Refusing to run: the database name must be kainow_test.');
  return url;
}

const ms = (n: number): string => `${n.toFixed(0)} ms`;

async function seed(pool: Pool): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`CREATE TEMP TABLE bu AS
      SELECT i AS idx, gen_random_uuid() AS id FROM generate_series(0, ${USERS - 1}) i`);
    await c.query(`INSERT INTO users (id, email, display_name, role)
      SELECT id, 'bench-' || idx || '@example.org', 'Bench ' || idx, CASE WHEN idx = 0 THEN 'enterprise_administrator' ELSE 'member' END FROM bu`);
    await c.query(`CREATE TEMP TABLE bd AS SELECT gen_random_uuid() AS id`);
    await c.query(`INSERT INTO departments (id, name, created_by, created_at)
      SELECT bd.id, 'Bench Registry', (SELECT id FROM bu WHERE idx = 0), now() FROM bd`);
    // Project p: members are users (p+2 ... p+2+k-1) mod USERS, k = 3 + p % 4 (3..6); PM p, Owner p+1.
    await c.query(`CREATE TEMP TABLE bp AS
      SELECT p AS idx, gen_random_uuid() AS id, 3 + p % 4 AS k FROM generate_series(0, ${PROJECTS - 1}) p`);
    await c.query(`INSERT INTO projects (id, name, purpose, owning_department_id, status, created_by, created_at)
      SELECT bp.id, 'Bench Project ' || bp.idx, 'Purpose', (SELECT id FROM bd), 'active',
             (SELECT id FROM bu WHERE idx = (bp.idx % ${USERS})), '2026-08-31T16:00:00Z' FROM bp`);
    await c.query(`INSERT INTO project_stage_periods (id, project_id, stage, started_at, started_by)
      SELECT gen_random_uuid(), bp.id, 'Execution', '2026-08-31T16:00:00Z', (SELECT id FROM bu WHERE idx = (bp.idx % ${USERS})) FROM bp`);
    await c.query(`INSERT INTO memberships (id, project_id, user_id, role, starts_on)
      SELECT gen_random_uuid(), bp.id, bu.id, r.role, '2026-08-01'
        FROM bp
        CROSS JOIN LATERAL (VALUES (0, 'pm'), (1, 'owner')) AS r(off, role)
        JOIN bu ON bu.idx = (bp.idx + r.off) % ${USERS}`);
    await c.query(`INSERT INTO memberships (id, project_id, user_id, role, starts_on)
      SELECT gen_random_uuid(), bp.id, bu.id, 'member', '2026-08-01'
        FROM bp CROSS JOIN LATERAL generate_series(0, bp.k - 1) j
        JOIN bu ON bu.idx = (bp.idx + 2 + j) % ${USERS}`);

    // Top-level tasks, spread over the projects; assignee is one of the project's members; due −60..+60 days around 2026-11-10.
    const top = TASKS - SUBTASKS;
    await c.query(`INSERT INTO tasks (id, project_id, parent_id, depth, title, assignee_id, due_on, status, authorised_by, authorised_at)
      SELECT gen_random_uuid(), bp.id, NULL, 0, 'Bench task ' || n, bu.id, date '2026-11-10' + ((n * 7919) % 121 - 60)::int,
             (ARRAY['not_started','in_progress','blocked'])[1 + n % 3], bu.id, timestamptz '2026-09-01 00:00+00'
        FROM generate_series(1, ${top}) n
        JOIN bp ON bp.idx = n % ${PROJECTS}
        JOIN bu ON bu.idx = (bp.idx + 2 + (n / ${PROJECTS}) % bp.k) % ${USERS}`);
    await c.query(`INSERT INTO tasks (id, project_id, parent_id, depth, title, assignee_id, due_on, status, authorised_by, authorised_at)
      SELECT gen_random_uuid(), t.project_id, t.id, 1, 'Bench subtask ' || t.rn, t.assignee_id,
             t.due_on - ((t.rn * 31) % 5)::int, 'not_started', t.assignee_id, timestamptz '2026-09-01 00:00+00'
        FROM (SELECT t.*, row_number() OVER (ORDER BY t.title) AS rn FROM tasks t WHERE t.depth = 0) t
       WHERE t.rn <= ${SUBTASKS}`);
    await c.query(`INSERT INTO task_events (id, task_id, kind, actor_id, at)
      SELECT gen_random_uuid(), id, 'authorised', authorised_by, authorised_at FROM tasks`);
    // About 5% were reopened once, so some tasks carry an episode counter.
    await c.query(`INSERT INTO task_events (id, task_id, kind, from_status, to_status, actor_id, at)
      SELECT gen_random_uuid(), id, 'reopened', 'completed', 'not_started', authorised_by, timestamptz '2026-10-01 00:00+00'
        FROM tasks WHERE (hashtext(id::text) % 20) = 0`);

    // Risks: 10 per project, review dates −60..+60, responsible a member.
    await c.query(`CREATE TEMP TABLE br AS
      SELECT n, gen_random_uuid() AS id, gen_random_uuid() AS prop FROM generate_series(1, ${RISKS}) n`);
    await c.query(`INSERT INTO human_proposals (id, project_id, kind, text, proposed_by, proposed_at)
      SELECT br.prop, bp.id, 'risk', 'Bench risk ' || br.n, bu.id, timestamptz '2026-09-01 00:00+00'
        FROM br JOIN bp ON bp.idx = br.n % ${PROJECTS} JOIN bu ON bu.idx = bp.idx % ${USERS}`);
    await c.query(`INSERT INTO risks (id, project_id, description, severity, responsible_id, review_on, mitigation, status, origin_proposal_id, authorised_by, authorised_at)
      SELECT br.id, bp.id, 'Bench risk ' || br.n, 'medium', bu.id, date '2026-11-10' + ((br.n * 104729) % 121 - 60)::int, 'Bench mitigation',
             (ARRAY['open','mitigating','accepted'])[1 + br.n % 3], br.prop, bu2.id, timestamptz '2026-09-01 00:00+00'
        FROM br JOIN bp ON bp.idx = br.n % ${PROJECTS}
        JOIN bu ON bu.idx = (bp.idx + 2 + (br.n / ${PROJECTS}) % bp.k) % ${USERS}
        JOIN bu bu2 ON bu2.idx = bp.idx % ${USERS}`);

    // Holidays for a year (organisation): every Monday-to-Friday date that is a multiple of 17 days in the year, ~15 days.
    await c.query(`INSERT INTO holidays (id, project_id, on_date, name, added_by, added_at)
      SELECT gen_random_uuid(), NULL, d::date, 'Bench holiday ' || to_char(d, 'YYYY-MM-DD'), (SELECT id FROM bu WHERE idx = 0), timestamptz '2026-01-01 00:00+00'
        FROM generate_series(date '2026-01-01', date '2026-12-31', interval '1 day') d
       WHERE extract(doy FROM d)::int % 15 = 0`);
    // Project holidays for 20 projects, a few overrides, digests, away periods and email preferences.
    await c.query(`INSERT INTO holidays (id, project_id, on_date, name, added_by, added_at)
      SELECT gen_random_uuid(), bp.id, date '2026-11-12' + j::int, 'Bench project holiday', (SELECT id FROM bu WHERE idx = 0), timestamptz '2026-01-01 00:00+00'
        FROM bp CROSS JOIN generate_series(0, 2) j WHERE bp.idx % 15 = 0`);
    await c.query(`UPDATE notification_settings SET projects_may_change_calendar = true, projects_may_change_timings = true, projects_may_change_digest = true`);
    await c.query(`INSERT INTO project_notification_settings (project_id, day_counting, lead_days, escalation_days, digest_enabled, digest_frequency, digest_weekday, digest_time)
      SELECT bp.id,
             CASE WHEN bp.idx % 20 = 1 THEN 'calendar' END,
             CASE WHEN bp.idx % 20 = 2 THEN ARRAY[14,3,1]::smallint[] END,
             CASE WHEN bp.idx % 20 = 3 THEN 5::smallint END,
             bp.idx % 30 = 4, CASE WHEN bp.idx % 30 = 4 THEN 'daily' END, NULL, CASE WHEN bp.idx % 30 = 4 THEN time '09:00' END
        FROM bp WHERE bp.idx % 20 IN (1, 2, 3) OR bp.idx % 30 = 4`);
    await c.query(`INSERT INTO email_preferences (user_id, project_id, choice, updated_at)
      SELECT bu.id, bp.id, (ARRAY['immediate','daily','off','daily_urgent_immediate'])[1 + (bp.idx + j) % 4], now()
        FROM bp CROSS JOIN generate_series(0, 1) j JOIN bu ON bu.idx = (bp.idx + 2 + j) % ${USERS}
       WHERE bp.idx % 3 = 0`);
    await c.query(`INSERT INTO away_periods (id, user_id, starts_on, ends_on, created_at)
      SELECT gen_random_uuid(), id, date '2026-11-05', date '2026-11-12', now() FROM bu WHERE idx % 25 = 7`);
    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
  await pool.query('ANALYZE');
}

async function counts(pool: Pool): Promise<Record<string, number>> {
  const q = async (sql: string) => Number((await pool.query(sql)).rows[0].n);
  return {
    users: await q('SELECT count(*) AS n FROM users'),
    activeProjects: await q(`SELECT count(*) AS n FROM projects WHERE status = 'active'`),
    memberships: await q('SELECT count(*) AS n FROM memberships'),
    openTasksAndSubtasks: await q(`SELECT count(*) AS n FROM tasks WHERE status NOT IN ('completed','cancelled')`),
    subtasks: await q('SELECT count(*) AS n FROM tasks WHERE depth > 0'),
    taskEvents: await q('SELECT count(*) AS n FROM task_events'),
    risks: await q('SELECT count(*) AS n FROM risks'),
    holidays: await q('SELECT count(*) AS n FROM holidays'),
    projectOverrides: await q('SELECT count(*) AS n FROM project_notification_settings'),
    emailPreferences: await q('SELECT count(*) AS n FROM email_preferences'),
    awayPeriods: await q('SELECT count(*) AS n FROM away_periods'),
  };
}

async function state(pool: Pool): Promise<string> {
  const q = async (sql: string) => Number((await pool.query(sql)).rows[0].n);
  const t = await q('SELECT count(*) AS n FROM notification_triggers');
  const n = await q('SELECT count(*) AS n FROM notifications');
  const o = await q('SELECT count(*) AS n FROM email_outbox');
  return `triggers=${t} notifications=${n} outbox=${o}`;
}

async function explain(pool: Pool, title: string, sql: string, params: unknown[]): Promise<void> {
  const rows = (await pool.query(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`, params)).rows as { 'QUERY PLAN': string }[];
  console.log(`\n--- EXPLAIN (ANALYZE, BUFFERS): ${title}`);
  for (const r of rows) console.log(r['QUERY PLAN']);
}

async function plans(pool: Pool, now: Date): Promise<void> {
  const proj = (await pool.query(`SELECT id FROM projects ORDER BY id LIMIT 1 OFFSET 17`)).rows[0].id as string;
  await explain(pool, 'task snapshots (one project)',
    `SELECT t.id, t.parent_id, t.title, t.assignee_id, to_char(t.due_on, 'YYYY-MM-DD'), t.status, t.deadline_review_required,
            COALESCE((SELECT max(e.at) FROM task_events e
                       WHERE e.task_id = t.id AND (e.kind IN ('authorised', 'deadline_reviewed') OR (e.kind = 'amended' AND e.detail ? 'dueOn'))),
                     t.authorised_at),
            (SELECT count(*)::int FROM task_events e WHERE e.task_id = t.id AND e.kind = 'reopened')
       FROM tasks t WHERE t.project_id = $1 AND t.status NOT IN ('completed', 'cancelled') ORDER BY t.id`, [proj]);
  await explain(pool, 'risk snapshots (one project)',
    `SELECT id, description, status, responsible_id, to_char(review_on, 'YYYY-MM-DD')
       FROM risks WHERE project_id = $1 AND status <> 'resolved' AND review_on IS NOT NULL ORDER BY id`, [proj]);
  const keys = (await pool.query(`SELECT key FROM notification_triggers WHERE project_id = $1`, [proj])).rows.map((r) => r.key as string);
  await explain(pool, `unrecorded keys, set-based anti-join (what the sweep runs once per sweep; here ${keys.length} keys of one project)`,
    `SELECT k AS key FROM unnest($1::text[]) AS k WHERE NOT EXISTS (SELECT 1 FROM notification_triggers t WHERE t.key = k)`, [keys]);
  const all = (await pool.query(`SELECT key FROM notification_triggers`)).rows.map((r) => r.key as string);
  await explain(pool, `unrecorded keys, set-based anti-join over every project (${all.length} keys, as one sweep sends them)`,
    `SELECT k AS key FROM unnest($1::text[]) AS k WHERE NOT EXISTS (SELECT 1 FROM notification_triggers t WHERE t.key = k)`, [all]);
  await explain(pool, 'unavailable-assignee tasks (one project)',
    `SELECT t.id, t.title, t.assignee_id, to_char(t.due_on, 'YYYY-MM-DD'),
            (SELECT count(*)::int FROM task_events e WHERE e.task_id = t.id AND e.kind = 'reopened'),
            t.invitation_id, i.status, i.expires_at
       FROM tasks t LEFT JOIN invitations i ON i.id = t.invitation_id
      WHERE t.project_id = $1 AND t.status NOT IN ('completed', 'cancelled') AND NOT t.deadline_review_required ORDER BY t.id`, [proj]);
  await explain(pool, 'mail candidates (all unemailed notifications)',
    `SELECT n.id, n.user_id, n.project_id, n.urgent, n.summary, n.link, n.trigger_id, t.fire_at, t.record_kind, t.record_id, t.detail,
            COALESCE((t.detail->>'minimal')::boolean, false), p.name, u.email, COALESCE(ep.choice, 'daily_urgent_immediate'),
            EXISTS (SELECT 1 FROM away_periods a WHERE a.user_id = n.user_id AND a.removed_at IS NULL AND a.starts_on <= $1::date AND a.ends_on >= $1::date),
            EXISTS (SELECT 1 FROM away_periods a WHERE a.user_id = n.user_id AND a.removed_at IS NULL
                       AND a.starts_on <= ((t.fire_at AT TIME ZONE 'UTC') + interval '8 hours')::date
                       AND a.ends_on >= ((t.fire_at AT TIME ZONE 'UTC') + interval '8 hours')::date),
            p.status = 'active',
            COALESCE(t.fire_at < (SELECT max(pt.at) FROM project_transitions pt
                                   WHERE pt.project_id = p.id AND pt.to_status = 'active' AND pt.from_status IN ('deferred', 'closed')), false)
       FROM notifications n
       JOIN notification_triggers t ON t.id = n.trigger_id
       JOIN projects p ON p.id = n.project_id
       JOIN users u ON u.id = n.user_id
       LEFT JOIN email_preferences ep ON ep.user_id = n.user_id AND ep.project_id = n.project_id
      WHERE n.outbox_id IS NULL AND NOT n.email_off
      ORDER BY n.user_id, n.project_id, t.fire_at, n.created_at, n.id`, [todayOf(now)]);
}

const todayOf = (now: Date): string => new Date(now.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);

async function main(): Promise<void> {
  const url = guardDatabase();
  const pool = new Pool({ connectionString: url, max: 4 });
  try {
    if (process.argv.includes('--plans-only')) {
      // Prints the plans on whatever the last run left in the database; nothing is reset or swept.
      await plans(pool, new Date(NOW_MS + 15 * 60_000));
      return;
    }
    console.log('Resetting the schema of kainow_test and migrating...');
    await resetPublicSchema(pool);
    await runMigrations(pool, join(__dirname, '..', '..', 'migrations'));
    const t0 = performance.now();
    await seed(pool);
    console.log(`Seeded in ${ms(performance.now() - t0)}`);
    console.log('Dataset:', JSON.stringify(await counts(pool), null, 2));

    let clockMs = NOW_MS;
    const warnings: string[] = [];
    let nudges = 0;
    const sweep = new Sweep({
      pool, clock: () => new Date(clockMs), appUrl: 'https://kainow.example.org',
      nudge: { nudge: async () => { nudges += 1; } },
      log: { warn: (m: string) => { warnings.push(m); } },
    });
    console.log(`\nClock: ${new Date(NOW_MS).toISOString()} (09:30 UTC+8)`);

    const runs: { label: string; ms: number }[] = [];
    const one = async (label: string): Promise<void> => {
      const s = performance.now();
      const r = await sweep.run();
      const d = performance.now() - s;
      runs.push({ label, ms: d });
      console.log(`${label.padEnd(28)} ${ms(d).padStart(10)}  triggers=${r.triggers} notifications=${r.notifications} emails=${r.emails}  [${await state(pool)}]`);
    };
    await one('cold (catch-up)');
    for (let i = 1; i <= 5; i++) await one(`warm ${i} (same clock)`);
    clockMs += 15 * 60_000;
    await one('+15 minutes');
    await one('+15 minutes, again');
    console.log(`\nWarnings logged: ${warnings.length}${warnings.length ? ` (${[...new Set(warnings)].join('; ')})` : ''}; nudges: ${nudges}`);
    const warm = runs.filter((r) => r.label.startsWith('warm') || r.label.startsWith('+15')).map((r) => r.ms).sort((a, b) => a - b);
    console.log(`Warm median ${ms(warm[Math.floor(warm.length / 2)])}, worst ${ms(warm[warm.length - 1])}; cold ${ms(runs[0].ms)}`);

    await plans(pool, new Date(clockMs));
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error('Sweep benchmark failed:', err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
