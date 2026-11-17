/**
 * The cleaning engine (history spec 7.4): for one item, every registered text value of the item and its derived rows
 * that holds the marked text is encrypted into quarantine_originals and replaced by its cleaned value; offsets into a
 * cleaned version (passages, transcript spans, quote locations) are mapped through the replacements; an uploaded
 * original is withheld. restoreOriginals decrypts them back into place (release unchanged, dismissing a copy).
 *
 * This is the only file outside tests that names the transaction-local setting that opens the immutability exception
 * (a test fails otherwise). Both entry points run inside a transaction the caller owns and set the setting there;
 * they never COMMIT, ROLLBACK or open a savepoint (kainow_quarantine_writing() checks the case row's xmin against the
 * top-level transaction when a case is being closed).
 *
 * Nothing here logs, and no error carries a value: a database error is rethrown naming the table and its SQLSTATE
 * only, because PostgreSQL's own detail ("Failing row contains ...") would quote the row.
 *
 * Decisions (Claude's call, see the task report):
 *  - Every column written gets its own originals row, offsets included (stored as JSON numbers), so restoring is
 *    exact: widening an offset to the marker cannot be inverted by mapping back.
 *  - Columns computed from a value are recomputed from the value written, both ways, and get no originals row:
 *    source_versions.text_sha256 and char_count, message_versions.body_sha256, and for a withheld upload
 *    original_sha256 (NULL while withheld: a hash of a small file is a guessing oracle) and quarantined_at.
 *  - summary_marks.phrase is in the table's primary key. A cleaned phrase that would equal another mark of the same
 *    version and kind gets " (2)", " (3)", ... appended; quarantine_originals.row_key holds that cleaned phrase.
 *  - A proposal whose quote changed is "Quote changed: credential removed — review": there is no column for it,
 *    it is derived when shown from an unrestored quarantine_originals row for extraction_items.quote
 *    (quoteChangedItems).
 *  - JSON keys are never rewritten (they are fixed by code); only string leaves are cleaned.
 */
import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { uuidv7 } from '../common/uuid7';
import { type Edit, cleanEdges, cleanJson, cleanText, mapOffset, removedSpans, searchForms } from './clean-text';
import type { ProtectedKey } from './protected-key';
import { locateQuote } from '../notes/text';
import { TEXT_COLUMNS, type ItemKind, type TextColumn } from './registry';

export const QUOTE_CHANGED_TEXT = 'Quote changed: credential removed — review';
/** Shown on a source version whose uploaded original is withheld (source_versions.quarantined_at is set). */
export const WITHHELD_TEXT = 'Original file withheld — credential removed from text';

type Db = Pick<PoolClient, 'query'>;
type Row = Record<string, unknown>;
type Codec = 'text' | 'json' | 'bytes';

const REGISTERED = new Map(TEXT_COLUMNS.map((c) => [`${c.table}.${c.column}`, c]));

/** Offsets the engine maps; stored in quarantine_originals like any column, as JSON numbers. */
const OFFSET_COLUMNS: Record<string, string[]> = {
  passages: ['start_offset', 'end_offset'],
  transcript_spans: ['header_start', 'body_start', 'body_end'],
  // quote_matches and chosen_occurrence follow the quote's places in the cleaned text.
  extraction_items: ['quote_start', 'quote_end', 'quote_matches', 'chosen_occurrence'],
};

/** Row keys of the tables the engine writes (the registry's, plus transcript_spans which holds offsets only). */
const ROW_KEYS = new Map<string, string[]>([
  ...TEXT_COLUMNS.map((c) => [c.table, c.rowKey] as [string, string[]]),
  ['transcript_spans', ['source_version_id', 'header_start']],
]);

/** The versioned texts other rows point into; cleaned first so their derived rows are recomputed, not replaced. */
const VERSION_TEXTS: Array<{ table: 'source_versions' | 'message_versions'; column: string; owner: 'source_version' | 'message_version' }> = [
  { table: 'source_versions', column: 'text_content', owner: 'source_version' },
  { table: 'message_versions', column: 'body', owner: 'message_version' },
];

function codecOf(table: string, column: string): Codec {
  const reg = REGISTERED.get(`${table}.${column}`);
  if (reg) return reg.binary ? 'bytes' : reg.json || reg.array ? 'json' : 'text';
  if (OFFSET_COLUMNS[table]?.includes(column)) return 'json';
  throw new Error(`quarantine: ${table}.${column} is not a column the cleaning engine writes`);
}

