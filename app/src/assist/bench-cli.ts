import { Pool, type PoolClient } from 'pg';
import { type Session, seedBench, startApp } from '../analysis/bench-cli';
import type { AuthUser } from '../auth/tokens';
import { ThreadsService } from '../discussion/threads.service';
import { ProjectAccess } from '../projects/access.service';
import { type MaterialScope, findMaterial } from './material';
import { backfillPassages } from './passage-index';
import { buildTerms } from './terms';

/**
 * Measured aims of sub-project 4b (spec 11) on the 4a bench data plus notes, minutes and records.
 *
 *   DATABASE_URL=postgres://.../kainow_bench npm run migrate && DATABASE_URL=... npm run bench-assist
 *
 * Seeds the 4a data set (about 2,000 threads and 100,000 messages across 50 projects), then 500 notes and minutes
 * versions of 5,000 to 8,000 words (English with some Malay; a quarter of the notes Restricted, minutes following their
 * meeting's audience) and 2,000 authorised records, all with set-based SQL and without passages. It then runs the
 * passage back-fill and reports its time, measures material search (`findMaterial`) over 200 varied questions, and
 * posting a message through the real HTTP app with and without indexing.
 *
 * The tool writes many rows, so it refuses any database whose name does not end in `_test` or `_bench`.
 */

export function assertAssistBenchDatabase(databaseUrl: string): string {
  let name = '';
  try {
    name = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, ''));
  } catch {
    // fall through to the refusal; the URL (and its password) is never echoed
  }
  if (!/_(test|bench)$/.test(name)) {
    throw new Error('Refusing to run: the bench writes many rows, so the database name must end in _test or _bench.');
  }
  return name;
}

const PROJECTS = 50;
const USERS = 400;
const NOTES = 380; // sources 0..379 are notes; 380..439 are minutes
const SOURCES = 440;
const SECOND_VERSIONS = 60; // sources 0..59 have a second version: 500 versions in all
const RECORDS = 2000;
const PENDING_PROPOSALS = 300;

const lit = (s: string): string => `'${s.replace(/'/g, "''")}'`;
const arr = (xs: string[]): string => `ARRAY[${xs.map(lit).join(', ')}]`;

