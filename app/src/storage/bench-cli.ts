import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../bootstrap';
import { uuidv7 } from '../common/uuid7';
import { loadConfig } from '../config';
import { ADMIN_EMAIL, seedDashboards } from '../dashboards/bench-cli';
import { NO_MEETING_END_HOOK } from '../discussion/meetings.service';
import { M365TokenSource } from '../email/m365-token';
import { todayUtc8 } from '../projects/membership';
import { CaptureSender } from '../testing/fakes';
import { type FakeGraph, startFakeGraph } from '../testing/fake-graph';
import type { StorageConnectorFactory } from './connector-factory';
import { GraphConnector } from './connectors/graph';
import { type StorageDeps, type StorageJob, storageHandler } from './jobs';
import { makeStorageNotify } from './notices';
import { checkSourceFiles } from './source-files';
import type { DestinationRef } from './types';
// The storage job handlers the bench runs, registered as the worker registers them.
import '../outputs/filing';
import '../outputs/checks';
import '../outputs/sharing';
import { syncFolderGrants } from '../outputs/sharing';

/**
 * Measured aims of sub-project 9 (external outputs spec section 15).
 *
 *   DATABASE_URL=postgres://.../kainow_bench_sp9 npm run migrate && DATABASE_URL=... npm run bench-outputs
 *
 * Seeds (set-based SQL, deterministic ids; skipped when already there) the sub-project 7 data set (200 people, 100
 * projects in 10 departments, 30,000 tasks), 700 more tasks so project 3 has 1,000, then 2,000 registered outputs
 * (20 per project) with 5,000 filed versions and their stored files, and 20,000 stored source files (stored_files rows
 * in the source area; the check reads only those rows). Then it measures:
 *   GET /projects/:id/outputs (project 3: 20 outputs, 50 versions) through the real HTTP app (aim p95 < 200 ms);
 *   GET /projects/:id/export?kind=tasks for project 3's 1,000 tasks (aim p95 < 2 s);
 *   and, against the fake Graph server with 50 ms added to every request:
 *   share-sync of a 50-reader project folder from no grants to 50 (aim < 5 s);
 *   the place-output job moving a 10-version output into its restricted folder, sharing that folder included (aim < 2 s);
 *   the daily source check of 2,000 stored files (aim within 15 minutes).
 * HTTP requests: 5 warm-up, 50 counted. Share-sync and the move: 1 warm-up, 5 counted (each round is reset without the
 * latency). The source check: one run. p95 is nearest-rank. Each run builds a fresh fake Graph, so it adds fresh
 * destinations and a fresh 50-reader project (earlier runs' are withdrawn or left as they are).
 *
 * The bench writes and deletes data, so it refuses a database whose name does not end in `_bench` or `_bench_<suffix>`.
 * All names are dummy. Seeded e-mails are at @example.org.
 */

const ROUNDS = 50;
const WARM_UP = 5;
const SLOW_ROUNDS = 5;
const LATENCY_MS = 50;
const SOURCE_FILES = 20_000;
const CHECKED_FILES = 2_000;
const READERS = 50;
const VERSIONS = 10;
const APP_ID = '11111111-2222-4333-8444-555555555555';
const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';

/** Aims in ms, from spec section 15. */
const AIMS = { outputs: 200, exportTasks: 2_000, shareSync: 5_000, move: 2_000, sourceCheck: 15 * 60_000 } as const;

const percentile = (xs: number[], q: number): number => [...xs].sort((a, b) => a - b)[Math.ceil(q * xs.length) - 1];
const ms = (n: number): string => (n >= 10_000 ? `${(n / 1000).toFixed(1)} s` : `${n.toFixed(1)} ms`);
const sleep = (n: number) => new Promise<void>((r) => setTimeout(r, n));
const user = (n: number) => `md5('dash-user-' || ${n})::uuid`;

export function assertOutputsBenchDatabase(databaseUrl: string): void {
  let name = '';
  try {
    name = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, ''));
  } catch {
    // fall through to the refusal; the URL (and its password) is never echoed
  }
  if (!/_bench(_[a-z0-9]+)?$/.test(name)) {
    throw new Error('Refusing to run: the bench writes and deletes data, so the database name must end in _bench or _bench_<suffix>.');
  }
}

