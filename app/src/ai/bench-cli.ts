import { randomUUID } from 'node:crypto';
import { cpus, totalmem } from 'node:os';
import { Pool, type PoolClient } from 'pg';
import { assertBenchDatabase } from '../analysis/bench-cli';
import { parseMicro } from '../spend/money';
import { SpendService } from '../spend/spend.service';
import { SpendSettingsService } from '../spend/spend.settings';

/**
 * Measured aim of sub-project 6 (spec 11): reserving AI spend with all six scopes applying, on a history of 200,000
 * entries over 50 projects and 400 people. Aim: p95 under 25 ms.
 *
 *   DATABASE_URL=postgres://.../kainow_bench npm run migrate && DATABASE_URL=... npm run bench-ai
 *
 * The tool writes about 200,000 rows, so it refuses any database whose name does not end in `_bench` (the guard of
 * the analysis bench). It seeds its own people and projects (the same shapes as the analysis bench) because it needs
 * none of that bench's discussions. Rows are deterministic (md5 of a label); the sealed keys are fake bytes that are
 * never opened.
 */

export const BENCH_PROJECTS = 50;
export const BENCH_PEOPLE = 400;
export const BENCH_ENTRIES = 200_000;
const WARM_UPS = 20;
const CALLS = 500;
const AIM_P95_MS = 25;
/** Generous so no limit refuses during the run: the bench times the checks, not the refusals (MYR 1,000,000). */
const LIMIT = parseMicro('1000000', 'limit');
const ESTIMATE = 1000n;

/** Nearest-rank percentile of a list of numbers. */
export const nearestRank = (xs: number[], q: number): number => [...xs].sort((a, b) => a - b)[Math.max(0, Math.ceil(q * xs.length) - 1)];
const ms = (n: number): string => `${n.toFixed(2)} ms`;

function seedSql(now: Date): string[] {
  const NOW = `'${now.toISOString()}'::timestamptz`;
  const user = (expr: string) => `md5('bench-user-' || (${expr}))::uuid`;
  const allPurposes = `ARRAY['extraction', 'discussion_analysis', 'minutes_draft', 'question_answer', 'report_draft', 'summary_draft']`;
  return [
    `INSERT INTO users (id, email, display_name, role)
       SELECT ${user('i')}, 'bench-user-' || i || '@example.org', CASE WHEN i = 0 THEN 'Bench Administrator' ELSE 'Member ' || i END,
              CASE WHEN i = 0 THEN 'enterprise_administrator' ELSE 'member' END
         FROM generate_series(0, ${BENCH_PEOPLE}) i`,
    `INSERT INTO organisation (id, name, registered_at, updated_at) VALUES (1, 'Example Organisation', now(), now()) ON CONFLICT (id) DO NOTHING`,
    `INSERT INTO departments (id, name, created_by, created_at)
       SELECT md5('bench-dept-' || d)::uuid, 'Department ' || d, ${user('0')}, ${NOW} FROM generate_series(0, 4) d`,
    `INSERT INTO projects (id, name, purpose, owning_department_id, status, created_by, created_at)
       SELECT md5('bench-project-' || p)::uuid, 'Project ' || p, 'Purpose of project ' || p, md5('bench-dept-' || (p % 5))::uuid,
              'active', ${user('0')}, ${NOW} - interval '90 days'
         FROM generate_series(0, ${BENCH_PROJECTS - 1}) p`,
    // Two approved models and one connection per project, with a fake sealed key that is never opened.
    `INSERT INTO ai_models (id, provider, model_id, display_name, input_usd_per_million_micro, cached_input_usd_per_million_micro,
                            cache_write_usd_per_million_micro, output_usd_per_million_micro, data_terms, purposes, restricted_ok, state, updated_at)
       VALUES (md5('bench-model-openai')::uuid, 'openai', 'bench-model-a', 'Bench model A', 2000000, 500000, 0, 8000000, 'Bench data terms',
               ${allPurposes}, true, 'approved', ${NOW}),
              (md5('bench-model-anthropic')::uuid, 'anthropic', 'bench-model-b', 'Bench model B', 3000000, 300000, 3750000, 15000000, 'Bench data terms',
               ${allPurposes}, true, 'approved', ${NOW})`,
    `INSERT INTO ai_connections (id, project_id, model_ref, label, position, state, created_at)
       SELECT md5('bench-conn-' || p)::uuid, md5('bench-project-' || p)::uuid,
              md5(CASE WHEN p % 2 = 0 THEN 'bench-model-openai' ELSE 'bench-model-anthropic' END)::uuid, 'Bench connection ' || p, 1, 'ready', ${NOW}
         FROM generate_series(0, ${BENCH_PROJECTS - 1}) p`,
    `INSERT INTO ai_connection_keys (id, connection_id, ciphertext, nonce, tag, key_id, saved_at)
       SELECT md5('bench-key-' || p)::uuid, md5('bench-conn-' || p)::uuid, decode(md5('bench-ct-' || p) || md5('bench-ct2-' || p), 'hex'),
              decode(substr(md5('bench-nonce-' || p), 1, 24), 'hex'), decode(md5('bench-tag-' || p), 'hex'), 'bench-key-1', ${NOW}
         FROM generate_series(0, ${BENCH_PROJECTS - 1}) p`,
    // Every project has all three limits: monthly, daily and per-person.
    `INSERT INTO project_ai_limits (project_id, monthly_limit_micro_myr, daily_mode, daily_limit_micro_myr, user_monthly_mode, user_monthly_limit_micro_myr, updated_at)
       SELECT md5('bench-project-' || p)::uuid, ${LIMIT}, 'limit', ${LIMIT}, 'limit', ${LIMIT}, ${NOW} FROM generate_series(0, ${BENCH_PROJECTS - 1}) p`,
    // The history: spread over the last 45 days, mostly confirmed, some released, some uncertain.
    `INSERT INTO ai_spend_entries
         (id, request_id, attempt_no, created_at, updated_at, status, purpose, actor_user_id, model_id,
          input_usd_per_million_micro, cached_input_usd_per_million_micro, cache_write_usd_per_million_micro, output_usd_per_million_micro, myr_per_usd_micro,
          estimate_micro_myr, amount_micro_myr, project_id, connection_id, provider, ruled)
       SELECT md5('bench-entry-' || i)::uuid, md5('bench-request-' || i)::uuid, 1,
              ${NOW} - ((i % (45 * 24 * 60)) * interval '1 minute'), ${NOW} - ((i % (45 * 24 * 60)) * interval '1 minute'), s.status, 'extraction',
              ${user(`1 + (i * 7) % ${BENCH_PEOPLE}`)}, CASE WHEN (i % ${BENCH_PROJECTS}) % 2 = 0 THEN 'bench-model-a' ELSE 'bench-model-b' END,
              2000000, 500000, 0, 8000000, 4100000,
              s.estimate, CASE s.status WHEN 'released' THEN 0 WHEN 'confirmed' THEN s.estimate / 2 ELSE s.estimate END,
              md5('bench-project-' || (i % ${BENCH_PROJECTS}))::uuid, md5('bench-conn-' || (i % ${BENCH_PROJECTS}))::uuid,
              CASE WHEN (i % ${BENCH_PROJECTS}) % 2 = 0 THEN 'openai' ELSE 'anthropic' END, true
         FROM generate_series(0, ${BENCH_ENTRIES - 1}) i
         CROSS JOIN LATERAL (SELECT CASE WHEN i % 97 = 0 THEN 'released' WHEN i % 211 = 0 THEN 'uncertain' ELSE 'confirmed' END AS status,
                                     (1000 + (i % 500))::bigint AS estimate) s`,
  ];
}

