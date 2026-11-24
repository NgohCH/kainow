import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { Pool, type PoolClient } from 'pg';
import { indexVersion } from '../assist/passage-index';
import { loadDatabaseConfig } from '../config';
import { uuidv7 } from '../common/uuid7';
import { runMigrations } from '../db/migrate';
import { SKIP_NO_DB, resetPublicSchema, testDatabaseUrl } from '../testing/db';
import { seedProject, seedUser } from '../testing/projects';
import { MARKER } from './clean-text';
import { cleanItem, findPlaces, quoteChangedItems, restoreOriginals } from './clean';
import { loadProtectedKey, newKeyBytes, type ProtectedKey } from './protected-key';
import type { ItemKind } from './registry';

const migrationsDir = loadDatabaseConfig({ DATABASE_URL: 'x' }).migrationsDir;
const SECRET = 'Xy7!pass';
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

/** Every piece of the secret longer than 3 characters (Review Focus 1). */
const FRAGMENTS = (() => {
  const out: string[] = [];
  for (let n = 4; n <= SECRET.length; n++) for (let i = 0; i + n <= SECRET.length; i++) out.push(SECRET.slice(i, i + n));
  return out;
})();
const fragmentIn = (s: string | null) => (s === null ? undefined : FRAGMENTS.find((f) => s.includes(f)));

describe('the setting string', () => {
  test('the setting string used only in the quarantine module', () => {
    const src = join(__dirname, '..', '..', 'src');
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && readFileSync(p, 'utf8').includes('kainow.quarantine_write')) {
          found.push(relative(src, p).replace(/\\/g, '/'));
        }
      }
    };
    walk(src);
    assert.deepEqual(found, ['quarantine/clean.ts']);
  });
});