function seedSql(now: Date): string[] {
  const NOW = `'${now.toISOString()}'::timestamptz`;
  const sql: string[] = [];
  // Project 3 gets 700 more top-level tasks (1,000 in all), assigned to its members, authorised over the last year.
  sql.push(`INSERT INTO tasks (id, project_id, parent_id, depth, title, assignee_id, due_on, status, authorised_by, authorised_at, completed_at)
    SELECT md5('sp9-task-' || n)::uuid, md5('dash-project-3')::uuid, NULL, 0, 'Extra task ' || n,
           (SELECT user_id FROM memberships WHERE project_id = md5('dash-project-3')::uuid ORDER BY role, user_id OFFSET n % 8 LIMIT 1),
           (${NOW})::date + (n % 61 - 30),
           (ARRAY['completed', 'in_progress', 'blocked', 'not_started', 'cancelled'])[1 + n % 5],
           (SELECT user_id FROM memberships WHERE project_id = md5('dash-project-3')::uuid AND role = 'pm' LIMIT 1),
           ${NOW} - ((5 + n % 355) * interval '1 day'),
           CASE WHEN n % 5 = 0 THEN ${NOW} - ((1 + n % 5) * interval '1 day') END
      FROM generate_series(0, 699) n`);
  sql.push(`UPDATE access_settings SET project_exports_allowed = true WHERE id`);
  sql.push(`UPDATE storage_settings SET scheduled_checks = true WHERE id`);
  sql.push(`INSERT INTO storage_destinations (id, connector, kind, purpose, label, drive_id, root_item_id, status, created_by, created_at)
    VALUES (md5('sp9-dest-outputs-seed')::uuid, 'graph', 'sharepoint_library', 'outputs', 'Bench outputs (seeded)', 'bench-seed-drive', 'bench-seed-root', 'approved', ${user(0)}, ${NOW}),
           (md5('sp9-dest-source-seed')::uuid, 'graph', 'sharepoint_library', 'source_area', 'Bench source area (seeded)', 'bench-seed-source-drive', 'bench-seed-source-root', 'approved', ${user(0)}, ${NOW})`);
  sql.push(`INSERT INTO project_output_settings (project_id, destination_id)
    SELECT md5('dash-project-' || p)::uuid, md5('sp9-dest-outputs-seed')::uuid FROM generate_series(0, 99) p`);
  // 20 registered outputs per project, Project-wide; even ones have 3 versions, odd ones 2 (5,000 versions).
  sql.push(`INSERT INTO outputs (id, project_id, title, report_type_id, issue_date, status, ai_assisted, author_id, created_at, registered_by, registered_at)
    SELECT md5('sp9-output-' || p || '-' || o)::uuid, md5('dash-project-' || p)::uuid, 'Output ' || p || '-' || o,
           t.id, (${NOW})::date - ((o * 17 + p) % 365), 'registered', o % 4 = 0, ${user(0)},
           ${NOW} - (((o * 17 + p) % 365 + 1) * interval '1 day'), ${user(0)}, ${NOW} - (((o * 17 + p) % 365) * interval '1 day')
      FROM generate_series(0, 99) p CROSS JOIN generate_series(0, 19) o
      JOIN report_types t ON t.position = 1 + o % 7`);
  sql.push(`CREATE TEMP TABLE sp9_versions AS
    SELECT p, o, v, CASE WHEN o % 2 = 0 THEN 3 ELSE 2 END AS last, (ARRAY['pdf', 'docx', 'md'])[1 + (o + v) % 3] AS fmt,
           20000 + (p * 31 + o * 7 + v) % 5000 AS size
      FROM generate_series(0, 99) p CROSS JOIN generate_series(0, 19) o CROSS JOIN generate_series(1, 3) v
     WHERE v <= CASE WHEN o % 2 = 0 THEN 3 ELSE 2 END`);
  sql.push(`INSERT INTO stored_files (id, purpose, project_id, destination_id, connector, drive_id, item_id, path, name, size_bytes, sha256, provider_hash, etag, ctag,
                             state, check_status, last_checked_at, created_at, stored_at)
    SELECT md5('sp9-ofile-' || p || '-' || o || '-' || v)::uuid, 'output', md5('dash-project-' || p)::uuid, md5('sp9-dest-outputs-seed')::uuid, 'graph',
           'bench-seed-drive', 'seed-out-' || p || '-' || o || '-' || v,
           'Department ' || (p % 10) || '/Project ' || p || '/2026/Reports/Output ' || p || '-' || o || ' v' || v || '.' || fmt,
           'Output ' || p || '-' || o || ' v' || v || '.' || fmt, size,
           md5('sp9-sha-' || p || '-' || o || '-' || v) || md5('sp9-sha2-' || p || '-' || o || '-' || v), 'seed-hash-' || p || '-' || o || '-' || v,
           '"seed-etag"', '"seed-ctag"', 'stored', 'ok', ${NOW} - interval '1 day', ${NOW} - interval '30 days', ${NOW} - interval '30 days'
      FROM sp9_versions`);
  sql.push(`INSERT INTO output_versions (id, output_id, version_no, origin, format, stored_file_id, status, sha256, size_bytes, created_by, created_at)
    SELECT md5('sp9-over-' || p || '-' || o || '-' || v)::uuid, md5('sp9-output-' || p || '-' || o)::uuid, v, 'upload', fmt,
           md5('sp9-ofile-' || p || '-' || o || '-' || v)::uuid,
           CASE WHEN o % 3 = 0 THEN CASE WHEN v = last THEN 'approved' ELSE 'superseded' END
                ELSE CASE WHEN v = last THEN 'draft' WHEN v = last - 1 THEN 'approved' ELSE 'superseded' END END,
           md5('sp9-sha-' || p || '-' || o || '-' || v) || md5('sp9-sha2-' || p || '-' || o || '-' || v), size, ${user(0)},
           ${NOW} - ((40 - v) * interval '1 day')
      FROM sp9_versions`);
  // 20,000 stored source files (originals and texts), all confirmed and checked an hour or more ago.
  sql.push(`INSERT INTO stored_files (id, purpose, project_id, destination_id, connector, drive_id, item_id, path, name, size_bytes, sha256, provider_hash, etag,
                             state, check_status, last_checked_at, created_at, stored_at)
    SELECT md5('sp9-sfile-' || i)::uuid, CASE WHEN i % 2 = 0 THEN 'source_original' ELSE 'source_text' END, md5('dash-project-' || (i % 100))::uuid,
           md5('sp9-dest-source-seed')::uuid, 'graph', 'bench-seed-source-drive', 'seed-src-' || i,
           'projects/' || md5('dash-project-' || (i % 100))::uuid || '/sources/' || md5('sp9-source-' || (i / 2))::uuid || '/v1/' || CASE WHEN i % 2 = 0 THEN 'original.docx' ELSE 'text.txt' END,
           CASE WHEN i % 2 = 0 THEN 'original.docx' ELSE 'text.txt' END, 1000 + i % 9000,
           md5('sp9-ssha-' || i) || md5('sp9-ssha2-' || i), 'seed-hash-' || i, '"seed-etag"', 'stored', 'ok',
           ${NOW} - ((1 + i % 20) * interval '1 hour'), ${NOW} - interval '30 days', ${NOW} - interval '30 days'
      FROM generate_series(0, ${SOURCE_FILES - 1}) i`);
  return sql;
}

