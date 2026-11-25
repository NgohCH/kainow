import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { Pool, type PoolClient } from 'pg';
import { loadDatabaseConfig } from '../config';
import { uuidv7 } from '../common/uuid7';
import { runMigrations } from '../db/migrate';
import { SKIP_NO_DB, resetPublicSchema, testDatabaseUrl } from '../testing/db';
import { seedProject, seedUser } from '../testing/projects';
import { MARKER } from './clean-text';
import { ITEM_KINDS, NO_USER_TEXT, QUARANTINE_WRITE_TABLES, TEXT_COLUMNS, type ItemKind, type TextColumn } from './registry';

const migrationsDir = loadDatabaseConfig({ DATABASE_URL: 'x' }).migrationsDir;

const name = (c: { table: string; column: string }) => `${c.table}.${c.column}`;

describe('text registry (spec 7.4)', { skip: SKIP_NO_DB }, () => {
  let pool: Pool;

  before(async () => {
    pool = new Pool({ connectionString: testDatabaseUrl() });
    await resetPublicSchema(pool);
    await runMigrations(pool, migrationsDir);
  });
  after(async () => {
    await pool.end();
  });

  /**
   * Every column of a base table that can hold text: text, varchar, char, json, jsonb, bytea, and arrays of
   * those. Views (search_documents) are left out: they store nothing, and every column they show comes from a
   * base table checked here.
   */
  async function textColumns(): Promise<string[]> {
    const { rows } = await pool.query<{ name: string }>(
      `SELECT c.table_name || '.' || c.column_name AS name
         FROM information_schema.columns c
         JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
          AND (c.data_type IN ('text', 'character varying', 'character', 'json', 'jsonb', 'bytea')
               OR (c.data_type = 'ARRAY' AND c.udt_name IN ('_text', '_varchar', '_bpchar', '_json', '_jsonb', '_bytea')))
        ORDER BY 1`,
    );
    return rows.map((r) => r.name);
  }

  test('every text, varchar and jsonb column is registered or declared', async () => {
    const registered = new Set(TEXT_COLUMNS.map(name));
    const declared = new Set(Object.keys(NO_USER_TEXT));
    const columns = await textColumns();
    const missing = columns.filter((c) => !registered.has(c) && !declared.has(c));
    assert.deepEqual(missing, [], `columns neither in TEXT_COLUMNS nor in NO_USER_TEXT:\n${missing.join('\n')}`);

    const both = [...registered].filter((c) => declared.has(c));
    assert.deepEqual(both, [], 'a column is either registered or declared, not both');
    const all = new Set(columns);
    const stale = [...registered, ...declared].filter((c) => !all.has(c));
    assert.deepEqual(stale, [], 'every entry names an existing text column');
    assert.equal(registered.size, TEXT_COLUMNS.length, 'no column registered twice');
    for (const [col, reason] of Object.entries(NO_USER_TEXT)) {
      assert.ok(reason.trim().length > 10 && !reason.includes('\n'), `${col} needs a one-line reason`);
    }
  });

  test('the column kinds match the schema', async () => {
    const { rows } = await pool.query<{ name: string; data_type: string }>(
      `SELECT table_name || '.' || column_name AS name, data_type FROM information_schema.columns WHERE table_schema = 'public'`,
    );
    const types = new Map(rows.map((r) => [r.name, r.data_type]));
    for (const c of TEXT_COLUMNS) {
      const t = types.get(name(c));
      assert.equal(c.json, t === 'jsonb' || t === 'json', `${name(c)} json flag`);
      assert.equal(c.array ?? false, t === 'ARRAY', `${name(c)} array flag`);
      assert.equal(c.binary ?? false, t === 'bytea', `${name(c)} binary flag`);
      for (const k of c.rowKey) assert.ok(types.has(`${c.table}.${k}`), `${name(c)} row key ${k} exists`);
    }
  });

  async function columnsOf(sql: string, params: unknown[]): Promise<string[]> {
    const r = await pool.query(sql, params);
    return r.fields.map((f) => f.name);
  }

  function expectShape(c: TextColumn, fields: string[], label: string): void {
    assert.deepEqual(fields, [...c.rowKey, 'value', 'item_kind', 'item_id'], `${label} returns the row key, value, item_kind, item_id`);
  }

  test('every registered projectSql runs', async () => {
    for (const c of TEXT_COLUMNS) {
      const fields = await columnsOf(c.projectSql, [uuidv7()]).catch((err: Error) => {
        throw new Error(`${name(c)} projectSql: ${err.message}\n${c.projectSql}`);
      });
      expectShape(c, fields, `${name(c)} projectSql`);
    }
  });

  test('every itemSql runs', async () => {
    let count = 0;
    for (const c of TEXT_COLUMNS) {
      for (const [kind, sql] of Object.entries(c.itemSql ?? {})) {
        assert.ok(ITEM_KINDS.includes(kind as ItemKind), `${name(c)}: ${kind} is an item kind`);
        const fields = await columnsOf(sql as string, [uuidv7()]).catch((err: Error) => {
          throw new Error(`${name(c)} itemSql.${kind}: ${err.message}\n${sql}`);
        });
        expectShape(c, fields, `${name(c)} itemSql.${kind}`);
        count += 1;
      }
    }
    assert.ok(count > 0);
    // cleanItem can reach every registered column from some item.
    const unreachable = TEXT_COLUMNS.filter((c) => Object.keys(c.itemSql ?? {}).length === 0).map(name);
    assert.deepEqual(unreachable, [], 'registered columns no itemSql reaches');
    // Every item kind finds at least its own text somewhere.
    for (const kind of ITEM_KINDS) {
      assert.ok(TEXT_COLUMNS.some((c) => c.itemSql?.[kind]), `${kind} has rows`);
    }
  });

  test('every UPDATE guard on a registered table honours the quarantine exception', async () => {
    const tables = [...new Set([...TEXT_COLUMNS.map((c) => c.table), ...QUARANTINE_WRITE_TABLES])];
    const { rows } = await pool.query<{ table: string; trigger: string; fn: string; src: string }>(
      `SELECT c.relname AS table, t.tgname AS trigger, p.proname AS fn, p.prosrc AS src
         FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_proc p ON p.oid = t.tgfoid
        WHERE n.nspname = 'public' AND NOT t.tgisinternal
          AND (t.tgtype & 16) <> 0
          AND c.relname = ANY($1)`,
      [tables],
    );
    assert.ok(rows.length > 10, 'the guards were found');
    const blind = rows.filter((r) => !r.src.includes('kainow_quarantine_writing()')).map((r) => `${r.table}: ${r.trigger} (${r.fn})`);
    assert.deepEqual(blind, [], 'UPDATE triggers on registered tables without the quarantine exception');
    const { rows: rules } = await pool.query(`SELECT tablename FROM pg_rules WHERE schemaname = 'public' AND tablename = ANY($1)`, [tables]);
    assert.deepEqual(rules, [], 'no rewrite rule on a registered table');
  });

  test('no length limit on a registered column can stop cleaning', async () => {
    // The marker is longer than most secrets, so a cleaned value may pass the limit set on input: every upper limit on
    // a swept column must let a value holding the marker through (the form of 0027). Otherwise the sweep rolls back and
    // the secret stays visible.
    const { rows } = await pool.query<{ table: string; constraint: string; columns: string[]; def: string }>(
      `SELECT cl.relname AS table, c.conname AS constraint, pg_get_constraintdef(c.oid) AS def,
              array(SELECT a.attname::text FROM pg_attribute a WHERE a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)) AS columns
         FROM pg_constraint c JOIN pg_class cl ON cl.oid = c.conrelid
        WHERE c.contype = 'c' AND c.connamespace = 'public'::regnamespace`,
    );
    const blocking: string[] = [];
    let relaxed = 0;
    for (const c of TEXT_COLUMNS) {
      for (const r of rows.filter((x) => x.table === c.table && x.columns.includes(c.column))) {
        const way = `OR (strpos(${c.column}, '${MARKER}'::text) > 0)`;
        const limit = new RegExp(`\\b(?:char_length|character_length|length|octet_length)\\((?:btrim\\()?\\(?${c.column}\\)?(?:::text)?\\)*\\s*(?:<=?|=)\\s*\\d+\\)*`, 'g');
        for (const m of r.def.matchAll(limit)) {
          if (r.def.slice(m.index + m[0].length).trimStart().startsWith(way)) relaxed += 1;
          else blocking.push(`${name(c)}: ${r.constraint} ${r.def}`);
        }
      }
    }
    assert.deepEqual(blocking, [], `length limits cleaning can break:\n${blocking.join('\n')}`);
    assert.ok(relaxed >= 14, `only ${relaxed} relaxed limits found: does the pattern still match what PostgreSQL prints?`);
    const typed = await pool.query(
      `SELECT table_name || '.' || column_name AS name FROM information_schema.columns WHERE table_schema = 'public' AND character_maximum_length IS NOT NULL`,
    );
    const registered = new Set(TEXT_COLUMNS.map(name));
    assert.deepEqual(typed.rows.map((r) => r.name).filter((n: string) => registered.has(n)), [], 'no registered column has a length in its type');
  });

  /**
   * Unique rules (unique indexes, UNIQUE and PRIMARY KEY constraints, exclusions) whose key uses a registered column
   * and which do not leave out values holding the marker. The exception counts only as a whole condition of the
   * index's WHERE, never as one side of an OR.
   */
  async function uniqueRules(db: Pick<PoolClient, 'query'>): Promise<{ blocking: string[]; excepted: string[] }> {
    const { rows } = await db.query<{ table: string; index: string; keys: string[]; predicate: string | null }>(
      `SELECT t.relname AS table, i.relname AS index, pg_get_expr(x.indpred, x.indrelid) AS predicate,
              array(SELECT pg_get_indexdef(x.indexrelid, k, false) FROM generate_series(1, x.indnkeyatts) k ORDER BY k) AS keys
         FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid JOIN pg_class t ON t.oid = x.indrelid
        WHERE (x.indisunique OR x.indisexclusion) AND t.relnamespace = 'public'::regnamespace`,
    );
    const blocking: string[] = [];
    const excepted: string[] = [];
    for (const c of TEXT_COLUMNS) {
      const uses = new RegExp(`\\b${c.column}\\b`);
      for (const r of rows.filter((x) => x.table === c.table && x.keys.some((k) => uses.test(k)))) {
        const way = `(strpos(${c.column}, '${MARKER}'::text) = 0)`;
        const p = r.predicate ?? '';
        (p.includes(way) && !/\b(OR|NOT)\b/.test(p.replace(/IS NOT NULL/g, '')) ? excepted : blocking).push(`${name(c)}: ${r.index}`);
      }
    }
    return { blocking: blocking.sort(), excepted: excepted.sort() };
  }

  /** Unique rules the cleaning engine keeps true itself. */
  const KEPT_BY_THE_ENGINE = [
    // The primary key: equal cleaned phrases get " (2)", " (3)" (clean.ts; proved in clean.db.test.ts).
    'summary_marks.phrase: summary_marks_pkey',
  ];

  test('no unique rule on a registered column can stop cleaning', async () => {
    // Two values that differ only in what is removed clean to the same text: the unique rule must ignore a value holding
    // the marker, or the sweep rolls back and the secret stays visible.
    const { blocking, excepted } = await uniqueRules(pool);
    assert.deepEqual(blocking, KEPT_BY_THE_ENGINE, `unique rules cleaning can break:\n${blocking.join('\n')}`);
    assert.ok(excepted.includes('project_stages.name: project_stages_name'), 'the rules with the exception were found');

    // The check sees each way such a rule can be made.
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`CREATE UNIQUE INDEX seen_plain ON sources (project_id, title)`);
      await c.query(`CREATE UNIQUE INDEX seen_lower ON tasks (lower(btrim(title))) WHERE depth = 0`);
      await c.query(`ALTER TABLE decisions ADD CONSTRAINT seen_constraint UNIQUE (statement)`);
      await c.query(`CREATE UNIQUE INDEX seen_or ON holidays (name) WHERE strpos(name, '${MARKER}') = 0 OR project_id IS NULL`);
      await c.query(`CREATE UNIQUE INDEX unseen_marker ON risks (description) WHERE strpos(description, '${MARKER}') = 0 AND project_id IS NOT NULL`);
      const seen = await uniqueRules(c);
      assert.deepEqual(
        seen.blocking.filter((b) => !blocking.includes(b)),
        ['decisions.statement: seen_constraint', 'holidays.name: seen_or', 'sources.title: seen_plain', 'tasks.title: seen_lower'],
      );
      assert.ok(seen.excepted.includes('risks.description: unseen_marker'));
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });

  describe('derived rows', () => {
    let user: string;
    let project: string;

    before(async () => {
      user = await seedUser(pool, 'registry@example.org');
      project = await seedProject(pool, { status: 'active', members: [{ userId: user, role: 'pm' }] });
    });

    async function itemRows(table: string, column: string, kind: ItemKind, id: string): Promise<unknown[]> {
      const c = TEXT_COLUMNS.find((x) => x.table === table && x.column === column);
      assert.ok(c, `${table}.${column} registered`);
      const sql = c.itemSql?.[kind];
      assert.ok(sql, `${table}.${column} has itemSql.${kind}`);
      return (await pool.query(sql, [id])).rows.map((r) => r.value);
    }

    async function projectRows(table: string, column: string): Promise<unknown[]> {
      const c = TEXT_COLUMNS.find((x) => x.table === table && x.column === column);
      assert.ok(c);
      return (await pool.query(c.projectSql, [project])).rows.map((r) => r.value);
    }

    test("a source's versions, passages, quotes, events and notices", async () => {
      const source = uuidv7();
      const other = uuidv7();
      for (const [id, title] of [[source, 'Notes A'], [other, 'Notes B']]) {
        await pool.query(`INSERT INTO sources (id, title, created_by, created_at, project_id) VALUES ($1, $2, $3, now(), $4)`, [id, title, user, project]);
      }
      const version = uuidv7();
      const otherVersion = uuidv7();
      for (const [id, s, text] of [[version, source, 'pw Xy7!pass here'], [otherVersion, other, 'nothing']]) {
        await pool.query(
          `INSERT INTO source_versions (id, source_id, version_no, origin, text_content, text_sha256, char_count, created_by, created_at)
           VALUES ($1, $2, 1, 'paste', $3, 'h', $4, $5, now())`,
          [id, s, text, text.length, user],
        );
        await pool.query(
          `INSERT INTO passages (id, project_id, owner_kind, owner_id, ordinal, location, start_offset, end_offset, body)
           VALUES ($1, $2, 'source_version', $3, 0, 'Paragraph 1', 0, $4, $5)`,
          [uuidv7(), project, id, text.length, text],
        );
      }
      const run = uuidv7();
      await pool.query(`INSERT INTO extraction_runs (id, source_version_id, requested_by, status, created_at) VALUES ($1, $2, $3, 'succeeded', now())`, [run, version, user]);
      await pool.query(
        `INSERT INTO extraction_items (id, run_id, source_version_id, position, kind, text, quote, quote_matches, created_at)
         VALUES ($1, $2, $3, 0, 'action', 'Rotate it', 'pw Xy7!pass', 0, now())`,
        [uuidv7(), run, version],
      );
      await pool.query(`INSERT INTO source_events (id, source_id, project_id, kind, actor_id, reason, at) VALUES ($1, $2, $3, 'deleted', $4, 'had pw Xy7!pass', now())`, [uuidv7(), source, project, user]);
      await pool.query(
        `INSERT INTO notifications (id, user_id, project_id, kind, summary, link, created_at) VALUES ($1, $2, $3, 'notes_submitted', 'Notes A submitted', $4, now())`,
        [uuidv7(), user, project, `#/projects/${project}/notes/${source}`],
      );

      assert.deepEqual(await itemRows('sources', 'title', 'source', source), ['Notes A']);
      assert.deepEqual(await itemRows('source_versions', 'text_content', 'source', source), ['pw Xy7!pass here']);
      assert.deepEqual(await itemRows('passages', 'body', 'source', source), ['pw Xy7!pass here']);
      assert.deepEqual(await itemRows('extraction_items', 'quote', 'source', source), ['pw Xy7!pass']);
      assert.deepEqual(await itemRows('source_events', 'reason', 'source', source), ['had pw Xy7!pass']);
      assert.deepEqual(await itemRows('notifications', 'summary', 'source', source), ['Notes A submitted']);
      assert.deepEqual((await projectRows('passages', 'body')).sort(), ['nothing', 'pw Xy7!pass here']);
      const owners = (await pool.query(TEXT_COLUMNS.find((c) => name(c) === 'passages.body')!.projectSql, [project])).rows;
      assert.deepEqual(
        owners.map((r) => `${r.item_kind}:${r.item_id}`).sort(),
        [`source:${source}`, `source:${other}`].sort(),
        'a passage belongs to its source',
      );
    });

    test('a transcript names no owner and is cleaned with its message', async () => {
      const audience = uuidv7();
      await pool.query(`INSERT INTO audiences (id, project_id, mode, created_at) VALUES ($1, $2, 'project', now())`, [audience, project]);
      const thread = uuidv7();
      await pool.query(
        `INSERT INTO discussion_threads (id, project_id, kind, title, audience_id, created_by, created_at) VALUES ($1, $2, 'discussion', 'Keys', $3, $4, now())`,
        [thread, project, audience, user],
      );
      const message = uuidv7();
      await pool.query(`INSERT INTO discussion_messages (id, thread_id, message_no, author_id, created_at) VALUES ($1, $2, 1, $3, now())`, [message, thread, user]);
      const mv = uuidv7();
      await pool.query(`INSERT INTO message_versions (id, message_id, version_no, body, body_sha256, created_at) VALUES ($1, $2, 1, 'pw Xy7!pass', 'h', now())`, [mv, message]);
      const transcript = uuidv7();
      await pool.query(
        `INSERT INTO sources (id, title, created_at, project_id, kind, audience_id, thread_id, publication) VALUES ($1, 'Keys', now(), $2, 'discussion', $3, $4, 'published')`,
        [transcript, project, audience, thread],
      );
      const text = 'Ada: pw Xy7!pass';
      const tv = uuidv7();
      await pool.query(
        `INSERT INTO source_versions (id, source_id, version_no, origin, text_content, text_sha256, char_count, created_at) VALUES ($1, $2, 1, 'discussion', $3, 'h', $4, now())`,
        [tv, transcript, text, text.length],
      );
      await pool.query(
        `INSERT INTO transcript_spans (source_version_id, message_no, message_version_id, author_id, header_start, body_start, body_end) VALUES ($1, 1, $2, $3, 0, 5, $4)`,
        [tv, mv, user, text.length],
      );
      await pool.query(
        `INSERT INTO passages (id, project_id, owner_kind, owner_id, ordinal, location, start_offset, end_offset, body) VALUES ($1, $2, 'source_version', $3, 0, 'Paragraph 1', 0, $4, $5)`,
        [uuidv7(), project, tv, text.length, text],
      );

      const owners = async (column: string) =>
        (await pool.query(TEXT_COLUMNS.find((c) => name(c) === column)!.projectSql, [project])).rows.filter((r) => r.value === text || r.id === tv);
      const versions = await owners('source_versions.text_content');
      assert.equal(versions.length, 1);
      assert.equal(versions[0].item_kind, null, 'a transcript version names no item');
      assert.equal(versions[0].item_id, null);
      const passages = await owners('passages.body');
      assert.equal(passages.length, 1);
      assert.equal(passages[0].item_kind, null, 'a transcript passage names no item');
      const source = (await pool.query(TEXT_COLUMNS.find((c) => name(c) === 'sources.title')!.projectSql, [project])).rows.find((r) => r.id === transcript);
      assert.equal(source.item_kind, null, 'a transcript source is not an item');
      const own = (await pool.query(TEXT_COLUMNS.find((c) => name(c) === 'message_versions.body')!.projectSql, [project])).rows.find((r) => r.id === mv);
      assert.equal(`${own.item_kind}:${own.item_id}`, `message:${message}`, 'the message version is the place reported');

      assert.deepEqual(await itemRows('source_versions', 'text_content', 'message', message), [text]);
      assert.deepEqual(await itemRows('passages', 'body', 'message', message), [text]);
      assert.deepEqual(await itemRows('message_versions', 'body', 'message', message), ['pw Xy7!pass']);
    });

    test('a project-level reason is reached from any item of the project', async () => {
      const task = uuidv7();
      await pool.query(
        `INSERT INTO tasks (id, project_id, depth, title, assignee_id, due_on, status, authorised_by, authorised_at)
         VALUES ($1, $2, 0, 'Another', $3, '2026-11-20', 'in_progress', $3, now())`,
        [task, project, user],
      );
      await pool.query(`UPDATE memberships SET hold_reason = 'held: pw Xy7!pass', held_at = now(), held_by = $2 WHERE project_id = $1`, [project, user]);
      assert.deepEqual(await itemRows('memberships', 'hold_reason', 'task', task), ['held: pw Xy7!pass']);
      assert.deepEqual(await itemRows('memberships', 'hold_reason', 'task', uuidv7()), []);
    });

    test("a task's events and snapshots", async () => {
      const task = uuidv7();
      await pool.query(
        `INSERT INTO tasks (id, project_id, depth, title, assignee_id, due_on, status, authorised_by, authorised_at)
         VALUES ($1, $2, 0, 'Rotate the key', $3, '2026-11-20', 'in_progress', $3, now())`,
        [task, project, user],
      );
      await pool.query(`INSERT INTO task_events (id, task_id, kind, note, actor_id, at) VALUES ($1, $2, 'blocked', 'waiting on pw Xy7!pass', $3, now())`, [uuidv7(), task, user]);
      const request = uuidv7();
      await pool.query(`INSERT INTO ai_requests (id, project_id, kind, requested_by, status, scope, created_at) VALUES ($1, $2, 'question', $3, 'succeeded', 'personal', now())`, [request, project, user]);
      await pool.query(
        `INSERT INTO ai_request_material (request_id, ordinal, marker, record_kind, record_id, snapshot, location) VALUES ($1, 0, '[1]', 'task', $2, 'Task: Rotate the key', 'Task')`,
        [request, task],
      );

      assert.deepEqual(await itemRows('tasks', 'title', 'task', task), ['Rotate the key']);
      assert.deepEqual(await itemRows('task_events', 'note', 'task', task), ['waiting on pw Xy7!pass']);
      assert.deepEqual(await itemRows('ai_request_material', 'snapshot', 'task', task), ['Task: Rotate the key']);
      assert.deepEqual(await itemRows('tasks', 'title', 'task', uuidv7()), []);
    });
  });
});
