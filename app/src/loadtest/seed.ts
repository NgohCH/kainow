import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { createApp } from '../bootstrap';
import { loadConfig } from '../config';
import { NO_MEETING_END_HOOK } from '../discussion/meetings.service';
import type { ProtectedKey } from '../quarantine/protected-key';
import { parseMicro } from '../spend/money';
import { MVP_SPEND_SETTINGS } from '../spend/mvp-settings';
import { SpendSettingsService } from '../spend/spend.settings';
import { KEY_A, seedAiConnection, seedAiModel, seedProjectAllowance } from '../testing/ai-connections';
import { CaptureSender } from '../testing/fakes';
import { ADMIN_EMAIL, LOAD_DOMAIN, LOAD_ORGANISATION } from './guard';
import { GENERAL_TEMPLATE_ID } from '../projects/stage-templates';

export { ADMIN_EMAIL, LOAD_DOMAIN, LOAD_ORGANISATION, assertLoadDatabase } from './guard';

/**
 * The load-test data set (10b spec 13.1 step 1), seeded into an empty migrated test database:
 *
 * - "Example Organisation" (example.org); people load-001@example.org … load-200@example.org, all Active. load-001 is the
 *   Enterprise Administrator. The first ten are the virtual people of a run: load-00N is Project Manager of every project
 *   p with p % 10 = N - 1, Owner of every project with (p + 5) % 10 = N - 1 (proposals are reviewed by the Owner or a
 *   Sponsor), and a Member of four others.
 * - 5 departments; 40 Active projects, each with a PM, an Owner, a Sponsor (load-011…load-050) and 4–12 Members (one
 *   virtual person and the rest from load-051…load-200).
 * - 75 tasks per project (3,000), 10 decisions and 10 risks per project from approved proposals, 40 proposals per
 *   project waiting for review, and 30 days of history (transitions, task events, review times).
 * - 300 notes (half with a second version) and 3 discussion threads per project with 4 messages each, written through the
 *   real HTTP routes of an in-process app, so every side table (audiences, search, history) is as the app makes it.
 * - AI: one approved catalogue model and a connection on every project. Its key is sealed with the installation's
 *   protected key when one is given; the worker of a load-test installation sends the calls to the local fake provider
 *   (fake-ai.ts). Automatic discussion analysis is turned off so the only AI work is the extraction journey.
 *
 * Deterministic ids (md5 of a label) for the set-based part, so the seed is repeatable. All names are dummy.
 */

export const VIRTUAL_PEOPLE = 10;
export const loadEmail = (i: number): string => `load-${String(i).padStart(3, '0')}@${LOAD_DOMAIN}`;

const DEPARTMENTS = ['Operations', 'Finance', 'Facilities', 'Research', 'Communications'];
const TASKS_PER_PROJECT = 75;
const DECISIONS_PER_PROJECT = 10;
const RISKS_PER_PROJECT = 10;
const PENDING_PER_PROJECT = 40;
const NOTES = 300;
const THREADS_PER_PROJECT = 3;
const MESSAGES_PER_THREAD = 4;
export const FAKE_MODEL_ID = 'load-test-fake-model';

export interface SeedSummary {
  people: number;
  projects: number;
  departments: number;
  tasks: number;
  decisions: number;
  risks: number;
  pendingProposals: number;
  notes: number;
  noteVersions: number;
  threads: number;
  messages: number;
  aiKeysSealed: boolean;
  seconds: number;
}

/** Words the notes, threads and task titles use; the search journey looks for them. */
export const SEARCH_WORDS = ['budget', 'procurement', 'survey', 'supplier', 'training', 'inspection', 'schedule', 'permit', 'handover', 'audit'];

/** Refuses anything but an empty migrated database: the seed never adds to a real or a used installation. */
async function assertEmpty(pool: Pool): Promise<void> {
  const org = (await pool.query(`SELECT count(*)::int AS n FROM organisation`)).rows[0].n;
  const users = (await pool.query(`SELECT count(*)::int AS n FROM users`)).rows[0].n;
  if (org > 0 || users > 0) {
    throw new Error('The load-test seed needs an empty migrated database; this one already has an organisation or people in it.');
  }
}

