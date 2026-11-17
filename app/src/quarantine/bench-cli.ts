import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { type Session, assertBenchDatabase, seedBench, startApp } from '../analysis/bench-cli';
import { type Stats, measureSearch, seedAssist } from '../assist/bench-cli';
import { backfillPassages } from '../assist/passage-index';
import { newKeyBytes } from './protected-key';

/**
 * Measured aims of sub-project 5 (history spec 10) on the 4b bench data.
 *
 *   DATABASE_URL=postgres://.../kainow_bench npm run migrate && DATABASE_URL=... npm run bench-history
 *
 * Seeds the 4a and 4b data sets (skipped when already there) and back-fills passages, then measures:
 *   1. passage search (`findMaterial`, as the 4b bench) with the Deleted and held filters in place, against 66 ms;
 *   2. report-to-cleaned: 50 reports, each of a secret in one large note (5,000 to 8,000 words, with its passages)
 *      that also appears in three messages of the project: the report request through holding, cleaning the note and
 *      its passages, the project-wide copy search and masking the three messages;
 *   3. confirming the three copies of each case (one request).
 * Requests go through the real HTTP app on loopback with a protected key made for this run in a temporary file (never
 * printed, removed afterwards). Five warm-up rounds are not counted; percentiles are nearest-rank.
 *
 * Refuses any database whose name does not end in `_bench`; use `kainow_bench`.
 */

const USERS = 400;
const ROUNDS = 50;
const WARM_UP = 5;
/** Active projects (0..37) without meetings in their first threads, so every pick has discussion threads. */
const ACTIVE = Array.from({ length: 38 }, (_, p) => p).filter((p) => p % 10 !== 3);

const percentile = (xs: number[], q: number): number => [...xs].sort((a, b) => a - b)[Math.ceil(q * xs.length) - 1];
const stats = (xs: number[]): Stats => ({ n: xs.length, p50Ms: percentile(xs, 0.5), p95Ms: percentile(xs, 0.95), maxMs: Math.max(...xs) });
const ms = (n: number): string => `${n.toFixed(1)} ms`;
const statsText = (s: Stats): string => `n=${s.n}, p50 ${ms(s.p50Ms)}, p95 ${ms(s.p95Ms)}, max ${ms(s.maxMs)}`;
const timed = async <T>(work: () => Promise<T>): Promise<[number, T]> => {
  const t0 = performance.now();
  const value = await work();
  return [performance.now() - t0, value];
};
const emailOf = (p: number, k: number): string => `bench-user-${1 + ((p * 8 + k) % USERS)}@example.org`;

export interface HistoryBenchResult {
  searchBefore: Awaited<ReturnType<typeof measureSearch>>;
  searchAfter: Awaited<ReturnType<typeof measureSearch>>;
  report: Stats;
  confirm: Stats;
  words: { min: number; max: number };
  passagesPerNote: { min: number; max: number };
}

/** A secret the credential check does not know (a person marks it), unique to the round. */
const secretOf = (run: string, i: number): string => `Qv${i}harbor-${run}Lantern${(i * 7919) % 1000}`;