describe('cleaning engine (spec 7.4)', { skip: SKIP_NO_DB }, () => {
  let pool: Pool;
  let key: ProtectedKey;
  let user: string;

  before(async () => {
    pool = new Pool({ connectionString: testDatabaseUrl() });
    await resetPublicSchema(pool);
    await runMigrations(pool, migrationsDir);
    const dir = mkdtempSync(join(tmpdir(), 'kainow-clean-'));
    writeFileSync(join(dir, 'key'), newKeyBytes().bytes);
    key = loadProtectedKey(join(dir, 'key')) as ProtectedKey;
    user = await seedUser(pool, 'cleaner@example.org');
  });
  after(async () => {
    await pool.end();
  });

  const newProject = () => seedProject(pool, { status: 'active', members: [{ userId: user, role: 'pm' }] });

  async function openCase(project: string, kind: ItemKind, id: string): Promise<string> {
    const caseId = uuidv7();
    await pool.query(
      `INSERT INTO quarantine_cases (id, project_id, item_kind, item_id, reporter_id, reason, marked_length, reported_at)
       VALUES ($1, $2, $3, $4, $5, 'looks like a password', $6, now())`,
      [caseId, project, kind, id, user, SECRET.length],
    );
    return caseId;
  }

  async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const out = await fn(c);
      await c.query('COMMIT');
      return out;
    } catch (err) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
  }

  async function clean(project: string, kind: ItemKind, id: string, marks = [SECRET]): Promise<{ caseId: string; rows: number }> {
    const caseId = await openCase(project, kind, id);
    const { rows } = await tx((c) => cleanItem(c, key, caseId, kind, id, marks));
    return { caseId, rows };
  }

  async function seedSource(project: string, text: string, opts: { upload?: Buffer; index?: boolean; kind?: string } = {}): Promise<{ source: string; version: string }> {
    const source = uuidv7();
    await pool.query(
      `INSERT INTO sources (id, title, created_by, created_at, project_id, kind) VALUES ($1, 'Keys', $2, now(), $3, $4)`,
      [source, user, project, opts.kind ?? 'notes'],
    );
    const version = uuidv7();
    await pool.query(
      `INSERT INTO source_versions (id, source_id, version_no, origin, filename, media_type, original_bytes, original_sha256, text_content, text_sha256, char_count, created_by, created_at)
       VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())`,
      [
        version, source, opts.upload ? 'upload' : 'paste', opts.upload ? 'keys.docx' : null,
        opts.upload ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : null,
        opts.upload ?? null, opts.upload ? sha(opts.upload) : null, text, sha(text), text.length, user,
      ],
    );
    if (opts.index !== false) await indexVersion(pool, 'source_version', version, project, text);
    return { source, version };
  }

  async function seedItem(version: string, quote: string, place: { start: number; end: number } | null): Promise<string> {
    const run = uuidv7();
    await pool.query(`INSERT INTO extraction_runs (id, source_version_id, requested_by, status, created_at) VALUES ($1, $2, $3, 'succeeded', now())`, [run, version, user]);
    const id = uuidv7();
    await pool.query(
      `INSERT INTO extraction_items (id, run_id, source_version_id, position, kind, text, quote, quote_start, quote_end, quote_matches, created_at)
       VALUES ($1, $2, $3, 0, 'action', 'Rotate it', $4, $5, $6, $7, now())`,
      [id, run, version, quote, place?.start ?? null, place?.end ?? null, place ? 1 : 0],
    );
    return id;
  }

  async function seedThread(project: string): Promise<string> {
    const audience = uuidv7();
    await pool.query(`INSERT INTO audiences (id, project_id, mode, created_at) VALUES ($1, $2, 'project', now())`, [audience, project]);
    const thread = uuidv7();
    await pool.query(
      `INSERT INTO discussion_threads (id, project_id, kind, title, audience_id, created_by, created_at) VALUES ($1, $2, 'discussion', 'Keys', $3, $4, now())`,
      [thread, project, audience, user],
    );
    return thread;
  }

  async function seedMessage(thread: string, no: number, body: string): Promise<{ message: string; mv: string }> {
    const message = uuidv7();
    await pool.query(`INSERT INTO discussion_messages (id, thread_id, message_no, author_id, created_at) VALUES ($1, $2, $3, $4, now())`, [message, thread, no, user]);
    const mv = uuidv7();
    await pool.query(`INSERT INTO message_versions (id, message_id, version_no, body, body_sha256, created_at) VALUES ($1, $2, 1, $3, $4, now())`, [mv, message, body, sha(body)]);
    return { message, mv };
  }

  async function seedTask(project: string, title: string): Promise<string> {
    const task = uuidv7();
    await pool.query(
      `INSERT INTO tasks (id, project_id, depth, title, assignee_id, due_on, status, authorised_by, authorised_at)
       VALUES ($1, $2, 0, $3, $4, '2026-11-20', 'in_progress', $4, now())`,
      [task, project, title, user],
    );
    return task;
  }

  const versionText = async (version: string): Promise<string> =>
    (await pool.query(`SELECT text_content FROM source_versions WHERE id = $1`, [version])).rows[0].text_content;

  const passagesOf = async (ownerKind: string, owner: string) =>
    (await pool.query(`SELECT id, start_offset, end_offset, body, location FROM passages WHERE owner_kind = $1 AND owner_id = $2 ORDER BY ordinal`, [ownerKind, owner])).rows;

  test('cleaning a notes version removes the secret from text, passages, search view and quotes', async () => {
    const project = await newProject();
    const intro = 'Intro paragraph about the staging rollout and who looks after it during the week.';
    const text = `${intro}\n\nThe key is ${SECRET} for staging, keep it safe.\n\nOutro: rotate monthly.`;
    const { source, version } = await seedSource(project, text);
    const at = text.indexOf('The key is');
    const located = await seedItem(version, `The key is ${SECRET}`, { start: at, end: at + `The key is ${SECRET}`.length });
    const outroAt = text.indexOf('Outro');
    const after = await seedItem(version, 'Outro: rotate monthly.', { start: outroAt, end: text.length });
    const unlocated = await seedItem(version, 'key is Xy7!p', null);

    const search = async () =>
      Number((await pool.query(`SELECT count(*) FROM search_documents WHERE project_id = $1 AND strpos(text, $2) > 0`, [project, SECRET])).rows[0].count) +
      Number((await pool.query(`SELECT count(*) FROM passages WHERE project_id = $1 AND simple @@ to_tsquery('simple', 'xy7')`, [project])).rows[0].count);
    assert.ok((await search()) > 0, 'the search found the secret before cleaning');

    const { rows } = await clean(project, 'source', source);
    assert.ok(rows > 0);

    const cleaned = await versionText(version);
    assert.equal(cleaned, text.replace(SECRET, MARKER));
    const v = (await pool.query(`SELECT text_sha256, char_count FROM source_versions WHERE id = $1`, [version])).rows[0];
    assert.equal(v.text_sha256, sha(cleaned), 'the text hash follows the cleaned text');
    assert.equal(v.char_count, cleaned.length);

    for (const p of await passagesOf('source_version', version)) {
      assert.equal(fragmentIn(p.body), undefined);
      assert.equal(p.body, cleaned.slice(p.start_offset, p.end_offset), 'a passage body is its slice of the cleaned text');
    }
    assert.equal(await search(), 0, 'the search view and the passage index no longer find it');

    const items = new Map(
      (await pool.query(`SELECT id, quote, quote_start, quote_end FROM extraction_items WHERE source_version_id = $1`, [version])).rows.map((r) => [r.id, r]),
    );
    const l = items.get(located);
    assert.equal(l.quote, `The key is ${MARKER}`);
    assert.equal(cleaned.slice(l.quote_start, l.quote_end), l.quote);
    const a = items.get(after);
    assert.equal(a.quote, 'Outro: rotate monthly.');
    assert.equal(cleaned.slice(a.quote_start, a.quote_end), a.quote, 'a quote after the secret moved with it');
    assert.equal(items.get(unlocated).quote, `key is ${MARKER}`, 'a cut-off secret at the end of an unplaced quote is removed');
    assert.deepEqual([...(await quoteChangedItems(pool, [located, after, unlocated]))].sort(), [located, unlocated].sort());
  });

  test('secret crossing a passage boundary leaves no fragment and offsets still slice', async () => {
    const project = await newProject();
    // A document whose two passages are cut inside the secret.
    const text = `alpha beta ${SECRET} gamma delta`;
    const { source, version } = await seedSource(project, text, { index: false });
    const cut = text.indexOf(SECRET) + 4;
    for (const [ordinal, start, end] of [[0, 0, cut], [1, cut, text.length]]) {
      await pool.query(
        `INSERT INTO passages (id, project_id, owner_kind, owner_id, ordinal, location, start_offset, end_offset, body)
         VALUES ($1, $2, 'source_version', $3, $4, 'Paragraph 1', $5, $6, $7)`,
        [uuidv7(), project, version, ordinal, start, end, text.slice(start as number, end as number)],
      );
    }
    // A quote that stops inside the secret.
    const quoteEnd = text.indexOf(SECRET) + 5;
    const quoted = await seedItem(version, text.slice(6, quoteEnd), { start: 6, end: quoteEnd });
    await clean(project, 'source', source);
    const cleaned = await versionText(version);
    for (const p of await passagesOf('source_version', version)) {
      assert.equal(fragmentIn(p.body), undefined, `passage ${p.body}`);
      assert.equal(p.body, cleaned.slice(p.start_offset, p.end_offset));
      assert.ok(p.body.includes(MARKER), 'both halves carry the whole marker');
    }
    const q = (await pool.query(`SELECT quote, quote_start, quote_end FROM extraction_items WHERE id = $1`, [quoted])).rows[0];
    assert.equal(fragmentIn(q.quote), undefined);
    assert.equal(q.quote, cleaned.slice(q.quote_start, q.quote_end));
    assert.equal(q.quote, `beta ${MARKER}`);

    // A discussion transcript: the message's span and the next one's still slice the cleaned transcript.
    const thread = await seedThread(project);
    const first = await seedMessage(thread, 1, `the secret is ${SECRET} ok`);
    const second = await seedMessage(thread, 2, 'thanks, noted');
    const transcript = uuidv7();
    await pool.query(
      `INSERT INTO sources (id, title, created_at, project_id, kind, audience_id, thread_id, publication)
       VALUES ($1, 'Keys', now(), $2, 'discussion', (SELECT audience_id FROM discussion_threads WHERE id = $3), $3, 'published')`,
      [transcript, project, thread],
    );
    const h1 = '#1 Ada:\n';
    const h2 = '\n\n#2 Ada:\n';
    const body1 = `the secret is ${SECRET} ok`;
    const ttext = `${h1}${body1}${h2}thanks, noted`;
    const tv = uuidv7();
    await pool.query(
      `INSERT INTO source_versions (id, source_id, version_no, origin, text_content, text_sha256, char_count, created_at) VALUES ($1, $2, 1, 'discussion', $3, $4, $5, now())`,
      [tv, transcript, ttext, sha(ttext), ttext.length],
    );
    const b2 = h1.length + body1.length + h2.length;
    await pool.query(
      `INSERT INTO transcript_spans (source_version_id, message_no, message_version_id, author_id, header_start, body_start, body_end)
       VALUES ($1, 1, $2, $3, 0, $4, $5), ($1, 2, $6, $3, $7, $8, $9)`,
      [tv, first.mv, user, h1.length, h1.length + body1.length, second.mv, h1.length + body1.length, b2, ttext.length],
    );
    // A transcript quote cut inside the secret, and a quote of the next message.
    const tq = await seedItem(tv, ttext.slice(h1.length, h1.length + 20), { start: h1.length, end: h1.length + 20 });
    const tq2 = await seedItem(tv, 'thanks, noted', { start: b2, end: ttext.length });
    const spansBefore = (await pool.query(`SELECT * FROM transcript_spans WHERE source_version_id = $1 ORDER BY message_no`, [tv])).rows;
    const { caseId } = await clean(project, 'message', first.message);

    const ctext = await versionText(tv);
    const spans = (await pool.query(`SELECT message_no, header_start, body_start, body_end FROM transcript_spans WHERE source_version_id = $1 ORDER BY message_no`, [tv])).rows;
    const mbody = (await pool.query(`SELECT body FROM message_versions WHERE id = $1`, [first.mv])).rows[0].body;
    assert.equal(mbody, `the secret is ${MARKER} ok`);
    assert.equal(ctext.slice(spans[0].body_start, spans[0].body_end), mbody, 'the span slices the cleaned message');
    assert.equal(ctext.slice(spans[1].body_start, spans[1].body_end), 'thanks, noted', 'the next span moved with the text');
    assert.equal(ctext.slice(spans[1].header_start, spans[1].body_start), h2);
    for (const s of spans) assert.equal(fragmentIn(ctext.slice(s.header_start, s.body_end)), undefined);
    for (const id of [tq, tq2]) {
      const r = (await pool.query(`SELECT quote, quote_start, quote_end FROM extraction_items WHERE id = $1`, [id])).rows[0];
      assert.equal(fragmentIn(r.quote), undefined);
      assert.equal(r.quote, ctext.slice(r.quote_start, r.quote_end));
    }
    for (const p of await passagesOf('message_version', first.mv)) {
      assert.equal(fragmentIn(p.body), undefined);
      assert.equal(p.body, mbody.slice(p.start_offset, p.end_offset));
    }

    // Released unchanged: the transcript and its spans (a moved primary key) are back exactly.
    assert.deepEqual((await tx((c) => restoreOriginals(c, key, caseId))).changed, []);
    assert.equal(await versionText(tv), ttext);
    assert.deepEqual((await pool.query(`SELECT * FROM transcript_spans WHERE source_version_id = $1 ORDER BY message_no`, [tv])).rows, spansBefore);
  });

  test("an uploaded file's original bytes are withheld and encrypted", async () => {
    const project = await newProject();
    const bytes = Buffer.from(`PK\u0003\u0004 binary with ${SECRET} inside`, 'latin1');
    const { source, version } = await seedSource(project, `Uploaded: ${SECRET}`, { upload: bytes });
    const { caseId } = await clean(project, 'source', source);
    const v = (await pool.query(`SELECT original_bytes, original_sha256, quarantined_at FROM source_versions WHERE id = $1`, [version])).rows[0];
    assert.equal(v.original_bytes, null);
    assert.equal(v.original_sha256, null, 'the hash of the withheld file goes with it');
    assert.ok(v.quarantined_at instanceof Date);
    const o = (await pool.query(
      `SELECT ciphertext, nonce, tag, key_id, row_key, cleaned_sha256 FROM quarantine_originals WHERE case_id = $1 AND table_name = 'source_versions' AND column_name = 'original_bytes'`,
      [caseId],
    )).rows;
    assert.equal(o.length, 1);
    assert.deepEqual(o[0].row_key, { id: version });
    assert.equal(o[0].key_id, key.id);
    assert.ok(!o[0].ciphertext.includes(Buffer.from(SECRET)), 'stored encrypted');
    assert.ok(key.decrypt(o[0]).equals(bytes));

    const r = await tx((c) => restoreOriginals(c, key, caseId));
    assert.deepEqual(r.changed, []);
    const back = (await pool.query(`SELECT original_bytes, original_sha256, quarantined_at, text_content FROM source_versions WHERE id = $1`, [version])).rows[0];
    assert.ok(back.original_bytes.equals(bytes));
    assert.equal(back.original_sha256, sha(bytes));
    assert.equal(back.quarantined_at, null);
    assert.equal(back.text_content, `Uploaded: ${SECRET}`);
  });

  test('secret in an earlier deletion reason is cleaned', async () => {
    const project = await newProject();
    const { source } = await seedSource(project, `notes with ${SECRET}`);
    const reason = `deleting — it had password ${SECRET}`;
    await pool.query(`UPDATE sources SET deleted_by = $2, deleted_at = now(), delete_reason = $3 WHERE id = $1`, [source, user, reason]);
    await pool.query(`INSERT INTO source_events (id, source_id, project_id, kind, actor_id, reason, at) VALUES ($1, $2, $3, 'deleted', $4, $5, now())`, [uuidv7(), source, project, user, reason]);
    // An item-less reason in the same project (a membership hold), and a task's reason.
    await pool.query(`UPDATE memberships SET hold_reason = $2, held_at = now(), held_by = $3 WHERE project_id = $1`, [project, reason, user]);
    const task = await seedTask(project, 'Rotate keys');
    await pool.query(`INSERT INTO task_events (id, task_id, kind, note, actor_id, at) VALUES ($1, $2, 'blocked', $3, $4, now())`, [uuidv7(), task, reason, user]);

    await clean(project, 'source', source);
    const cleanedReason = `deleting — it had password ${MARKER}`;
    assert.equal((await pool.query(`SELECT delete_reason FROM sources WHERE id = $1`, [source])).rows[0].delete_reason, cleanedReason);
    assert.equal((await pool.query(`SELECT reason FROM source_events WHERE source_id = $1`, [source])).rows[0].reason, cleanedReason);
    assert.deepEqual((await pool.query(`SELECT DISTINCT hold_reason FROM memberships WHERE project_id = $1`, [project])).rows.map((r) => r.hold_reason), [cleanedReason]);
    // The task is another item: its own reason is a copy, found by findPlaces, not swept with the source.
    assert.deepEqual(await tx((c) => findPlaces(c, project, [SECRET], { kind: 'source', id: source })), [{ kind: 'task', id: task }]);
  });

  test('originals decrypt back to the exact values', async () => {
    const project = await newProject();
    const title = `Rotate ${SECRET} now`;
    const task = await seedTask(project, title);
    const note = `blocked on ${SECRET}`;
    await pool.query(`INSERT INTO task_events (id, task_id, kind, note, detail, actor_id, at) VALUES ($1, $2, 'blocked', $3, $4, $5, now())`, [
      uuidv7(), task, note, JSON.stringify({ was: SECRET, n: 2, list: [`a ${SECRET}`] }), user,
    ]);
    const request = uuidv7();
    await pool.query(`INSERT INTO ai_requests (id, project_id, kind, requested_by, status, scope, created_at) VALUES ($1, $2, 'question', $3, 'succeeded', 'personal', now())`, [request, project, user]);
    await pool.query(
      `INSERT INTO ai_request_material (request_id, ordinal, marker, record_kind, record_id, snapshot, location) VALUES ($1, 0, '[1]', 'task', $2, $3, 'Task')`,
      [request, task, `Task: ${title}`],
    );
    const html = `<p>Task: Rotate ${SECRET} now, p&lt;w</p>`;
    await pool.query(
      `INSERT INTO email_outbox (id, to_address, subject, text_body, html_body, kind, project_id, initiated_by, created_at)
       VALUES ($1, 'a@example.org', 'Task due', $2, $3, 'reminder', $4, 'schedule', now())`,
      [uuidv7(), `Task: ${title}`, html, project],
    );
    const before = new Map<string, unknown>();
    const { caseId } = await clean(project, 'task', task, [SECRET, 'p<w']);
    const originals = (await pool.query(`SELECT * FROM quarantine_originals WHERE case_id = $1`, [caseId])).rows;
    assert.ok(originals.length >= 5, `originals written: ${originals.length}`);
    const expected: Record<string, unknown> = {
      'tasks.title': title,
      'task_events.note': note,
      'task_events.detail': { n: 2, was: SECRET, list: [`a ${SECRET}`] },
      'ai_request_material.snapshot': `Task: ${title}`,
      'email_outbox.text_body': `Task: ${title}`,
    };
    for (const o of originals) {
      assert.equal(o.key_id, key.id);
      assert.equal(o.item_kind, 'task');
      assert.equal(o.item_id, task);
      assert.equal(o.restored_at, null);
      const plain = key.decrypt(o).toString('utf8');
      const name = `${o.table_name}.${o.column_name}`;
      before.set(name, plain);
      if (name in expected) {
        const want = expected[name];
        assert.deepEqual(typeof want === 'string' ? plain : JSON.parse(plain), want, name);
      }
      // The cleaned value's hash matches what is stored now.
      const cols = Object.keys(o.row_key);
      const where = cols.map((k, i) => `${k}::text = $${i + 1}`).join(' AND ');
      const cur = (await pool.query(`SELECT ${o.column_name} AS v FROM ${o.table_name} WHERE ${where}`, cols.map((k) => String(o.row_key[k])))).rows[0].v;
      assert.equal(o.cleaned_sha256, sha(typeof cur === 'string' ? cur : JSON.stringify(cur)), `${name} cleaned hash`);
      assert.ok(!JSON.stringify(o.row_key).includes(SECRET));
    }
    assert.ok(before.has('email_outbox.html_body'), 'the html body was cleaned in its escaped form');
    const email = (await pool.query(`SELECT html_body FROM email_outbox WHERE project_id = $1`, [project])).rows[0].html_body;
    assert.equal(email, `<p>Task: Rotate ${MARKER} now, ${MARKER}</p>`);
    assert.equal((await pool.query(`SELECT title FROM tasks WHERE id = $1`, [task])).rows[0].title, `Rotate ${MARKER} now`);
  });

  test('findPlaces finds a message and a task title holding the text, not the item itself', async () => {
    const project = await newProject();
    const { source } = await seedSource(project, `the key ${SECRET}`);
    const thread = await seedThread(project);
    const { message } = await seedMessage(thread, 1, `copied: ${SECRET}`);
    const task = await seedTask(project, `Rotate ${SECRET}`);
    await seedTask(project, 'Unrelated');
    // A reason in no item is not a place.
    await pool.query(`UPDATE memberships SET hold_reason = $2, held_at = now(), held_by = $3 WHERE project_id = $1`, [project, SECRET, user]);
    const places = await tx((c) => findPlaces(c, project, [SECRET], { kind: 'source', id: source }));
    const want = [{ kind: 'message', id: message }, { kind: 'task', id: task }];
    const key = (p: { kind: string; id: string }) => `${p.kind}:${p.id}`;
    assert.deepEqual(places.map(key).sort(), want.map(key).sort());
  });

  test('matching semantics: exact and case-sensitive for %, _, backslash, quotes and <&> in text, jsonb, arrays and escaped HTML', async () => {
    // Pins what "contains" means for the copy search and the sweep (final review I1): any later optimisation must keep it.
    const MARK = `a%b_c\d'"<&>Q9`;
    const project = await newProject();
    const { source, version } = await seedSource(project, `the key ${MARK}`);
    const thread = await seedThread(project);
    // A text column.
    const task = await seedTask(project, `Rotate ${MARK}`);
    // A jsonb leaf (quotes and the backslash are escaped in jsonb's text form).
    const { message } = await seedMessage(thread, 1, 'nothing here');
    await pool.query(`INSERT INTO discussion_events (id, thread_id, message_id, actor_id, action, detail, at) VALUES ($1, $2, $3, $4, 'posted', $5, now())`, [
      uuidv7(), thread, message, user, JSON.stringify({ note: `see ${MARK}` }),
    ]);
    // A text array.
    const run = uuidv7();
    await pool.query(`INSERT INTO extraction_runs (id, source_version_id, requested_by, status, created_at) VALUES ($1, $2, $3, 'succeeded', now())`, [run, version, user]);
    const proposal = uuidv7();
    await pool.query(
      `INSERT INTO extraction_items (id, run_id, source_version_id, position, kind, text, quote, quote_start, quote_end, quote_matches, created_at, alternatives)
       VALUES ($1, $2, $3, 0, 'action', 'Rotate it', 'the key', 0, 7, 1, now(), $4)`,
      [proposal, run, version, ['first', `or ${MARK}`]],
    );
    // Near misses: a case-differing copy, and what % and _ would match as LIKE wildcards.
    await seedTask(project, `Rotate ${MARK.toUpperCase()}`);
    await seedTask(project, `Rotate aXbYc\d'"<&>Q9`);
    await seedTask(project, `Rotate a%b_c\\d'"<&>Q9`);
    // An email (no item: swept with the project, never a place) holding only the HTML-escaped form.
    const email = uuidv7();
    const escaped = `a%b_c\d&#39;&quot;&lt;&amp;&gt;Q9`;
    await pool.query(
      `INSERT INTO email_outbox (id, to_address, subject, text_body, html_body, kind, project_id, initiated_by, created_at)
       VALUES ($1, 'ops@example.org', 'Keys', 'see the item', $2, 'test', $3, 'system', now())`,
      [email, `<p>${escaped}</p>`, project],
    );

    const places = await tx((c) => findPlaces(c, project, [MARK], { kind: 'source', id: source }));
    const key = (p: { kind: string; id: string }) => `${p.kind}:${p.id}`;
    assert.deepEqual(places.map(key).sort(), [`message:${message}`, `proposal:${proposal}`, `task:${task}`].sort());
    assert.deepEqual(await tx((c) => findPlaces(c, project, [MARK.toLowerCase()], { kind: 'source', id: source })), [], 'a mark differing only in case is found nowhere');

    // The sweep of the source cleans the project's email in its escaped form.
    await clean(project, 'source', source, [MARK]);
    const html = (await pool.query(`SELECT html_body FROM email_outbox WHERE id = $1`, [email])).rows[0].html_body;
    assert.equal(html, `<p>${MARKER}</p>`);
  });

  test('restoreOriginals skips a value changed since cleaning', async () => {
    const project = await newProject();
    const text = `${'Opening words. '.repeat(20)}\n\nThe key is ${SECRET} here.\n\n${'Closing words. '.repeat(20)}`;
    const { source, version } = await seedSource(project, text);
    const passagesBefore = await passagesOf('source_version', version);
    const task = await seedTask(project, `Rotate ${SECRET}`);
    await pool.query(`UPDATE tasks SET owner_as_written = $2 WHERE id = $1`, [task, `owner of ${SECRET}`]);
    const { caseId } = await clean(project, 'source', source);
    await tx(async (c) => {
      await cleanItem(c, key, caseId, 'task', task, [SECRET]);
    });
    // The task is amended during review.
    await pool.query(`UPDATE tasks SET title = 'Rotate the staging key' WHERE id = $1`, [task]);

    const r = await tx((c) => restoreOriginals(c, key, caseId));
    assert.deepEqual(r.changed, [{ table: 'tasks', rowKey: { id: task } }]);
    assert.ok(r.restored > 3);
    const t = (await pool.query(`SELECT title, owner_as_written FROM tasks WHERE id = $1`, [task])).rows[0];
    assert.equal(t.title, 'Rotate the staging key', 'the amendment is kept');
    assert.equal(t.owner_as_written, `owner of ${SECRET}`, 'the unchanged value is restored');
    assert.equal(await versionText(version), text);
    assert.deepEqual(await passagesOf('source_version', version), passagesBefore, 'passages and their offsets are back exactly');
    const left = (await pool.query(`SELECT table_name, column_name FROM quarantine_originals WHERE case_id = $1 AND restored_at IS NULL`, [caseId])).rows;
    assert.deepEqual(left, [{ table_name: 'tasks', column_name: 'title' }]);
    // A second release restores nothing more.
    const again = await tx((c) => restoreOriginals(c, key, caseId));
    assert.equal(again.restored, 0);
  });

  test('restoring only one copy brings back what its own sweep cleaned', async () => {
    const project = await newProject();
    const { source, version } = await seedSource(project, `the key ${SECRET}`);
    const task = await seedTask(project, `Rotate ${SECRET}`);
    const { caseId } = await clean(project, 'source', source);
    await tx((c) => cleanItem(c, key, caseId, 'task', task, [SECRET]));
    const r = await tx((c) => restoreOriginals(c, key, caseId, { kind: 'task', id: task }));
    assert.equal(r.restored, 1);
    assert.equal((await pool.query(`SELECT title FROM tasks WHERE id = $1`, [task])).rows[0].title, `Rotate ${SECRET}`);
    assert.equal(await versionText(version), `the key ${MARKER}`);
  });

  test('a second pass with more marks restores back through both', async () => {
    const project = await newProject();
    const title = `Rotate ${SECRET} and hunter22`;
    const task = await seedTask(project, title);
    const { caseId } = await clean(project, 'task', task);
    await tx((c) => cleanItem(c, key, caseId, 'task', task, ['hunter22']));
    assert.equal((await pool.query(`SELECT title FROM tasks WHERE id = $1`, [task])).rows[0].title, `Rotate ${MARKER} and ${MARKER}`);
    const r = await tx((c) => restoreOriginals(c, key, caseId));
    assert.deepEqual(r, { restored: 2, changed: [] });
    assert.equal((await pool.query(`SELECT title FROM tasks WHERE id = $1`, [task])).rows[0].title, title);
  });

  test('summary marks that clean to the same phrase stay distinct and restore', async () => {
    const project = await newProject();
    const { source } = await seedSource(project, 'original notes');
    const summary = uuidv7();
    await pool.query(
      `INSERT INTO summaries (id, project_id, original_source_id, intended_audience, leave_out, created_by, created_at)
       VALUES ($1, $2, $3, '{"mode":"project"}', $4, $5, now())`,
      [summary, project, source, `leave out ${SECRET}`, user],
    );
    const sv = uuidv7();
    await pool.query(
      `INSERT INTO summary_versions (id, summary_id, version_no, origin, body, omitted_categories, created_by, created_at)
       VALUES ($1, $2, 1, 'human', $3, $4, $5, now())`,
      [sv, summary, `Summary mentions ${SECRET}.`, [`passwords like ${SECRET}`], user],
    );
    const phrases = [SECRET, `${SECRET}${SECRET}`, MARKER, `${MARKER} (2)`];
    for (const p of phrases) await pool.query(`INSERT INTO summary_marks (version_id, phrase, kind) VALUES ($1, $2, 'leave_out')`, [sv, p]);
    await pool.query(`INSERT INTO summary_marks (version_id, phrase, kind) VALUES ($1, $2, 'name')`, [sv, SECRET]);

    const { caseId } = await clean(project, 'summary', summary);
    const marks = (await pool.query(`SELECT phrase, kind FROM summary_marks WHERE version_id = $1 ORDER BY kind, phrase`, [sv])).rows;
    assert.equal(marks.length, 5);
    for (const m of marks) assert.equal(fragmentIn(m.phrase), undefined);
    assert.deepEqual(marks.filter((m) => m.kind === 'leave_out').map((m) => m.phrase).sort(), [MARKER, `${MARKER} (2)`, `${MARKER} (3)`, `${MARKER} (4)`].sort());
    assert.deepEqual(marks.filter((m) => m.kind === 'name').map((m) => m.phrase), [MARKER]);
    const keys = (await pool.query(`SELECT row_key FROM quarantine_originals WHERE case_id = $1 AND table_name = 'summary_marks'`, [caseId])).rows;
    assert.equal(keys.length, 3);
    for (const k of keys) assert.ok(!JSON.stringify(k.row_key).includes(SECRET), 'the row key holds the cleaned phrase only');
    const sver = (await pool.query(`SELECT body, omitted_categories FROM summary_versions WHERE id = $1`, [sv])).rows[0];
    assert.equal(sver.body, `Summary mentions ${MARKER}.`);
    assert.deepEqual(sver.omitted_categories, [`passwords like ${MARKER}`]);

    await tx((c) => restoreOriginals(c, key, caseId));
    const back = (await pool.query(`SELECT phrase, kind FROM summary_marks WHERE version_id = $1`, [sv])).rows;
    assert.deepEqual(back.map((m) => `${m.kind}:${m.phrase}`).sort(), [...phrases.map((p) => `leave_out:${p}`), `name:${SECRET}`].sort());
  });

  test('cleaning writes through every replaced UPDATE guard', async () => {
    const project = await newProject();
    // A secret of its own: other tests restore theirs, and the check below counts whole tables.
    const S = 'Qz9#guarded';
    // source_versions, passages, extraction_items (source); extraction_item_edits (proposal); message_versions (message);
    // minutes_drafts (minutes_draft); summary_versions/summary_marks (previous test); task_events, ai_request_material (task).
    const { source, version } = await seedSource(project, `text ${S}`);
    const item = await seedItem(version, `text ${S}`, { start: 0, end: 5 + S.length });
    await pool.query(`INSERT INTO extraction_item_edits (id, item_id, text, edited_by, edited_at) VALUES ($1, $2, $3, $4, now())`, [uuidv7(), item, `edit ${S}`, user]);
    const thread = await seedThread(project);
    const { message, mv } = await seedMessage(thread, 1, `msg ${S}`);
    await indexVersion(pool, 'message_version', mv, project, `msg ${S}`, { messageNo: 1, author: 'Ada', at: '1 Nov 10:00' });
    const draft = uuidv7();
    await pool.query(
      `INSERT INTO minutes_drafts (id, thread_id, version_no, origin, body, covers_through_no, created_by, created_at) VALUES ($1, $2, 1, 'human', $3, 1, $4, now())`,
      [draft, thread, `minutes ${S}`, user],
    );
    await pool.query(
      `INSERT INTO discussion_events (id, thread_id, draft_id, actor_id, action, reason, at) VALUES ($1, $2, $3, $4, 'minutes_edited', $5, now())`,
      [uuidv7(), thread, draft, user, `why ${S}`],
    );
    const caseId = await openCase(project, 'source', source);
    await tx(async (c) => {
      for (const [kind, id] of [['source', source], ['proposal', item], ['message', message], ['minutes_draft', draft]] as Array<[ItemKind, string]>) {
        await cleanItem(c, key, caseId, kind, id, [S]);
      }
    });
    const holding: Array<[string, string]> = [
      ['source_versions', 'text_content'], ['passages', 'body'], ['extraction_items', 'quote'], ['extraction_item_edits', 'text'],
      ['message_versions', 'body'], ['minutes_drafts', 'body'], ['discussion_events', 'reason'],
    ];
    for (const [table, column] of holding) {
      const n = Number((await pool.query(`SELECT count(*) FROM ${table} WHERE strpos(${column}, $1) > 0`, [S])).rows[0].count);
      assert.equal(n, 0, `${table}.${column} still holds the secret`);
    }
    const mbody = (await pool.query(`SELECT body_sha256, body FROM message_versions WHERE id = $1`, [mv])).rows[0];
    assert.equal(mbody.body_sha256, sha(mbody.body));
  });

  test('a long message and a full-length thread title can still be cleaned', async () => {
    const project = await newProject();
    const thread = await seedThread(project);
    // 9,995 characters with an 8-character secret: the cleaned body is 10,007, over the 10,000 input limit.
    const body = `${'x'.repeat(9995 - SECRET.length - 1)} ${SECRET}`;
    assert.equal(body.length, 9995);
    const { message, mv } = await seedMessage(thread, 1, body);
    await clean(project, 'message', message);
    const cleaned = (await pool.query(`SELECT body FROM message_versions WHERE id = $1`, [mv])).rows[0].body;
    assert.equal(cleaned.length, 10007);
    assert.ok(cleaned.endsWith(` ${MARKER}`));
    // A 200-character title holding the secret.
    const title = `${'T'.repeat(200 - SECRET.length - 1)} ${SECRET}`;
    await pool.query(`UPDATE discussion_threads SET title = $2 WHERE id = $1`, [thread, title]);
    await clean(project, 'thread', thread);
    const t = (await pool.query(`SELECT title FROM discussion_threads WHERE id = $1`, [thread])).rows[0].title;
    assert.equal(t.length, 212);
    assert.ok(t.endsWith(MARKER));
    // Without the marker the limits still hold.
    await assert.rejects(pool.query(`UPDATE discussion_threads SET title = $2 WHERE id = $1`, [thread, 'y'.repeat(201)]), (e: { code?: string }) => e.code === '23514');
  });

  test('a full-length stage name holding the text is cleaned everywhere it is kept, and restored', async () => {
    const project = await newProject();
    const task = await seedTask(project, 'Rotate the key');
    const mark = 'Q7!z';
    const name = `${'S'.repeat(80 - mark.length - 1)} ${mark}`;
    const cleanedName = name.replace(mark, MARKER);
    assert.deepEqual([name.length, cleanedName.length], [80, 96]);
    const stage = uuidv7();
    await pool.query(`INSERT INTO project_stages (id, project_id, position, name, substages, added_by, added_at) VALUES ($1, $2, 9, $3, $4, $5, now())`, [stage, project, name, [`Sub ${mark}`], user]);
    const period = uuidv7();
    await pool.query(`INSERT INTO project_stage_periods (id, project_id, stage, started_at, ended_at, started_by) VALUES ($1, $2, $3, now(), now(), $4)`, [period, project, name, user]);
    const change = uuidv7();
    const next = [{ name, substages: [`Sub ${mark}`], status: 'active' }];
    await pool.query(
      `INSERT INTO project_stage_changes (id, project_id, kind, stage_id, actor_id, at, reason, previous, next) VALUES ($1, $2, 'added', $3, $4, now(), $5, '[]', $6)`,
      [change, project, stage, user, `For ${mark}`, JSON.stringify(next)],
    );
    const read = async () => ({
      stage: (await pool.query(`SELECT name, substages FROM project_stages WHERE id = $1`, [stage])).rows[0],
      period: (await pool.query(`SELECT stage FROM project_stage_periods WHERE id = $1`, [period])).rows[0],
      change: (await pool.query(`SELECT reason, previous, next FROM project_stage_changes WHERE id = $1`, [change])).rows[0],
    });
    const before = await read();
    const { caseId } = await clean(project, 'task', task, [mark]);
    assert.deepEqual(await read(), {
      stage: { name: cleanedName, substages: [`Sub ${MARKER}`] },
      period: { stage: cleanedName },
      change: { reason: `For ${MARKER}`, previous: [], next: [{ name: cleanedName, substages: [`Sub ${MARKER}`], status: 'active' }] },
    });
    const r = await tx((c) => restoreOriginals(c, key, caseId));
    assert.deepEqual(r.changed, []);
    assert.deepEqual(await read(), before);
    // Without the marker the limits still hold, and a name may never be blank.
    for (const bad of ['y'.repeat(81), '   ']) {
      for (const [sql, id] of [[`UPDATE project_stages SET name = $2 WHERE id = $1`, stage], [`UPDATE project_stage_periods SET stage = $2 WHERE id = $1`, period]]) {
        await assert.rejects(pool.query(sql, [id, bad]), (e: { code?: string }) => e.code === '23514');
      }
    }
  });

  test('a full-length reason for a correction is cleaned and restored', async () => {
    const project = await newProject();
    const { version } = await seedSource(project, 'Notes.');
    const item = await seedItem(version, 'Notes', { start: 0, end: 5 });
    const mark = 'Q7!z';
    const reason = `${'r'.repeat(500 - mark.length - 1)} ${mark}`;
    const edit = uuidv7();
    await pool.query(`INSERT INTO extraction_item_edits (id, item_id, kind, text, reason, edited_by, edited_at) VALUES ($1, $2, 'decision', 'Rotate it', $3, $4, now())`, [edit, item, reason, user]);
    const read = async () => (await pool.query(`SELECT reason FROM extraction_item_edits WHERE id = $1`, [edit])).rows[0].reason as string;
    const { caseId } = await clean(project, 'proposal', item, [mark]);
    assert.equal(await read(), reason.replace(mark, MARKER));
    await tx((c) => restoreOriginals(c, key, caseId));
    assert.equal(await read(), reason);
  });

  test('a full-length AI connection label is cleaned and restored', async () => {
    const project = await newProject();
    const task = await seedTask(project, 'Rotate the key');
    const mark = 'Q7!z';
    const label = `${'L'.repeat(100 - mark.length - 1)} ${mark}`;
    const model = uuidv7();
    await pool.query(
      `INSERT INTO ai_models (id, provider, model_id, display_name, input_usd_per_million_micro, cached_input_usd_per_million_micro, output_usd_per_million_micro, data_terms, state, updated_at, updated_by)
       VALUES ($1, 'openai', 'dummy-model', 'Dummy', 1, 1, 1, 'None kept', 'approved', now(), $2)`,
      [model, user],
    );
    const connection = uuidv7();
    await pool.query(`INSERT INTO ai_connections (id, project_id, model_ref, label, position, state, created_at) VALUES ($1, $2, $3, $4, 1, 'ready', now())`, [connection, project, model, label]);
    const read = async () => (await pool.query(`SELECT label FROM ai_connections WHERE id = $1`, [connection])).rows[0].label as string;
    const { caseId } = await clean(project, 'task', task, [mark]);
    assert.equal(await read(), label.replace(mark, MARKER));
    await tx((c) => restoreOriginals(c, key, caseId));
    assert.equal(await read(), label);
  });

  test('the exception is closed again when cleanItem and restoreOriginals return', async () => {
    const project = await newProject();
    const { source, version } = await seedSource(project, `text ${SECRET}`);
    const other = await seedSource(project, 'unrelated text');
    const caseId = await openCase(project, 'source', source);
    const refused = async (c: PoolClient, sql: string, params: unknown[]) => {
      await c.query('SAVEPOINT s');
      let code: string | undefined;
      try {
        await c.query(sql, params);
      } catch (err) {
        code = (err as { code?: string }).code;
      }
      await c.query('ROLLBACK TO SAVEPOINT s');
      return code;
    };
    await tx(async (c) => {
      const { rows } = await cleanItem(c, key, caseId, 'source', source, [SECRET]);
      assert.ok(rows > 0);
      assert.equal(await refused(c, `UPDATE source_versions SET text_content = 'x' WHERE id = $1`, [other.version]), '23001');
      assert.equal(await refused(c, `UPDATE source_events SET reason = 'x' WHERE source_id = $1`, [source]), undefined, 'no rows: nothing to refuse');
      await c.query(`INSERT INTO source_events (id, source_id, project_id, kind, actor_id, reason, at) VALUES ($1, $2, $3, 'deleted', $4, 'r', now())`, [uuidv7(), source, project, user]);
      assert.equal(await refused(c, `UPDATE source_events SET reason = 'x' WHERE source_id = $1`, [source]), '23001');
      const r = await restoreOriginals(c, key, caseId);
      assert.ok(r.restored > 0);
      assert.equal(await refused(c, `UPDATE source_versions SET text_content = 'x' WHERE id = $1`, [version]), '23001');
    });
  });

  test('quote places, matches and chosen occurrence follow the cleaned text', async () => {
    const project = await newProject();
    const OTHER = 'Qq1#word';
    const text = `pw ${SECRET}; later pw ${OTHER}; again pw ${SECRET}.`;
    const { source, version } = await seedSource(project, text);
    const run = uuidv7();
    await pool.query(`INSERT INTO extraction_runs (id, source_version_id, requested_by, status, created_at) VALUES ($1, $2, $3, 'succeeded', now())`, [run, version, user]);
    const quote = `pw ${SECRET}`;
    const item = uuidv7();
    // Approved against the second of two places.
    await pool.query(
      `INSERT INTO extraction_items (id, run_id, source_version_id, position, kind, text, quote, quote_start, quote_end, quote_matches, chosen_occurrence,
                                     review_status, reviewed_by, reviewed_at, created_at)
       VALUES ($1, $2, $3, 0, 'action', 'Rotate it', $4, $5, $6, 2, 1, 'approved', $7, now(), now())`,
      [item, run, version, quote, text.indexOf(quote), text.indexOf(quote) + quote.length, user],
    );
    const before = (await pool.query(`SELECT quote, quote_start, quote_end, quote_matches, chosen_occurrence FROM extraction_items WHERE id = $1`, [item])).rows[0];
    const { caseId } = await clean(project, 'source', source, [SECRET, OTHER]);
    const cleaned = await versionText(version);
    const r = (await pool.query(`SELECT quote, quote_start, quote_end, quote_matches, chosen_occurrence FROM extraction_items WHERE id = $1`, [item])).rows[0];
    assert.equal(r.quote, `pw ${MARKER}`);
    assert.equal(r.quote_matches, 3, 'the other secret cleaned to the same text is a third place');
    assert.equal(r.quote_start, 0);
    assert.equal(cleaned.slice(r.quote_start, r.quote_end), r.quote);
    const places: number[] = [];
    for (let at = cleaned.indexOf(r.quote); at !== -1; at = cleaned.indexOf(r.quote, at + 1)) places.push(at);
    assert.equal(places[r.chosen_occurrence], cleaned.lastIndexOf(r.quote), 'the chosen place is still the second original place');
    await tx((c) => restoreOriginals(c, key, caseId));
    assert.deepEqual((await pool.query(`SELECT quote, quote_start, quote_end, quote_matches, chosen_occurrence FROM extraction_items WHERE id = $1`, [item])).rows[0], before);
  });

  test('without the setting the same UPDATE is refused', async () => {
    const project = await newProject();
    const { source, version } = await seedSource(project, `text ${SECRET}`);
    const { caseId } = await clean(project, 'source', source);
    const passage = (await passagesOf('source_version', version))[0];
    const statements: Array<[string, unknown[]]> = [
      [`UPDATE source_versions SET text_content = $2 WHERE id = $1`, [version, `text ${SECRET}`]],
      [`UPDATE passages SET body = $2 WHERE id = $1`, [passage.id, `text ${SECRET}`]],
    ];
    for (const [sql, params] of statements) {
      await assert.rejects(pool.query(sql, params), (err: { code?: string }) => err.code === '23001', sql);
      // With the case set, inside a transaction, the same statement passes.
      await tx(async (c) => {
        await c.query(`SELECT set_config('kainow.quarantine_write', $1, true)`, [caseId]);
        await c.query('SAVEPOINT s');
        await c.query(sql, params);
        await c.query('ROLLBACK TO SAVEPOINT s');
      });
    }
    // cleanItem under a case closed earlier is refused too.
    await pool.query(`UPDATE quarantine_cases SET state = 'released', closed_at = now(), closed_by = $2, close_reason = 'ok' WHERE id = $1`, [caseId, user]);
    const other = await seedSource(project, `more ${SECRET}`);
    await assert.rejects(
      tx((c) => cleanItem(c, key, caseId, 'source', other.source, [SECRET])),
      (err: Error & { code?: string }) => err.code === '23001' && !err.message.includes(SECRET),
    );
  });
});