function encode(value: unknown, codec: Codec): Buffer {
  if (codec === 'bytes') return value as Buffer;
  if (codec === 'json') return Buffer.from(JSON.stringify(value), 'utf8');
  if (typeof value !== 'string') throw new Error('quarantine: a text value was not a string');
  return Buffer.from(value, 'utf8');
}

function decode(plain: Buffer, codec: Codec): unknown {
  if (codec === 'bytes') return plain;
  const s = plain.toString('utf8');
  if (codec !== 'json') return s;
  try {
    return JSON.parse(s);
  } catch {
    throw new Error('quarantine: a decrypted original is not valid JSON');
  }
}

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

/** What quarantine_originals.cleaned_sha256 holds for a value: the SHA-256 of its encoding, or 'null'. */
function fingerprint(value: unknown, codec: Codec): string {
  return value === null || value === undefined ? 'null' : sha256(encode(value, codec));
}

const same = (a: unknown, b: unknown): boolean => {
  if (Buffer.isBuffer(a) || Buffer.isBuffer(b)) return Buffer.isBuffer(a) && Buffer.isBuffer(b) && a.equals(b);
  return JSON.stringify(a) === JSON.stringify(b);
};

const keyOf = (table: string, row: Row): Row => Object.fromEntries((ROW_KEYS.get(table) as string[]).map((k) => [k, row[k]]));
const rowId = (table: string, key: Row): string => `${table}\u0000${JSON.stringify((ROW_KEYS.get(table) as string[]).map((k) => key[k]))}`;

/** A database error without its detail (which could quote the row): table and SQLSTATE only. */
function quiet(err: unknown, table: string): Error {
  const code = (err as { code?: string }).code;
  const out = new Error(`quarantine write to ${table} failed${code ? ` (${code})` : ''}`) as Error & { code?: string };
  if (code) out.code = code;
  return out;
}

async function openWrite(c: Db, caseId: string): Promise<void> {
  await c.query(`SELECT set_config('kainow.quarantine_write', $1, true)`, [caseId]);
}

/**
 * Closes the exception again before an entry point returns or throws, so nothing else in the caller's transaction
 * can write an immutable row (Review Focus 3). On a failed (aborted) transaction the reset cannot run, and nothing
 * more can run in it either, so that error is ignored.
 */
async function closeWrite(c: Db): Promise<void> {
  await c.query(`SELECT set_config('kainow.quarantine_write', '', true)`).catch(() => undefined);
}

// ---------------------------------------------------------------------------------------------------------------
// Writing rows
// ---------------------------------------------------------------------------------------------------------------

/** One row to update: located by `key`; `set` holds every column written (including key columns and aux columns). */
interface RowWrite {
  table: string;
  key: Row;
  set: Row;
}

/** A value as jsonb_populate_record reads it into its column. */
function toJson(v: unknown): unknown {
  if (Buffer.isBuffer(v)) return `\\x${v.toString('hex')}`;
  if (v instanceof Date) return v.toISOString();
  return v;
}

/** Columns computed from a written value (see the header): recomputed whenever the value is written. */
function withAux(w: RowWrite): RowWrite {
  const set = { ...w.set };
  if (w.table === 'source_versions') {
    if (typeof set.text_content === 'string') {
      set.text_sha256 = sha256(set.text_content);
      set.char_count = set.text_content.length;
    }
    if ('original_bytes' in set) {
      const bytes = set.original_bytes as Buffer | null;
      set.original_sha256 = bytes ? sha256(bytes) : null;
      set.quarantined_at = bytes ? null : new Date();
    }
  }
  if (w.table === 'message_versions' && typeof set.body === 'string') set.body_sha256 = sha256(set.body);
  return { ...w, set };
}

