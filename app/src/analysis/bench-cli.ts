import { randomBytes } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import type { INestApplication } from '@nestjs/common';
import { SpendService } from '../spend/spend.service';
import { SpendSettingsService } from '../spend/spend.settings';
import { MVP_SPEND_SETTINGS } from '../spend/mvp-settings';
import { createApp } from '../bootstrap';
import { loadConfig } from '../config';
import { NO_MEETING_END_HOOK } from '../discussion/meetings.service';
import { CaptureSender } from '../testing/fakes';
import type { AnalysisQueue } from './queue';
import { AnalysisTick } from './tick';

/**
 * Measured aims of sub-project 4a (spec 12) on seeded data: about 2,000 threads and 100,000 messages across 50 projects.
 *
 *   DATABASE_URL=postgres://.../kainow_bench npm run migrate && DATABASE_URL=... npm run bench-analysis
 *
 * The tool writes thousands of rows and deletes analysis runs, so it refuses any database whose name does not end in
 * `_test` or `_bench`. Everything is seeded with set-based SQL (generate_series) and deterministic ids (md5 of a label).
 */

const THREADS = 2000;
const PROJECTS = 50;
const USERS = 400;
const BIG_MEETINGS = [3, 13] as const; // 500 messages each: 3 is Project-wide, 13 is Restricted with named people

export function assertBenchDatabase(databaseUrl: string): string {
  let name = '';
  try {
    name = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, ''));
  } catch {
    // fall through to the refusal; the URL (and its password) is never echoed
  }
  if (!/_(test|bench)$/.test(name)) {
    throw new Error('Refusing to run: the bench writes and deletes data, so the database name must end in _test or _bench.');
  }
  return name;
}

const SENTENCES = [
  'We should confirm the delivery date with the vendor before we commit to the schedule.',
  'The budget for this phase is tight, so any extra scope needs to be agreed first.',
  'Saya setuju dengan cadangan itu, tetapi kita perlu semak semula kos bulan depan.',
  'Can someone check whether the test environment is ready for the next round of reviews?',
  'Let us move the review to Thursday so that everyone on the team can attend.',
  'Kita perlu hantar laporan kemajuan kepada pihak pengurusan sebelum akhir minggu ini.',
  'The risk with this approach is that the supplier may not meet the revised timeline.',
  'I have updated the draft plan and shared it in the project folder for comments.',
  'Tolong pastikan semua dokumen disemak oleh pasukan kewangan terlebih dahulu.',
  'We decided to go with the second option because it costs less and is easier to maintain.',
  'Does anyone know who is responsible for the training sessions in the second quarter?',
  'The numbers from last month look correct, but the totals for the regional offices still need checking.',
  'Mesyuarat minggu lepas tidak menyentuh isu keselamatan; mari kita bincangkan hari ini.',
  'Please send me the revised figures by Monday so I can include them in the summary.',
  'I think we are on track, although the approval step could still slow us down.',
  'Kami akan bertemu dengan pembekal pada hari Rabu untuk menyelesaikan perkara ini.',
  'The open question is whether the pilot should include all departments or only two.',
  'Thanks for the update; I will follow up with the finance team and report back here.',
  'Ada risiko bahawa jadual tidak dapat dipenuhi jika kelulusan lewat diterima.',
  'We agreed that the plan needs a clear owner for each remaining task before the next meeting.',
  'Let me check the previous notes and come back with the exact dates for the milestones.',
  'The new requirement came in late, so we should talk about its impact on the schedule.',
  'Saya akan semak status tugasan itu dan maklumkan kepada semua orang esok pagi.',
  'Good point; we should record that as a risk and review it again at the next checkpoint.',
];

const TOPICS = ['Budget review', 'Vendor selection', 'Release timing', 'Training plan', 'Risk register', 'Supplier contract', 'Pilot scope', 'Quarterly report', 'Site readiness', 'Staffing plan', 'Procurement steps', 'Handover checklist'];