function seedSql(people: number, projects: number, now: Date): string[] {
  const NOW = `'${now.toISOString()}'::timestamptz`;
  const user = (expr: string) => `md5('load-user-' || (${expr}))::uuid`;
  const project = (expr: string) => `md5('load-project-' || (${expr}))::uuid`;
  // Person numbers (1-based) by role in project p (0-based).
  const pm = (p: string) => `(${p} % ${VIRTUAL_PEOPLE} + 1)`;
  // Proposals are reviewed by the Owner or a Sponsor, so the Owner is a virtual person too (never the project's PM).
  const owner = (p: string) => `((${p} + 5) % ${VIRTUAL_PEOPLE} + 1)`;
  const sponsor = (p: string) => `(${VIRTUAL_PEOPLE + 1} + ${p} % ${projects})`;
  const firstMember = VIRTUAL_PEOPLE + 1 + projects;
  const memberPool = people - firstMember + 1;
  // Member k of project p: k = 0 is another virtual person; the rest come from the people above the sponsors.
  const member = (p: string, k: string) => `(CASE WHEN ${k} = 0 THEN (${p} + 3) % ${VIRTUAL_PEOPLE} + 1 ELSE ${firstMember} + ((${p} * 7 + ${k} * 13) % ${memberPool}) END)`;
  const memberCount = (p: string) => `(4 + ${p} % 9)`;
  const sql: string[] = [];

  sql.push(`INSERT INTO users (id, email, display_name, role, status, created_at, updated_at)
    SELECT ${user('i')}, 'load-' || lpad(i::text, 3, '0') || '@${LOAD_DOMAIN}', 'Load Person ' || lpad(i::text, 3, '0'),
           CASE WHEN i = 1 THEN 'enterprise_administrator' ELSE 'member' END, 'active', ${NOW} - interval '60 days', ${NOW} - interval '60 days'
      FROM generate_series(1, ${people}) i`);
  sql.push(`INSERT INTO eligible_domains (id, domain, added_by, added_at) VALUES (md5('load-domain')::uuid, '${LOAD_DOMAIN}', ${user('1')}, ${NOW} - interval '60 days')`);
  sql.push(`INSERT INTO organisation (id, name, registered_by, registered_at, updated_by, updated_at)
    VALUES (1, '${LOAD_ORGANISATION}', ${user('1')}, ${NOW} - interval '60 days', ${user('1')}, ${NOW} - interval '60 days')`);
  sql.push(`INSERT INTO departments (id, name, created_by, created_at)
    SELECT md5('load-dept-' || d)::uuid, (ARRAY[${DEPARTMENTS.map((d) => `'${d}'`).join(', ')}])[d + 1], ${user('1')}, ${NOW} - interval '60 days'
      FROM generate_series(0, ${DEPARTMENTS.length - 1}) d`);
  sql.push(`INSERT INTO projects (id, name, purpose, owning_department_id, planned_end, status, created_by, created_at)
    SELECT ${project('p')}, 'Load Project ' || lpad((p + 1)::text, 2, '0'), 'Deliver the ' || (ARRAY[${SEARCH_WORDS.map((w) => `'${w}'`).join(', ')}])[p % ${SEARCH_WORDS.length} + 1] || ' work of load project ' || (p + 1),
           md5('load-dept-' || (p % ${DEPARTMENTS.length}))::uuid, (${NOW})::date + (60 + p * 5), 'active', ${user('1')}, ${NOW} - interval '45 days'
      FROM generate_series(0, ${projects - 1}) p`);
  // Each project's own copy of General's stages (D131), as creating a project gives it.
  sql.push(`UPDATE projects SET stage_template_id = '${GENERAL_TEMPLATE_ID}' WHERE stage_template_id IS NULL`);
  sql.push(`INSERT INTO project_stages (id, project_id, position, name, substages, status, added_by, added_at)
    SELECT md5('load-pstage-' || p || '-' || s.position)::uuid, ${project('p')}, s.position, s.name, s.substages, 'active', ${user('1')}, ${NOW} - interval '45 days'
      FROM generate_series(0, ${projects - 1}) p CROSS JOIN stage_template_stages s WHERE s.template_id = '${GENERAL_TEMPLATE_ID}'`);
  sql.push(`INSERT INTO project_stage_periods (id, project_id, stage, started_at, ended_at, started_by)
    SELECT md5('load-stage-a-' || p)::uuid, ${project('p')}, 'Initiation', ${NOW} - interval '45 days', ${NOW} - interval '30 days' + (p % 7) * interval '1 day', ${user('1')}
      FROM generate_series(0, ${projects - 1}) p`);
  sql.push(`INSERT INTO project_stage_periods (id, project_id, stage, started_at, started_by)
    SELECT md5('load-stage-b-' || p)::uuid, ${project('p')}, CASE WHEN p % 3 = 0 THEN 'Planning' ELSE 'Execution' END,
           ${NOW} - interval '30 days' + (p % 7) * interval '1 day', ${user(pm('p'))}
      FROM generate_series(0, ${projects - 1}) p`);
  sql.push(`INSERT INTO project_transitions (id, project_id, from_status, to_status, actor_id, reason, at)
    SELECT md5('load-trans-' || p || '-' || t.j)::uuid, ${project('p')}, t.from_s, t.to_s, ${user('1')}, 'Load-test seed',
           ${NOW} - (t.days - p % 7) * interval '1 day'
      FROM generate_series(0, ${projects - 1}) p
      CROSS JOIN (VALUES (1, 'draft', 'planned', 40), (2, 'planned', 'active', 30)) AS t(j, from_s, to_s, days)`);
  const membership = (role: string, who: string, extra = '') =>
    `INSERT INTO memberships (id, project_id, user_id, role, starts_on)
     SELECT md5('load-mem-${role}-' || p${extra ? ` || '-' || k` : ''})::uuid, ${project('p')}, ${user(who)}, '${role}', (${NOW})::date - 45
       FROM generate_series(0, ${projects - 1}) p ${extra}`;
  sql.push(membership('pm', pm('p')));
  sql.push(membership('owner', owner('p')));
  sql.push(membership('sponsor', sponsor('p')));
  sql.push(membership('member', member('p', 'k'), `CROSS JOIN generate_series(0, 11) k WHERE k < ${memberCount('p')}`));

  // Tasks, top level only: status by n % 10 (0-2 completed, 3-5 in progress, 6 blocked, 7-8 not started, 9 cancelled),
  // authorised over the last 30 days, due within +/- 30 days, assigned to the PM or a Member of the project.
  sql.push(`CREATE TEMP TABLE load_tasks ON COMMIT DROP AS
    SELECT p, n, md5('load-task-' || p || '-' || n)::uuid AS id, ${project('p')} AS project_id,
           (${NOW})::date + ((n * 7 + p) % 61 - 30) AS due_on,
           CASE n % 10 WHEN 0 THEN 'completed' WHEN 1 THEN 'completed' WHEN 2 THEN 'completed' WHEN 3 THEN 'in_progress' WHEN 4 THEN 'in_progress'
                       WHEN 5 THEN 'in_progress' WHEN 6 THEN 'blocked' WHEN 7 THEN 'not_started' WHEN 8 THEN 'not_started' ELSE 'cancelled' END AS status,
           ${NOW} - ((2 + (n * 37 + p * 11) % 28) * interval '1 day') - (n % 24) * interval '1 hour' AS authorised_at,
           CASE WHEN n % 3 = 0 THEN ${pm('p')} ELSE ${member('p', `(n % ${memberCount('p')})`)} END AS assignee,
           ${pm('p')} AS manager
      FROM generate_series(0, ${projects - 1}) p CROSS JOIN generate_series(0, ${TASKS_PER_PROJECT - 1}) n`);
  sql.push(`INSERT INTO tasks (id, project_id, parent_id, depth, title, assignee_id, due_on, status, authorised_by, authorised_at, completed_at)
    SELECT id, project_id, NULL, 0,
           initcap((ARRAY[${SEARCH_WORDS.map((w) => `'${w}'`).join(', ')}])[(n + p) % ${SEARCH_WORDS.length} + 1]) || ' task ' || (p + 1) || '.' || (n + 1),
           ${user('assignee')}, due_on, status, ${user('manager')}, authorised_at,
           CASE WHEN status = 'completed' THEN authorised_at + interval '1 day' END
      FROM load_tasks`);
  sql.push(`INSERT INTO task_events (id, task_id, kind, from_status, to_status, actor_id, at)
    SELECT md5('load-tev-a-' || id)::uuid, id, 'authorised', NULL, 'not_started', ${user('manager')}, authorised_at FROM load_tasks`);
  sql.push(`INSERT INTO task_events (id, task_id, kind, from_status, to_status, actor_id, at)
    SELECT md5('load-tev-s-' || id)::uuid, id, 'started', 'not_started', 'in_progress', ${user('assignee')}, authorised_at + interval '6 hours'
      FROM load_tasks WHERE status IN ('in_progress', 'blocked', 'completed')`);
  sql.push(`INSERT INTO task_events (id, task_id, kind, from_status, to_status, note, actor_id, at)
    SELECT md5('load-tev-b-' || id)::uuid, id, 'blocked', 'in_progress', 'blocked', 'Waiting for the supplier', ${user('assignee')}, authorised_at + interval '12 hours'
      FROM load_tasks WHERE status = 'blocked'`);
  sql.push(`INSERT INTO task_events (id, task_id, kind, from_status, to_status, note, actor_id, at)
    SELECT md5('load-tev-c-' || id)::uuid, id, 'completed', 'in_progress', 'completed', 'Done', ${user('assignee')}, authorised_at + interval '1 day'
      FROM load_tasks WHERE status = 'completed'`);
  sql.push(`INSERT INTO task_events (id, task_id, kind, from_status, to_status, note, actor_id, at)
    SELECT md5('load-tev-x-' || id)::uuid, id, 'cancelled', 'not_started', 'cancelled', 'No longer needed', ${user('manager')}, authorised_at + interval '2 days'
      FROM load_tasks WHERE status = 'cancelled'`);

  // Decisions and risks, each from an approved proposal of the last 30 days.
  sql.push(`INSERT INTO human_proposals (id, project_id, kind, text, proposed_by, proposed_at, review_status, reviewed_by, reviewed_at)
    SELECT md5('load-prop-d-' || p || '-' || r)::uuid, ${project('p')}, 'decision', 'Agree the ' || (ARRAY[${SEARCH_WORDS.map((w) => `'${w}'`).join(', ')}])[(r + p) % ${SEARCH_WORDS.length} + 1] || ' approach ' || (p + 1) || '.' || (r + 1),
           ${user(member('p', '1'))}, ${NOW} - ((3 + (r * 3 + p) % 27) * interval '1 day'), 'approved', ${user(pm('p'))}, ${NOW} - ((2 + (r * 3 + p) % 27) * interval '1 day')
      FROM generate_series(0, ${projects - 1}) p CROSS JOIN generate_series(0, ${DECISIONS_PER_PROJECT - 1}) r`);
  sql.push(`INSERT INTO decisions (id, project_id, statement, rationale, origin_proposal_id, authorised_by, authorised_at)
    SELECT md5('load-dec-' || p || '-' || r)::uuid, ${project('p')}, 'Agree the ' || (ARRAY[${SEARCH_WORDS.map((w) => `'${w}'`).join(', ')}])[(r + p) % ${SEARCH_WORDS.length} + 1] || ' approach ' || (p + 1) || '.' || (r + 1),
           'Agreed at the project meeting', md5('load-prop-d-' || p || '-' || r)::uuid, ${user(pm('p'))}, ${NOW} - ((2 + (r * 3 + p) % 27) * interval '1 day')
      FROM generate_series(0, ${projects - 1}) p CROSS JOIN generate_series(0, ${DECISIONS_PER_PROJECT - 1}) r`);
  sql.push(`INSERT INTO human_proposals (id, project_id, kind, text, proposed_by, proposed_at, review_status, reviewed_by, reviewed_at)
    SELECT md5('load-prop-r-' || p || '-' || r)::uuid, ${project('p')}, 'risk', 'The ' || (ARRAY[${SEARCH_WORDS.map((w) => `'${w}'`).join(', ')}])[(r + p + 3) % ${SEARCH_WORDS.length} + 1] || ' may slip ' || (p + 1) || '.' || (r + 1),
           ${user(member('p', '1'))}, ${NOW} - ((3 + (r * 5 + p) % 27) * interval '1 day'), 'approved', ${user(pm('p'))}, ${NOW} - ((2 + (r * 5 + p) % 27) * interval '1 day')
      FROM generate_series(0, ${projects - 1}) p CROSS JOIN generate_series(0, ${RISKS_PER_PROJECT - 1}) r`);
  sql.push(`INSERT INTO risks (id, project_id, description, severity, responsible_id, review_on, status, origin_proposal_id, authorised_by, authorised_at)
    SELECT md5('load-risk-' || p || '-' || r)::uuid, ${project('p')}, 'The ' || (ARRAY[${SEARCH_WORDS.map((w) => `'${w}'`).join(', ')}])[(r + p + 3) % ${SEARCH_WORDS.length} + 1] || ' may slip ' || (p + 1) || '.' || (r + 1),
           (ARRAY['low', 'medium', 'high', 'critical'])[1 + r % 4], ${user(pm('p'))}, (${NOW})::date + ((r * 5 + p) % 40 - 10),
           (ARRAY['open', 'mitigating', 'open', 'accepted'])[1 + r % 4], md5('load-prop-r-' || p || '-' || r)::uuid, ${user(pm('p'))},
           ${NOW} - ((2 + (r * 5 + p) % 27) * interval '1 day')
      FROM generate_series(0, ${projects - 1}) p CROSS JOIN generate_series(0, ${RISKS_PER_PROJECT - 1}) r`);
  // Proposals waiting for the PM's review (the approve journey): decisions and risks, proposed over the last 10 days.
  sql.push(`INSERT INTO human_proposals (id, project_id, kind, text, proposed_by, proposed_at)
    SELECT md5('load-prop-w-' || p || '-' || r)::uuid, ${project('p')}, CASE WHEN r % 2 = 0 THEN 'decision' ELSE 'risk' END,
           CASE WHEN r % 2 = 0 THEN 'Proposed: change the ' ELSE 'Proposed risk: the ' END || (ARRAY[${SEARCH_WORDS.map((w) => `'${w}'`).join(', ')}])[(r + p + 5) % ${SEARCH_WORDS.length} + 1] || ' plan ' || (p + 1) || '.' || (r + 1),
           ${user(member('p', `(1 + r % 3)`))}, ${NOW} - ((r % 10) * interval '1 day') - (r * interval '13 minutes')
      FROM generate_series(0, ${projects - 1}) p CROSS JOIN generate_series(0, ${PENDING_PER_PROJECT - 1}) r`);

  // Automatic discussion analysis off: the extraction journey is the AI work of the run.
  sql.push(`INSERT INTO analysis_settings (id, automatic, quiet_minutes, projects_may_change, updated_at, updated_by) VALUES (1, false, 5, false, ${NOW}, ${user('1')})
    ON CONFLICT (id) DO UPDATE SET automatic = false`);
  return sql;
}