async function updateGroup(c: Db, table: string, columns: string[], rows: RowWrite[]): Promise<void> {
  const keys = ROW_KEYS.get(table) as string[];
  const sql = `UPDATE ${table} t SET ${columns.map((col) => `${col} = v.${col}`).join(', ')}
                 FROM jsonb_array_elements($1::jsonb) e
                 CROSS JOIN LATERAL jsonb_populate_record(NULL::${table}, e->'k') k
                 CROSS JOIN LATERAL jsonb_populate_record(NULL::${table}, e->'v') v
                WHERE ${keys.map((k) => `t.${k} = k.${k}`).join(' AND ')}`;
  const payload = rows.map((r) => ({
    k: Object.fromEntries(Object.entries(r.key).map(([n, v]) => [n, toJson(v)])),
    v: Object.fromEntries(Object.entries(r.set).map(([n, v]) => [n, toJson(v)])),
  }));
  let result;
  try {
    result = await c.query(sql, [JSON.stringify(payload)]);
  } catch (err) {
    throw quiet(err, table);
  }
  if (result.rowCount !== rows.length) throw new Error(`quarantine write to ${table}: ${result.rowCount} of ${rows.length} rows found`);
}

/**
 * Writes rows. Rows whose key does not change are written one statement per table and column set. A row whose key
 * changes (transcript_spans.header_start, summary_marks.phrase) is written alone, in an order where no row takes a
 * key another row still holds: rows moving to a larger number last-first, then rows moving to a smaller one
 * first-first (the offset mapping is monotonic, so this order never collides).
 */
async function writeRows(c: Db, writes: RowWrite[]): Promise<void> {
  const groups = new Map<string, RowWrite[]>();
  const moving: RowWrite[] = [];
  for (const raw of writes) {
    const w = withAux(raw);
    const keys = ROW_KEYS.get(w.table) as string[];
    if (keys.some((k) => k in w.set && !same(w.set[k], w.key[k]))) {
      moving.push(w);
      continue;
    }
    const cols = Object.keys(w.set).sort();
    const g = `${w.table}\u0000${cols.join(',')}`;
    groups.set(g, [...(groups.get(g) ?? []), w]);
  }
  for (const [g, rows] of groups) {
    const [table, cols] = g.split('\u0000');
    await updateGroup(c, table, cols.split(','), rows);
  }
  const numericMove = (w: RowWrite): number => {
    const k = (ROW_KEYS.get(w.table) as string[]).find((n) => typeof w.key[n] === 'number' && n in w.set);
    return k ? (w.set[k] as number) - (w.key[k] as number) : 0;
  };
  const pos = (w: RowWrite): number => {
    const k = (ROW_KEYS.get(w.table) as string[]).find((n) => typeof w.key[n] === 'number');
    return k ? (w.key[k] as number) : 0;
  };
  const up = moving.filter((w) => numericMove(w) > 0).sort((a, b) => pos(b) - pos(a));
  const rest = moving.filter((w) => numericMove(w) <= 0).sort((a, b) => pos(a) - pos(b));
  for (const w of [...up, ...rest]) await updateGroup(c, w.table, Object.keys(w.set).sort(), [w]);
}

// ---------------------------------------------------------------------------------------------------------------
// Cleaning
// ---------------------------------------------------------------------------------------------------------------

interface Change {
  before: unknown;
  after: unknown;
}

/** The changes planned for one item, row by row. */
class Plan {
  readonly rows = new Map<string, { table: string; key: Row; newKey: Row; cols: Map<string, Change> }>();

  has(table: string, key: Row, column: string): boolean {
    return this.rows.get(rowId(table, key))?.cols.has(column) ?? false;
  }

  set(table: string, key: Row, column: string, before: unknown, after: unknown): void {
    if (same(before, after)) return;
    const id = rowId(table, key);
    let row = this.rows.get(id);
    if (!row) {
      row = { table, key, newKey: { ...key }, cols: new Map() };
      this.rows.set(id, row);
    }
    row.cols.set(column, { before, after });
    if (column in row.newKey) row.newKey[column] = after;
  }
}

function formsFor(col: TextColumn, marks: string[]): string[] {
  const html = col.table === 'email_outbox' && col.column === 'html_body';
  const forms = searchForms(marks, html);
  // In jsonb's text form a string's quotes, backslashes and control characters are escaped.
  return col.json ? [...new Set([...forms, ...forms.map((f) => JSON.stringify(f).slice(1, -1))])] : forms;
}

function containsSql(col: TextColumn, param: string): string {
  const cond = col.json
    ? 'strpos(q.value::text, m) > 0'
    : col.array
      ? 'EXISTS (SELECT 1 FROM unnest(q.value) e WHERE strpos(e, m) > 0)'
      : 'strpos(q.value, m) > 0';
  return `EXISTS (SELECT 1 FROM unnest(${param}::text[]) m WHERE ${cond})`;
}