function seedSql(now: Date): string[] {
  const NOW = `'${now.toISOString()}'::timestamptz`;
  const user = (expr: string) => `md5('bench-user-' || (${expr}))::uuid`;
  const member = (p: string, k: string) => `1 + (${p} * 8 + ${k}) % ${USERS}`;
  const sql: string[] = [];

  // People, organisation, departments, projects (mixed states), memberships.
  sql.push(`INSERT INTO users (id, email, display_name, role)
    SELECT ${user('i')}, 'bench-user-' || i || '@example.org', CASE WHEN i = 0 THEN 'Bench Administrator' ELSE 'Member ' || i END,
           CASE WHEN i = 0 THEN 'enterprise_administrator' ELSE 'member' END
      FROM generate_series(0, ${USERS}) i`);
  sql.push(`INSERT INTO organisation (id, name, registered_at, updated_at) VALUES (1, 'Example Organisation', now(), now())
    ON CONFLICT (id) DO NOTHING`);
  sql.push(`INSERT INTO departments (id, name, created_by, created_at)
    SELECT md5('bench-dept-' || d)::uuid, 'Department ' || d, ${user('0')}, ${NOW} FROM generate_series(0, 4) d`);
  sql.push(`INSERT INTO projects (id, name, purpose, owning_department_id, status, closure_outcome, created_by, created_at)
    SELECT md5('bench-project-' || p)::uuid, 'Project ' || p, 'Purpose of project ' || p, md5('bench-dept-' || (p % 5))::uuid,
           s.status, CASE WHEN s.status = 'closed' THEN 'delivered' END, ${user(member('p', '0'))}, ${NOW} - interval '90 days'
      FROM generate_series(0, ${PROJECTS - 1}) p
      CROSS JOIN LATERAL (SELECT CASE WHEN p < 38 THEN 'active' WHEN p < 42 THEN 'planned' WHEN p < 45 THEN 'draft'
                                      WHEN p < 48 THEN 'deferred' ELSE 'closed' END AS status) s`);
  sql.push(`INSERT INTO project_stage_periods (id, project_id, stage, started_at, started_by)
    SELECT md5('bench-stage-' || p)::uuid, md5('bench-project-' || p)::uuid, 'Initiation', ${NOW} - interval '90 days', ${user(member('p', '0'))}
      FROM generate_series(0, ${PROJECTS - 1}) p`);
  // Twelve people per project: PM, Owner, Deputy, Sponsor, eight members. One revoked and one expired in some projects.
  sql.push(`INSERT INTO memberships (id, project_id, user_id, role, starts_on, expires_on, revoked_at, revoked_by)
    SELECT md5('bench-mem-' || p || '-' || k)::uuid, md5('bench-project-' || p)::uuid, ${user(member('p', 'k'))},
           CASE k WHEN 0 THEN 'pm' WHEN 1 THEN 'owner' WHEN 2 THEN 'deputy_pm' WHEN 3 THEN 'sponsor' ELSE 'member' END,
           (${NOW})::date - 60,
           CASE WHEN k = 10 AND p % 7 = 0 THEN (${NOW})::date - 5 END,
           CASE WHEN k = 11 AND p % 5 = 0 THEN ${NOW} - interval '10 days' END,
           CASE WHEN k = 11 AND p % 5 = 0 THEN ${user(member('p', '0'))} END
      FROM generate_series(0, ${PROJECTS - 1}) p CROSS JOIN generate_series(0, 11) k`);

  sql.push(`CREATE TEMP TABLE bench_sentences (i int PRIMARY KEY, s text NOT NULL)`);
  sql.push(`INSERT INTO bench_sentences SELECT ord - 1, s FROM unnest(ARRAY[${SENTENCES.map((s) => `'${s.replace(/'/g, "''")}'`).join(', ')}]) WITH ORDINALITY AS u(s, ord)`);

  // One row per thread: kind, size, how far analysis has got, and when the last message came.
  // Groups (t % 7): 0,1,2,6 fully analysed; 3 has five new messages and has been quiet for an hour or more (due);
  // 4 has five new messages from two minutes ago (not due); 5 has five new messages but two automatic runs in the last 20 minutes (limit).
  sql.push(`CREATE TEMP TABLE bench_threads AS
    SELECT t, md5('bench-thread-' || t)::uuid AS id, p, md5('bench-project-' || p)::uuid AS project_id, kind, n, g,
           CASE WHEN g = 3 THEN ${NOW} - ((60 + t % 120) * interval '1 minute')
                WHEN g = 4 THEN ${NOW} - interval '2 minutes'
                WHEN g = 5 THEN ${NOW} - ((180 + t % 60) * interval '1 minute')
                ELSE ${NOW} - ((1 + t % 30) * interval '1 day') END AS last_at,
           CASE WHEN g IN (3, 4, 5) THEN n - 5 ELSE n END AS cov,
           CASE WHEN kind = 'meeting' THEN CASE WHEN (t / 10) % 2 = 0 AND t NOT IN (3, 13) THEN 'ended' ELSE 'open' END END AS state,
           kind = 'meeting' AND (t / 10) % 3 = 1 AS restricted
      FROM (SELECT t, t % ${PROJECTS} AS p, t % 7 AS g,
                   CASE WHEN t % 10 = 3 THEN 'meeting' ELSE 'discussion' END AS kind,
                   CASE WHEN t IN (${BIG_MEETINGS.join(', ')}) THEN 500 WHEN t % 10 = 3 THEN 40 + (t * 3) % 21 ELSE 30 + (t * 7) % 41 END AS n
              FROM generate_series(0, ${THREADS - 1}) t) x`);

  sql.push(`INSERT INTO audiences (id, project_id, mode, created_at)
    SELECT md5('bench-aud-' || t)::uuid, project_id, CASE WHEN restricted THEN 'restricted' ELSE 'project' END, last_at - n * interval '7 minutes' FROM bench_threads`);
  sql.push(`INSERT INTO audience_members (audience_id, user_id, added_by, added_at)
    SELECT md5('bench-aud-' || t)::uuid, ${user(member('p', 'k'))}, ${user(member('p', '0'))}, last_at - n * interval '7 minutes'
      FROM bench_threads CROSS JOIN unnest(ARRAY[2, 4, 5]) k WHERE restricted`);
  sql.push(`INSERT INTO discussion_threads (id, project_id, kind, title, audience_id, meeting_date, state, ended_by, ended_at, created_by, created_at, last_message_at, next_message_no)
    SELECT id, project_id, kind, (ARRAY[${TOPICS.map((s) => `'${s}'`).join(', ')}])[1 + t % ${TOPICS.length}] || ' (' || t || ')', md5('bench-aud-' || t)::uuid,
           CASE WHEN kind = 'meeting' THEN (last_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date END, state,
           CASE WHEN state = 'ended' THEN ${user(member('p', '0'))} END, CASE WHEN state = 'ended' THEN last_at END,
           ${user(member('p', '4'))}, last_at - n * interval '7 minutes', last_at, n + 1
      FROM bench_threads`);
  sql.push(`INSERT INTO meeting_attendees (thread_id, user_id, marked_by, marked_at)
    SELECT id, ${user(member('p', 'k'))}, ${user(member('p', '0'))}, last_at FROM bench_threads CROSS JOIN generate_series(0, 4) k WHERE kind = 'meeting'`);

  // Messages: a few sentences each, one in a hundred hidden, one in two hundred deleted.
  sql.push(`CREATE TEMP TABLE bench_msgs AS
    SELECT x.*, (SELECT string_agg(s.s, ' ' ORDER BY j.j) FROM generate_series(1, 2 + x.h % 3) AS j(j) JOIN bench_sentences s ON s.i = (x.h / j.j + j.j * 5) % ${SENTENCES.length}) AS body
      FROM (SELECT th.t, th.id AS thread_id, th.p, th.n, th.last_at, k, md5('bench-msg-' || th.t || '-' || k)::uuid AS id,
                   (hashtext(th.t::text || ':' || k::text) & 2147483647) AS h
              FROM bench_threads th CROSS JOIN LATERAL generate_series(1, th.n) k) x`);
  sql.push(`CREATE INDEX ON bench_msgs (id)`);
  sql.push(`INSERT INTO discussion_messages (id, thread_id, message_no, author_id, state, state_reason, state_by, state_at, created_at)
    SELECT id, thread_id, k, ${user(`1 + (p * 8 + h % 10) % ${USERS}`)},
           CASE WHEN h % 100 = 0 THEN 'hidden' WHEN h % 200 = 1 THEN 'deleted' ELSE 'visible' END,
           CASE WHEN h % 100 = 0 THEN 'Posted in the wrong place' WHEN h % 200 = 1 THEN 'Posted in error' END,
           CASE WHEN h % 100 = 0 OR h % 200 = 1 THEN ${user(member('p', '0'))} END,
           CASE WHEN h % 100 = 0 OR h % 200 = 1 THEN least(last_at - (n - k) * interval '7 minutes' + interval '1 hour', ${NOW}) END,
           last_at - (n - k) * interval '7 minutes'
      FROM bench_msgs`);
  sql.push(`UPDATE discussion_messages m SET reply_to_id = prev.id
      FROM bench_msgs b, discussion_messages prev
     WHERE b.id = m.id AND b.h % 20 = 0 AND b.k > 1 AND prev.thread_id = m.thread_id AND prev.message_no = m.message_no - 1`);
  const version = (no: number, filter: string, suffix: string) => `INSERT INTO message_versions (id, message_id, version_no, body, body_sha256, created_at)
    SELECT md5('bench-ver-' || id || '-${no}')::uuid, id, ${no}, body || '${suffix}', encode(sha256(convert_to(body || '${suffix}', 'UTF8')), 'hex'),
           last_at - (n - k) * interval '7 minutes' + ${no === 1 ? "interval '0'" : "interval '5 minutes'"}
      FROM bench_msgs WHERE ${filter}`;
  sql.push(version(1, 'true', ''));
  sql.push(version(2, 'h % 30 = 2', ' Edited to add the confirmed date.'));
  sql.push(`INSERT INTO message_versions (id, message_id, version_no, body, body_sha256, created_at)
    SELECT md5('bench-ver-' || id || '-3')::uuid, id, 3, body || ' Edited to add the confirmed date. Corrected the name.', encode(sha256(convert_to(body || ' Edited to add the confirmed date. Corrected the name.', 'UTF8')), 'hex'),
           last_at - (n - k) * interval '7 minutes' + interval '9 minutes'
      FROM bench_msgs WHERE h % 300 = 5 AND h % 30 = 2`);
  sql.push(`INSERT INTO discussion_events (id, thread_id, message_id, actor_id, action, detail, at)
    SELECT md5('bench-ev-' || m.id)::uuid, m.thread_id, m.id, m.author_id, 'posted',
           jsonb_build_object('length', char_length(b.body), 'sha256', encode(sha256(convert_to(b.body, 'UTF8')), 'hex')), m.created_at
      FROM discussion_messages m JOIN bench_msgs b ON b.id = m.id`);

  // Analysis runs and minutes drafts (the facts query reads both). Meetings carry minutes runs, discussions proposals runs.
  sql.push(`CREATE TEMP TABLE bench_runs AS
    SELECT th.t, 1 AS j, th.id AS thread_id, th.kind, th.p, 'quiet_period'::text AS trigger, 'succeeded'::text AS status,
           CASE WHEN th.g = 5 THEN th.cov - 5 ELSE th.cov END AS cov_through,
           CASE WHEN th.g IN (3, 4) THEN th.last_at - interval '40 minutes' WHEN th.g = 5 THEN ${NOW} - interval '12 minutes' ELSE th.last_at + interval '6 minutes' END AS created_at
      FROM bench_threads th
    UNION ALL
    SELECT th.t, 2, th.id, th.kind, th.p, 'quiet_period', 'succeeded', th.cov, ${NOW} - interval '5 minutes' FROM bench_threads th WHERE th.g = 5`);
  sql.push(`INSERT INTO analysis_runs (id, thread_id, kind, trigger, requested_by, status, covers_from_no, covers_through_no, repeated_count, created_at, started_at, finished_at)
    SELECT md5('bench-run-' || t || '-' || j)::uuid, thread_id, CASE WHEN kind = 'meeting' THEN 'minutes' ELSE 'proposals' END, trigger, NULL, status,
           1, cov_through, 0, created_at, created_at + interval '5 seconds', created_at + interval '40 seconds'
      FROM bench_runs`);
  sql.push(`INSERT INTO analysis_runs (id, thread_id, kind, trigger, requested_by, status, failure_code, failure_detail, covers_from_no, covers_through_no, created_at, started_at, finished_at)
    SELECT md5('bench-failed-' || t)::uuid, id, CASE WHEN kind = 'meeting' THEN 'minutes' ELSE 'proposals' END, 'button', ${user(member('p', '4'))}, 'failed',
           'timeout', 'The AI did not answer in time; try again.', 1, 5, last_at - interval '3 days', last_at - interval '3 days', last_at - interval '3 days' + interval '2 minutes'
      FROM bench_threads WHERE t % 53 = 0`);
  sql.push(`INSERT INTO minutes_drafts (id, thread_id, version_no, origin, body, covers_through_no, analysis_run_id, created_by, created_at)
    SELECT md5('bench-draft-' || t || '-' || j)::uuid, thread_id, j, 'ai',
           '# ' || (ARRAY[${TOPICS.map((s) => `'${s}'`).join(', ')}])[1 + t % ${TOPICS.length}] || E'\\nDate: 11 November 2026\\nPresent: Member 1, Member 2\\nDrafted by AI from messages #1-#' || cov_through
           || E'\\n\\n## Summary\\n' || (SELECT s FROM bench_sentences WHERE i = t % ${SENTENCES.length}) || E'\\n\\n## Decisions\\n- ' || (SELECT s FROM bench_sentences WHERE i = (t + 9) % ${SENTENCES.length})
           || E'\\n\\n## Action items\\n- ' || (SELECT s FROM bench_sentences WHERE i = (t + 13) % ${SENTENCES.length}) || E' — Owner: not stated; Due: not stated\\n\\n## Risks\\n- ' || (SELECT s FROM bench_sentences WHERE i = (t + 6) % ${SENTENCES.length}) || E'\\n',
           cov_through, md5('bench-run-' || t || '-' || j)::uuid, NULL, created_at + interval '40 seconds'
      FROM bench_runs WHERE kind = 'meeting'`);
  // Every seventh ended or open meeting also has a version a person edited (automatic minutes then pause).
  sql.push(`INSERT INTO minutes_drafts (id, thread_id, version_no, origin, body, covers_through_no, edited_from_id, created_by, created_at)
    SELECT md5('bench-human-' || d.thread_id)::uuid, d.thread_id, 2, 'human', d.body || E'\\n- Edited by a person.', d.covers_through_no, d.id, ${user(member('b.p', '0'))}, d.created_at + interval '1 hour'
      FROM minutes_drafts d JOIN bench_threads b ON b.id = d.thread_id
     WHERE d.version_no = (SELECT max(version_no) FROM minutes_drafts WHERE thread_id = d.thread_id) AND (b.t / 10) % 7 = 0 AND b.g IN (0, 1, 2, 6) AND b.t NOT IN (3, 13)`);
  sql.push(`UPDATE analysis_runs r SET minutes_draft_id = d.id FROM minutes_drafts d WHERE d.analysis_run_id = r.id`);
  return sql;
}