async function seedOutputs(pool: Pool, log: (m: string) => void): Promise<void> {
  if ((await pool.query(`SELECT 1 FROM outputs WHERE id = md5('sp9-output-0-0')::uuid`)).rows[0]) {
    log('outputs already seeded; using what is there');
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
  for (const t of ['tasks', 'outputs', 'output_versions', 'stored_files', 'storage_destinations', 'project_output_settings']) await pool.query(`ANALYZE ${t}`);
  log(`outputs seeded in ${((Date.now() - started) / 1000).toFixed(1)} s`);
}

// ---------------------------------------------------------------------------------------------------------------------
// The app, a signed-in session that can also upload, and the fake Graph with added latency
// ---------------------------------------------------------------------------------------------------------------------

interface Reply { status: number; body: any; text: string }
interface Session {
  request(method: string, path: string, body?: unknown): Promise<Reply>;
  upload(method: string, path: string, fields: Record<string, string>, file: { name: string; bytes: Buffer }): Promise<Reply>;
}

async function reply(res: Response): Promise<Reply> {
  const text = await res.text();
  let body: unknown;
  try { body = text ? JSON.parse(text) : undefined; } catch { body = undefined; }
  return { status: res.status, body, text };
}

function multipart(fields: Record<string, string>, file: { name: string; bytes: Buffer }): { body: Buffer; type: string } {
  const b = `benchboundary${randomBytes(6).toString('hex')}`;
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`), file.bytes, Buffer.from(`\r\n--${b}--\r\n`));
  return { body: Buffer.concat(parts), type: `multipart/form-data; boundary=${b}` };
}

async function startBenchApp(databaseUrl: string, connectors: StorageConnectorFactory): Promise<{ app: INestApplication; signIn: (email: string) => Promise<Session> }> {
  const sender = new CaptureSender();
  const config = loadConfig({ DATABASE_URL: databaseUrl, AUTH_SECRET: randomBytes(32).toString('hex'), LOG_SIGN_IN_CODES: 'true', COOKIE_SECURE: 'false' });
  const app = await createApp(config, {
    codeSender: sender,
    logger: false,
    extractionQueue: { enqueue: async () => undefined },
    emailNudge: { nudge: async () => undefined },
    meetingEndHook: NO_MEETING_END_HOOK,
    analysisQueue: { enqueue: async () => undefined },
    storageConnectors: connectors,
  });
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  const signIn = async (email: string): Promise<Session> => {
    await fetch(`${base}/auth/request-code`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
    const res = await fetch(`${base}/auth/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, code: sender.lastCode(email) }) });
    if (res.status !== 200) throw new Error(`Sign-in failed for ${email}: ${res.status}`);
    const cookie = (res.headers.getSetCookie()[0] ?? '').split(';')[0];
    const { csrfToken } = (await res.json()) as { csrfToken: string };
    const headers = { Cookie: cookie, 'X-CSRF-Token': csrfToken };
    return {
      request: async (method, path, body) =>
        reply(await fetch(`${base}${path}`, {
          method,
          headers: { ...headers, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        })),
      upload: async (method, path, fields, file) => {
        const m = multipart(fields, file);
        return reply(await fetch(`${base}${path}`, { method, headers: { ...headers, 'Content-Type': m.type }, body: new Uint8Array(m.body) }));
      },
    };
  };
  return { app, signIn };
}