/** The rows of `sql` (a registry query, $1 = id) whose value may hold a mark. Over-inclusion is harmless. */
async function holding(c: Db, col: TextColumn, sql: string, id: string, marks: string[]): Promise<Row[]> {
  const forms = formsFor(col, marks);
  if (forms.length === 0) return [];
  try {
    return (await c.query(`SELECT q.* FROM (${sql}) q WHERE ${containsSql(col, '$2')}`, [id, forms])).rows;
  } catch (err) {
    throw quiet(err, col.table);
  }
}

function cleanValue(col: TextColumn, value: unknown, marks: string[]): unknown {
  if (value === null || value === undefined) return value;
  if (col.json) return cleanJson(value, marks);
  if (col.array) return (value as Array<string | null>).map((v) => (v === null ? v : cleanText(v, marks).text));
  return cleanText(value as string, marks, col.table === 'email_outbox' && col.column === 'html_body').text;
}

/**
 * The rows derived from cleaned versions, recomputed: passages re-sliced between mapped offsets, transcript spans
 * mapped, proposal quotes re-sliced (or, unplaced, cleaned with their cut-off edges), uploads withheld.
 */
async function planDerived(
  c: Db,
  plan: Plan,
  owner: 'source_version' | 'message_version',
  versions: Map<string, { before: string; after: string; edits: Edit[] }>,
  marks: string[],
): Promise<void> {
  const ids = [...versions.keys()];
  const passages = await c.query(`SELECT id, owner_id, start_offset, end_offset, body FROM passages WHERE owner_kind = $1 AND owner_id = ANY($2::uuid[])`, [owner, ids]);
  for (const p of passages.rows) {
    const v = versions.get(p.owner_id) as { after: string; edits: Edit[] };
    const start = mapOffset(v.edits, p.start_offset, 'start');
    const end = mapOffset(v.edits, p.end_offset, 'end');
    const key = { id: p.id };
    plan.set('passages', key, 'start_offset', p.start_offset, start);
    plan.set('passages', key, 'end_offset', p.end_offset, end);
    plan.set('passages', key, 'body', p.body, v.after.slice(start, end));
  }
  if (owner !== 'source_version') return;

  const spans = await c.query(
    `SELECT source_version_id, header_start, body_start, body_end FROM transcript_spans WHERE source_version_id = ANY($1::uuid[])`,
    [ids],
  );
  for (const s of spans.rows) {
    const { edits } = versions.get(s.source_version_id) as { edits: Edit[] };
    const key = { source_version_id: s.source_version_id, header_start: s.header_start };
    plan.set('transcript_spans', key, 'body_start', s.body_start, mapOffset(edits, s.body_start, 'start'));
    plan.set('transcript_spans', key, 'body_end', s.body_end, mapOffset(edits, s.body_end, 'end'));
    plan.set('transcript_spans', key, 'header_start', s.header_start, mapOffset(edits, s.header_start, 'start'));
  }

  const items = await c.query(
    `SELECT id, source_version_id, quote, quote_start, quote_end, quote_matches, chosen_occurrence, review_status
       FROM extraction_items WHERE source_version_id = ANY($1::uuid[])`,
    [ids],
  );
  for (const i of items.rows) {
    const v = versions.get(i.source_version_id) as { before: string; after: string; edits: Edit[] };
    planQuote(plan, i, v, marks);
  }

  const uploads = await c.query(`SELECT id, original_bytes FROM source_versions WHERE id = ANY($1::uuid[]) AND original_bytes IS NOT NULL`, [ids]);
  for (const u of uploads.rows) plan.set('source_versions', { id: u.id }, 'original_bytes', u.original_bytes, null);
}

/**
 * A proposal's quote in a cleaned version. Unplaced: cleaned with its cut-off edges, nothing else. Placed: its places
 * are mapped. The quote text is rewritten only when a replaced span overlaps one of its places (then it is the cleaned
 * slice, so it shows QUOTE_CHANGED_TEXT); quote_start/quote_end become its first place in the cleaned text,
 * quote_matches the count of places there, and an approved proposal's chosen_occurrence the index of the place the
 * reviewer chose, mapped (spec 7.4; migration 0008's numbering, as locateQuote).
 */