const EN_SUBJECTS = ['The project team', 'The vendor', 'Finance', 'The steering committee', 'Procurement', 'The site lead', 'Operations', 'The training coordinator', 'Legal', 'The pilot group', 'The regional office', 'Quality assurance', 'The architect', 'Human resources', 'The supplier', 'IT support', 'The sponsor', 'Facilities'];
const EN_VERBS = ['reviewed', 'approved', 'postponed', 'questioned', 'confirmed', 'escalated', 'drafted', 'updated', 'rejected', 'tested', 'scheduled', 'estimated', 'cancelled', 'signed off', 'raised concerns about', 'shared', 'audited', 'revised'];
const EN_ADJECTIVES = ['revised', 'quarterly', 'draft', 'final', 'interim', 'overdue', 'regional', 'technical', 'preliminary', 'updated', 'detailed', 'second', 'outstanding', 'urgent'];
const EN_NOUNS = ['budget', 'delivery schedule', 'migration plan', 'risk register', 'training material', 'contract', 'cost estimate', 'test report', 'handover checklist', 'staffing plan', 'procurement request', 'network design', 'data retention policy', 'invoice', 'milestone plan', 'safety assessment', 'user acceptance tests', 'warehouse layout', 'licence renewal', 'backup procedure', 'floor plan', 'payroll interface', 'audit findings', 'service agreement'];
const EN_CONTEXTS = ['before the next steering meeting', 'for the second phase', 'after the site visit', 'because the supplier missed the deadline', 'pending approval from finance', 'for the Penang office', 'for the Johor warehouse', 'ahead of the go-live weekend', 'following the incident in October', 'to reduce the overtime costs', 'for the pilot in three departments', 'once the licences arrive', 'subject to the legal review', 'by the end of the month', 'on 12 November', 'by 3 December', 'in the first quarter'];
const NAMES = ['Ms Aisyah', 'Mr Tan', 'Encik Rahman', 'Dr Lim', 'Ms Priya', 'Mr Wong', 'Puan Noraini', 'Mr Kumar', 'Cik Farah', 'Ms Chen'];
const MS_SUBJECTS = ['Pasukan projek', 'Pembekal', 'Jabatan kewangan', 'Jawatankuasa pemandu', 'Unit perolehan', 'Ketua tapak', 'Bahagian operasi', 'Pegawai latihan'];
const MS_VERBS = ['telah menyemak', 'akan meluluskan', 'menangguhkan', 'mengesahkan', 'membincangkan', 'mengemas kini', 'menolak', 'menguji'];
const MS_NOUNS = ['anggaran kos', 'jadual penghantaran', 'pelan latihan', 'daftar risiko', 'kontrak pembekal', 'laporan ujian', 'senarai semak serahan', 'pelan kakitangan', 'reka bentuk rangkaian', 'dasar penyimpanan data'];
const MS_CONTEXTS = ['sebelum mesyuarat seterusnya', 'untuk fasa kedua', 'selepas lawatan tapak', 'kerana pembekal lewat', 'menunggu kelulusan kewangan', 'pada minggu hadapan', 'sebelum akhir bulan ini'];
const PLAIN = [
  'We should confirm the delivery date with the vendor before we commit to the schedule.',
  'The budget for this phase is tight, so any extra scope needs to be agreed first.',
  'Saya setuju dengan cadangan itu, tetapi kita perlu semak semula kos bulan depan.',
  'The risk with this approach is that the supplier may not meet the revised timeline.',
  'Kita perlu hantar laporan kemajuan kepada pihak pengurusan sebelum akhir minggu ini.',
  'We decided to go with the second option because it costs less and is easier to maintain.',
  'The open question is whether the pilot should include all departments or only two.',
  'Ada risiko bahawa jadual tidak dapat dipenuhi jika kelulusan lewat diterima.',
];
const CODE_NAMES = ['Kestrel', 'Merbau', 'Halcyon', 'Cendana', 'Orion', 'Tualang', 'Seraya', 'Nautilus'];
const NOTE_HEADINGS = ['Background', 'Discussion', 'Progress', 'Issues raised', 'Next steps', 'Costs', 'Timeline', 'Latar belakang', 'Perbincangan'];
const MINUTES_HEADINGS = ['Summary', 'Decisions', 'Action items', 'Risks', 'Discussion', 'Open questions', 'Keputusan', 'Tindakan'];

/** A deterministic sentence for a seed: mostly English, about a fifth Malay, some with a rare code name. */
const SENTENCE_FN = `CREATE FUNCTION pg_temp.bench_sentence(seed text) RETURNS text LANGUAGE sql IMMUTABLE AS $f$
  SELECT CASE WHEN h.a % 10 < 5 THEN (${arr(EN_SUBJECTS)})[1 + h.b % ${EN_SUBJECTS.length}] || ' ' || (${arr(EN_VERBS)})[1 + h.c % ${EN_VERBS.length}]
                     || ' the ' || (${arr(EN_ADJECTIVES)})[1 + h.d % ${EN_ADJECTIVES.length}] || ' ' || (${arr(EN_NOUNS)})[1 + h.e % ${EN_NOUNS.length}]
                     || ' ' || (${arr(EN_CONTEXTS)})[1 + h.f % ${EN_CONTEXTS.length}]
              WHEN h.a % 10 = 5 THEN (${arr(NAMES)})[1 + h.b % ${NAMES.length}] || ' will follow up on the ' || (${arr(EN_NOUNS)})[1 + h.e % ${EN_NOUNS.length}]
                     || ' ' || (${arr(EN_CONTEXTS)})[1 + h.f % ${EN_CONTEXTS.length}]
              WHEN h.a % 10 < 8 THEN (${arr(MS_SUBJECTS)})[1 + h.b % ${MS_SUBJECTS.length}] || ' ' || (${arr(MS_VERBS)})[1 + h.c % ${MS_VERBS.length}]
                     || ' ' || (${arr(MS_NOUNS)})[1 + h.e % ${MS_NOUNS.length}] || ' ' || (${arr(MS_CONTEXTS)})[1 + h.f % ${MS_CONTEXTS.length}]
              ELSE rtrim((${arr(PLAIN)})[1 + h.b % ${PLAIN.length}], '.') END
         || CASE WHEN h.g % 29 = 0 THEN ' (workstream ' || (${arr(CODE_NAMES)})[1 + h.c % ${CODE_NAMES.length}] || ')' ELSE '' END || '.'
    FROM (SELECT hashtext(seed) & 2147483647 AS a, hashtext(seed || 'b') & 2147483647 AS b, hashtext(seed || 'c') & 2147483647 AS c,
                 hashtext(seed || 'd') & 2147483647 AS d, hashtext(seed || 'e') & 2147483647 AS e, hashtext(seed || 'f') & 2147483647 AS f,
                 hashtext(seed || 'g') & 2147483647 AS g) h
$f$`;

