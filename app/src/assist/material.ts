import type { PoolClient } from 'pg';
import { UUID } from '../common/uuid7';
import { audienceVisibleSql } from '../discussion/audience';
import { type ProjectContext, canReadContent } from '../projects/access.service';
import { hrefFor } from '../search/query';

type Db = Pick<PoolClient, 'query'>;

/**
 * Material search for AI requests (spec 4.2, 4.3) and the recheck of what a request used (spec 5.5).
 *
 * This file decides what any AI request may see. Every rule here follows global search (search.service.ts and the
 * search_documents view): a source's audience row is joined at query time, a deleted, submitted, returned or
 * `discussion` source is never material, a message counts only while visible, and only current versions are found.
 * Personal scope is what the requester may read (audienceVisibleSql, after canReadContent). Thread scope is what every
 * person in the thread's audience may read: Project-wide material and the thread's own audience row only, whatever
 * the requester could read, plus authorised records; never pending proposals.
 */

/** Kinds of record material; the same vocabulary as ai_request_material.record_kind. */
export type RecordKind = 'task' | 'decision' | 'question' | 'risk' | 'ai_proposal' | 'human_proposal';

export type MaterialScope = { kind: 'personal'; ctx: ProjectContext } | { kind: 'thread'; ctx: ProjectContext; threadAudienceId: string };

export interface MaterialItem {
  marker: string;
  passageId: string | null;
  recordKind: RecordKind | null;
  recordId: string | null;
  recordAudienceId: string | null;
  snapshot: string | null;
  text: string;
  location: string;
  href: string;
  rank: number;
}

export interface MaterialOptions {
  sourceIds?: string[];
  threadIds?: string[];
  period?: { from: string; to: string };
  recordKinds?: RecordKind[];
}

/** What readableMaterial needs of an item: the same fields ai_request_material stores. */
export type MaterialRef = Pick<MaterialItem, 'passageId' | 'recordKind' | 'recordId' | 'recordAudienceId'>;

/** The fields a snapshot is rendered from; each kind uses its own. Dates are already UTC+8 'YYYY-MM-DD'. */
export interface SnapshotRow {
  text: string;
  status?: string | null;
  /** Assignee (task), asker (question) or responsible person (risk). */
  person?: string | null;
  /** Due date (task) or review date (risk). */
  due?: string | null;
  severity?: string | null;
  mitigation?: string | null;
  rationale?: string | null;
  answers?: string[];
  authorisedOn?: string | null;
  /** A proposal's kind: action, decision, question or risk. */
  kind?: string | null;
  /** A proposal's owner and due date as written. */
  owner?: string | null;
  dueAsWritten?: string | null;
}

export const MAX_PASSAGES = 40;
export const MAX_CHARACTERS = 30_000;
export const MAX_RECORDS = 20;
export const PROPOSED_PREFIX = 'Proposed — not authorised: ';
const RECORD_BOOST = 1.2;
const RECENT_BOOST = 1.1;
const RECENT_DAYS = 30;
const AUTHORISED: RecordKind[] = ['task', 'decision', 'question', 'risk'];
const ALL_KINDS: RecordKind[] = [...AUTHORISED, 'ai_proposal', 'human_proposal'];

/** Placeholders in order; every value stays a bound parameter. */
class Params {
  readonly values: unknown[] = [];
  add(v: unknown): string {
    this.values.push(v);
    return `$${this.values.length}`;
  }
}

/**
 * SQL over the sources row `s`: true unless it is a `summary` source whose summary is not shown. The one rule for
 * notes lists, search and material (spec 7.2, 7.3):
 *   - approved, or Access review required (audience of the original tightened): shown;
 *   - hidden (a message of the meeting hidden or deleted, or the original deleted): shown only to a `viewer` in the
 *     original's audience; with no viewer (AI material, spec 4.3) never;
 *   - a draft or withdrawn: never.
 * The caller still applies the summary source's own audience.
 */