function planQuote(plan: Plan, i: Row, v: { before: string; after: string; edits: Edit[] }, marks: string[]): void {
  const key = { id: i.id };
  const quote = i.quote as string;
  if (i.quote_start === null) {
    plan.set('extraction_items', key, 'quote', quote, cleanEdges(quote, marks));
    return;
  }
  const qs = i.quote_start as number;
  const qe = i.quote_end as number;
  const before = locateQuote(v.before, quote);
  const placed = before.length > 0 && before.some((p) => p.start === qs && p.end === qe);
  const chosen = i.chosen_occurrence === null ? null : (i.chosen_occurrence as number);
  const intended = chosen !== null && before[chosen] ? before[chosen] : { start: qs, end: qe };
  const touched = (p: { start: number; end: number }) => v.edits.some((e) => e.from < p.end && e.to > p.start);
  const overlaps = placed ? before.some(touched) : touched({ start: qs, end: qe });
  let newQuote = quote;
  if (overlaps) {
    newQuote = placed
      ? v.after.slice(mapOffset(v.edits, intended.start, 'start'), mapOffset(v.edits, intended.end, 'end'))
      : cleanEdges(quote, marks);
  }
  const intendedStart = mapOffset(v.edits, intended.start, 'start');
  const after = locateQuote(v.after, newQuote);
  let start = mapOffset(v.edits, qs, 'start');
  let end = mapOffset(v.edits, qe, 'end');
  let matches = i.quote_matches as number;
  let chosenAfter = chosen;
  if (placed && after.length > 0) {
    ({ start, end } = after[0]);
    matches = after.length;
    const at = after.findIndex((p) => p.start === intendedStart);
    chosenAfter = i.review_status === 'approved' && matches > 1 ? Math.max(at, 0) : null;
  }
  plan.set('extraction_items', key, 'quote_start', qs, start);
  plan.set('extraction_items', key, 'quote_end', qe, end);
  plan.set('extraction_items', key, 'quote_matches', i.quote_matches, matches);
  plan.set('extraction_items', key, 'chosen_occurrence', chosen, chosenAfter);
  plan.set('extraction_items', key, 'quote', quote, newQuote);
}

/** Unique phrases for cleaned summary marks (the phrase is in the primary key). */
async function uniquePhrase(c: Db, taken: Map<string, Set<string>>, key: Row, phrase: string): Promise<string> {
  const scope = `${key.version_id}\u0000${key.kind}`;
  let used = taken.get(scope);
  if (!used) {
    const r = await c.query(`SELECT phrase FROM summary_marks WHERE version_id = $1 AND kind = $2`, [key.version_id, key.kind]);
    used = new Set(r.rows.map((x) => x.phrase as string));
    taken.set(scope, used);
  }
  let out = phrase;
  for (let n = 2; used.has(out); n++) out = `${phrase} (${n})`;
  used.add(out);
  return out;
}

/**
 * Cleans one item and the rows derived from it (spec 7.4, "the sweep"), within the caller's transaction, under case
 * `caseId` (which must be open). Returns the number of rows written.
 */
export async function cleanItem(
  c: PoolClient,
  key: ProtectedKey,
  caseId: string,
  kind: ItemKind,
  itemId: string,
  marks: string[],
): Promise<{ rows: number }> {
  const plan = new Plan();

  // 1. The versioned texts, and what points into them.
  for (const vt of VERSION_TEXTS) {
    const col = REGISTERED.get(`${vt.table}.${vt.column}`) as TextColumn;
    const sql = col.itemSql?.[kind];
    if (!sql) continue;
    const versions = new Map<string, { before: string; after: string; edits: Edit[] }>();
    for (const r of await holding(c, col, sql, itemId, marks)) {
      const { text, edits } = cleanText(r.value as string, marks);
      if (edits.length === 0) continue;
      plan.set(vt.table, keyOf(vt.table, r), vt.column, r.value, text);
      versions.set(r.id as string, { before: r.value as string, after: text, edits });
    }
    if (versions.size > 0) await planDerived(c, plan, vt.owner, versions, marks);
  }

  // 2. Every other registered column the item reaches.
  const phrases = new Map<string, Set<string>>();
  for (const col of TEXT_COLUMNS) {
    if (col.binary || VERSION_TEXTS.some((v) => v.table === col.table && v.column === col.column)) continue;
    const sql = col.itemSql?.[kind];
    if (!sql) continue;
    for (const r of await holding(c, col, sql, itemId, marks)) {
      const rowKey = keyOf(col.table, r);
      if (plan.has(col.table, rowKey, col.column)) continue;
      let after = cleanValue(col, r.value, marks);
      if (same(after, r.value)) continue;
      if (col.table === 'summary_marks') after = await uniquePhrase(c, phrases, rowKey, after as string);
      plan.set(col.table, rowKey, col.column, r.value, after);
    }
  }
  if (plan.rows.size === 0) return { rows: 0 };

  // 3. Originals first (encrypted, keyed by the cleaned row key), then the cleaned values.
  try {
    await openWrite(c, caseId);
    return await writePlan(c, key, caseId, kind, itemId, plan);
  } finally {
    await closeWrite(c);
  }
}