/** Seeds the realistic data set into an empty, migrated bench database. Returns the instant "now" for the tick. */
export async function seedBench(pool: Pool, log: (m: string) => void = console.log): Promise<Date> {
  const name = (await pool.query(`SELECT current_database() AS name`)).rows[0].name as string;
  assertBenchDatabase(`postgres://x/${name}`);
  await pool.query(`CREATE TABLE IF NOT EXISTS bench_meta (key text PRIMARY KEY, value text NOT NULL)`);
  const prior = await pool.query(`SELECT value FROM bench_meta WHERE key = 'seeded_at'`);
  if (prior.rows[0]) {
    log(`already seeded at ${prior.rows[0].value}; measuring what is there (drop and recreate the database for a clean run)`);
    return new Date(prior.rows[0].value as string);
  }
  if ((await pool.query(`SELECT count(*)::int AS n FROM users`)).rows[0].n > 0) throw new Error('The database already holds users; use an empty migrated database.');
  const now = new Date();
  now.setMilliseconds(0);
  const started = Date.now();
  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const statement of seedSql(now)) await client.query(statement);
    await client.query(`INSERT INTO bench_meta (key, value) VALUES ('seeded_at', $1)`, [now.toISOString()]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  await new SpendSettingsService(pool, () => now).apply(MVP_SPEND_SETTINGS, (await pool.query(`SELECT id FROM users WHERE email = 'bench-user-0@example.org'`)).rows[0].id);
  for (const t of ['users', 'memberships', 'discussion_threads', 'discussion_messages', 'message_versions', 'discussion_events', 'analysis_runs', 'minutes_drafts', 'audiences', 'audience_members']) {
    await pool.query(`ANALYZE ${t}`);
  }
  log(`seeded in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  return now;
}

/** Median; for an even count, the mean of the two middle values. */
const median = (xs: number[]): number => {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = sorted.length / 2;
  return sorted.length % 2 ? sorted[Math.floor(mid)] : (sorted[mid - 1] + sorted[mid]) / 2;
};
/** Nearest-rank percentile. */
const percentile = (xs: number[], q: number): number => [...xs].sort((a, b) => a - b)[Math.ceil(q * xs.length) - 1];
const ms = (n: number): string => `${n.toFixed(1)} ms`;
const timed = async <T>(work: () => Promise<T>): Promise<[number, T]> => {
  const t0 = performance.now();
  const value = await work();
  return [performance.now() - t0, value];
};

export interface BenchResult {
  counts: Record<string, number>;
  tick: { medianMs: number; allMs: number[]; started: number[]; candidates: number; idleMedianMs: number };
  post: { n: number; p50Ms: number; p95Ms: number; maxMs: number };
  open: Array<{ label: string; medianMs: number; allMs: number[]; bytes: number; messages: number }>;
}

async function measureTick(pool: Pool, now: Date): Promise<BenchResult['tick']> {
  const queue: AnalysisQueue = { enqueue: async () => undefined };
  const tick = new AnalysisTick({ pool, clock: () => now, queue, spend: new SpendService(pool, () => now), log: () => undefined });
  const { loadThreadFacts } = await import('./facts');
  const candidates = (await loadThreadFacts(pool, now)).length;
  // Runs queued by a tick are deleted again after every iteration, so each one starts from the same state and does the same work.
  // The seed holds no queued or running runs, so every queued row belongs to the iteration that just ran.
  const reset = () => pool.query(`DELETE FROM analysis_runs WHERE status = 'queued'`);
  await tick.run(); // warm-up (plans, caches), not counted
  await reset();
  const allMs: number[] = [];
  const started: number[] = [];
  for (let i = 0; i < 10; i++) {
    const [took, result] = await timed(() => tick.run());
    allMs.push(took);
    started.push(result.started);
    await reset();
  }
  // Steady state: the runs just started stay in place (a thread with a queued run is not due), so a tick that starts nothing
  // measures the per-minute cost of reading the facts and judging every candidate.
  await tick.run();
  const idle: number[] = [];
  for (let i = 0; i < 10; i++) idle.push((await timed(() => tick.run()))[0]);
  await reset();
  return { medianMs: median(allMs), allMs, started, candidates, idleMedianMs: median(idle) };
}

interface Session {
  request(method: string, path: string, body?: unknown): Promise<{ status: number; text: string }>;
}

async function startApp(databaseUrl: string): Promise<{ app: INestApplication; base: string; signIn: (email: string) => Promise<Session> }> {
  const sender = new CaptureSender();
  const config = loadConfig({
    DATABASE_URL: databaseUrl,
    AUTH_SECRET: randomBytes(32).toString('hex'),
    LOG_SIGN_IN_CODES: 'true',
    COOKIE_SECURE: 'false',
  });
  const app = await createApp(config, {
    codeSender: sender,
    logger: false,
    extractionQueue: { enqueue: async () => undefined },
    emailNudge: { nudge: async () => undefined },
    meetingEndHook: NO_MEETING_END_HOOK,
    analysisQueue: { enqueue: async () => undefined },
  });
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  const signIn = async (email: string): Promise<Session> => {
    await fetch(`${base}/auth/request-code`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
    const res = await fetch(`${base}/auth/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, code: sender.lastCode(email) }) });
    if (res.status !== 200) throw new Error(`Sign-in failed for ${email}: ${res.status}`);
    const cookie = (res.headers.getSetCookie()[0] ?? '').split(';')[0];
    const { csrfToken } = (await res.json()) as { csrfToken: string };
    return {
      request: async (method, path, body) => {
        const r = await fetch(`${base}${path}`, {
          method,
          headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), Cookie: cookie, 'X-CSRF-Token': csrfToken },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        return { status: r.status, text: await r.text() };
      },
    };
  };
  return { app, base, signIn };
}

