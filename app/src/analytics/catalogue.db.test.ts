import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { Pool } from 'pg';
import { loadDatabaseConfig } from '../config';
import { runMigrations } from '../db/migrate';
import { SKIP_NO_DB, resetPublicSchema, testDatabaseUrl } from '../testing/db';
import { CATALOGUE } from './catalogue';

const migrationsDir = loadDatabaseConfig({ DATABASE_URL: 'x' }).migrationsDir;
/** Tests run from app/, so the sources are under ./src. */
const SRC = join(process.cwd(), 'src');

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'testing') out.push(...sources(p));
    } else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

/** The text of every `writeAudit(...)` call, parentheses balanced. */
function writeAuditCalls(): string[] {
  const calls: string[] = [];
  for (const file of sources(SRC)) {
    if (file.endsWith(join('audit', 'audit.ts'))) continue;
    const s = readFileSync(file, 'utf8');
    for (let i = s.indexOf('writeAudit('); i >= 0; i = s.indexOf('writeAudit(', i + 1)) {
      let j = i + 'writeAudit('.length;
      for (let depth = 1; depth > 0 && j < s.length; j++) {
        if (s[j] === '(') depth++;
        else if (s[j] === ')') depth--;
      }
      calls.push(s.slice(i, j));
    }
  }
  return calls;
}

/**
 * Every action a `writeAudit` call can write: quoted literals (`action: 'x'`, either result of a ternary but not what
 * it compares, or a template with nothing interpolated), and the fixed prefixes of interpolated templates
 * (`grant.${decision}` gives `grant.`).
 */
function auditActions(): { literals: Set<string>; prefixes: Set<string> } {
  const literals = new Set<string>();
  const prefixes = new Set<string>();
  for (const call of writeAuditCalls()) {
    for (const m of call.matchAll(/action:\s*(`[^`]*`|[^,}\n]+)/g)) {
      const expr = m[1].trim();
      if (expr.startsWith('`')) {
        const body = expr.slice(1, -1);
        const at = body.indexOf('${');
        if (at < 0) literals.add(body);
        else prefixes.add(body.slice(0, at));
      } else for (const q of expr.matchAll(/(?:^|[?:])\s*'([^']+)'/g)) literals.add(q[1]);
    }
  }
  return { literals, prefixes };
}

describe('event catalogue', { skip: SKIP_NO_DB }, () => {
  let pool: Pool;
  let checks: Map<string, Set<string>>;
  let tables: Set<string>;

  before(async () => {
    pool = new Pool({ connectionString: testDatabaseUrl() });
    await resetPublicSchema(pool);
    await runMigrations(pool, migrationsDir);
    tables = new Set((await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`)).rows.map((r) => r.table_name as string));
    // The kind, action or outcome CHECK list of every event table, from the database catalogue.
    const rows = (
      await pool.query(
        `SELECT cl.relname AS tbl, pg_get_constraintdef(c.oid) AS def
           FROM pg_constraint c
           JOIN pg_class cl ON cl.oid = c.conrelid
           JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
          WHERE c.contype = 'c' AND c.connamespace = 'public'::regnamespace AND cardinality(c.conkey) = 1
            AND a.attname IN ('kind', 'action', 'outcome')
            AND (cl.relname LIKE '%\\_events' OR cl.relname IN ('email_attempts', 'notification_triggers'))`,
      )
    ).rows as Array<{ tbl: string; def: string }>;
    checks = new Map();
    for (const r of rows) {
      const set = checks.get(r.tbl) ?? new Set<string>();
      for (const m of r.def.matchAll(/'([^']+)'/g)) set.add(m[1]);
      checks.set(r.tbl, set);
    }
  });
  after(async () => {
    await pool.end();
  });

  const inCatalogue = (table: string, name: string) => CATALOGUE.some((e) => e.table === table && e.name === name);

  test('every writeAudit literal under app/src is in the catalogue', () => {
    const { literals, prefixes } = auditActions();
    assert.ok(literals.size > 50, `only ${literals.size} literals found: is the scan reading app/src?`);
    assert.ok(literals.has('analytics.exported') && literals.has('leadership.granted') && literals.has('access_settings.changed'));
    const missing = [...literals].filter((a) => !inCatalogue('audit_events', a));
    assert.deepEqual(missing, [], 'audit actions missing from the catalogue');
    const noFamily = [...prefixes].filter((p) => !CATALOGUE.some((e) => e.table === 'audit_events' && e.name.startsWith(p) && e.name.length > p.length));
    assert.deepEqual(noFamily, [], 'interpolated audit actions with no catalogue entry');
  });

  test('every event-table CHECK value is in the catalogue', () => {
    assert.ok(checks.has('task_events') && checks.has('leadership_grant_events'));
    const missing: string[] = [];
    for (const [table, values] of checks) for (const v of values) if (!inCatalogue(table, v)) missing.push(`${table}.${v}`);
    assert.deepEqual(missing, []);
    // Event tables without a CHECK list still have their entries.
    const eventTables = [...tables].filter((t) => /_events$|_changes$|_transitions$|_edits$/.test(t) || t === 'email_attempts' || t === 'notification_triggers');
    const uncovered = eventTables.filter((t) => t !== 'audit_events' && !CATALOGUE.some((e) => e.table === t));
    assert.deepEqual(uncovered, []);
  });

  test('the catalogue names nothing that no longer exists', () => {
    const { literals, prefixes } = auditActions();
    const stale: string[] = [];
    const seen = new Set<string>();
    for (const e of CATALOGUE) {
      const key = `${e.table}.${e.name}`;
      if (seen.has(key)) stale.push(`${key} (twice)`);
      seen.add(key);
      if (!tables.has(e.table)) stale.push(`${key} (no such table)`);
      else if (e.table === 'audit_events') {
        if (!literals.has(e.name) && ![...prefixes].some((p) => e.name.startsWith(p))) stale.push(`${key} (never written)`);
      } else if (checks.has(e.table) && !checks.get(e.table)?.has(e.name)) stale.push(`${key} (not in the CHECK list)`);
      for (const f of ['name', 'table', 'version', 'area', 'meaning', 'actor', 'subject'] as const) {
        if (typeof e[f] !== 'string' || e[f].trim() === '') stale.push(`${key} (empty ${f})`);
      }
      if (!Array.isArray(e.measurements)) stale.push(`${key} (measurements)`);
    }
    assert.deepEqual(stale, []);
  });
});