function assistSeedSql(now: Date): string[] {
  const NOW = `'${now.toISOString()}'::timestamptz`;
  const user = (expr: string) => `md5('bench-user-' || (${expr}))::uuid`;
  const member = (p: string, k: string) => `1 + (${p} * 8 + ${k}) % ${USERS}`;
  const sql: string[] = [SENTENCE_FN];

  // Sources: notes 0..379 (a quarter Restricted to three named people; one in fifty deleted), minutes 380..439 on meeting threads.
  sql.push(`CREATE TEMP TABLE bench_meetings AS
    SELECT id, project_id, audience_id, row_number() OVER (ORDER BY id) AS rn FROM discussion_threads WHERE kind = 'meeting'`);
  sql.push(`CREATE TEMP TABLE bench_sources AS
    SELECT d, md5('bench-source-' || d)::uuid AS id,
           CASE WHEN d < ${NOTES} THEN md5('bench-project-' || (d % ${PROJECTS}))::uuid ELSE mt.project_id END AS project_id,
           CASE WHEN d < ${NOTES} THEN (d % ${PROJECTS}) END AS p,
           CASE WHEN d < ${NOTES} THEN 'notes' ELSE 'minutes' END AS kind,
           CASE WHEN d < ${NOTES} THEN NULL ELSE mt.id END AS thread_id,
           CASE WHEN d < ${NOTES} THEN md5('bench-source-aud-' || d)::uuid ELSE mt.audience_id END AS audience_id,
           d < ${NOTES} AND d % 4 = 1 AS restricted,
           CASE WHEN d % 50 = 7 THEN 'deleted' ELSE 'active' END AS status,
           ${NOW} - ((5 + d % 60) * interval '1 day') AS created_at
      FROM generate_series(0, ${SOURCES - 1}) d
      LEFT JOIN bench_meetings mt ON d >= ${NOTES} AND mt.rn = 1 + (d - ${NOTES}) * 3`);
  sql.push(`INSERT INTO audiences (id, project_id, mode, created_at)
    SELECT audience_id, project_id, CASE WHEN restricted THEN 'restricted' ELSE 'project' END, created_at FROM bench_sources WHERE kind = 'notes'`);
  sql.push(`INSERT INTO audience_members (audience_id, user_id, added_by, added_at)
    SELECT audience_id, ${user(member('p', 'k'))}, ${user(member('p', '0'))}, created_at
      FROM bench_sources CROSS JOIN unnest(ARRAY[2, 4, 5]) k WHERE restricted`);
  sql.push(`INSERT INTO sources (id, title, created_by, created_at, status, project_id, kind, audience_id, publication, thread_id)
    SELECT s.id, CASE WHEN s.kind = 'minutes' THEN 'Minutes ' ELSE 'Notes ' END || (${arr(NOTE_HEADINGS)})[1 + s.d % ${NOTE_HEADINGS.length}] || ' ' || s.d,
           pm.user_id, s.created_at, s.status, s.project_id, s.kind, s.audience_id, 'published', s.thread_id
      FROM bench_sources s
      CROSS JOIN LATERAL (SELECT m.user_id FROM memberships m WHERE m.project_id = s.project_id AND m.role = 'pm' LIMIT 1) pm`);

  // Versions (500): 5,000 to 8,000 words each, cut from up to 700 generated sentences by a running word count.
  sql.push(`CREATE TEMP TABLE bench_versions AS
    SELECT s.d, v, md5('bench-source-ver-' || s.d || '-' || v)::uuid AS id, s.id AS source_id, s.kind, s.created_at + (v - 1) * interval '1 day' AS created_at,
           5000 + ((s.d * 1237 + v * 311) % 3001) AS target_words
      FROM bench_sources s CROSS JOIN generate_series(1, 2) v WHERE v = 1 OR s.d < ${SECOND_VERSIONS}`);
  sql.push(`CREATE TEMP TABLE bench_version_sentences AS
    SELECT y.*, sum(y.wc) OVER (PARTITION BY y.id ORDER BY y.n) AS cum
      FROM (SELECT bv.id, bv.kind, bv.d, bv.target_words, n, t.txt, array_length(string_to_array(t.txt, ' '), 1) AS wc
              FROM bench_versions bv CROSS JOIN generate_series(1, 700) n
              CROSS JOIN LATERAL (SELECT pg_temp.bench_sentence(bv.id::text || ':' || n) AS txt) t) y`);
  sql.push(`CREATE TEMP TABLE bench_version_text AS
    SELECT id, string_agg(
             CASE WHEN n = 1 THEN ''
                  WHEN n % 45 = 1 THEN E'\\n\\n## ' || CASE WHEN kind = 'minutes' THEN (${arr(MINUTES_HEADINGS)})[1 + (n / 45 + d) % ${MINUTES_HEADINGS.length}]
                                                       ELSE (${arr(NOTE_HEADINGS)})[1 + (n / 45 + d) % ${NOTE_HEADINGS.length}] END || E'\\n\\n'
                  WHEN n % (3 + d % 4) = 1 THEN E'\\n\\n'
                  ELSE ' ' END || txt, '' ORDER BY n) AS body,
           max(cum) AS words
      FROM bench_version_sentences WHERE cum <= target_words GROUP BY id`);
  sql.push(`INSERT INTO source_versions (id, source_id, version_no, origin, text_content, text_sha256, char_count, created_by, created_at)
    SELECT bv.id, bv.source_id, bv.v, CASE WHEN bv.kind = 'minutes' THEN 'meeting' ELSE 'paste' END, t.body,
           encode(sha256(convert_to(t.body, 'UTF8')), 'hex'), char_length(t.body), s.created_by, bv.created_at
      FROM bench_versions bv JOIN bench_version_text t ON t.id = bv.id JOIN sources s ON s.id = bv.source_id`);

  // Records (2,000): 500 tasks, 500 decisions, 500 questions (half answered), 500 risks; plus 300 pending proposals.
  const hp = (r: string) => `md5('bench-hp-' || ${r})::uuid`;
  sql.push(`INSERT INTO human_proposals (id, project_id, kind, text, proposed_by, proposed_at, review_status, reviewed_by, reviewed_at)
    SELECT ${hp('r')}, md5('bench-project-' || (r % ${PROJECTS}))::uuid,
           CASE WHEN r >= ${RECORDS} THEN (ARRAY['action', 'decision', 'question', 'risk'])[1 + r % 4]
                ELSE (ARRAY['action', 'decision', 'question', 'risk'])[1 + r / 500] END,
           pg_temp.bench_sentence('record-' || r), ${user(member('r % 50', '4'))}, ${NOW} - ((r % 80) * interval '1 day') - interval '1 hour',
           CASE WHEN r >= ${RECORDS} THEN 'pending' ELSE 'approved' END,
           CASE WHEN r >= ${RECORDS} THEN NULL ELSE ${user(member('r % 50', '0'))} END,
           CASE WHEN r >= ${RECORDS} THEN NULL ELSE ${NOW} - ((r % 80) * interval '1 day') END
      FROM generate_series(500, ${RECORDS + PENDING_PROPOSALS - 1}) r`);
  sql.push(`INSERT INTO tasks (id, project_id, depth, title, assignee_id, due_on, status, authorised_by, authorised_at)
    SELECT md5('bench-task-' || r)::uuid, md5('bench-project-' || (r % ${PROJECTS}))::uuid, 0, pg_temp.bench_sentence('record-' || r),
           ${user(member('r % 50', '4 + r % 8'))}, (${NOW})::date + (r % 60 - 20),
           (ARRAY['not_started', 'in_progress', 'blocked', 'completed', 'cancelled'])[1 + r % 5],
           ${user(member('r % 50', '0'))}, ${NOW} - ((r % 80) * interval '1 day')
      FROM generate_series(0, 499) r`);
  sql.push(`INSERT INTO decisions (id, project_id, statement, rationale, origin_proposal_id, authorised_by, authorised_at)
    SELECT md5('bench-decision-' || r)::uuid, md5('bench-project-' || (r % ${PROJECTS}))::uuid, pg_temp.bench_sentence('record-' || r),
           CASE WHEN r % 2 = 0 THEN pg_temp.bench_sentence('rationale-' || r) END, ${hp('r')},
           ${user(member('r % 50', '0'))}, ${NOW} - ((r % 80) * interval '1 day')
      FROM generate_series(500, 999) r`);
  sql.push(`INSERT INTO questions (id, project_id, text, requester_id, status, origin_proposal_id, authorised_by, authorised_at)
    SELECT md5('bench-question-' || r)::uuid, md5('bench-project-' || (r % ${PROJECTS}))::uuid, pg_temp.bench_sentence('record-' || r),
           ${user(member('r % 50', '5'))}, CASE WHEN r % 2 = 0 THEN 'answered' ELSE 'open' END, ${hp('r')},
           ${user(member('r % 50', '0'))}, ${NOW} - ((r % 80) * interval '1 day')
      FROM generate_series(1000, 1499) r`);
  sql.push(`INSERT INTO question_answers (id, question_id, answer, author_id, at)
    SELECT md5('bench-answer-' || r)::uuid, md5('bench-question-' || r)::uuid, pg_temp.bench_sentence('answer-' || r),
           ${user(member('r % 50', '0'))}, ${NOW} - ((r % 80) * interval '1 day') + interval '2 hours'
      FROM generate_series(1000, 1499) r WHERE r % 2 = 0`);
  sql.push(`INSERT INTO risks (id, project_id, description, severity, responsible_id, review_on, mitigation, status, origin_proposal_id, authorised_by, authorised_at)
    SELECT md5('bench-risk-' || r)::uuid, md5('bench-project-' || (r % ${PROJECTS}))::uuid, pg_temp.bench_sentence('record-' || r),
           (ARRAY['low', 'medium', 'high', 'critical'])[1 + r % 4], ${user(member('r % 50', '6'))}, (${NOW})::date + (r % 30),
           CASE WHEN r % 3 <> 0 THEN pg_temp.bench_sentence('mitigation-' || r) END,
           (ARRAY['open', 'mitigating', 'resolved', 'accepted'])[1 + r % 4], ${hp('r')},
           ${user(member('r % 50', '0'))}, ${NOW} - ((r % 80) * interval '1 day')
      FROM generate_series(1500, 1999) r`);
  return sql;
}