export async function runHistoryBench(databaseUrl: string, log: (m: string) => void = console.log): Promise<HistoryBenchResult> {
  assertBenchDatabase(databaseUrl);
  const pool = new Pool({ connectionString: databaseUrl, max: 10 });
  const dir = mkdtempSync(join(tmpdir(), 'kainow-history-bench-'));
  try {
    const now = await seedBench(pool, log);
    await seedAssist(pool, now, log);
    const backfill = await backfillPassages(pool, () => undefined);
    if (backfill.versions > 0) log(`back-fill: ${backfill.versions} versions, ${backfill.passages} passages in ${(backfill.ms / 1000).toFixed(1)} s`);
    await pool.query('ANALYZE passages');

    log('passage search with the Deleted and held filters (before any report) ...');
    const searchBefore = await measureSearch(pool);
    log(`  ${statsText(searchBefore.all)}`);

    // The key for this run: a temporary file, never printed.
    const keyFile = join(dir, 'protected.key');
    writeFileSync(keyFile, newKeyBytes().bytes, { mode: 0o600 });
    const { app, signIn } = await startApp(databaseUrl, { KAINOW_PROTECTED_KEY_FILE: keyFile });
    try {
      const run = Date.now().toString(36).slice(-4);
      const sessions = new Map<string, Session>();
      const as = async (email: string): Promise<Session> => {
        let s = sessions.get(email);
        if (!s) {
          s = await signIn(email);
          sessions.set(email, s);
        }
        return s;
      };
      const send = async (s: Session, method: string, path: string, body: unknown, expect: number) => {
        const r = await s.request(method, path, body);
        if (r.status !== expect) throw new Error(`${method} ${path} answered ${r.status}`);
        return JSON.parse(r.text);
      };

      const reportMs: number[] = [];
      const confirmMs: number[] = [];
      const words: number[] = [];
      const passageCounts: number[] = [];
      for (let i = 0; i < WARM_UP + ROUNDS; i++) {
        const p = ACTIVE[i % ACTIVE.length];
        const projectId = (await pool.query(`SELECT md5('bench-project-' || $1::int)::uuid::text AS id`, [p])).rows[0].id as string;
        const secret = secretOf(run, i);
        // A large note: the text of a seeded note (the longest first; the seed's own notes, never one made here), with the
        // secret written twice into it. Taken from any project: project 7's seeded notes are all Deleted.
        const base = (
          await pool.query(
            `SELECT v.text_content AS text FROM source_versions v JOIN sources s ON s.id = v.source_id
              WHERE s.kind = 'notes' AND s.id IN (SELECT md5('bench-source-' || d)::uuid FROM generate_series(0, 379) d)
              ORDER BY length(v.text_content) DESC, v.id LIMIT 1 OFFSET $1`,
            [i],
          )
        ).rows[0].text as string;
        const cut1 = base.indexOf('. ', Math.floor(base.length / 3)) + 2;
        const cut2 = base.indexOf('. ', Math.floor((base.length * 2) / 3)) + 2;
        const text = `${base.slice(0, cut1)}The plant room vault code is ${secret} until March. ${base.slice(cut1, cut2)}Use ${secret} only on site. ${base.slice(cut2)}`;
        words.push(text.trim().split(/\s+/).length);
        const pm = await as(emailOf(p, 0));
        const note = await send(pm, 'POST', `/projects/${projectId}/notes`, { title: `Plant room ${run}-${i}`, text }, 201);
        const sourceId = note.source.id as string;
        passageCounts.push(
          Number(
            (await pool.query(`SELECT count(*) AS n FROM passages p JOIN source_versions v ON p.owner_kind = 'source_version' AND p.owner_id = v.id WHERE v.source_id = $1`, [sourceId])).rows[0].n,
          ),
        );
        // Three copies in messages of the project's discussions.
        const threads = (
          await pool.query(`SELECT id FROM discussion_threads WHERE project_id = $1 AND kind = 'discussion' AND held_case_id IS NULL ORDER BY id LIMIT 3`, [projectId])
        ).rows.map((r) => r.id as string);
        if (threads.length < 3) throw new Error(`project ${p} has fewer than three discussions`);
        const poster = await as(emailOf(p, 4));
        const copies: string[] = [];
        for (const [j, t] of threads.entries()) {
          copies.push((await send(poster, 'POST', `/threads/${t}/messages`, { body: `Copy ${j + 1}: the vault code ${secret} is for the plant room.` }, 201)).id as string);
        }

        // Timed: the report request, which holds the note, cleans it with its passages, searches the project and masks the copies.
        const reporter = await as(emailOf(p, 6));
        const [took, r] = await timed(() => send(reporter, 'POST', `/projects/${projectId}/secret-reports`, { kind: 'source', id: sourceId, marked: [secret], reason: 'Looks like the plant room vault code' }, 201));
        const caseId = r.caseId as string;
        const c = (await pool.query(`SELECT state, (SELECT count(*) FROM quarantine_possible_copies WHERE case_id = $1 AND masked) AS masked FROM quarantine_cases WHERE id = $1`, [caseId])).rows[0];
        if (c.state !== 'cleaned' || Number(c.masked) !== 3) throw new Error(`round ${i}: case ${c.state} with ${c.masked} masked copies`);

        // Timed: confirming the three copies in one request.
        const decisions = copies.map((id) => ({ kind: 'message', id, decision: 'confirmed' }));
        const [took2] = await timed(() => send(pm, 'POST', `/quarantine/cases/${caseId}/copies`, { decisions }, 200));
        if (i >= WARM_UP) {
          reportMs.push(took);
          confirmMs.push(took2);
        }
        if ((i + 1) % 10 === 0) log(`  ${i + 1} of ${WARM_UP + ROUNDS} rounds`);
      }
      const report = stats(reportMs);
      const confirm = stats(confirmMs);
      log(`report-to-cleaned (aim p95 < 2 s): ${statsText(report)}`);
      log(`confirming three copies (aim p95 < 2 s): ${statsText(confirm)}`);
      const counted = words.slice(WARM_UP);
      const counts = passageCounts.slice(WARM_UP);
      log(`notes reported: ${Math.min(...counted)} to ${Math.max(...counted)} words, ${Math.min(...counts)} to ${Math.max(...counts)} passages each`);

      await pool.query('ANALYZE passages');
      log('passage search with the Deleted and held filters (after the reports) ...');
      const searchAfter = await measureSearch(pool);
      log(`  ${statsText(searchAfter.all)}`);
      log(`passage search p95 (aim within 10% of 66 ms, i.e. under 72.6 ms): before ${ms(searchBefore.all.p95Ms)}, after ${ms(searchAfter.all.p95Ms)}`);
      return {
        searchBefore,
        searchAfter,
        report,
        confirm,
        words: { min: Math.min(...counted), max: Math.max(...counted) },
        passagesPerNote: { min: Math.min(...counts), max: Math.max(...counts) },
      };
    } finally {
      await app.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await pool.end();
  }
}

if (require.main === module) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('Set DATABASE_URL to a migrated database whose name ends in _bench.');
    process.exit(1);
  }
  runHistoryBench(url).then(
    () => process.exit(0),
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