interface Graph {
  fake: FakeGraph;
  connector: GraphConnector;
  factory: StorageConnectorFactory;
  /** Milliseconds added before every request to the fake Graph (and its token endpoint). */
  latency: { ms: number };
}

async function startGraph(pool: Pool): Promise<Graph> {
  const fake = await startFakeGraph();
  const latency = { ms: 0 };
  const slow: typeof fetch = async (input, init) => {
    if (latency.ms > 0) await sleep(latency.ms);
    return fake.fetch(input, init);
  };
  const tokens = new M365TokenSource({ tenantId: 'bench-tenant', clientId: APP_ID, clientSecret: 'bench-client-secret-value' }, slow, undefined, undefined, GRAPH_SCOPE);
  const connector = new GraphConnector(tokens, { fetchFn: slow, graphBase: fake.graphBase, lookup: false, allowedDomains: async () => ['example.org'], appClientId: APP_ID });
  const factory: StorageConnectorFactory = {
    forDestination: async (id) => {
      const d = (await pool.query(`SELECT drive_id, root_item_id FROM storage_destinations WHERE id = $1`, [id])).rows[0];
      return { connector, dest: { id, connector: 'graph', driveId: d.drive_id, rootItemId: d.root_item_id } };
    },
    forNew: async () => connector,
  };
  return { fake, connector, factory, latency };
}

/**
 * Runs the queued storage work as the worker would, urgent first, until none is left. `skip` decides jobs left unrun
 * (marked sent); `timed` jobs run with the latency on and their durations are returned.
 */
