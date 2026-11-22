import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { cpus, release, totalmem, type } from 'node:os';
import type { Pool } from 'pg';
import { loadProtectedKey } from '../quarantine/protected-key';
import { idleSlotWaitMs, startFakeAi } from './fake-ai';
import { type ExtractionAsked, JOURNEYS, type JourneyContext, type JourneyName, RUN, mulberry32, pickJourney } from './journeys';
import { type Machine, type RunResult, type Sample, type WorkerLag, aims, percentile, writeReport } from './report';
import { ADMIN_EMAIL, assertLoadDatabase, loadEmail, seedLoad } from './seed';
import { type Session, signIn } from './sessions';

/**
 * The load test (10b spec 13): `--seed` fills an empty test database; a run drives N virtual people through the weighted
 * journeys against a running test installation (API and worker), then waits for the AI and email work the run produced
 * and writes the report.
 */

export interface LoadOptions {
  base: string;
  users: number;
  minutes: number;
  thinkMs: [number, number];
  /** Journey seed: person i uses seed + i. */
  seed?: number;
  /** The test installation's database (checks, AI and email results, database figures). */
  pool: Pool;
  /** The API's log so far (sign-in codes are read from it). */
  readApiLog: () => string;
  /** Where the fake AI provider listens; the worker's KAINOW_LOAD_TEST_AI_URL points here. */
  aiPort: number;
  /** How long to wait after the run for the AI and email work it produced (default 6 minutes). */
  drainMs?: number;
  log?: (m: string) => void;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function runLoad(opts: LoadOptions): Promise<RunResult> {
  const log = opts.log ?? (() => undefined);
  const pool = opts.pool;
  const seed = opts.seed ?? 1;
  await assertLoadDatabase(pool);
  const notes: string[] = [];
  const fake = await startFakeAi({ port: opts.aiPort });
  const sampler: { timer?: NodeJS.Timeout } = {};
  try {
    const slots = (await pool.query(`SELECT concurrency FROM ai_spend_settings LIMIT 1`)).rows[0]?.concurrency ?? 2;
    const sizeBefore = Number((await pool.query(`SELECT pg_database_size(current_database()) AS n`)).rows[0].n);

    const sessions: Session[] = [];
    for (let i = 1; i <= opts.users; i++) sessions.push(await signIn(opts.base, loadEmail(i), opts.readApiLog));
    const admin = sessions.find((s) => s.email === ADMIN_EMAIL && s.role === 'enterprise_administrator');
    if (!admin) throw new Error(`${ADMIN_EMAIL} must be among the virtual people and be the Enterprise Administrator.`);
    log(`${sessions.length} people signed in through request-code and verify`);

    let maxConnections = 0;
    let maxActive = 0;
    const sample = async () => {
      try {
        const r = (await pool.query(`SELECT count(*)::int AS open, count(*) FILTER (WHERE state <> 'idle')::int AS active FROM pg_stat_activity WHERE datname = current_database()`)).rows[0];
        maxConnections = Math.max(maxConnections, r.open);
        maxActive = Math.max(maxActive, r.active);
      } catch {
        // a missed sample is not a result
      }
    };
    sampler.timer = setInterval(() => void sample(), 5000);

    const samples: Sample[] = [];
    const extractions: ExtractionAsked[] = [];
    const journeys = Object.fromEntries(JOURNEYS.map((j) => [j, 0])) as Record<JourneyName, number>;
    const startedAt = new Date();
    const deadline = startedAt.getTime() + opts.minutes * 60_000;
    const [thinkMin, thinkMax] = opts.thinkMs;
    let done = 0;
    const person = async (me: Session, i: number) => {
      const rng = mulberry32(seed + i);
      const ctx: JourneyContext = { me, admin, rng, record: (s) => samples.push(s), extractions };
      await sleep(rng() * thinkMax);
      while (Date.now() < deadline) {
        const j = pickJourney(rng);
        journeys[j]++;
        try {
          await RUN[j](ctx);
        } catch {
          samples.push({ journey: j, label: `${j} journey stopped`, method: 'GET', status: 0, ms: 0, outcome: 'error', untimed: true });
        }
        done++;
        await sleep(thinkMin + rng() * (thinkMax - thinkMin));
      }
    };
    const progress = setInterval(() => log(`${Math.round((Date.now() - startedAt.getTime()) / 60_000)} min: ${done} journeys, ${samples.length} requests, ${samples.filter((s) => s.outcome === 'error').length} errors`), 60_000);
    try {
      await Promise.all(sessions.map((s, i) => person(s, i)));
    } finally {
      clearInterval(progress);
    }
    const endedAt = new Date();
    log(`run ended: ${done} journeys, ${samples.length} requests; waiting for the AI and email work it produced`);

    // Drain: every requested extraction finished, and no email of the run still waiting to go.
    const sourceIds = extractions.map((e) => e.sourceId);
    const drainUntil = Date.now() + (opts.drainMs ?? 6 * 60_000);
    for (;;) {
      const openRuns = (
        await pool.query(
          `SELECT count(*)::int AS n FROM extraction_runs r JOIN source_versions v ON v.id = r.source_version_id
            WHERE v.source_id = ANY($1::uuid[]) AND r.status IN ('queued', 'running')`,
          [sourceIds],
        )
      ).rows[0].n;
      const openMail = (await pool.query(`SELECT count(*)::int AS n FROM email_outbox WHERE created_at >= $1 AND status IN ('queued', 'sending', 'retry_wait')`, [startedAt])).rows[0].n;
      if ((openRuns === 0 && openMail === 0) || Date.now() > drainUntil) break;
      await sleep(5000);
    }
    await sample();

    // AI: each request against the fake provider's own record of its calls.
    const runs = (
      await pool.query(
        `SELECT DISTINCT ON (v.source_id) v.source_id AS "sourceId", r.status FROM extraction_runs r JOIN source_versions v ON v.id = r.source_version_id
          WHERE v.source_id = ANY($1::uuid[]) ORDER BY v.source_id, r.created_at DESC, r.id`,
        [sourceIds],
      )
    ).rows as { sourceId: string; status: string }[];
    const statusOf = new Map(runs.map((r) => [r.sourceId, r.status]));
    const queueWaitMs: number[] = [];
    const runMs: number[] = [];
    let maxIdle = 0;
    for (const e of extractions) {
      const first = fake.calls.find((c) => c.marker === e.marker);
      if (!first) continue;
      queueWaitMs.push(first.startedAt - e.requestedAt);
      if (first.endedAt !== null) runMs.push(first.endedAt - first.startedAt);
      maxIdle = Math.max(maxIdle, idleSlotWaitMs(e.requestedAt, first.startedAt, fake.calls, slots));
    }
    const statuses = extractions.map((e) => statusOf.get(e.sourceId) ?? 'missing');
    const ai = {
      requested: extractions.length,
      succeeded: statuses.filter((s) => s === 'succeeded').length,
      failed: statuses.filter((s) => s === 'failed' || s === 'blocked').length,
      notFinished: statuses.filter((s) => s === 'queued' || s === 'running' || s === 'missing').length,
      queueWaitMs,
      runMs,
      slots,
      maxInFlight: fake.maxInFlight(),
      maxIdleSlotWaitMs: maxIdle,
    };
    if (fake.calls.some((c) => c.marker === null)) notes.push(`The fake provider received ${fake.calls.filter((c) => c.marker === null).length} calls not from the extraction journey.`);

    // Email: everything the run produced (created since the start), from the outbox.
    const mail = (await pool.query(`SELECT status, created_at, sent_at FROM email_outbox WHERE created_at >= $1`, [startedAt])).rows as { status: string; created_at: Date; sent_at: Date | null }[];
    const cancelled = mail.filter((m) => m.status === 'cancelled').length;
    if (cancelled) notes.push(`${cancelled} emails of the run were cancelled by the app (not counted as produced).`);
    const live = mail.filter((m) => m.status !== 'cancelled');
    const email = {
      produced: live.length,
      sent: live.filter((m) => m.status === 'sent').length,
      notSent: live.filter((m) => m.status !== 'sent').length,
      sendDelayMs: live.filter((m) => m.sent_at).map((m) => (m.sent_at as Date).getTime() - m.created_at.getTime()),
    };

    const sizeAfter = Number((await pool.query(`SELECT pg_database_size(current_database()) AS n`)).rows[0].n);
    let slowest: RunResult['db']['slowest'] = null;
    let slowestNote = 'not available';
    try {
      slowest = (
        await pool.query(
          `SELECT query, calls::int AS calls, mean_exec_time AS "meanMs" FROM pg_stat_statements
            WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database()) ORDER BY mean_exec_time DESC, queryid LIMIT 10`,
        )
      ).rows;
    } catch {
      slowestNote = 'not available (pg_stat_statements is not loaded on this database server)';
    }

    let worker: WorkerLag[] = [];
    try {
      const jobs = (
        await pool.query(
          `SELECT name, extract(epoch FROM (started_on - greatest(created_on, start_after))) * 1000 AS lag
             FROM pgboss.job WHERE created_on >= $1 AND started_on IS NOT NULL`,
          [startedAt],
        )
      ).rows as { name: string; lag: string }[];
      const by = new Map<string, number[]>();
      for (const j of jobs) by.set(j.name, [...(by.get(j.name) ?? []), Math.max(0, Number(j.lag))]);
      worker = [...by.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([queue, lags]) => ({ queue, jobs: lags.length, p95LagMs: percentile(lags, 0.95), maxLagMs: Math.max(...lags) }));
    } catch {
      notes.push('Worker lag: the pg-boss job table could not be read.');
    }

    return {
      params: { base: opts.base, users: opts.users, minutes: opts.minutes, thinkMs: opts.thinkMs, seed },
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      journeys,
      samples,
      ai,
      email,
      db: { maxConnections, maxActive, sizeBeforeBytes: sizeBefore, sizeAfterBytes: sizeAfter, slowest, slowestNote },
      worker,
      notes,
    };
  } finally {
    if (sampler.timer) clearInterval(sampler.timer);
    await fake.close();
  }
}

/** What the machine is, as far as Node and Docker can tell; the disk is given on the command line. */
export function describeMachine(label: string, disk: string, database: string): Machine {
  let docker = 'not found';
  try {
    docker = `Docker ${execFileSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8', timeout: 10_000 }).trim()}`;
  } catch {
    // not installed or not running
  }
  return {
    label,
    os: `${type()} ${release()}`,
    cpu: cpus()[0]?.model?.trim() ?? 'unknown',
    cores: cpus().length,
    memoryGb: Math.round(totalmem() / 1024 ** 3),
    disk,
    docker,
    node: process.version,
    database,
  };
}

export interface CliDeps {
  pool: Pool;
  env: Record<string, string | undefined>;
  out(line: string): void;
  err(line: string): void;
  now(): Date;
}

const USAGE = [
  'Usage:',
  '  npm run load-test -- --seed                      (DATABASE_URL: an empty migrated test database; KAINOW_PROTECTED_KEY_FILE: the installation key)',
  '  npm run load-test -- --users 10 --minutes 30 --api-log <file> [--think 5-20] [--base http://127.0.0.1:3310] [--ai-port 3311]',
  '                       [--out load-test-<date>.md] [--machine "<name>"] [--disk "<disk>"] [--journey-seed 1]',
].join('\n');

function args(argv: string[]): Map<string, string | true> | null {
  const out = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) return null;
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out.set(a.slice(2), next);
      i++;
    } else out.set(a.slice(2), true);
  }
  return out;
}