async function writePlan(c: Db, key: ProtectedKey, caseId: string, kind: ItemKind, itemId: string, plan: Plan): Promise<{ rows: number }> {
  const originals: unknown[] = [];
  const writes: RowWrite[] = [];
  for (const row of plan.rows.values()) {
    const set: Row = {};
    for (const [column, ch] of row.cols) {
      const codec = codecOf(row.table, column);
      const sealed = key.encrypt(encode(ch.before, codec));
      originals.push({
        id: uuidv7(),
        table: row.table,
        rowKey: row.newKey,
        column,
        ciphertext: sealed.ciphertext.toString('base64'),
        nonce: sealed.nonce.toString('base64'),
        tag: sealed.tag.toString('base64'),
        sha: fingerprint(ch.after, codec),
      });
      set[column] = ch.after;
    }
    writes.push({ table: row.table, key: row.key, set });
  }
  try {
    await c.query(
      `INSERT INTO quarantine_originals (id, case_id, table_name, row_key, column_name, item_kind, item_id, sweep, ciphertext, nonce, tag, key_id, cleaned_sha256)
       SELECT (e->>'id')::uuid, $2, e->>'table', e->'rowKey', e->>'column', $3, $4, s.sweep,
              decode(e->>'ciphertext', 'base64'), decode(e->>'nonce', 'base64'), decode(e->>'tag', 'base64'), $5, e->>'sha'
         FROM jsonb_array_elements($1::jsonb) e, (SELECT nextval('quarantine_sweep_seq') AS sweep) s`,
      [JSON.stringify(originals), caseId, kind, itemId, key.id],
    );
  } catch (err) {
    throw quiet(err, 'quarantine_originals');
  }
  await writeRows(c, writes);
  return { rows: writes.length };
}

// ---------------------------------------------------------------------------------------------------------------
// Finding other places
// ---------------------------------------------------------------------------------------------------------------

/**
 * The items of the project, other than `except`, with a registered value holding a mark (spec 7.4, "copies in other
 * items"). Rows that belong to no item (reasons, notices, transcripts) are not places; a transcript's text is
 * reported through its message.
 */
export async function findPlaces(
  c: PoolClient,
  projectId: string,
  marks: string[],
  except: { kind: ItemKind; id: string },
): Promise<Array<{ kind: ItemKind; id: string }>> {
  const params: unknown[] = [projectId, except.kind, except.id];
  const formParam = new Map<string, string>();
  const parts: string[] = [];
  for (const col of TEXT_COLUMNS) {
    if (col.binary) continue;
    const forms = formsFor(col, marks);
    if (forms.length === 0) continue;
    const id = JSON.stringify(forms);
    let p = formParam.get(id);
    if (!p) {
      params.push(forms);
      p = `$${params.length}`;
      formParam.set(id, p);
    }
    parts.push(`SELECT q.item_kind, q.item_id FROM (${col.projectSql}) q WHERE q.item_kind IS NOT NULL AND ${containsSql(col, p)}`);
  }
  if (parts.length === 0) return [];
  const { rows } = await c.query(
    `SELECT DISTINCT x.item_kind AS kind, x.item_id::text AS id FROM (${parts.join('\n UNION ALL ')}) x
      WHERE NOT (x.item_kind = $2 AND x.item_id = $3::uuid)
      ORDER BY 1, 2`,
    params,
  );
  return rows as Array<{ kind: ItemKind; id: string }>;
}