/** Seeds an empty, migrated `_bench` database. Seeding twice does nothing. */
export async function seedAiBench(pool: Pool, log: (m: string) => void = console.log): Promise<void> {
  const name = (await pool.query(`SELECT current_database() AS name`)).rows[0].name as string;
  assertBenchDatabase(`postgres://x/${name}`);
  await pool.query(`CREATE TABLE IF NOT EXISTS bench_meta (key text PRIMARY KEY, value text NOT NULL)`);
  const prior = await pool.query(`SELECT value FROM bench_meta WHERE key = 'ai_seeded_at'`);
  if (prior.rows[0]) {
    log(`already seeded at ${prior.rows[0].value}; measuring what is there (drop and recreate the database for a clean run)`);
    return;
  }
  if ((await pool.query(`SELECT count(*)::int AS n FROM users`)).rows[0].n > 0) throw new Error('The database already holds users; use an empty migrated database.');
  const now = new Date();
  now.setMilliseconds(0);
  const started = Date.now();
  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const statement of seedSql(now)) await client.query(statement);
    await client.query(`INSERT INTO bench_meta (key, value) VALUES ('ai_seeded_at', $1)`, [now.toISOString()]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  // Organisation settings with every scope applying: monthly, daily and per-person.
  const admin = (await pool.query(`SELECT id FROM users WHERE email = 'bench-user-0@example.org'`)).rows[0].id as string;
  await new SpendSettingsService(pool, () => now).apply(
    {
      prices: { myrPerUsdMicro: parseMicro('4.1', 'rate') },
      monthlyLimitMicroMyr: LIMIT,
      daily: { mode: 'limit', limitMicroMyr: LIMIT },
      userMonthly: { mode: 'limit', limitMicroMyr: LIMIT },
      projectsMaySetLimits: true,
      projectsMayManageConnections: true,
      projectCeiling: { mode: 'not_applied' },
      maxAttempts: 3,
      timeoutSeconds: 120,
      concurrency: 2,
    },
    admin,
  );
  for (const t of ['users', 'projects', 'ai_connections', 'project_ai_limits', 'ai_spend_entries']) await pool.query(`ANALYZE ${t}`);
  log(`seeded in ${((Date.now() - started) / 1000).toFixed(1)} s`);
}

