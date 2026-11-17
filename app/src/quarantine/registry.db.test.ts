import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { Pool } from 'pg';
import { loadDatabaseConfig } from '../config';
import { uuidv7 } from '../common/uuid7';
import { runMigrations } from '../db/migrate';
import { SKIP_NO_DB, resetPublicSchema, testDatabaseUrl } from '../testing/db';
import { seedProject, seedUser } from '../testing/projects';
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