// ---------------------------------------------------------------------------------------------------------------
// Restoring
// ---------------------------------------------------------------------------------------------------------------

interface Original {
  id: string;
  table_name: string;
  row_key: Row;
  column_name: string;
  sweep: string;
  ciphertext: Buffer;
  nonce: Buffer;
  tag: Buffer;
  key_id: string;
  cleaned_sha256: string;
}

/** A row being restored: where it is stored now (loadKey), its values as they unwind, and what to write. */
interface Working {
  table: string;
  loadKey: Row;
  values: Row;
  set: Row;
}

/**
 * Decrypts the case's unrestored originals (or only those written by the sweep of `scope`) back into place. Sweeps
 * unwind newest first, so a value cleaned twice (Mark more) comes back through both. Within one sweep every original
 * of a row names the row's key as that sweep left it, so a key column restored (transcript_spans.header_start,
 * summary_marks.phrase) moves the row only once the whole sweep is applied. A value whose current SHA-256 is not the
 * one written at cleaning (changed since, e.g. a task amended during review) is left as it is and listed in `changed`
 * by table and (cleaned) row key. Restored originals get restored_at; the encrypted rows are kept.
 */
export async function restoreOriginals(
  c: PoolClient,
  key: ProtectedKey,
  caseId: string,
  scope?: { kind: ItemKind; id: string },
): Promise<{ restored: number; changed: Array<{ table: string; rowKey: unknown }> }> {
  const { rows } = await c.query<Original>(
    `SELECT id, table_name, row_key, column_name, sweep, ciphertext, nonce, tag, key_id, cleaned_sha256
       FROM quarantine_originals
      WHERE case_id = $1 AND restored_at IS NULL ${scope ? 'AND item_kind = $2 AND item_id = $3' : ''}
      ORDER BY sweep DESC`,
    scope ? [caseId, scope.kind, scope.id] : [caseId],
  );
  if (rows.length === 0) return { restored: 0, changed: [] };
  if (rows.some((o) => o.key_id !== key.id)) throw new Error('quarantine: an original was encrypted with another protected key');

  // Rows as stored now, loaded once per table; a row moves into `work` the first time an original reaches it.
  const stored = new Map<string, Row>();
  const keysByTable = new Map<string, Row[]>();
  for (const o of rows) keysByTable.set(o.table_name, [...(keysByTable.get(o.table_name) ?? []), o.row_key]);
  for (const [table, keys] of keysByTable) {
    const cols = ROW_KEYS.get(table);
    if (!cols) throw new Error(`quarantine: ${table} is not a table the cleaning engine writes`);
    let loaded;
    try {
      loaded = await c.query(
        `SELECT DISTINCT t.* FROM ${table} t JOIN jsonb_populate_recordset(NULL::${table}, $1::jsonb) k ON ${cols.map((k) => `t.${k} = k.${k}`).join(' AND ')}`,
        [JSON.stringify(keys)],
      );
    } catch (err) {
      throw quiet(err, table);
    }
    for (const r of loaded.rows) stored.set(rowId(table, keyOf(table, r)), r);
  }

  const work = new Map<string, Working>();
  const changed = new Map<string, { table: string; rowKey: unknown }>();
  const restored: string[] = [];
  for (let i = 0; i < rows.length; ) {
    const sweep = rows[i].sweep;
    const moved = new Set<Working>();
    for (; i < rows.length && rows[i].sweep === sweep; i++) {
      const o = rows[i];
      const id = rowId(o.table_name, o.row_key);
      let w = work.get(id);
      if (!w) {
        const r = stored.get(id);
        if (r) {
          stored.delete(id);
          w = { table: o.table_name, loadKey: keyOf(o.table_name, r), values: { ...r }, set: {} };
          work.set(id, w);
        }
      }
      const codec = codecOf(o.table_name, o.column_name);
      if (!w || fingerprint(w.values[o.column_name], codec) !== o.cleaned_sha256) {
        changed.set(id, { table: o.table_name, rowKey: o.row_key });
        continue;
      }
      const value = decode(key.decrypt(o), codec);
      w.values[o.column_name] = value;
      w.set[o.column_name] = value;
      restored.push(o.id);
      if ((ROW_KEYS.get(o.table_name) as string[]).includes(o.column_name)) moved.add(w);
    }
    // The sweep is applied: rows whose key came back are found by that key from the next (older) sweep on.
    for (const [id, w] of [...work]) if (moved.has(w)) work.delete(id);
    for (const w of moved) work.set(rowId(w.table, keyOf(w.table, w.values)), w);
  }

  const writes = [...new Set(work.values())].filter((w) => Object.keys(w.set).length > 0);
  try {
    await openWrite(c, caseId);
    await writeRows(c, writes.map((w) => ({ table: w.table, key: w.loadKey, set: w.set })));
  } finally {
    await closeWrite(c);
  }
  if (restored.length > 0) await c.query(`UPDATE quarantine_originals SET restored_at = now() WHERE id = ANY($1::uuid[])`, [restored]);
  return { restored: restored.length, changed: [...changed.values()] };
}