const threadId = (t: number): string => `SELECT md5('bench-thread-${t}')::uuid AS id`;

async function measureHttp(pool: Pool, databaseUrl: string): Promise<Pick<BenchResult, 'post' | 'open'>> {
  const { app, signIn } = await startApp(databaseUrl);
  try {
    const idOf = async (t: number) => (await pool.query(threadId(t))).rows[0].id as string;
    const emailOf = (n: number) => `bench-user-${n}@example.org`;
    // Project p's member k is user 1 + (p * 8 + k) % 400. Project 0: poster is member 4 (user 5). Project 3: PM user 25, member user 29.
    // Project 13: member 4 is user 109 and is one of the named people of the Restricted meeting 13.
    const [poster, pm3, member3, member13] = await Promise.all([5, 25, 29, 109].map((n) => signIn(emailOf(n))));

    const threads = await Promise.all([0, 50, 100, 150, 200, 250, 300, 350, 400, 450].map(idOf)); // discussions of project 0 (active, Project-wide)
    const post = async (i: number) => {
      const body = `${['Update number', 'Following up on item', 'Noted, and a question on point'][i % 3]} ${i}: we should confirm the delivery date with the vendor before committing, and Saya akan semak status tugasan itu esok pagi.`;
      const [took, r] = await timed(() => poster.request('POST', `/threads/${threads[i % threads.length]}/messages`, { body }));
      if (r.status !== 201) throw new Error(`Posting failed with ${r.status}: ${r.text.slice(0, 200)}`);
      return took;
    };
    for (let i = 0; i < 5; i++) await post(i); // warm-up, not counted
    const times: number[] = [];
    for (let i = 0; i < 200; i++) times.push(await post(5 + i));

    const open = async (label: string, who: Session, t: number) => {
      const id = await idOf(t);
      const first = await who.request('GET', `/threads/${id}`);
      if (first.status !== 200) throw new Error(`Opening ${label} failed with ${first.status}`);
      const messages = (JSON.parse(first.text) as { messages: unknown[] }).messages.length;
      const allMs: number[] = [];
      for (let i = 0; i < 10; i++) allMs.push((await timed(() => who.request('GET', `/threads/${id}`)))[0]);
      return { label, medianMs: median(allMs), allMs, bytes: Buffer.byteLength(first.text), messages };
    };
    return {
      post: { n: times.length, p50Ms: percentile(times, 0.5), p95Ms: percentile(times, 0.95), maxMs: Math.max(...times) },
      open: [
        await open('500-message meeting, Project-wide audience, viewer is a member (not PM)', member3, 3),
        await open('500-message meeting, Restricted to named people, viewer is a named member (not PM)', member13, 13),
        await open('500-message meeting, Project-wide audience, viewer is the PM', pm3, 3),
      ],
    };
  } finally {
    await app.close();
  }
}