export function summaryShownSql(s: string, viewer?: { user: string; today: string }): string {
  const hidden = viewer
    ? ` OR (sm.state = 'hidden' AND EXISTS (
          SELECT 1 FROM audiences oa
           WHERE oa.id = COALESCE((SELECT os.audience_id FROM sources os WHERE os.id = sm.original_source_id),
                                  (SELECT ot.audience_id FROM discussion_threads ot WHERE ot.id = sm.original_thread_id))
             AND ${audienceVisibleSql('oa', viewer.user, viewer.today)}))`
    : '';
  return `(${s}.kind <> 'summary' OR EXISTS (SELECT 1 FROM summaries sm WHERE sm.id = ${s}.summary_id AND (sm.state IN ('approved', 'review_required')${hidden})))`;
}

/** A source whose current text may be material: not deleted, published, not a transcript, a summary only while approved. */
export function sourceOkSql(s: string): string {
  return `${s}.status <> 'deleted' AND ${s}.publication = 'published' AND ${s}.kind <> 'discussion'
     AND ${summaryShownSql(s)}`;
}

/** The scope's audience test over the audience row `a`. */
function audienceSql(scope: MaterialScope, p: Params, a: string): string {
  if (scope.kind === 'personal') return audienceVisibleSql(a, p.add(scope.ctx.viewerId), p.add(scope.ctx.today));
  return `(${a}.mode = 'project' OR ${a}.id = ${p.add(scope.threadAudienceId)}::uuid)`;
}

const ids = (xs: string[] | undefined): string[] => (xs ?? []).filter((x) => typeof x === 'string' && UUID.test(x));