/** Adds the 4b data (no passages) once; a second run measures what is there. */
async function seedAssist(pool: Pool, now: Date, log: (m: string) => void): Promise<void> {
  const prior = await pool.query(`SELECT value FROM bench_meta WHERE key = 'assist_seeded_at'`);
  if (prior.rows[0]) {
    log(`4b data already seeded at ${prior.rows[0].value}; measuring what is there`);
    return;
  }
  const started = Date.now();
  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const statement of assistSeedSql(now)) await client.query(statement);
    await client.query(`INSERT INTO bench_meta (key, value) VALUES ('assist_seeded_at', $1)`, [new Date().toISOString()]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  for (const t of ['sources', 'source_versions', 'audiences', 'audience_members', 'human_proposals', 'tasks', 'decisions', 'questions', 'question_answers', 'risks']) {
    await pool.query(`ANALYZE ${t}`);
  }
  log(`4b data seeded in ${((Date.now() - started) / 1000).toFixed(1)} s`);
}

/** Nearest-rank percentile. */
const percentile = (xs: number[], q: number): number => [...xs].sort((a, b) => a - b)[Math.ceil(q * xs.length) - 1];
export interface Stats {
  n: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}
const stats = (xs: number[]): Stats => ({ n: xs.length, p50Ms: percentile(xs, 0.5), p95Ms: percentile(xs, 0.95), maxMs: Math.max(...xs) });
const ms = (n: number): string => `${n.toFixed(1)} ms`;
const statsText = (s: Stats): string => `n=${s.n}, p50 ${ms(s.p50Ms)}, p95 ${ms(s.p95Ms)}, max ${ms(s.maxMs)}`;
const timed = async <T>(work: () => Promise<T>): Promise<[number, T]> => {
  const t0 = performance.now();
  const value = await work();
  return [performance.now() - t0, value];
};

