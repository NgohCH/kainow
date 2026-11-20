import { Pool } from 'pg';
import { startApp } from '../analysis/bench-cli';
import { ADMIN_EMAIL, LEADER_EMAIL, ensureGrant, seedDashboards, type Row } from '../dashboards/bench-cli';

/**
 * Measured aims of sub-project 8 (resources and budget spec section 13).
 *
 *   DATABASE_URL=postgres://.../kainow_bench_sp8 npm run migrate && DATABASE_URL=... npm run bench-resources
 *
 * Seeds the sub-project 7 bench data (by importing its seed), then (set-based SQL, deterministic ids, skipped when
 * already there) 10 categories and 300 catalogue items, 5,000 resource lines (40% on catalogue items, many overlapping
 * in time; 100 of them in project 3), and 60 tracking projects (projects 0..59, currency MYR, a budget each) with
 * 20,000 spending entries (1,000 in project 4; one in five in USD) and 1,000 approved adjustments (corrections,
 * refunds, and conversions of the USD entries). Then times through the real HTTP app on loopback, 5 warm-up requests
 * not counted and 50 counted (nearest-rank p95), and prints met or missed against the aims:
 *   GET /projects/:id/resources for a project with 100 lines, as a participant (aim p95 < 200 ms);
 *   GET /projects/:id/finance for a project with 1,000 entries, as its Project Manager (aim < 200 ms);
 *   GET /admin/analytics?panel=resources, default filters, as the Administrator (aim < 500 ms);
 *   GET /dashboard/leadership for the organisation-scope holder, with the new fields (aim < 500 ms).
 *
 * The tool writes thousands of rows, so it refuses any database whose name does not end in _bench or _bench_sp8.
 * All names are dummy. Seeded e-mails are at @example.org.
 */

const ROUNDS = 50;
const WARM_UP = 5;
const AIMS = { resources: 200, finance: 200, panel: 500, leadership: 500 } as const;
const LINES = 5000;
const ITEMS = 300;
const ENTRIES = 20000;
const TRACKING_PROJECTS = 60;
const RESOURCES_PROJECT = 3; // 100 lines; the Administrator is its Project Manager
const FINANCE_PROJECT = 4; // 1,000 entries; the Administrator is its Project Manager

const percentile = (xs: number[], q: number): number => [...xs].sort((a, b) => a - b)[Math.ceil(q * xs.length) - 1];
const ms = (n: number): string => `${n.toFixed(1)} ms`;

export function assertResourcesBenchDatabase(databaseUrl: string): string {
  let name = '';
  try {
    name = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, ''));
  } catch {
    // fall through to the refusal; the URL (and its password) is never echoed
  }
  if (!/_bench(_sp8)?$/.test(name)) throw new Error('Refusing to run: the bench writes data, so the database name must end in _bench or _bench_sp8.');
  return name;
}