async function drain(
  deps: StorageDeps, graph: Graph,
  opts: { skip?: (job: StorageJob, subjectId: string) => Promise<boolean>; timed?: StorageJob } = {},
): Promise<number[]> {
  const times: number[] = [];
  for (let i = 0; i < 500; i++) {
    const next = (
      await deps.pool.query<{ job: StorageJob; subject_id: string }>(
        `UPDATE storage_outbox SET sent_at = now() WHERE id = (SELECT id FROM storage_outbox WHERE sent_at IS NULL ORDER BY urgent DESC, created_at, id LIMIT 1) RETURNING job, subject_id`,
      )
    ).rows[0];
    if (!next) return times;
    if (opts.skip && (await opts.skip(next.job, next.subject_id))) continue;
    const handler = storageHandler(next.job);
    if (!handler) throw new Error(`no handler for ${next.job}`);
    const timed = next.job === opts.timed;
    if (timed) graph.latency.ms = LATENCY_MS;
    const t0 = performance.now();
    try {
      await handler(deps, next.subject_id, 1);
    } finally {
      graph.latency.ms = 0;
    }
    if (timed) times.push(performance.now() - t0);
  }
  throw new Error('the storage outbox did not drain');
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

const row = (label: string, aimMs: number, xs: number[]): Row => {
  const p95Ms = percentile(xs, 0.95);
  return { label, aimMs, n: xs.length, p50Ms: percentile(xs, 0.5), p95Ms, maxMs: Math.max(...xs), met: p95Ms < aimMs };
};

/** A fresh outputs destination and source area on this run's fake Graph; earlier runs' source areas are withdrawn. */
async function freshDestinations(pool: Pool, graph: Graph): Promise<{ outputs: DestinationRef; source: DestinationRef }> {
  const admin = (await pool.query(`SELECT id FROM users WHERE email = $1`, [ADMIN_EMAIL])).rows[0].id as string;
  const o = graph.fake.addDrive();
  const s = graph.fake.addDrive();
  const outputs: DestinationRef = { id: uuidv7(), connector: 'graph', driveId: o.driveId, rootItemId: o.rootItemId };
  const source: DestinationRef = { id: uuidv7(), connector: 'graph', driveId: s.driveId, rootItemId: s.rootItemId };
  await pool.query(`UPDATE storage_destinations SET status = 'withdrawn' WHERE purpose = 'source_area' AND status = 'approved'`);
  for (const [d, purpose, label] of [[outputs, 'outputs', 'Bench outputs'], [source, 'source_area', 'Bench source area']] as const) {
    await pool.query(
      `INSERT INTO storage_destinations (id, connector, kind, purpose, label, drive_id, root_item_id, status, created_by, created_at)
       VALUES ($1, 'graph', 'sharepoint_library', $2, $3, $4, $5, 'approved', $6, now())`,
      [d.id, purpose, `${label} ${d.id.slice(-6)}`, d.driveId, d.rootItemId, admin],
    );
  }
  await pool.query(
    `INSERT INTO eligible_domains (id, domain, added_by, added_at) SELECT $1, 'example.org', $2, now()
      WHERE NOT EXISTS (SELECT 1 FROM eligible_domains WHERE domain = 'example.org' AND removed_at IS NULL)`,
    [uuidv7(), admin],
  );
  // Nothing an earlier run left queued is run against this run's drives.
  await pool.query(`UPDATE storage_outbox SET sent_at = now() WHERE sent_at IS NULL`);
  return { outputs, source };
}

/** A new Active project in Department 0 with 50 content readers: the Administrator as PM, then dashboard members 1..49. */
async function sharingProject(pool: Pool, graph: Graph, destinationId: string): Promise<string> {
  const id = uuidv7();
  const since = todayUtc8(new Date(Date.now() - 30 * 86_400_000));
  await pool.query(
    `INSERT INTO projects (id, name, purpose, owning_department_id, status, created_by, created_at)
     VALUES ($1, $2, 'Bench sharing', md5('dash-dept-0')::uuid, 'active', ${user(0)}, now() - interval '30 days')`,
    [id, `Bench sharing ${id.slice(-6)}`],
  );
  await pool.query(`INSERT INTO project_stage_periods (id, project_id, stage, started_at, started_by) VALUES ($1, $2, 'Execution', now() - interval '30 days', ${user(0)})`, [uuidv7(), id]);
  await pool.query(
    `INSERT INTO memberships (id, project_id, user_id, role, starts_on)
     SELECT md5($1 || '-' || k)::uuid, $1::uuid, md5('dash-user-' || k)::uuid,
            CASE k WHEN 0 THEN 'pm' WHEN 1 THEN 'owner' WHEN 2 THEN 'deputy_pm' WHEN 3 THEN 'sponsor' ELSE 'member' END, $2::date
       FROM generate_series(0, ${READERS - 1}) k`,
    [id, since],
  );
  await pool.query(`INSERT INTO project_output_settings (project_id, destination_id) VALUES ($1, $2)`, [id, destinationId]);
  const emails = (await pool.query<{ email: string }>(`SELECT u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.project_id = $1`, [id])).rows;
  for (const e of emails) graph.fake.addUser(e.email);
  return id;
}

const expect = (r: Reply, status: number, what: string): Reply => {
  if (r.status !== status) throw new Error(`${what} answered ${r.status}: ${r.text.slice(0, 200)}`);
  return r;
};

/** Times share-sync of the project folder (no grants to 50) and the 10-version narrowing move, on the fake Graph with latency. */
async function measureStorage(pool: Pool, graph: Graph, deps: StorageDeps, pm: Session, dest: DestinationRef, log: (m: string) => void): Promise<Row[]> {
  const project = await sharingProject(pool, graph, dest.id);
  const typeId = (await pool.query(`SELECT id FROM report_types WHERE name = 'Status reports'`)).rows[0].id as string;
  const base = `/projects/${project}/outputs`;
  const doc = (v: number) => ({ name: 'briefing.md', bytes: Buffer.from(`# Bench briefing\n\nVersion ${v}: the valve audit is on Friday.\n`) });
  const sub = expect(await pm.upload('POST', base, { title: 'Bench briefing' }, doc(1)), 201, 'Submitting');
  const outputId = sub.body.id as string;
  expect(await pm.request('POST', `${base}/${outputId}/register`, { reportTypeId: typeId, issueDate: todayUtc8(new Date()) }), 200, 'Registering');
  // The project folder's own share-sync is held back while the ten versions are filed, so it can be timed from nothing.
  const projectFolder = async (subjectId: string) =>
    ((await pool.query(`SELECT 1 FROM storage_folders WHERE id = $1 AND level = 'project'`, [subjectId])).rowCount ?? 0) > 0;
  const holdProjectShare = async (job: StorageJob, subjectId: string) => job === 'share-sync' && (await projectFolder(subjectId));
  for (let v = 1; v <= VERSIONS; v++) {
    if (v > 1) expect(await pm.upload('POST', `${base}/${outputId}/versions`, {}, doc(v)), 201, `Adding version ${v}`);
    expect(await pm.request('POST', `${base}/${outputId}/versions/${v}/file`), 200, `Filing version ${v}`);
    await drain(deps, graph, { skip: holdProjectShare });
  }
  const stored = (
    await pool.query(`SELECT count(*)::int AS n FROM output_versions v JOIN stored_files f ON f.id = v.stored_file_id WHERE v.output_id = $1 AND f.state = 'stored'`, [outputId])
  ).rows[0].n;
  if (stored !== VERSIONS) throw new Error(`only ${stored} of ${VERSIONS} versions were filed`);
  const pf = (
    await pool.query<{ id: string; item_id: string }>(`SELECT id, item_id FROM storage_folders WHERE level = 'project' AND destination_id = $1 AND split_part(key, '/', 2) = $2`, [dest.id, project])
  ).rows[0];
  const granted = async () => (await pool.query(`SELECT count(*)::int AS n FROM storage_grants WHERE folder_id = $1 AND state = 'granted'`, [pf.id])).rows[0].n as number;

  // Share-sync from no grants to 50; reset (without latency) between rounds.
  const syncTimes: number[] = [];
  for (let round = 0; round <= SLOW_ROUNDS; round++) {
    if ((await granted()) !== 0) throw new Error('the project folder was not reset');
    graph.latency.ms = LATENCY_MS;
    const t0 = performance.now();
    try {
      await syncFolderGrants(deps, pf.id);
    } finally {
      graph.latency.ms = 0;
    }
    const took = performance.now() - t0;
    if ((await granted()) !== READERS) throw new Error(`share-sync granted ${await granted()} of ${READERS}`);
    if (round > 0) syncTimes.push(took);
    if (round === SLOW_ROUNDS) break;
    const rows = (await pool.query<{ id: string; permission_id: string }>(`SELECT id, permission_id FROM storage_grants WHERE folder_id = $1 AND state = 'granted'`, [pf.id])).rows;
    for (const g of rows) await graph.connector.revoke(dest, pf.item_id, g.permission_id);
    await pool.query(`UPDATE storage_grants SET state = 'revoked', updated_at = now() WHERE id = ANY($1::uuid[])`, [rows.map((g) => g.id)]);
  }

  // The narrowing move of all ten files into the output's own folder (the place-output job, sharing that folder with its
  // three readers included); widened back without latency between rounds.
  const readers = (await pool.query<{ id: string }>(`SELECT md5('dash-user-' || k)::uuid::text AS id FROM generate_series(0, 2) k`)).rows.map((r) => r.id);
  const moveTimes: number[] = [];
  for (let round = 0; round <= SLOW_ROUNDS; round++) {
    expect(await pm.request('PUT', `${base}/${outputId}/audience`, { mode: 'restricted', userIds: readers, reason: 'Bench: board only' }), 200, 'Narrowing');
    const times = await drain(deps, graph, { timed: 'place-output' });
    if (times.length !== 1) throw new Error(`expected one place-output job, ran ${times.length}`);
    const inOwn = (
      await pool.query(
        `SELECT count(*)::int AS n FROM output_versions v JOIN stored_files f ON f.id = v.stored_file_id JOIN storage_folders sf ON sf.id = f.folder_id
          WHERE v.output_id = $1 AND sf.level = 'output'`,
        [outputId],
      )
    ).rows[0].n;
    if (inOwn !== VERSIONS) throw new Error(`only ${inOwn} of ${VERSIONS} files reached the restricted folder`);
    if (round > 0) moveTimes.push(times[0]);
    expect(await pm.request('PUT', `${base}/${outputId}/audience`, { mode: 'project', reason: 'Bench: everyone again' }), 200, 'Widening');
    await drain(deps, graph);
  }
  log(`share-sync and move: project folder of ${READERS} readers, output of ${VERSIONS} filed versions, ${LATENCY_MS} ms added per Graph request`);
  return [
    row(`share-sync of a ${READERS}-reader project folder (no grants to ${READERS})`, AIMS.shareSync, syncTimes),
    row(`place-output: ${VERSIONS}-version output into its restricted folder`, AIMS.move, moveTimes),
  ];
}

/** Times the daily source check of 2,000 stored files that exist on the fake Graph. */
async function measureSourceCheck(pool: Pool, graph: Graph, deps: StorageDeps, source: DestinationRef, log: (m: string) => void): Promise<Row> {
  await pool.query(
    `UPDATE stored_files SET destination_id = $1, drive_id = $2, last_checked_at = now() - interval '1 hour', check_status = 'ok'
      WHERE purpose IN ('source_original', 'source_text') AND id IN (SELECT md5('sp9-sfile-' || i)::uuid FROM generate_series(0, ${SOURCE_FILES - 1}) i)`,
    [source.id, source.driveId],
  );
  const folder = await graph.connector.createFolder(source, null, 'projects');
  const ids: string[] = [];
  const items: string[] = [];
  const hashes: string[] = [];
  const etags: string[] = [];
  const sizes: number[] = [];
  for (let i = 0; i < CHECKED_FILES; i++) {
    const ref = await graph.connector.upload(source, folder.itemId, `file-${i}.txt`, Buffer.from(`Source text ${i}: the valve audit is on Friday.\n`), { conflict: 'fail' });
    ids.push(`sp9-sfile-${i}`);
    items.push(ref.itemId);
    hashes.push(ref.providerHash ?? '');
    etags.push(ref.etag ?? '');
    sizes.push(ref.size);
  }
  await pool.query(
    `UPDATE stored_files f SET item_id = x.item, provider_hash = x.hash, etag = x.etag, size_bytes = x.size, last_checked_at = NULL
       FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::bigint[]) AS x(label, item, hash, etag, size)
      WHERE f.id = md5(x.label)::uuid`,
    [ids, items, hashes, etags, sizes],
  );
  graph.latency.ms = LATENCY_MS;
  const t0 = performance.now();
  let result;
  try {
    result = await checkSourceFiles(deps, new Date(), CHECKED_FILES);
  } finally {
    graph.latency.ms = 0;
  }
  const took = performance.now() - t0;
  if (result.checked !== CHECKED_FILES || result.flagged !== 0) throw new Error(`the source check checked ${result.checked} and flagged ${result.flagged}`);
  log(`source check: ${result.checked} of ${SOURCE_FILES} stored source files checked, ${result.flagged} flagged, ${LATENCY_MS} ms added per Graph request`);
  return row(`daily source check of ${CHECKED_FILES} files`, AIMS.sourceCheck, [took]);
}

export async function runOutputsBench(databaseUrl: string, log: (m: string) => void = console.log): Promise<Row[]> {
  assertOutputsBenchDatabase(databaseUrl);
  const pool = new Pool({ connectionString: databaseUrl, max: 10 });
  let graph: Graph | undefined;
  try {
    await seedDashboards(pool, log);
    await seedOutputs(pool, log);
    graph = await startGraph(pool);
    const g = graph;
    const deps: StorageDeps = { pool, connectors: g.factory, key: null, clock: () => new Date(), notify: makeStorageNotify(pool, () => new Date()) };
    const { app, signIn } = await startBenchApp(databaseUrl, g.factory);
    try {
      const counts: string[] = [];
      for (const [label, sql] of [
        ['projects', `SELECT count(*)::int AS n FROM projects`],
        ['tasks', `SELECT count(*)::int AS n FROM tasks`],
        ['outputs', `SELECT count(*)::int AS n FROM outputs`],
        ['output versions', `SELECT count(*)::int AS n FROM output_versions`],
        ['stored source files', `SELECT count(*)::int AS n FROM stored_files WHERE purpose IN ('source_original', 'source_text')`],
      ]) counts.push(`${(await pool.query(sql)).rows[0].n} ${label}`);
      log(`data: ${counts.join(', ')}`);
      const admin = await signIn(ADMIN_EMAIL);
      const project3 = (await pool.query(`SELECT md5('dash-project-3')::uuid::text AS id`)).rows[0].id as string;
      const p3 = (await pool.query(`SELECT (SELECT count(*)::int FROM tasks WHERE project_id = $1) AS tasks, (SELECT count(*)::int FROM outputs WHERE project_id = $1) AS outputs`, [project3])).rows[0];
      log(`project 3: ${p3.tasks} tasks, ${p3.outputs} outputs`);

      const measure = async (label: string, aimMs: number, path: string): Promise<Row> => {
        const once = async (): Promise<number> => {
          const t0 = performance.now();
          const r = await admin.request('GET', path);
          const took = performance.now() - t0;
          expect(r, 200, `GET ${path}`);
          return took;
        };
        for (let i = 0; i < WARM_UP; i++) await once();
        const xs: number[] = [];
        for (let i = 0; i < ROUNDS; i++) xs.push(await once());
        return row(label, aimMs, xs);
      };
      const rows: Row[] = [];
      const report = (r: Row) => {
        rows.push(r);
        log(`${r.label}: p50 ${ms(r.p50Ms)}, p95 ${ms(r.p95Ms)}, max ${ms(r.maxMs)} (n ${r.n}, aim < ${ms(r.aimMs)}): ${r.met ? 'met' : 'MISSED'}`);
      };
      report(await measure('GET /projects/:id/outputs (20 outputs, 50 versions)', AIMS.outputs, `/projects/${project3}/outputs`));
      // The export is what is timed: every one of the project's tasks not Deleted is a row (header lines start with #).
      const csv = expect(await admin.request('GET', `/projects/${project3}/export?kind=tasks`), 200, 'Exporting').text;
      const dataRows = csv.split('\r\n').filter((l) => l !== '' && !l.startsWith('#') && !l.startsWith('﻿#')).length - 1;
      const live = (await pool.query(`SELECT count(*)::int AS n FROM tasks WHERE project_id = $1 AND deleted_at IS NULL`, [project3])).rows[0].n;
      log(`tasks export of project 3: ${dataRows} rows for ${live} tasks not Deleted`);
      report(await measure('GET /projects/:id/export?kind=tasks (1,000 tasks)', AIMS.exportTasks, `/projects/${project3}/export?kind=tasks`));
      const { outputs, source } = await freshDestinations(pool, g);
      for (const r of await measureStorage(pool, g, deps, admin, outputs, log)) report(r);
      report(await measureSourceCheck(pool, g, deps, source, log));
      log('');
      log('| Measure | Aim | n | p50 | p95 | max | Result |');
      log('|---|---|---|---|---|---|---|');
      for (const r of rows) log(`| ${r.label} | < ${ms(r.aimMs)} | ${r.n} | ${ms(r.p50Ms)} | ${ms(r.p95Ms)} | ${ms(r.maxMs)} | ${r.met ? 'met' : 'missed'} |`);
      return rows;
    } finally {
      await app.close();
    }
  } finally {
    await graph?.fake.close();
    await pool.end();
  }
}

if (require.main === module) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('Set DATABASE_URL to a migrated database whose name ends in _bench or _bench_<suffix> (for example kainow_bench_sp9).');
    process.exit(1);
  }
  runOutputsBench(url).then(
    () => process.exit(0),
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