/** Questions in English, Malay and mixed; common words, rare code names, names and words found nowhere. */
const QUESTIONS = [
  'What did we decide about the delivery schedule?',
  'Who will follow up on the cost estimate?',
  'What is the status of the migration plan for the second phase?',
  'Why was the contract postponed?',
  'What are the risks with the supplier timeline?',
  'When is the handover checklist due?',
  'What happened with workstream Kestrel?',
  'Bila jadual penghantaran akan disahkan?',
  'Apakah keputusan tentang anggaran kos untuk fasa kedua?',
  'Siapa yang menyemak laporan ujian?',
  'What did finance say about the overdue invoice?',
  'Has the steering committee approved the revised budget?',
  'What is planned for the Johor warehouse layout?',
  'Did Ms Aisyah follow up on the training material?',
  'What did the audit findings say about the backup procedure?',
  'Is the licence renewal still pending approval from finance?',
  'Kenapa pembekal lewat dan apa risiko kepada jadual?',
  'What did we agree on the payroll interface after the site visit?',
  'Status of user acceptance tests for the pilot in three departments',
  'What is the latest on workstream Nautilus and workstream Cendana?',
  'Which decisions were made about the data retention policy?',
  'Are there open questions about the safety assessment?',
  'What is the network design for the Penang office?',
  'Summarise the staffing plan concerns raised by human resources',
  'Mr Tan Dr Lim Encik Rahman follow up items',
  'What did the vendor confirm before the go-live weekend?',
  'What changed in the risk register this month?',
  'What overtime costs were discussed?',
  'Pelan latihan dan pelan kakitangan untuk minggu hadapan',
  'Any news about the floor plan for facilities?',
  'What is the quantum entanglement policy for llamas?',
  'Which procurement requests were rejected?',
  'Was the service agreement signed off by legal?',
  'What is outstanding on the milestone plan by 3 December?',
  'Workstream Orion progress',
  'Mesyuarat jawatankuasa pemandu: apa yang dibincangkan tentang kontrak pembekal?',
  'How are we tracking against the quarterly budget and the delivery date?',
  'Who is responsible for the urgent technical test report?',
  'What did quality assurance escalate following the incident in October?',
  'Daftar risiko: apa yang perlu dikemas kini sebelum akhir bulan ini?',
];