function label(s: string | null | undefined): string {
  const t = (s ?? '').replace(/_/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
}

const flat = (s: string): string => s.replace(/\s+/g, ' ').trim();
const sentence = (s: string): string => {
  const t = flat(s);
  return /[.!?]$/.test(t) ? t : `${t}.`;
};

/** Kainow's own rendering of a record's current fields. Never a quote or evidence text from a source. */
export function snapshotOf(kind: RecordKind, row: SnapshotRow): string {
  const parts: string[] = [];
  const field = (name: string, value: string | null | undefined) => {
    if (value !== null && value !== undefined && flat(value) !== '') parts.push(`${name}: ${sentence(value)}`);
  };
  switch (kind) {
    case 'task':
      parts.push(`Task: ${sentence(row.text)}`);
      field('Status', label(row.status));
      field('Assigned to', row.person);
      field('Due', row.due);
      break;
    case 'decision':
      parts.push(`Decision: ${sentence(row.text)}`);
      field('Rationale', row.rationale);
      field('Status', label(row.status));
      field('Authorised on', row.authorisedOn);
      break;
    case 'question': {
      parts.push(`Question: ${sentence(row.text)}`);
      field('Status', label(row.status));
      field('Asked by', row.person);
      const answers = (row.answers ?? []).filter((a) => flat(a) !== '');
      if (answers.length === 1) field('Answer', answers[0]);
      else if (answers.length > 1) parts.push(`Answers: ${answers.map((a, i) => `(${i + 1}) ${sentence(a)}`).join(' ')}`);
      break;
    }
    case 'risk':
      parts.push(`Risk: ${sentence(row.text)}`);
      field('Severity', label(row.severity));
      field('Status', label(row.status));
      field('Responsible', row.person);
      field('Review on', row.due);
      field('Mitigation', row.mitigation);
      break;
    case 'ai_proposal':
    case 'human_proposal':
      parts.push(`${PROPOSED_PREFIX}${label(row.kind)}: ${sentence(row.text)}`);
      field('Owner as written', row.owner);
      field('Due as written', row.dueAsWritten);
      break;
  }
  return parts.join(' ');
}

/** `websearch_to_tsquery` per term joined with `||`, for one configuration. */
function tsquerySql(config: 'english' | 'simple', placeholders: string[]): string {
  return `(${placeholders.map((t) => `websearch_to_tsquery('${config}', ${t}::text)`).join(' || ')})`;
}

const KL = `'Asia/Kuala_Lumpur'`;

interface PassageRow {
  id: string;
  body: string;
  location: string;
  ownerTitle: string;
  sourceId: string | null;
  threadId: string | null;
  messageNo: number | null;
  rank: number;
}

interface RecordHit {
  kind: RecordKind;
  id: string;
  audienceId: string | null;
  rank: number;
}

/**
 * Finds the material for a request: passages within the budget (40 passages or 30,000 characters, stopping at the
 * first that does not fit) plus up to 20 record snapshots, marked P1…Pn in rank order. With chosen sources or
 * threads only their passages are searched (a chosen meeting brings its minutes too); with no terms, their passages
 * come in document order and no records are added.
 */
export async function findMaterial(db: Db, scope: MaterialScope, terms: string[], opts: MaterialOptions = {}): Promise<MaterialItem[]> {
  if (scope.kind === 'personal' && !canReadContent(scope.ctx)) return [];
  const projectId = scope.ctx.project.id;
  const sourceIds = ids(opts.sourceIds);
  const threadIds = ids(opts.threadIds);
  const chosen = (opts.sourceIds?.length ?? 0) + (opts.threadIds?.length ?? 0) > 0;
  const words = terms.filter((t) => typeof t === 'string' && t.trim() !== '');
  if (words.length === 0 && !chosen) return [];

  const passages = await findPassages(db, scope, projectId, words, chosen, sourceIds, threadIds, opts.period);
  const items: MaterialItem[] = [];
  let characters = 0;
  for (const p of passages) {
    if (items.length >= MAX_PASSAGES || characters + p.body.length > MAX_CHARACTERS) break;
    characters += p.body.length;
    items.push({
      marker: '',
      passageId: p.id,
      recordKind: null,
      recordId: null,
      recordAudienceId: null,
      snapshot: null,
      text: p.body,
      location: `${p.ownerTitle} — ${p.location}`,
      href:
        p.threadId !== null && p.messageNo !== null
          ? hrefFor({ kind: 'message', projectId, itemId: p.id, runId: null, versionNo: null, isCurrent: true, threadId: p.threadId, messageNo: p.messageNo })
          : hrefFor({ kind: 'note', projectId, itemId: p.sourceId as string, runId: null, versionNo: null, isCurrent: true }),
      rank: Number(p.rank),
    });
  }

  if (words.length > 0) {
    const kinds = (opts.recordKinds ?? ALL_KINDS).filter((k) => scope.kind === 'personal' || AUTHORISED.includes(k));
    if (kinds.length > 0) items.push(...(await findRecords(db, scope, projectId, words, kinds)));
  }

  // Stable: equal ranks keep their order (document order when there are no terms).
  const ordered = items.map((item, i) => ({ item, i })).sort((a, b) => b.item.rank - a.item.rank || a.i - b.i).map((x) => x.item);
  ordered.forEach((item, i) => {
    item.marker = `P${i + 1}`;
  });
  return ordered;
}

async function findPassages(
  db: Db,
  scope: MaterialScope,
  projectId: string,
  words: string[],
  chosen: boolean,
  sourceIds: string[],
  threadIds: string[],
  period: MaterialOptions['period'],
): Promise<PassageRow[]> {
  const p = new Params();
  const proj = p.add(projectId);
  const termPh = words.map((w) => p.add(w));
  const qe = words.length > 0 ? tsquerySql('english', termPh) : null;
  const qs = words.length > 0 ? tsquerySql('simple', termPh) : null;
  const match = qe && qs ? `(p.english @@ ${qe} OR p.simple @@ ${qs})` : 'true';
  const src = p.add(sourceIds);
  const thr = p.add(threadIds);
  const sourceOwner = chosen ? `AND (s.id = ANY(${src}::uuid[]) OR s.thread_id = ANY(${thr}::uuid[]))` : '';
  const messageOwner = chosen ? `AND th.id = ANY(${thr}::uuid[])` : '';
  let within = (_at: string) => '';
  if (period) {
    const from = p.add(period.from);
    const to = p.add(period.to);
    within = (at: string) => `AND ${at} >= (${from}::date::timestamp AT TIME ZONE ${KL}) AND ${at} < ((${to}::date + 1)::timestamp AT TIME ZONE ${KL})`;
  }
  // A placeholder only when used: PostgreSQL refuses a parameter it cannot type.
  const rank =
    qe && qs
      ? `(greatest(ts_rank_cd(c.english, ${qe}), ts_rank_cd(c.simple, ${qs}))::float8
          * CASE WHEN c.at >= ((${p.add(scope.ctx.today)}::date - ${RECENT_DAYS})::timestamp AT TIME ZONE ${KL}) THEN ${RECENT_BOOST}::float8 ELSE 1::float8 END)`
      : '0::float8';
  const order = qe ? 'rank DESC, c.at DESC, c.id' : `c.owner_order, c.message_no NULLS FIRST, c.ordinal, c.id`;
  const text = `
WITH c AS (
  SELECT p.id, p.body, p.location, p.ordinal, p.english, p.simple, v.created_at AS at,
         s.title AS owner_title, s.id AS source_id, NULL::uuid AS thread_id, NULL::int AS message_no,
         coalesce(array_position(${src}::uuid[], s.id), 100000 + array_position(${thr}::uuid[], s.thread_id)) AS owner_order
    FROM passages p
    JOIN source_versions v ON v.id = p.owner_id
    JOIN sources s ON s.id = v.source_id
    JOIN audiences au ON au.id = s.audience_id
   WHERE p.owner_kind = 'source_version' AND p.project_id = ${proj}::uuid AND s.project_id = ${proj}::uuid
     AND ${sourceOkSql('s')}
     AND ${audienceSql(scope, p, 'au')}
     AND NOT EXISTS (SELECT 1 FROM source_versions v2 WHERE v2.source_id = v.source_id AND v2.version_no > v.version_no)
     AND ${match} ${sourceOwner} ${within('v.created_at')}
  UNION ALL
  SELECT p.id, p.body, p.location, p.ordinal, p.english, p.simple, mv.created_at AS at,
         th.title, NULL::uuid, th.id, m.message_no,
         100000 + array_position(${thr}::uuid[], th.id)
    FROM passages p
    JOIN message_versions mv ON mv.id = p.owner_id
    JOIN discussion_messages m ON m.id = mv.message_id
    JOIN discussion_threads th ON th.id = m.thread_id
    JOIN audiences au ON au.id = th.audience_id
   WHERE p.owner_kind = 'message_version' AND p.project_id = ${proj}::uuid AND th.project_id = ${proj}::uuid
     AND m.state = 'visible'
     AND ${audienceSql(scope, p, 'au')}
     AND NOT EXISTS (SELECT 1 FROM message_versions v2 WHERE v2.message_id = mv.message_id AND v2.version_no > mv.version_no)
     AND ${match} ${messageOwner} ${within('mv.created_at')}
)
SELECT c.id, c.body, c.location, c.owner_title AS "ownerTitle", c.source_id AS "sourceId", c.thread_id AS "threadId",
       c.message_no AS "messageNo", ${rank} AS rank
  FROM c
 ORDER BY ${order}
 LIMIT ${MAX_PASSAGES}`;
  return (await db.query(text, p.values)).rows as PassageRow[];
}

async function findRecords(db: Db, scope: MaterialScope, projectId: string, words: string[], kinds: RecordKind[]): Promise<MaterialItem[]> {
  const p = new Params();
  const proj = p.add(projectId);
  const today = p.add(scope.ctx.today);
  const termPh = words.map((w) => p.add(w));
  const qe = tsquerySql('english', termPh);
  const qs = tsquerySql('simple', termPh);
  // The expressions match the 0026 expression indexes exactly.
  const hit = (expr: string) => `(to_tsvector('english', ${expr}) @@ ${qe} OR to_tsvector('simple', ${expr}) @@ ${qs})`;
  const score = (expr: string) => `greatest(ts_rank_cd(to_tsvector('english', ${expr}), ${qe}), ts_rank_cd(to_tsvector('simple', ${expr}), ${qs}))::float8`;
  const branches: string[] = [];
  if (kinds.includes('task')) {
    branches.push(`SELECT 'task' AS kind, t.id, NULL::uuid AS audience_id, t.authorised_at AS at, ${score('t.title')} AS r
      FROM tasks t WHERE t.project_id = ${proj}::uuid AND ${hit('t.title')}`);
  }
  if (kinds.includes('decision')) {
    const e = `d.statement || ' ' || coalesce(d.rationale, '')`;
    branches.push(`SELECT 'decision', d.id, NULL::uuid, d.authorised_at, ${score(e)} FROM decisions d WHERE d.project_id = ${proj}::uuid AND ${hit(e)}`);
  }
  if (kinds.includes('question')) {
    branches.push(`SELECT 'question', q.id, NULL::uuid, q.authorised_at, ${score('q.text')} FROM questions q WHERE q.project_id = ${proj}::uuid AND ${hit('q.text')}`);
    branches.push(`SELECT 'question', q.id, NULL::uuid, a.at, ${score('a.answer')}
      FROM question_answers a JOIN questions q ON q.id = a.question_id WHERE q.project_id = ${proj}::uuid AND ${hit('a.answer')}`);
  }
  if (kinds.includes('risk')) {
    const e = `r.description || ' ' || coalesce(r.mitigation, '')`;
    branches.push(`SELECT 'risk', r.id, NULL::uuid, r.authorised_at, ${score(e)} FROM risks r WHERE r.project_id = ${proj}::uuid AND ${hit(e)}`);
  }
  // Pending proposals: personal scope only (the caller has removed them for thread scope), following their source's
  // audience as global search does. Matched on the wording in force, never on the quote.
  if (scope.kind === 'personal' && kinds.includes('ai_proposal')) {
    branches.push(`SELECT 'ai_proposal', x.id, s.audience_id, x.created_at, ${score('w.wording')}
      FROM extraction_items x
      JOIN source_versions v ON v.id = x.source_version_id
      JOIN sources s ON s.id = v.source_id
      JOIN audiences au ON au.id = s.audience_id
      CROSS JOIN LATERAL (SELECT coalesce((SELECT e.text FROM extraction_item_edits e WHERE e.item_id = x.id ORDER BY e.edited_at DESC, e.id DESC LIMIT 1), x.text) AS wording) w
     WHERE x.review_status = 'pending' AND s.project_id = ${proj}::uuid AND s.status <> 'deleted' AND s.publication = 'published'
       AND ${audienceSql(scope, p, 'au')} AND ${hit('w.wording')}`);
  }
  if (scope.kind === 'personal' && kinds.includes('human_proposal')) {
    branches.push(`SELECT 'human_proposal', h.id, NULL::uuid, h.proposed_at, ${score('h.text')}
      FROM human_proposals h WHERE h.review_status = 'pending' AND h.project_id = ${proj}::uuid AND ${hit('h.text')}`);
  }
  if (branches.length === 0) return [];
  const text = `
WITH hits AS (${branches.join('\n  UNION ALL\n  ')}),
best AS (
  SELECT kind, id, (array_agg(audience_id))[1] AS audience_id, max(at) AS at, max(r) AS r FROM hits GROUP BY kind, id
)
SELECT kind, id, audience_id AS "audienceId",
       r * ${RECORD_BOOST}::float8 * CASE WHEN at >= ((${today}::date - ${RECENT_DAYS})::timestamp AT TIME ZONE ${KL}) THEN ${RECENT_BOOST}::float8 ELSE 1::float8 END AS rank
  FROM best
 ORDER BY rank DESC, at DESC, id
 LIMIT ${MAX_RECORDS}`;
  const hits = (await db.query(text, p.values)).rows as RecordHit[];
  const details = await loadRecords(db, hits);
  const out: MaterialItem[] = [];
  for (const h of hits) {
    const d = details.get(`${h.kind}:${h.id}`);
    if (!d) continue;
    const snapshot = snapshotOf(h.kind, d.row);
    out.push({
      marker: '',
      passageId: null,
      recordKind: h.kind,
      recordId: h.id,
      recordAudienceId: h.audienceId,
      snapshot,
      text: snapshot,
      location: recordLocation(h.kind, d.row),
      href: recordHref(h.kind, projectId, h.id, d.runId),
      rank: Number(h.rank),
    });
  }
  return out;
}

function recordLocation(kind: RecordKind, row: SnapshotRow): string {
  const short = flat(row.text);
  const title = short.length > 80 ? `${short.slice(0, 79)}…` : short;
  const name = kind === 'ai_proposal' || kind === 'human_proposal' ? `Proposed ${(row.kind ?? '').toLowerCase()} (not authorised)` : label(kind);
  return `${name} — ${title}`;
}

function recordHref(kind: RecordKind, projectId: string, id: string, runId: string | null): string {
  return hrefFor({ kind, projectId, itemId: id, runId, versionNo: null, isCurrent: true });
}

async function loadRecords(db: Db, hits: RecordHit[]): Promise<Map<string, { row: SnapshotRow; runId: string | null }>> {
  const out = new Map<string, { row: SnapshotRow; runId: string | null }>();
  const of = (kind: RecordKind) => hits.filter((h) => h.kind === kind).map((h) => h.id);
  const date = (col: string) => `to_char(${col}, 'YYYY-MM-DD')`;
  const queries: Array<[RecordKind, string]> = [
    ['task', `SELECT t.id, t.title AS text, t.status, u.display_name AS person, ${date('t.due_on')} AS due
                FROM tasks t JOIN users u ON u.id = t.assignee_id WHERE t.id = ANY($1::uuid[])`],
    ['decision', `SELECT d.id, d.statement AS text, d.rationale, d.status, ${date(`d.authorised_at AT TIME ZONE ${KL}`)} AS "authorisedOn"
                    FROM decisions d WHERE d.id = ANY($1::uuid[])`],
    ['question', `SELECT q.id, q.text, q.status, u.display_name AS person,
                         coalesce((SELECT array_agg(a.answer ORDER BY a.at, a.id) FROM question_answers a WHERE a.question_id = q.id), ARRAY[]::text[]) AS answers
                    FROM questions q JOIN users u ON u.id = q.requester_id WHERE q.id = ANY($1::uuid[])`],
    ['risk', `SELECT r.id, r.description AS text, r.severity, r.status, u.display_name AS person, ${date('r.review_on')} AS due, r.mitigation
                FROM risks r LEFT JOIN users u ON u.id = r.responsible_id WHERE r.id = ANY($1::uuid[])`],
    ['ai_proposal', `SELECT x.id, x.kind, x.owner, x.due AS "dueAsWritten", x.run_id AS "runId",
                            coalesce((SELECT e.text FROM extraction_item_edits e WHERE e.item_id = x.id ORDER BY e.edited_at DESC, e.id DESC LIMIT 1), x.text) AS text
                       FROM extraction_items x WHERE x.id = ANY($1::uuid[])`],
    ['human_proposal', `SELECT h.id, h.kind, h.text, h.owner, h.due AS "dueAsWritten" FROM human_proposals h WHERE h.id = ANY($1::uuid[])`],
  ];
  for (const [kind, sql] of queries) {
    const wanted = of(kind);
    if (wanted.length === 0) continue;
    for (const r of (await db.query(sql, [wanted])).rows) {
      const { id, runId, ...row } = r as SnapshotRow & { id: string; runId?: string };
      out.set(`${kind}:${id}`, { row, runId: runId ?? null });
    }
  }
  return out;
}

/**
 * Which items are readable now within the scope, in the same order. Personal scope: the passage's owner is still
 * visible (not deleted, hidden, returned or withdrawn) and in an audience the viewer is in; a record's project is
 * readable by the viewer; a proposal's audience (recordAudienceId) still includes the viewer. Thread scope: the
 * owner is visible and Project-wide or in the thread's own audience; authorised records only. A version superseded
 * by an edit stays readable: the material was current when it was sent.
 */
export async function readableMaterial(db: Db, scope: MaterialScope, items: MaterialRef[]): Promise<boolean[]> {
  if (items.length === 0) return [];
  if (scope.kind === 'personal' && !canReadContent(scope.ctx)) return items.map(() => false);
  const p = new Params();
  const proj = p.add(scope.ctx.project.id);
  const a = p.add(items.map((i) => i.passageId));
  const b = p.add(items.map((i) => i.recordKind));
  const c = p.add(items.map((i) => i.recordId));
  const d = p.add(items.map((i) => i.recordAudienceId));
  const record = (table: string) => `EXISTS (SELECT 1 FROM ${table} r WHERE r.id = i.record_id AND r.project_id = ${proj}::uuid)`;
  const proposals =
    scope.kind === 'personal'
      ? `WHEN i.record_kind = 'ai_proposal' THEN
           -- The source's current audience as well as the stored one: publishing a returned note may give it a new row.
           EXISTS (SELECT 1 FROM extraction_items x JOIN source_versions v ON v.id = x.source_version_id JOIN sources s ON s.id = v.source_id
                     JOIN audiences sa ON sa.id = s.audience_id
                    WHERE x.id = i.record_id AND s.project_id = ${proj}::uuid AND s.status <> 'deleted' AND s.publication = 'published'
                      AND ${audienceSql(scope, p, 'sa')})
           AND EXISTS (SELECT 1 FROM audiences au WHERE au.id = i.record_audience_id AND au.project_id = ${proj}::uuid AND ${audienceSql(scope, p, 'au')})
         WHEN i.record_kind = 'human_proposal' THEN
           ${record('human_proposals')}
           AND (i.record_audience_id IS NULL
                OR EXISTS (SELECT 1 FROM audiences au WHERE au.id = i.record_audience_id AND au.project_id = ${proj}::uuid AND ${audienceSql(scope, p, 'au')}))`
      : '';
  const text = `
SELECT CASE
         WHEN i.passage_id IS NOT NULL THEN
           EXISTS (SELECT 1 FROM passages p
                     JOIN source_versions v ON v.id = p.owner_id
                     JOIN sources s ON s.id = v.source_id
                     JOIN audiences au ON au.id = s.audience_id
                    WHERE p.id = i.passage_id AND p.owner_kind = 'source_version'
                      AND p.project_id = ${proj}::uuid AND s.project_id = ${proj}::uuid
                      AND ${sourceOkSql('s')} AND ${audienceSql(scope, p, 'au')})
           OR EXISTS (SELECT 1 FROM passages p
                        JOIN message_versions mv ON mv.id = p.owner_id
                        JOIN discussion_messages m ON m.id = mv.message_id
                        JOIN discussion_threads th ON th.id = m.thread_id
                        JOIN audiences au ON au.id = th.audience_id
                       WHERE p.id = i.passage_id AND p.owner_kind = 'message_version'
                         AND p.project_id = ${proj}::uuid AND th.project_id = ${proj}::uuid
                         AND m.state = 'visible' AND ${audienceSql(scope, p, 'au')})
         WHEN i.record_kind = 'task' THEN ${record('tasks')}
         WHEN i.record_kind = 'decision' THEN ${record('decisions')}
         WHEN i.record_kind = 'question' THEN ${record('questions')}
         WHEN i.record_kind = 'risk' THEN ${record('risks')}
         ${proposals}
         ELSE false
       END AS ok
  FROM unnest(${a}::uuid[], ${b}::text[], ${c}::uuid[], ${d}::uuid[]) WITH ORDINALITY AS i(passage_id, record_kind, record_id, record_audience_id, n)
 ORDER BY i.n`;
  return ((await db.query(text, p.values)).rows as Array<{ ok: boolean }>).map((r) => r.ok === true);
}

/** True when every material row the request did not drop at start is readable by the viewer now (spec 5.5). */
export async function stillReadable(db: Db, viewer: ProjectContext, requestId: string): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT m.passage_id AS "passageId", m.record_kind AS "recordKind", m.record_id AS "recordId", m.record_audience_id AS "recordAudienceId"
       FROM ai_request_material m
      WHERE m.request_id = $1 AND NOT m.dropped_at_start
      ORDER BY m.ordinal`,
    [requestId],
  );
  if (rows.length === 0) return true;
  return (await readableMaterial(db, { kind: 'personal', ctx: viewer }, rows as MaterialRef[])).every(Boolean);
}