const noteText = (p: number, i: number): string => {
  const w = (k: number) => SEARCH_WORDS[(p + i + k) % SEARCH_WORDS.length];
  return [
    `Meeting notes for Load Project ${p + 1}, session ${i + 1}.`,
    `Present: the Project Manager, the Owner and three Members.`,
    `The team agreed to review the ${w(0)} figures before the next meeting.`,
    `Action: the Project Manager will prepare the ${w(1)} report by Friday.`,
    `Risk: the ${w(2)} may be late if the supplier does not confirm this week.`,
    `Question: who signs off the ${w(3)} plan?`,
    `Discussion covered the ${w(4)} timetable, the ${w(5)} costs and the next ${w(6)} visit.`,
  ].join('\n');
};

interface InProcess {
  app: INestApplication;
  base: string;
  signIn(email: string): Promise<(method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>>;
}

/** The app in this process with a capturing code sender and no queues: content is written exactly as the routes write it. */
async function startInProcess(databaseUrl: string): Promise<InProcess> {
  const sender = new CaptureSender();
  const config = loadConfig({ DATABASE_URL: databaseUrl, AUTH_SECRET: randomBytes(32).toString('hex'), LOG_SIGN_IN_CODES: 'true', COOKIE_SECURE: 'false' });
  const app = await createApp(config, {
    codeSender: sender,
    logger: false,
    extractionQueue: { enqueue: async () => undefined },
    emailNudge: { nudge: async () => undefined },
    meetingEndHook: NO_MEETING_END_HOOK,
    analysisQueue: { enqueue: async () => undefined },
    assistQueue: { enqueue: async () => undefined },
  });
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  return {
    app,
    base,
    async signIn(email) {
      await fetch(`${base}/auth/request-code`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
      const res = await fetch(`${base}/auth/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, code: sender.lastCode(email) }) });
      if (res.status !== 200) throw new Error(`Seed sign-in failed for ${email}: ${res.status}`);
      const cookie = (res.headers.getSetCookie()[0] ?? '').split(';')[0];
      const { csrfToken } = (await res.json()) as { csrfToken: string };
      return async (method, path, body) => {
        const r = await fetch(`${base}${path}`, {
          method,
          headers: { Cookie: cookie, 'X-CSRF-Token': csrfToken, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        const text = await r.text();
        return { status: r.status, body: text ? JSON.parse(text) : undefined };
      };
    },
  };
}

function connectionString(pool: Pool): string {
  const url = (pool as unknown as { options: { connectionString?: string } }).options.connectionString;
  if (!url) throw new Error('The seed needs a pool made from a connection string.');
  return url;
}

/**
 * Seeds the data set. `protectedKey` seals each project connection's (obviously fake) key so the worker can open it; without
 * it the connections have no key and every extraction ends blocked.
 */
export async function seedLoad(
  pool: Pool,
  opts: { people: 200; projects: 40; protectedKey?: ProtectedKey | null; log?: (m: string) => void },
): Promise<SeedSummary> {
  const log = opts.log ?? (() => undefined);
  const started = Date.now();
  await assertEmpty(pool);
  const now = new Date();
  now.setMilliseconds(0);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const statement of seedSql(opts.people, opts.projects, now)) await client.query(statement);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  log('people, projects, tasks, decisions, risks and proposals seeded');

  // AI: generous organisation limits (the fake costs nothing real), one model, a ready connection per project.
  const adminId = (await pool.query(`SELECT id FROM users WHERE email = $1`, [ADMIN_EMAIL])).rows[0].id as string;
  await new SpendSettingsService(pool, () => new Date()).apply({ ...MVP_SPEND_SETTINGS, monthlyLimitMicroMyr: parseMicro('100000', 'monthly limit') }, adminId, 'Load-test seed');
  const model = await seedAiModel(pool, { provider: 'openai', modelId: FAKE_MODEL_ID });
  const projectRows = (await pool.query(`SELECT id, name FROM projects ORDER BY name, id`)).rows as { id: string; name: string }[];
  for (const p of projectRows) {
    await seedAiConnection(pool, { projectId: p.id, model, position: 1, label: 'Load-test fake provider', protectedKey: opts.protectedKey ?? null, apiKey: KEY_A });
    await seedProjectAllowance(pool, p.id);
  }

  // Notes and discussion through the real routes, written by each project's PM.
  const inProcess = await startInProcess(connectionString(pool));
  let notes = 0;
  let noteVersions = 0;
  let threads = 0;
  let messages = 0;
  try {
    const pms = new Map<number, Awaited<ReturnType<InProcess['signIn']>>>();
    for (let v = 1; v <= VIRTUAL_PEOPLE; v++) pms.set(v, await inProcess.signIn(loadEmail(v)));
    const must = (r: { status: number; body: any }, what: string) => {
      if (r.status >= 300) throw new Error(`Seeding ${what} answered ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`);
      return r.body;
    };
    for (let i = 0; i < NOTES; i++) {
      const p = i % projectRows.length;
      const call = pms.get((p % VIRTUAL_PEOPLE) + 1)!;
      const k = Math.floor(i / projectRows.length);
      const created = must(await call('POST', `/projects/${projectRows[p].id}/notes`, { title: `Meeting notes ${p + 1}.${k + 1}`, text: noteText(p, k) }), 'a note');
      notes++;
      noteVersions++;
      if (i % 2 === 0) {
        must(await call('POST', `/notes/${created.source.id}/versions`, { text: `${noteText(p, k)}\nCorrection: the ${SEARCH_WORDS[(p + k) % SEARCH_WORDS.length]} date moved by a week.` }), 'a note version');
        noteVersions++;
      }
    }
    log(`${notes} notes seeded`);
    for (let p = 0; p < projectRows.length; p++) {
      const call = pms.get((p % VIRTUAL_PEOPLE) + 1)!;
      for (let t = 0; t < THREADS_PER_PROJECT; t++) {
        const word = SEARCH_WORDS[(p + t) % SEARCH_WORDS.length];
        const thread = must(await call('POST', `/projects/${projectRows[p].id}/threads`, { kind: 'discussion', title: `The ${word} plan, part ${t + 1}` }), 'a thread');
        threads++;
        for (let m = 0; m < MESSAGES_PER_THREAD; m++) {
          must(await call('POST', `/threads/${thread.id}/messages`, { body: `Update ${m + 1} on the ${word}: the ${SEARCH_WORDS[(p + t + m + 1) % SEARCH_WORDS.length]} is on track.` }), 'a message');
          messages++;
        }
      }
    }
    log(`${threads} threads and ${messages} messages seeded`);
  } finally {
    await inProcess.app.close();
  }

  for (const t of ['users', 'projects', 'memberships', 'tasks', 'task_events', 'risks', 'decisions', 'human_proposals', 'sources', 'source_versions', 'discussion_threads', 'discussion_messages']) {
    await pool.query(`ANALYZE ${t}`);
  }
  const count = async (sql: string) => (await pool.query(sql)).rows[0].n as number;
  return {
    people: await count(`SELECT count(*)::int AS n FROM users`),
    projects: await count(`SELECT count(*)::int AS n FROM projects`),
    departments: await count(`SELECT count(*)::int AS n FROM departments`),
    tasks: await count(`SELECT count(*)::int AS n FROM tasks`),
    decisions: await count(`SELECT count(*)::int AS n FROM decisions`),
    risks: await count(`SELECT count(*)::int AS n FROM risks`),
    pendingProposals: await count(`SELECT count(*)::int AS n FROM human_proposals WHERE review_status = 'pending'`),
    notes,
    noteVersions,
    threads,
    messages,
    aiKeysSealed: !!opts.protectedKey,
    seconds: Math.round((Date.now() - started) / 1000),
  };
}