type Who = 'member' | 'pm' | 'thread';

/** findMaterial over 200 varied questions (10 warm-up not counted), across Active projects and three kinds of asker. */
async function measureSearch(pool: Pool): Promise<{ all: Stats; byWho: Record<Who, Stats>; items: { min: number; median: number; max: number; empty: number } }> {
  const access = new ProjectAccess(pool, () => new Date());
  const userOf = async (n: number): Promise<AuthUser> =>
    (await pool.query(`SELECT id, email, display_name AS "displayName", role FROM users WHERE email = $1`, [`bench-user-${n}@example.org`])).rows[0] as AuthUser;
  const scopes = new Map<string, MaterialScope>();
  const scopeFor = async (i: number): Promise<{ who: Who; scope: MaterialScope }> => {
    const p = (i * 7) % 38; // projects 0..37 are Active
    const who: Who = (['member', 'member', 'pm', 'pm', 'thread'] as const)[i % 5];
    // Project p's member k is user 1 + (p * 8 + k) % 400: k = 6 is a plain member named in no Restricted audience, k = 0 the PM.
    const k = who === 'pm' ? 0 : 6;
    const t = p + PROJECTS * (i % 40); // a thread of project p (meetings for projects 3, 13, 23, 33)
    const key = `${who}:${p}:${who === 'thread' ? t : ''}`;
    let scope = scopes.get(key);
    if (!scope) {
      const projectId = (await pool.query(`SELECT md5('bench-project-' || $1::int)::uuid AS id`, [p])).rows[0].id as string;
      const ctx = await access.load(projectId, await userOf(1 + ((p * 8 + k) % USERS)));
      if (!ctx) throw new Error(`no project context for project ${p}`);
      if (who === 'thread') {
        const aud = (await pool.query(`SELECT audience_id AS id FROM discussion_threads WHERE id = md5('bench-thread-' || $1::int)::uuid`, [t])).rows[0].id as string;
        scope = { kind: 'thread', ctx, threadAudienceId: aud };
      } else scope = { kind: 'personal', ctx };
      scopes.set(key, scope);
    }
    return { who, scope };
  };
  const run = async (i: number) => {
    const { who, scope } = await scopeFor(i);
    const terms = buildTerms(QUESTIONS[(i * 13) % QUESTIONS.length]);
    const [took, items] = await timed(() => findMaterial(pool, scope, terms));
    return { who, took, items: items.length };
  };
  for (let i = 0; i < 10; i++) await run(1000 + i); // warm-up, not counted
  const all: number[] = [];
  const byWho: Record<Who, number[]> = { member: [], pm: [], thread: [] };
  const counts: number[] = [];
  for (let i = 0; i < 200; i++) {
    const r = await run(i);
    all.push(r.took);
    byWho[r.who].push(r.took);
    counts.push(r.items);
  }
  const sorted = [...counts].sort((a, b) => a - b);
  return {
    all: stats(all),
    byWho: { member: stats(byWho.member), pm: stats(byWho.pm), thread: stats(byWho.thread) },
    items: { min: sorted[0], median: sorted[Math.floor(sorted.length / 2)], max: sorted[sorted.length - 1], empty: counts.filter((c) => c === 0).length },
  };
}