function seedSql(now: Date): string[] {
  const NOW = `'${now.toISOString()}'::timestamptz`;
  const admin = `md5('dash-user-0')::uuid`;
  const sql: string[] = [];

  sql.push(`INSERT INTO resource_categories (id, name, created_by, created_at)
    SELECT md5('res-cat-' || c)::uuid, 'Category ' || c, ${admin}, ${NOW} FROM generate_series(0, 9) c`);
  sql.push(`INSERT INTO resource_items (id, kind, reference, name, category_id, description, created_by, created_at)
    SELECT md5('res-item-' || i)::uuid, CASE WHEN i % 4 = 0 THEN 'facility' ELSE 'equipment' END, 'ITEM-' || i, 'Item ' || i,
           md5('res-cat-' || (i % 10))::uuid, 'Catalogue item ' || i, ${admin}, ${NOW}
      FROM generate_series(0, ${ITEMS - 1}) i`);

  // Lines 0..99 are in the timed project; the rest spread over the other 99 projects. Lines g % 5 in (0, 1) are on a
  // catalogue item (40%), 300 items shared, so many overlap; the rest are one-off. Status by (g / 5) % 5.
  sql.push(`CREATE TEMP TABLE res_lines AS
    SELECT g, md5('res-line-' || g)::uuid AS id,
           md5('dash-project-' || (CASE WHEN g < 100 THEN ${RESOURCES_PROJECT} WHEN (g - 100) % 99 < ${RESOURCES_PROJECT} THEN (g - 100) % 99 ELSE (g - 100) % 99 + 1 END))::uuid AS project_id,
           g % 5 < 2 AS on_item,
           (${NOW})::date + ((g * 3) % 120 - 20) AS starts_on,
           (ARRAY['needed', 'arranged', 'in_use', 'finished', 'cancelled'])[1 + (g / 5) % 5] AS status
      FROM generate_series(0, ${LINES - 1}) g`);
  sql.push(`INSERT INTO resource_lines (id, project_id, item_id, one_off_kind, description, quantity, unit, starts_on, ends_on, needed_by, notes, status, created_by, created_at, updated_at)
    SELECT id, project_id,
           CASE WHEN on_item THEN md5('res-item-' || ((g * 7) % ${ITEMS}))::uuid END,
           CASE WHEN NOT on_item THEN (ARRAY['equipment', 'facility', 'other'])[1 + g % 3] END,
           CASE WHEN NOT on_item THEN 'One-off need ' || g ELSE '' END,
           1 + g % 20, (ARRAY['hours', 'days', 'items', 'seats'])[1 + g % 4],
           CASE WHEN g % 9 <> 0 THEN starts_on END,
           CASE WHEN g % 9 <> 0 AND g % 11 <> 0 THEN starts_on + (10 + g % 40) END,
           starts_on - 5, 'Note ' || g, status, ${admin}, ${NOW} - interval '30 days', ${NOW} - interval '10 days'
      FROM res_lines`);
  sql.push(`INSERT INTO resource_line_events (id, line_id, kind, actor_id, at, reason, detail)
    SELECT md5('res-lev-c-' || id)::uuid, id, 'created', ${admin}, ${NOW} - interval '30 days', NULL, '{}'::jsonb FROM res_lines`);
  sql.push(`INSERT INTO resource_line_events (id, line_id, kind, actor_id, at, reason, detail)
    SELECT md5('res-lev-f-' || id)::uuid, id, 'status_changed', ${admin}, ${NOW} - ((1 + g % 25) * interval '1 day'), NULL,
           '{"previous": {"status": "in_use"}, "next": {"status": "finished"}}'::jsonb FROM res_lines WHERE status = 'finished'`);
  sql.push(`INSERT INTO resource_line_events (id, line_id, kind, actor_id, at, reason, detail)
    SELECT md5('res-lev-x-' || id)::uuid, id, 'cancelled', ${admin}, ${NOW} - ((1 + g % 25) * interval '1 day'), 'No longer needed',
           '{"previous": {"status": "needed"}, "next": {"status": "cancelled"}}'::jsonb FROM res_lines WHERE status = 'cancelled'`);

  // Tracking projects 0..59: Enabled, MYR, one budget version (two for every third project), each by an approved request.
  sql.push(`INSERT INTO project_finance_settings (project_id, tracking, currency)
    SELECT md5('dash-project-' || p)::uuid, 'enabled', 'MYR' FROM generate_series(0, ${TRACKING_PROJECTS - 1}) p`);
  sql.push(`INSERT INTO project_finance_state (project_id, notified_level)
    SELECT md5('dash-project-' || p)::uuid, 0 FROM generate_series(0, ${TRACKING_PROJECTS - 1}) p`);
  sql.push(`INSERT INTO change_requests (id, project_id, kind, target_kind, target_id, required_approvals, status, submitted_by, submitted_at, decided_by, decided_at, reason)
    SELECT md5('res-budget-cr-' || p || '-' || v)::uuid, md5('dash-project-' || p)::uuid, 'set_budget', 'project_budget', md5('dash-project-' || p)::uuid,
           1, 'authorised', ${admin}, ${NOW} - ((200 - v * 60) * interval '1 day'), ${admin}, ${NOW} - ((200 - v * 60) * interval '1 day'), 'Bench budget'
      FROM generate_series(0, ${TRACKING_PROJECTS - 1}) p CROSS JOIN generate_series(0, 1) v WHERE v = 0 OR p % 3 = 0`);
  sql.push(`INSERT INTO budget_versions (id, project_id, amount, currency, change_request_id, approved_at)
    SELECT md5('res-budget-' || p || '-' || v)::uuid, md5('dash-project-' || p)::uuid, 200000 + p * 5000 + v * 50000, 'MYR',
           md5('res-budget-cr-' || p || '-' || v)::uuid, ${NOW} - ((200 - v * 60) * interval '1 day')
      FROM generate_series(0, ${TRACKING_PROJECTS - 1}) p CROSS JOIN generate_series(0, 1) v WHERE v = 0 OR p % 3 = 0`);

  // Entries: the first 1,000 in the timed finance project, the rest over the other 59 tracking projects. One in five is USD.
  sql.push(`CREATE TEMP TABLE res_entries AS
    SELECT e, md5('res-entry-' || e)::uuid AS id,
           md5('dash-project-' || (CASE WHEN e < 1000 THEN ${FINANCE_PROJECT} WHEN (e - 1000) % ${TRACKING_PROJECTS - 1} < ${FINANCE_PROJECT} THEN (e - 1000) % ${TRACKING_PROJECTS - 1} ELSE (e - 1000) % ${TRACKING_PROJECTS - 1} + 1 END))::uuid AS project_id,
           (10 + (e * 37) % 5000)::numeric(16, 2) + (e % 100) / 100.0 AS amount,
           CASE WHEN e % 5 = 1 THEN 'USD' ELSE 'MYR' END AS currency
      FROM generate_series(0, ${ENTRIES - 1}) e`);
  sql.push(`INSERT INTO expenditures (id, project_id, spent_on, amount, currency, description, reference, recorded_by, recorded_at)
    SELECT id, project_id, (${NOW})::date - (e % 180), amount, currency, 'Spending ' || e, 'INV-' || e, ${admin}, ${NOW} - ((e % 180) * interval '1 day')
      FROM res_entries`);
  // 1,000 approved adjustments: 500 conversions (on USD entries), 250 corrections, 250 refunds; each by an approved request.
  sql.push(`CREATE TEMP TABLE res_adjs AS
    SELECT e AS n, id AS entry_id, project_id, amount, currency,
           CASE WHEN e % 40 = 1 THEN 'conversion' WHEN e % 80 = 0 THEN 'correction' ELSE 'refund' END AS kind
      FROM res_entries WHERE e % 40 = 1 OR e % 80 = 0 OR e % 80 = 40`);
  sql.push(`INSERT INTO change_requests (id, project_id, kind, target_kind, target_id, required_approvals, status, submitted_by, submitted_at, decided_by, decided_at, reason)
    SELECT md5('res-adj-cr-' || n)::uuid, project_id, 'finance_adjustment', 'expenditure', entry_id, 1, 'authorised', ${admin},
           ${NOW} - interval '5 days', ${admin}, ${NOW} - interval '5 days', 'Bench adjustment' FROM res_adjs`);
  sql.push(`INSERT INTO expenditure_adjustments (id, expenditure_id, kind, amount, rate, rate_on, refund_on, reason, change_request_id, approved_at)
    SELECT md5('res-adj-' || n)::uuid, entry_id, kind,
           CASE kind WHEN 'conversion' THEN round(amount * 4.5, 2) WHEN 'correction' THEN round(amount * 0.9, 2) ELSE round(amount * 0.3, 2) END,
           CASE WHEN kind = 'conversion' THEN 4.5 END, CASE WHEN kind = 'conversion' THEN (${NOW})::date - 10 END,
           CASE WHEN kind = 'refund' THEN (${NOW})::date - 6 END, 'Bench ' || kind, md5('res-adj-cr-' || n)::uuid, ${NOW} - interval '5 days'
      FROM res_adjs`);
  return sql;
}