export async function runBench(databaseUrl: string, log: (m: string) => void = console.log): Promise<BenchResult> {
  assertBenchDatabase(databaseUrl);
  const pool = new Pool({ connectionString: databaseUrl, max: 10 });
  try {
    const now = await seedBench(pool, log);
    const counts: Record<string, number> = {};
    for (const [label, table] of [['users', 'users'], ['projects', 'projects'], ['threads', 'discussion_threads'], ['messages', 'discussion_messages'], ['message versions', 'message_versions'], ['analysis runs', 'analysis_runs'], ['minutes drafts', 'minutes_drafts']]) {
      counts[label] = (await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
    }
    log(`data: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}`);
    const tick = await measureTick(pool, now);
    const http = await measureHttp(pool, databaseUrl);
    const result: BenchResult = { counts, tick, ...http };
    log('');
    log(`analysis tick (aim < 1000 ms): median ${ms(tick.medianMs)} of 10 (${tick.allMs.map((x) => x.toFixed(0)).join(', ')} ms); ${tick.candidates} threads with unanalysed messages; started per run: ${tick.started.join(', ')}; idle tick (nothing newly due, runs from the previous tick still queued): median ${ms(tick.idleMedianMs)} of 10`);
    log(`post a message (aim p95 < 300 ms): n=${http.post.n}, p50 ${ms(http.post.p50Ms)}, p95 ${ms(http.post.p95Ms)}, max ${ms(http.post.maxMs)}`);
    for (const o of http.open) log(`open (aim < 1000 ms): ${o.label}: median ${ms(o.medianMs)} of 10 (${o.allMs.map((x) => x.toFixed(0)).join(', ')} ms); ${o.messages} messages, ${(o.bytes / 1024).toFixed(0)} KB`);
    return result;
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('Set DATABASE_URL to a migrated database whose name ends in _bench or _test.');
    process.exit(1);
  }
  runBench(url).then(
    () => process.exit(0),
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