type IndexMessage = (this: unknown, ...args: unknown[]) => Promise<void>;

/**
 * Posting through the real HTTP app, 400 posts alternating indexing on and off (10 warm-up not counted). Indexing is
 * switched by wrapping ThreadsService's indexMessage in this process only (the author lookup and indexVersion, the
 * whole indexing step of a post); with it on, the wrapper also times that step on its own. Posts made with indexing
 * off have no passages until the back-fill runs again.
 */
async function measurePosts(databaseUrl: string): Promise<{ on: Stats; off: Stats; indexing: Stats }> {
  const proto = ThreadsService.prototype as unknown as { indexMessage: IndexMessage };
  const original = proto.indexMessage;
  let indexing = true;
  const indexMs: number[] = [];
  proto.indexMessage = async function (this: unknown, ...args: unknown[]) {
    if (!indexing) return;
    const t0 = performance.now();
    await original.apply(this, args);
    indexMs.push(performance.now() - t0);
  };
  const { app, signIn } = await startApp(databaseUrl);
  try {
    const pool = new Pool({ connectionString: databaseUrl, max: 2 });
    let threads: string[];
    try {
      // Discussions of project 0 (Active, Project-wide); the poster is member 4 of project 0 (user 5).
      threads = (await pool.query(`SELECT md5('bench-thread-' || t)::uuid::text AS id FROM unnest(ARRAY[0, 50, 100, 150, 200, 250, 300, 350, 400, 450]) t`)).rows.map((r) => r.id as string);
    } finally {
      await pool.end();
    }
    const poster: Session = await signIn('bench-user-5@example.org');
    const post = async (i: number): Promise<number> => {
      const base = `${['Update', 'Following up on item', 'Noted, and a question on point', 'Kemas kini'][i % 4]} ${i}: ${QUESTIONS[i % QUESTIONS.length]} We should confirm the delivery date with the vendor, and Saya akan semak status tugasan itu esok pagi.`;
      // One post in twenty is long enough (over 1,500 characters) to be split into several passages.
      const body = i % 20 === 0 ? Array.from({ length: 12 }, (_, j) => `${base} (${j + 1})`).join(' ') : base;
      const [took, r] = await timed(() => poster.request('POST', `/threads/${threads[i % threads.length]}/messages`, { body }));
      if (r.status !== 201) throw new Error(`Posting failed with ${r.status}: ${r.text.slice(0, 200)}`);
      return took;
    };
    for (let i = 0; i < 10; i++) {
      indexing = i % 2 === 0;
      await post(i);
    }
    indexMs.length = 0;
    const on: number[] = [];
    const off: number[] = [];
    for (let i = 0; i < 400; i++) {
      indexing = i % 2 === 0;
      (indexing ? on : off).push(await post(10 + i));
    }
    if (indexMs.length !== on.length) throw new Error(`indexing timed ${indexMs.length} times for ${on.length} posts`);
    return { on: stats(on), off: stats(off), indexing: stats(indexMs) };
  } finally {
    await app.close();
    proto.indexMessage = original;
  }
}

export interface AssistBenchResult {
  counts: Record<string, number>;
  words: { min: number; max: number; restrictedNotes: number };
  backfill: { versions: number; passages: number; ms: number };
  search: Awaited<ReturnType<typeof measureSearch>>;
  posts: Awaited<ReturnType<typeof measurePosts>>;
}