export interface AiBenchResult {
  calls: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  allMs: number[];
  metAim: boolean;
}

/** Seeds if needed, then times 500 reservations (all six scopes applying) after 20 warm-ups. */
export async function runAiBench(databaseUrl: string, log: (m: string) => void = console.log): Promise<AiBenchResult> {
  assertBenchDatabase(databaseUrl);
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  try {
    await seedAiBench(pool, log);
    const entries = (await pool.query(`SELECT count(*)::int AS n FROM ai_spend_entries`)).rows[0].n as number;
    const version = ((await pool.query(`SHOW server_version`)).rows[0].server_version as string).split(' ')[0];
    const inForce = (
      await pool.query(`SELECT count(*)::int AS n FROM project_ai_limits WHERE monthly_limit_micro_myr IS NOT NULL AND daily_mode = 'limit' AND user_monthly_mode = 'limit'`)
    ).rows[0].n as number;
    const org = (await pool.query(`SELECT daily_mode, user_monthly_mode, monthly_limit_micro_myr FROM ai_spend_settings WHERE id = 1`)).rows[0];
    if (inForce !== BENCH_PROJECTS || org?.daily_mode !== 'limit' || org?.user_monthly_mode !== 'limit' || org?.monthly_limit_micro_myr === null) {
      throw new Error('The bench needs every scope applying: organisation monthly, daily and per-person, and the same three for every project.');
    }
    log(`data: ${entries} spend entries, ${BENCH_PROJECTS} projects, ${BENCH_PEOPLE} people; six scopes apply to every reservation`);

    const projects = (
      await pool.query(
        `SELECT c.project_id, c.id AS connection_id, m.provider, m.model_id FROM ai_connections c JOIN ai_models m ON m.id = c.model_ref ORDER BY c.project_id`,
      )
    ).rows as Array<{ project_id: string; connection_id: string; provider: 'openai' | 'anthropic'; model_id: string }>;
    const people = (await pool.query(`SELECT id FROM users WHERE email <> 'bench-user-0@example.org' ORDER BY email`)).rows.map((r) => r.id as string);
    const spend = new SpendService(pool, () => new Date());
    const one = async (i: number): Promise<number> => {
      const p = projects[i % projects.length];
      const t0 = performance.now();
      const r = await spend.reserve({
        requestId: randomUUID(),
        attemptNo: 1,
        estimateMicroMyr: ESTIMATE,
        purpose: 'extraction',
        actorUserId: people[i % people.length],
        projectId: p.project_id,
        connectionId: p.connection_id,
        provider: p.provider,
        modelId: p.model_id,
        prices: { inputMicroUsdPerMillion: 2_000_000n, cachedInputMicroUsdPerMillion: 500_000n, cacheWriteMicroUsdPerMillion: 0n, outputMicroUsdPerMillion: 8_000_000n, myrPerUsdMicro: 4_100_000n },
      });
      const elapsed = performance.now() - t0;
      if (r.status !== 'reserved') throw new Error(`A reservation was refused (${JSON.stringify(r)}); the bench would be timing a refusal.`);
      return elapsed;
    };
    for (let i = 0; i < WARM_UPS; i++) await one(i);
    const allMs: number[] = [];
    for (let i = 0; i < CALLS; i++) allMs.push(await one(WARM_UPS + i));
    const result: AiBenchResult = {
      calls: CALLS,
      p50Ms: nearestRank(allMs, 0.5),
      p95Ms: nearestRank(allMs, 0.95),
      maxMs: Math.max(...allMs),
      allMs,
      metAim: nearestRank(allMs, 0.95) < AIM_P95_MS,
    };
    log('');
    log(`reserve, all six scopes applying (aim p95 < ${AIM_P95_MS} ms): n=${CALLS} after ${WARM_UPS} warm-ups, p50 ${ms(result.p50Ms)}, p95 ${ms(result.p95Ms)}, max ${ms(result.maxMs)} (nearest rank)`);
    log(result.metAim ? 'Aim met.' : `AIM MISSED: p95 ${ms(result.p95Ms)} is not under ${AIM_P95_MS} ms. Report it to the Product Owner; do not tune silently.`);
    log(`machine: ${cpus()[0]?.model.trim()} x${cpus().length}, ${(totalmem() / 2 ** 30).toFixed(0)} GiB memory, node ${process.version}, PostgreSQL ${version}, ${process.platform}`);
    return result;
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('Set DATABASE_URL to a migrated database whose name ends in _bench.');
    process.exit(1);
  }
  runAiBench(url).then(
    () => process.exit(0),
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