async function analyse(pool: Pool): Promise<void> {
  for (const t of ['resource_categories', 'resource_items', 'resource_lines', 'resource_line_events', 'project_finance_settings', 'budget_versions', 'expenditures', 'expenditure_adjustments', 'change_requests']) {
    await pool.query(`ANALYZE ${t}`);
  }
}

/** Seeds the sub-project 8 data on top of the dashboards data (skipped when the catalogue items are already there). */
export async function seedResources(pool: Pool, log: (m: string) => void = console.log): Promise<void> {
  await seedDashboards(pool, log);
  if ((await pool.query(`SELECT 1 FROM resource_items LIMIT 1`)).rows[0]) {
    log('resources already seeded; using what is there');
    return;
  }
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
  log(`resources seeded in ${((Date.now() - started) / 1000).toFixed(1)} s`);
}

export async function runResourcesBench(databaseUrl: string, log: (m: string) => void = console.log): Promise<Row[]> {
  assertResourcesBenchDatabase(databaseUrl);
  const pool = new Pool({ connectionString: databaseUrl, max: 10 });
  try {
    await seedResources(pool, log);
    const leaderId = (await pool.query(`SELECT id FROM users WHERE email = $1`, [LEADER_EMAIL])).rows[0].id as string;
    const granted = !!(await pool.query(`SELECT 1 FROM leadership_grants WHERE user_id = $1 AND revoked_at IS NULL`, [leaderId])).rows[0];
    const { app, signIn } = await startApp(databaseUrl);
    try {
      const admin = await signIn(ADMIN_EMAIL);
      if (!granted) await ensureGrant(pool, admin);
      const leader = await signIn(LEADER_EMAIL);
      const counts: string[] = [];
      for (const [label, table] of [['users', 'users'], ['projects', 'projects'], ['tasks', 'tasks'], ['catalogue items', 'resource_items'], ['resource lines', 'resource_lines'], ['spending entries', 'expenditures'], ['adjustments', 'expenditure_adjustments']]) {
        counts.push(`${(await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n} ${label}`);
      }
      log(`data: ${counts.join(', ')}`);
      const tracking = (await pool.query(`SELECT count(*)::int AS n FROM project_finance_settings WHERE tracking = 'enabled'`)).rows[0].n;
      const pid = async (p: number) => (await pool.query(`SELECT md5('dash-project-${p}')::uuid::text AS id`)).rows[0].id as string;
      const resProject = await pid(RESOURCES_PROJECT);
      const finProject = await pid(FINANCE_PROJECT);
      const nLines = (await pool.query(`SELECT count(*)::int AS n FROM resource_lines WHERE project_id = $1`, [resProject])).rows[0].n;
      const nEntries = (await pool.query(`SELECT count(*)::int AS n FROM expenditures WHERE project_id = $1`, [finProject])).rows[0].n;
      log(`${tracking} tracking projects; the timed resources project has ${nLines} lines, the timed finance project ${nEntries} entries`);

      const measure = async (label: string, aimMs: number, who: { request(m: string, p: string): Promise<{ status: number; text: string }> }, path: string): Promise<Row> => {
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
      rows.push(await measure(`GET /projects/:id/resources (${nLines} lines)`, AIMS.resources, admin, `/projects/${resProject}/resources`));
      rows.push(await measure(`GET /projects/:id/finance (${nEntries} entries)`, AIMS.finance, admin, `/projects/${finProject}/finance`));
      rows.push(await measure('GET /admin/analytics?panel=resources', AIMS.panel, admin, '/admin/analytics?panel=resources'));
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
    console.error('Set DATABASE_URL to a migrated database whose name ends in _bench or _bench_sp8.');
    process.exit(1);
  }
  runResourcesBench(url).then(
    () => process.exit(0),
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