export async function runAssistBench(databaseUrl: string, log: (m: string) => void = console.log): Promise<AssistBenchResult> {
  assertAssistBenchDatabase(databaseUrl);
  const pool = new Pool({ connectionString: databaseUrl, max: 10 });
  try {
    const now = await seedBench(pool, log, assertAssistBenchDatabase);
    await seedAssist(pool, now, log);

    log('back-fill: indexing every source and message version without passages ...');
    let batches = 0;
    const backfill = await backfillPassages(pool, (m) => {
      if (++batches % 40 === 0) log(`  ${m}`);
    });
    log(`back-fill: ${backfill.versions} versions, ${backfill.passages} passages in ${(backfill.ms / 1000).toFixed(1)} s`);
    for (const t of ['passages']) await pool.query(`ANALYZE ${t}`);

    const counts: Record<string, number> = {};
    for (const [label, sql] of [
      ['users', 'SELECT count(*) FROM users'],
      ['projects', 'SELECT count(*) FROM projects'],
      ['threads', 'SELECT count(*) FROM discussion_threads'],
      ['messages', 'SELECT count(*) FROM discussion_messages'],
      ['message versions', 'SELECT count(*) FROM message_versions'],
      ['notes and minutes sources', `SELECT count(*) FROM sources WHERE kind IN ('notes', 'minutes')`],
      ['notes and minutes versions', `SELECT count(*) FROM source_versions v JOIN sources s ON s.id = v.source_id WHERE s.kind IN ('notes', 'minutes')`],
      ['tasks', 'SELECT count(*) FROM tasks'],
      ['decisions', 'SELECT count(*) FROM decisions'],
      ['questions', 'SELECT count(*) FROM questions'],
      ['risks', 'SELECT count(*) FROM risks'],
      ['pending human proposals', `SELECT count(*) FROM human_proposals WHERE review_status = 'pending'`],
      ['passages from sources', `SELECT count(*) FROM passages WHERE owner_kind = 'source_version'`],
      ['passages from messages', `SELECT count(*) FROM passages WHERE owner_kind = 'message_version'`],
    ] as const) {
      counts[label] = Number((await pool.query(sql)).rows[0].count);
    }
    const w = (
      await pool.query(
        `SELECT min(array_length(regexp_split_to_array(btrim(v.text_content), '\\s+'), 1)) AS min,
                max(array_length(regexp_split_to_array(btrim(v.text_content), '\\s+'), 1)) AS max,
                (SELECT count(*) FROM sources s JOIN audiences a ON a.id = s.audience_id WHERE s.kind IN ('notes', 'minutes') AND a.mode = 'restricted') AS restricted
           FROM source_versions v JOIN sources s ON s.id = v.source_id WHERE s.kind IN ('notes', 'minutes')`,
      )
    ).rows[0];
    const words = { min: Number(w.min), max: Number(w.max), restrictedNotes: Number(w.restricted) };
    log(`data: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}`);
    log(`notes and minutes: ${words.min} to ${words.max} words per version (headings included); ${words.restrictedNotes} of the sources Restricted`);

    const search = await measureSearch(pool);
    const posts = await measurePosts(databaseUrl);
    log('');
    log(`material search (aim p95 < 300 ms): ${statsText(search.all)}`);
    for (const who of ['member', 'pm', 'thread'] as const) log(`  ${who === 'thread' ? 'thread scope' : `personal scope, ${who === 'pm' ? 'PM' : 'member'}`}: ${statsText(search.byWho[who])}`);
    log(`  items returned per question: min ${search.items.min}, median ${search.items.median}, max ${search.items.max}; ${search.items.empty} questions found nothing`);
    log(`post a message with indexing (aim p95 < 300 ms): ${statsText(posts.on)}`);
    log(`post a message with indexing switched off: ${statsText(posts.off)}`);
    log(`indexing step's own time in the posts with indexing (aim p95 < 20 ms): ${statsText(posts.indexing)}`);
    log(`difference of post p95 with and without indexing: ${ms(posts.on.p95Ms - posts.off.p95Ms)}`);
    return { counts, words, backfill, search, posts };
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('Set DATABASE_URL to a migrated database whose name ends in _test or _bench.');
    process.exit(1);
  }
  runAssistBench(url).then(
    () => process.exit(0),
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