const KNOWN = new Set(['seed', 'users', 'minutes', 'think', 'base', 'ai-port', 'api-log', 'out', 'machine', 'disk', 'journey-seed']);

/** Exit 0 when seeded, or when the run met every aim; 1 when refused, failed or an aim was missed; 2 for usage. */
export async function runLoadTest(argv: string[], deps: CliDeps): Promise<number> {
  const a = args(argv);
  if (!a || [...a.keys()].some((k) => !KNOWN.has(k))) {
    deps.err(USAGE);
    return 2;
  }
  if (a.has('seed')) {
    if (a.size > 1) {
      deps.err(USAGE);
      return 2;
    }
    const key = loadProtectedKey(deps.env.KAINOW_PROTECTED_KEY_FILE?.trim() || null, (m) => deps.err(m));
    if (!key) deps.err('No protected key (KAINOW_PROTECTED_KEY_FILE): the AI connections get no key and every extraction will end blocked.');
    try {
      const s = await seedLoad(deps.pool, { people: 200, projects: 40, protectedKey: key, log: deps.out });
      deps.out(
        `Seeded in ${s.seconds} s: ${s.people} people, ${s.projects} projects, ${s.departments} departments, ${s.tasks} tasks, ${s.decisions} decisions, ${s.risks} risks, ` +
          `${s.pendingProposals} proposals waiting, ${s.notes} notes (${s.noteVersions} versions), ${s.threads} threads, ${s.messages} messages.`,
      );
      return 0;
    } catch (err) {
      deps.err(err instanceof Error ? err.message : 'The seed failed.');
      return 1;
    }
  }
  const int = (name: string, dflt: number) => {
    const v = a.get(name);
    if (v === undefined) return dflt;
    return typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN;
  };
  const users = int('users', 10);
  const minutes = int('minutes', 30);
  const aiPort = int('ai-port', 3311);
  const journeySeed = int('journey-seed', 1);
  const think = String(a.get('think') ?? '5-20').match(/^(\d+)-(\d+)s?$/);
  const apiLog = a.get('api-log');
  if (![users, minutes, aiPort, journeySeed].every((x) => Number.isInteger(x) && x > 0) || !think || Number(think[1]) > Number(think[2]) || typeof apiLog !== 'string') {
    deps.err(USAGE);
    return 2;
  }
  const base = String(a.get('base') ?? 'http://127.0.0.1:3310').replace(/\/+$/, '');
  try {
    const result = await runLoad({
      base,
      users,
      minutes,
      thinkMs: [Number(think[1]) * 1000, Number(think[2]) * 1000],
      seed: journeySeed,
      pool: deps.pool,
      readApiLog: () => readFileSync(apiLog, 'utf8'),
      aiPort,
      log: deps.out,
    });
    const version = (await deps.pool.query(`SELECT current_setting('server_version') AS v`)).rows[0].v as string;
    const machine = describeMachine(String(a.get('machine') ?? 'this machine'), String(a.get('disk') ?? 'not recorded'), `PostgreSQL ${version}`);
    const md = writeReport(result, machine);
    const out = String(a.get('out') ?? `load-test-${deps.now().toISOString().slice(0, 10)}.md`);
    writeFileSync(out, md);
    writeFileSync(out.replace(/\.md$/, '') + '.json', JSON.stringify({ ...result, samples: undefined, sampleCount: result.samples.length }, null, 2));
    const rows = aims(result);
    for (const r of rows) deps.out(`${r.met ? 'met   ' : 'MISSED'} ${r.aim}: ${r.measured}`);
    deps.out(`Report written to ${out}`);
    return rows.every((r) => r.met) ? 0 : 1;
  } catch (err) {
    deps.err(err instanceof Error ? err.message : 'The load test failed.');
    return 1;
  }
}