// ---------------------------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------------------------

/** The proposals (extraction items) among `itemIds` whose quote was cleaned and not restored: QUOTE_CHANGED_TEXT. */
export async function quoteChangedItems(db: Pool | PoolClient, itemIds: string[]): Promise<Set<string>> {
  if (itemIds.length === 0) return new Set();
  const { rows } = await db.query<{ id: string }>(
    `SELECT DISTINCT row_key->>'id' AS id FROM quarantine_originals
      WHERE table_name = 'extraction_items' AND column_name = 'quote' AND restored_at IS NULL AND row_key->>'id' = ANY($1::text[])`,
    [itemIds],
  );
  return new Set(rows.map((r) => r.id));
}

/** One original text value of an item, as Reveal original shows it (spec 7.6), with the place of each removed span. */
export interface RevealedValue {
  table: string;
  column: string;
  rowKey: Row;
  text: string;
  /** [start, end) of each removed span in `text`; empty when the stored value no longer shows where (changed since). */
  marks: Array<{ start: number; end: number }>;
}

/**
 * The original text values the case's sweeps of one item encrypted (spec 7.6, Reveal original), decrypted in memory
 * only: nothing is written. Text columns only (JSON, arrays, offsets and withheld uploads are not shown). A value
 * cleaned by several sweeps (Mark more) is shown as the oldest sweep found it, which is the original. The marks are
 * found by matching the original against the value stored now. The caller authorises; the result is for Reveal only.
 */
export async function readOriginals(c: Db, key: ProtectedKey, caseId: string, scope: { kind: ItemKind; id: string }): Promise<RevealedValue[]> {
  const { rows } = await c.query<Original>(
    `SELECT id, table_name, row_key, column_name, sweep, ciphertext, nonce, tag, key_id, cleaned_sha256
       FROM quarantine_originals
      WHERE case_id = $1 AND item_kind = $2 AND item_id = $3
      ORDER BY sweep, table_name, column_name, id`,
    [caseId, scope.kind, scope.id],
  );
  if (rows.some((o) => o.key_id !== key.id)) throw new Error('quarantine: an original was encrypted with another protected key');
  const seen = new Set<string>();
  const out: RevealedValue[] = [];
  for (const o of rows) {
    if (codecOf(o.table_name, o.column_name) !== 'text') continue;
    const id = `${o.table_name}|${o.column_name}|${JSON.stringify(o.row_key)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const text = decode(key.decrypt(o), 'text') as string;
    const keys = ROW_KEYS.get(o.table_name) as string[];
    let now: unknown;
    try {
      now = (
        await c.query(
          `SELECT t.${o.column_name} AS v FROM ${o.table_name} t, jsonb_populate_record(NULL::${o.table_name}, $1::jsonb) k WHERE ${keys.map((k) => `t.${k} = k.${k}`).join(' AND ')}`,
          [JSON.stringify(o.row_key)],
        )
      ).rows[0]?.v;
    } catch (err) {
      throw quiet(err, o.table_name);
    }
    const marks = typeof now === 'string' ? (removedSpans(text, now) ?? []) : [];
    out.push({ table: o.table_name, column: o.column_name, rowKey: o.row_key, text, marks });
  }
  return out.sort((a, b) => a.table.localeCompare(b.table) || a.column.localeCompare(b.column) || JSON.stringify(a.rowKey).localeCompare(JSON.stringify(b.rowKey)));
}
