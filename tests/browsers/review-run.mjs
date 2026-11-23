// A finished AI extraction run with decisions waiting, so the review screen (#/runs/:id) can be checked without an AI
// provider. Writes straight to the database, as tests/a11y/audit.mjs does: a TEST installation seeded with the load-test seed only.
//
//   DATABASE_URL=… node review-run.mjs [count]      (prints where to find it; count = decisions in the run, default 3)
//
// The run is on the newest version of "Meeting notes 6.1" in Load Project 06, where load-001@example.org is the Owner
// (an Owner may authorise). Each decision quotes one line of those notes exactly, so each can be authorised.
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pg = createRequire(join(here, '..', '..', 'app', 'package.json'))('pg');

export const REVIEW_NOTE = 'Meeting notes 6.1';
export const REVIEW_NOTE_PROJECT = 'Load Project 06';
const REQUESTER = 'load-001@example.org';
const FAKE_MODEL = 'load-test-fake-model';

/** The lines quoted, in the seed's note text order: [start of line, the decision it becomes]. */
const DECISIONS = [
  ['The team agreed to review the ', (line) => `Review the ${line.match(/review the (\w+)/)[1]} figures before the next meeting`],
  ['Action: the Project Manager will prepare the ', (line) => `Prepare the ${line.match(/prepare the (\w+)/)[1]} report by Friday`],
  ['Discussion covered the ', (line) => `Settle the ${line.match(/covered the (\w+)/)[1]} timetable`],
];

/** Inserts one succeeded run with `count` (1–3) decisions; returns its id and the decisions' text. */
export async function createReviewRun(databaseUrl, count = 1) {
  if (!databaseUrl) throw new Error('DATABASE_URL must name the test installation database.');
  const db = new pg.Client({ connectionString: databaseUrl });
  await db.connect();
  try {
    const org = (await db.query('SELECT name FROM organisation WHERE id = 1')).rows[0];
    if (org?.name !== 'Example Organisation') throw new Error('Refusing: this database is not the seeded load-test organisation.');
    const version = (
      await db.query(
        `SELECT sv.id, sv.text_content FROM sources s JOIN source_versions sv ON sv.source_id = s.id JOIN projects p ON p.id = s.project_id
          WHERE s.title = $1 AND p.name = $2 ORDER BY sv.version_no DESC LIMIT 1`,
        [REVIEW_NOTE, REVIEW_NOTE_PROJECT],
      )
    ).rows[0];
    if (!version) throw new Error(`No "${REVIEW_NOTE}" in ${REVIEW_NOTE_PROJECT}: seed the database with the load-test seed first.`);
    const requester = (await db.query('SELECT id FROM users WHERE email = $1', [REQUESTER])).rows[0].id;
    const text = version.text_content;
    const items = DECISIONS.slice(0, Math.max(1, Math.min(count, DECISIONS.length))).map(([starts, toText]) => {
      const start = text.indexOf(starts);
      if (start < 0) throw new Error(`The note no longer has the line starting "${starts}".`);
      const end = text.indexOf('\n', start) < 0 ? text.length : text.indexOf('\n', start);
      const quote = text.slice(start, end);
      return { text: toText(quote), quote, start, end };
    });
    const runId = randomUUID();
    await db.query('BEGIN');
    await db.query(
      `INSERT INTO extraction_runs (id, source_version_id, requested_by, status, model_id, attempts, item_count, unlocated_count, created_at, finished_at)
       VALUES ($1, $2, $3, 'succeeded', $4, 1, $5, 0, now(), now())`,
      [runId, version.id, requester, FAKE_MODEL, items.length],
    );
    for (const [i, it] of items.entries()) {
      await db.query(
        `INSERT INTO extraction_items (id, run_id, source_version_id, position, kind, text, quote, quote_start, quote_end, quote_matches, created_at)
         VALUES ($1, $2, $3, $4, 'decision', $5, $6, $7, $8, 1, now())`,
        [randomUUID(), runId, version.id, i, it.text, it.quote, it.start, it.end],
      );
    }
    await db.query('COMMIT');
    return { runId, decisions: items.map((it) => it.text) };
  } catch (e) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    await db.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const count = Number(process.argv[2] ?? 3);
  createReviewRun(process.env.DATABASE_URL, count).then(
    (r) => {
      console.log(`A finished AI run with ${r.decisions.length} decisions to review is on "${REVIEW_NOTE}" in ${REVIEW_NOTE_PROJECT} (Review button).`);
      for (const d of r.decisions) console.log(`  - ${d}`);
    },
    (e) => {
      console.error(e.message);
      process.exit(1);
    },
  );
}
