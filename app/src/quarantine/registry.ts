/**
 * The text registry (history spec 7.4): every stored column that can hold user text, how to find a project's rows
 * of it, and how to find the rows belonging to or derived from one item. The cleaning engine sweeps exactly what
 * is listed here, so a column missing from it would let a secret survive quarantine. The completeness test
 * (registry.db.test.ts) fails for any text, varchar, jsonb, bytea or text-array column of a base table that is
 * neither here nor in NO_USER_TEXT.
 *
 * Every query takes one parameter and returns, in this order: the row key columns (named as in `rowKey`), `value`
 * (the column's value), `item_kind` and `item_id` (the item the row belongs to, for findPlaces; NULL when the row
 * belongs to no item, e.g. a membership reason or the project's own name).
 *
 *   projectSql  $1 = project id: the table's rows in that project.
 *   itemSql[k]  $1 = item id: the rows of the item and the rows derived from it (spec 7.4, "scope of the sweep").
 *               A kind missing means the column holds nothing of or from that kind of item; findPlaces still
 *               searches it through projectSql.
 *
 * Over-inclusion in itemSql is safe: the sweep only rewrites a value that holds the marked text. Notices
 * (notifications, notification_triggers, email_outbox) are not items and carry no reliable link back to the item
 * that produced them (a summary-approval notice quotes the original source's title but links to the summary; an
 * escalated-feedback notice links to a list), so for every kind their itemSql is the item's whole project, plus any
 * row outside a project whose link, body or relevance names the item's id or whose trigger is about the item.
 *
 * Item ids: 'answer' is the AI request id (ai_answers.request_id). 'minutes_draft' accepts a minutes_drafts id or
 * the meeting thread's id (held_case_id for minutes lives on discussion_threads, spec 7.2); either way it covers
 * every minutes draft of that thread, since each draft is edited from the one before. 'thread' is the thread's own
 * text (its title) and what repeats it; its messages are items of their own.
 *
 * summary_marks: `phrase` is part of the primary key. The cleaning engine must locate the row by its original key
 * but store the cleaned key (never the original phrase) in quarantine_originals.row_key.
 */

export type ItemKind =
  | 'message' | 'source' | 'task' | 'decision' | 'question' | 'risk' | 'proposal' | 'human_proposal'
  | 'answer' | 'report_draft' | 'summary' | 'minutes_draft' | 'feedback' | 'thread';

export const ITEM_KINDS: readonly ItemKind[] = [
  'message', 'source', 'task', 'decision', 'question', 'risk', 'proposal', 'human_proposal',
  'answer', 'report_draft', 'summary', 'minutes_draft', 'feedback', 'thread',
];

export interface TextColumn {
  table: string;
  column: string;
  /** jsonb: cleaned string leaf by string leaf. */
  json: boolean;
  /** text[]: cleaned element by element. */
  array?: boolean;
  /** bytea (source_versions.original_bytes): cannot be cleaned; withheld (encrypted, set NULL) when the row's text held the secret. */
  binary?: boolean;
  rowKey: string[];
  projectSql: string;
  itemSql?: Partial<Record<ItemKind, string>>;
}

/**
 * Tables the cleaning engine updates although they hold no registered text: transcript spans' offsets into a
 * cleaned transcript are mapped through the replacements. Their UPDATE guards are checked like the others'.
 */
export const QUARANTINE_WRITE_TABLES: readonly string[] = ['transcript_spans'];

// ---------------------------------------------------------------------------------------------------------------
// Building blocks. $1 is always cast explicitly ($1::uuid, $1::text) so one query can use it both ways.
// ---------------------------------------------------------------------------------------------------------------

const ID = '$1::uuid';
const ID_TEXT = '$1::text';

/** The project of item $1. */
export const ITEM_PROJECT: Record<ItemKind, string> = {
  message: `SELECT th.project_id FROM discussion_messages m JOIN discussion_threads th ON th.id = m.thread_id WHERE m.id = ${ID}`,
  source: `SELECT project_id FROM sources WHERE id = ${ID}`,
  task: `SELECT project_id FROM tasks WHERE id = ${ID}`,
  decision: `SELECT project_id FROM decisions WHERE id = ${ID}`,
  question: `SELECT project_id FROM questions WHERE id = ${ID}`,
  risk: `SELECT project_id FROM risks WHERE id = ${ID}`,
  proposal: `SELECT s.project_id FROM extraction_items i JOIN source_versions v ON v.id = i.source_version_id JOIN sources s ON s.id = v.source_id WHERE i.id = ${ID}`,
  human_proposal: `SELECT project_id FROM human_proposals WHERE id = ${ID}`,
  answer: `SELECT project_id FROM ai_requests WHERE id = ${ID}`,
  report_draft: `SELECT project_id FROM report_drafts WHERE id = ${ID}`,
  summary: `SELECT project_id FROM summaries WHERE id = ${ID}`,
  minutes_draft: `SELECT th.project_id FROM discussion_threads th WHERE th.id = ${ID} OR th.id IN (SELECT thread_id FROM minutes_drafts WHERE id = ${ID})`,
  feedback: `SELECT project_id FROM ai_feedback WHERE id = ${ID}`,
  thread: `SELECT project_id FROM discussion_threads WHERE id = ${ID}`,
};

/** Every minutes draft of the thread of minutes draft (or thread) $1. */
const MINUTES_DRAFTS = `SELECT d.id FROM minutes_drafts d WHERE d.thread_id IN (SELECT thread_id FROM minutes_drafts WHERE id = ${ID} UNION SELECT ${ID})`;

/**
 * Source versions holding the item's text: its own versions; for a message, the discussion transcripts built from
 * it (transcript_spans); for a thread, the versions of its transcript and minutes sources; for a minutes draft, the
 * minutes versions published from it; for a summary, the versions of its approved summary source.
 */
const VERSIONS: Partial<Record<ItemKind, string>> = {
  source: `SELECT v.id FROM source_versions v WHERE v.source_id = ${ID}`,
  message: `SELECT ts.source_version_id FROM transcript_spans ts JOIN message_versions mv ON mv.id = ts.message_version_id WHERE mv.message_id = ${ID}`,
  thread: `SELECT v.id FROM source_versions v JOIN sources s ON s.id = v.source_id WHERE s.thread_id = ${ID}`,
  minutes_draft: `SELECT v.id FROM source_versions v WHERE v.minutes_draft_id IN (${MINUTES_DRAFTS})`,
  summary: `SELECT v.id FROM source_versions v JOIN sources s ON s.id = v.source_id WHERE s.summary_id = ${ID}`,
};

/** Message versions of the item (only a message has them). */
const MESSAGE_VERSIONS: Partial<Record<ItemKind, string>> = {
  message: `SELECT mv.id FROM message_versions mv WHERE mv.message_id = ${ID}`,
};

const VERSION_KINDS = Object.keys(VERSIONS) as ItemKind[];

/** Passages (alias a) cut from the item's source versions or message versions. */
function passageCond(kind: ItemKind, a: string): string | null {
  const parts: string[] = [];
  if (VERSIONS[kind]) parts.push(`(${a}.owner_kind = 'source_version' AND ${a}.owner_id IN (${VERSIONS[kind]}))`);
  if (MESSAGE_VERSIONS[kind]) parts.push(`(${a}.owner_kind = 'message_version' AND ${a}.owner_id IN (${MESSAGE_VERSIONS[kind]}))`);
  return parts.length > 0 ? parts.join(' OR ') : null;
}

/** ai_request_material.record_kind of a record snapshot of each item kind. */
const SNAPSHOT_KIND: Partial<Record<ItemKind, string>> = {
  task: 'task', decision: 'decision', question: 'question', risk: 'risk', proposal: 'ai_proposal', human_proposal: 'human_proposal',
};

/** change_requests.target_kind of each item kind a change can target. */
const CHANGE_TARGET: Partial<Record<ItemKind, string>> = {
  proposal: 'extraction_item', human_proposal: 'human_proposal', task: 'task', decision: 'decision', risk: 'risk',
};

function each(kinds: readonly ItemKind[], cond: (k: ItemKind) => string | null): Partial<Record<ItemKind, string>> {
  const out: Partial<Record<ItemKind, string>> = {};
  for (const k of kinds) {
    const c = cond(k);
    if (c) out[k] = c;
  }
  return out;
}

const KIND_LIST = ITEM_KINDS.map((k) => `'${k}'`).join(', ');

const sourceOfVersion = (v: string) => `(SELECT source_id FROM source_versions WHERE id = ${v})`;
const messageOfVersion = (v: string) => `(SELECT message_id FROM message_versions WHERE id = ${v})`;

/**
 * A discussion transcript (sources.kind = 'discussion') is built from message text and is never an item itself
 * (spec 4.1, 7.1): its source row, versions, passages and runs name no owning item (NULL), so findPlaces reports
 * the message's own message_versions row instead. They stay in the message's itemSql (through transcript_spans),
 * so cleaning a message cleans its transcript text. Task 12 maps a runner's hit in a transcript passage to the
 * message through transcript_spans.
 */
const NOT_TRANSCRIPT = (sourceKind: string) => `CASE WHEN ${sourceKind} = 'discussion' THEN NULL ELSE 'source' END`;
const sourceKindOfVersion = (v: string) =>
  `(SELECT s.kind FROM source_versions sv JOIN sources s ON s.id = sv.source_id WHERE sv.id = ${v})`;

// ---------------------------------------------------------------------------------------------------------------
// Tables. `from` names the table `t`; `project` and every `items` entry are WHERE conditions.
// ---------------------------------------------------------------------------------------------------------------

interface TableDef {
  table: string;
  from?: string;
  rowKey?: string[];
  project: string;
  /** SQL for the owning item's kind and id; a kind outside ITEM_KINDS (or a NULL id) gives NULL. */
  owner?: { kind: string; id: string };
  text?: string[];
  json?: string[];
  array?: string[];
  binary?: string[];
  items?: Partial<Record<ItemKind, string>>;
  /** Restricts an item kind to some columns (default: every column of the table). */
  itemColumns?: Partial<Record<ItemKind, string[]>>;
}

const P = `= ${ID}`;

const TABLES: TableDef[] = [
  // ---- Sources and their derived text --------------------------------------------------------------------
  {
    table: 'sources',
    project: `t.project_id ${P}`,
    owner: { kind: NOT_TRANSCRIPT('t.kind'), id: 't.id' },
    text: ['title', 'delete_reason', 'returned_reason'],
    items: {
      source: `t.id ${P}`,
      thread: `t.thread_id ${P}`,
      summary: `t.summary_id ${P}`,
      minutes_draft: `t.id IN (SELECT v.source_id FROM source_versions v WHERE v.minutes_draft_id IN (${MINUTES_DRAFTS}))`,
    },
  },
  {
    table: 'source_versions',
    from: 'source_versions t JOIN sources s ON s.id = t.source_id',
    project: `s.project_id ${P}`,
    owner: { kind: NOT_TRANSCRIPT('s.kind'), id: 't.source_id' },
    text: ['text_content', 'filename'],
    binary: ['original_bytes'],
    items: each(VERSION_KINDS, (k) => `t.id IN (${VERSIONS[k]})`),
  },
  {
    table: 'source_events',
    project: `t.project_id ${P}`,
    owner: { kind: `'source'`, id: 't.source_id' },
    text: ['reason'],
    items: { source: `t.source_id ${P}` },
  },
  {
    table: 'passages',
    project: `t.project_id ${P}`,
    owner: {
      kind: `CASE t.owner_kind WHEN 'source_version' THEN ${NOT_TRANSCRIPT(sourceKindOfVersion('t.owner_id'))} WHEN 'message_version' THEN 'message' END`,
      id: `CASE t.owner_kind WHEN 'source_version' THEN ${sourceOfVersion('t.owner_id')} ELSE ${messageOfVersion('t.owner_id')} END`,
    },
    // location repeats the nearest heading of the text, so it can hold the secret too.
    text: ['body', 'location'],
    items: each(ITEM_KINDS, (k) => passageCond(k, 't')),
  },
  {
    table: 'extraction_runs',
    from: 'extraction_runs t JOIN source_versions v ON v.id = t.source_version_id JOIN sources s ON s.id = v.source_id',
    project: `s.project_id ${P}`,
    owner: { kind: NOT_TRANSCRIPT('s.kind'), id: 'v.source_id' },
    text: ['failure_detail'],
    items: each(VERSION_KINDS, (k) => `t.source_version_id IN (${VERSIONS[k]})`),
  },
  {
    // AI proposals. A proposal's own text belongs to it; from a source (or transcript, minutes, summary) only the
    // quote is taken, so only the quote is derived from those items (spec 7.4). The proposal text, if it repeats
    // the secret, is found by findPlaces as a copy.
    table: 'extraction_items',
    from: 'extraction_items t JOIN source_versions v ON v.id = t.source_version_id JOIN sources s ON s.id = v.source_id',
    project: `s.project_id ${P}`,
    owner: { kind: `'proposal'`, id: 't.id' },
    text: ['text', 'owner', 'due', 'due_event', 'quote'],
    array: ['alternatives'],
    items: { proposal: `t.id ${P}`, ...each(VERSION_KINDS, (k) => `t.source_version_id IN (${VERSIONS[k]})`) },
    itemColumns: Object.fromEntries(VERSION_KINDS.map((k) => [k, ['quote']])),
  },
  {
    table: 'extraction_item_edits',
    from: 'extraction_item_edits t JOIN extraction_items i ON i.id = t.item_id JOIN source_versions v ON v.id = i.source_version_id JOIN sources s ON s.id = v.source_id',
    project: `s.project_id ${P}`,
    owner: { kind: `'proposal'`, id: 't.item_id' },
    text: ['text', 'owner', 'due', 'due_event'],
    items: { proposal: `t.item_id ${P}` },
  },
  {
    table: 'human_proposals',
    project: `t.project_id ${P}`,
    owner: { kind: `'human_proposal'`, id: 't.id' },
    text: ['text', 'owner', 'due', 'reject_reason'],
    items: { human_proposal: `t.id ${P}` },
  },

  // ---- Discussion ------------------------------------------------------------------------------------------
  {
    table: 'discussion_threads',
    project: `t.project_id ${P}`,
    owner: { kind: `'thread'`, id: 't.id' },
    text: ['title'],
    items: { thread: `t.id ${P}` },
  },
  {
    table: 'discussion_messages',
    from: 'discussion_messages t JOIN discussion_threads th ON th.id = t.thread_id',
    project: `th.project_id ${P}`,
    owner: { kind: `'message'`, id: 't.id' },
    text: ['state_reason'],
    items: { message: `t.id ${P}` },
  },
  {
    table: 'message_versions',
    from: 'message_versions t JOIN discussion_messages m ON m.id = t.message_id JOIN discussion_threads th ON th.id = m.thread_id',
    project: `th.project_id ${P}`,
    owner: { kind: `'message'`, id: 't.message_id' },
    text: ['body'],
    items: { message: `t.message_id ${P}` },
  },
  {
    table: 'minutes_drafts',
    from: 'minutes_drafts t JOIN discussion_threads th ON th.id = t.thread_id',
    project: `th.project_id ${P}`,
    owner: { kind: `'minutes_draft'`, id: 't.id' },
    text: ['body'],
    items: { minutes_draft: `t.id IN (${MINUTES_DRAFTS})`, thread: `t.thread_id ${P}` },
  },
  {
    table: 'discussion_events',
    from: 'discussion_events t JOIN discussion_threads th ON th.id = t.thread_id',
    project: `th.project_id ${P}`,
    owner: {
      kind: `CASE WHEN t.message_id IS NOT NULL THEN 'message' WHEN t.draft_id IS NOT NULL THEN 'minutes_draft' ELSE 'thread' END`,
      id: 'COALESCE(t.message_id, t.draft_id, t.thread_id)',
    },
    text: ['reason'],
    json: ['detail'],
    items: { message: `t.message_id ${P}`, minutes_draft: `t.draft_id IN (${MINUTES_DRAFTS})`, thread: `t.thread_id ${P}` },
  },
  {
    table: 'analysis_runs',
    from: 'analysis_runs t JOIN discussion_threads th ON th.id = t.thread_id',
    project: `th.project_id ${P}`,
    owner: { kind: `'thread'`, id: 't.thread_id' },
    text: ['failure_detail'],
    items: { thread: `t.thread_id ${P}`, minutes_draft: `t.minutes_draft_id IN (${MINUTES_DRAFTS})` },
  },

  // ---- Authorised records ----------------------------------------------------------------------------------
  {
    table: 'tasks',
    project: `t.project_id ${P}`,
    owner: { kind: `'task'`, id: 't.id' },
    text: ['title', 'owner_as_written', 'delete_reason'],
    items: { task: `t.id ${P}` },
  },
  {
    table: 'task_events',
    from: 'task_events t JOIN tasks k ON k.id = t.task_id',
    project: `k.project_id ${P}`,
    owner: { kind: `'task'`, id: 't.task_id' },
    text: ['note', 'override_reason'],
    json: ['detail'],
    items: { task: `t.task_id ${P}` },
  },
  {
    table: 'decisions',
    project: `t.project_id ${P}`,
    owner: { kind: `'decision'`, id: 't.id' },
    text: ['statement', 'rationale', 'delete_reason'],
    items: { decision: `t.id ${P}` },
  },
  {
    table: 'questions',
    project: `t.project_id ${P}`,
    owner: { kind: `'question'`, id: 't.id' },
    text: ['text', 'delete_reason'],
    items: { question: `t.id ${P}` },
  },
  {
    table: 'question_answers',
    from: 'question_answers t JOIN questions q ON q.id = t.question_id',
    project: `q.project_id ${P}`,
    owner: { kind: `'question'`, id: 't.question_id' },
    text: ['answer'],
    items: { question: `t.question_id ${P}` },
  },
  {
    table: 'risks',
    project: `t.project_id ${P}`,
    owner: { kind: `'risk'`, id: 't.id' },
    text: ['description', 'mitigation', 'delete_reason'],
    items: { risk: `t.id ${P}` },
  },
  {
    table: 'record_events',
    project: `COALESCE((SELECT project_id FROM questions WHERE id = t.record_id), (SELECT project_id FROM risks WHERE id = t.record_id),
                       (SELECT project_id FROM decisions WHERE id = t.record_id)) ${P}`,
    owner: { kind: 't.record_kind', id: 't.record_id' },
    text: ['note'],
    json: ['detail'],
    items: each(['decision', 'question', 'risk'], (k) => `t.record_kind = '${k}' AND t.record_id ${P}`),
  },
  {
    table: 'change_requests',
    project: `t.project_id ${P}`,
    owner: { kind: `CASE t.target_kind WHEN 'extraction_item' THEN 'proposal' ELSE t.target_kind END`, id: 't.target_id' },
    text: ['reason'],
    items: each(ITEM_KINDS, (k) => (CHANGE_TARGET[k] ? `t.target_kind = '${CHANGE_TARGET[k]}' AND t.target_id ${P}` : null)),
  },
  {
    table: 'change_request_versions',
    from: 'change_request_versions t JOIN change_requests cr ON cr.id = t.request_id',
    rowKey: ['request_id', 'version'],
    project: `cr.project_id ${P}`,
    owner: { kind: `CASE cr.target_kind WHEN 'extraction_item' THEN 'proposal' ELSE cr.target_kind END`, id: 'cr.target_id' },
    text: ['reason'],
    json: ['terms'],
    items: each(ITEM_KINDS, (k) => (CHANGE_TARGET[k] ? `cr.target_kind = '${CHANGE_TARGET[k]}' AND cr.target_id ${P}` : null)),
  },
  {
    table: 'review_flags',
    project: `t.project_id ${P}`,
    owner: { kind: 't.record_kind', id: 't.record_id' },
    text: ['note'],
    items: {
      ...each(['task', 'question', 'risk'], (k) => `t.record_kind = '${k}' AND t.record_id ${P}`),
      decision: `t.decision_id ${P}`,
    },
  },
  {
    table: 'closure_dispositions',
    project: `t.project_id ${P}`,
    owner: { kind: 't.record_kind', id: 't.record_id' },
    text: ['reason'],
    items: each(['task', 'question', 'risk'], (k) => `t.record_kind = '${k}' AND t.record_id ${P}`),
  },

  // ---- AI assist ---------------------------------------------------------------------------------------------
  {
    table: 'ai_requests',
    project: `t.project_id ${P}`,
    owner: {
      kind: `CASE t.kind WHEN 'question' THEN 'answer' WHEN 'report' THEN 'report_draft' WHEN 'summary' THEN 'summary' END`,
      id: `CASE t.kind WHEN 'question' THEN t.id
                       WHEN 'report' THEN (SELECT draft_id FROM report_draft_versions WHERE request_id = t.id LIMIT 1)
                       WHEN 'summary' THEN (SELECT summary_id FROM summary_versions WHERE request_id = t.id LIMIT 1) END`,
    },
    text: ['failure_detail'],
    items: {
      answer: `t.id ${P}`,
      report_draft: `t.id IN (SELECT request_id FROM report_draft_versions WHERE draft_id = ${ID})`,
      summary: `t.id IN (SELECT request_id FROM summary_versions WHERE summary_id = ${ID})`,
    },
  },
  {
    table: 'ai_request_material',
    from: 'ai_request_material t JOIN ai_requests r ON r.id = t.request_id LEFT JOIN passages p ON p.id = t.passage_id',
    rowKey: ['request_id', 'ordinal'],
    project: `r.project_id ${P}`,
    owner: {
      kind: `CASE WHEN t.record_kind = 'ai_proposal' THEN 'proposal' WHEN t.record_kind IS NOT NULL THEN t.record_kind
                  WHEN p.owner_kind = 'source_version' THEN ${NOT_TRANSCRIPT(sourceKindOfVersion('p.owner_id'))} WHEN p.owner_kind = 'message_version' THEN 'message' END`,
      id: `COALESCE(t.record_id, CASE p.owner_kind WHEN 'source_version' THEN ${sourceOfVersion('p.owner_id')} ELSE ${messageOfVersion('p.owner_id')} END)`,
    },
    // location repeats a passage's heading or names the record.
    text: ['snapshot', 'location'],
    items: each(ITEM_KINDS, (k) => {
      if (SNAPSHOT_KIND[k]) return `t.record_kind = '${SNAPSHOT_KIND[k]}' AND t.record_id ${P}`;
      const pc = passageCond(k, 'p');
      return pc ? `t.passage_id IS NOT NULL AND (${pc})` : null;
    }),
  },
  {
    table: 'ai_answers',
    rowKey: ['request_id'],
    project: `t.project_id ${P}`,
    owner: { kind: `'answer'`, id: 't.request_id' },
    text: ['question', 'answer_markdown', 'hidden_reason', 'review_reason'],
    items: { answer: `t.request_id ${P}` },
  },
  {
    table: 'report_drafts',
    project: `t.project_id ${P}`,
    owner: { kind: `'report_draft'`, id: 't.id' },
    text: ['title', 'brief', 'review_reason'],
    items: { report_draft: `t.id ${P}` },
  },
  {
    table: 'report_draft_versions',
    from: 'report_draft_versions t JOIN report_drafts d ON d.id = t.draft_id',
    project: `d.project_id ${P}`,
    owner: { kind: `'report_draft'`, id: 't.draft_id' },
    text: ['body'],
    items: { report_draft: `t.draft_id ${P}` },
  },
  {
    table: 'summaries',
    project: `t.project_id ${P}`,
    owner: { kind: `'summary'`, id: 't.id' },
    text: ['leave_out', 'review_reason'],
    items: { summary: `t.id ${P}` },
  },
  {
    table: 'summary_versions',
    from: 'summary_versions t JOIN summaries sm ON sm.id = t.summary_id',
    project: `sm.project_id ${P}`,
    owner: { kind: `'summary'`, id: 't.summary_id' },
    text: ['body'],
    // Category names written by the model (assist/prompts.ts), so free text that can echo the source or leave-out.
    array: ['omitted_categories'],
    items: { summary: `t.summary_id ${P}` },
  },
  {
    table: 'summary_marks',
    from: 'summary_marks t JOIN summary_versions v ON v.id = t.version_id JOIN summaries sm ON sm.id = v.summary_id',
    rowKey: ['version_id', 'phrase', 'kind'],
    project: `sm.project_id ${P}`,
    owner: { kind: `'summary'`, id: 'v.summary_id' },
    text: ['phrase'],
    items: { summary: `v.summary_id ${P}` },
  },
  {
    table: 'ai_assist_events',
    project: `t.project_id ${P}`,
    owner: { kind: 't.target_kind', id: 't.target_id' },
    text: ['reason'],
    json: ['detail'],
    items: each(['answer', 'report_draft', 'summary'], (k) => `t.target_kind = '${k}' AND t.target_id ${P}`),
  },
  {
    table: 'ai_feedback',
    project: `t.project_id ${P}`,
    owner: { kind: `'feedback'`, id: 't.id' },
    text: ['note', 'escalation_note'],
    items: { feedback: `t.id ${P}` },
  },
  {
    table: 'feedback_events',
    from: 'feedback_events t JOIN ai_feedback f ON f.id = t.feedback_id',
    project: `f.project_id ${P}`,
    owner: { kind: `'feedback'`, id: 't.feedback_id' },
    text: ['note'],
    items: { feedback: `t.feedback_id ${P}` },
  },
  {
    // The provider's error text for a failed or uncertain call (ai/guarded-call.ts). request_id is an AI request,
    // an extraction run or an analysis run.
    table: 'ai_spend_entries',
    project: `${ID} IN (SELECT project_id FROM ai_requests WHERE id = t.request_id
                 UNION ALL SELECT s.project_id FROM extraction_runs er JOIN source_versions v ON v.id = er.source_version_id
                             JOIN sources s ON s.id = v.source_id WHERE er.id = t.request_id
                 UNION ALL SELECT th.project_id FROM analysis_runs ar JOIN discussion_threads th ON th.id = ar.thread_id
                            WHERE ar.id = t.request_id)`,
    text: ['note'],
  },

  // ---- Notices: not items; see the header for why their item scope is the item's whole project ---------------
  {
    table: 'notifications',
    project: `t.project_id ${P}`,
    text: ['summary'],
    items: each(ITEM_KINDS, (k) => `t.project_id IN (${ITEM_PROJECT[k]})
      OR strpos(COALESCE(t.link, ''), ${ID_TEXT}) > 0
      OR t.trigger_id IN (SELECT id FROM notification_triggers WHERE record_id = ${ID})`),
  },
  {
    table: 'notification_triggers',
    project: `t.project_id ${P}`,
    owner: { kind: 't.record_kind', id: 't.record_id' },
    json: ['detail'],
    items: each(ITEM_KINDS, (k) => `t.project_id IN (${ITEM_PROJECT[k]}) OR t.record_id ${P}`),
  },
  {
    // Queued, sent or failed alike: a sent email cannot be recalled, but the stored copy is still cleaned.
    table: 'email_outbox',
    project: `t.project_id ${P}`,
    text: ['subject', 'text_body', 'html_body'],
    json: ['relevance'],
    items: each(ITEM_KINDS, (k) => `t.project_id IN (${ITEM_PROJECT[k]})
      OR strpos(t.text_body, ${ID_TEXT}) > 0
      OR strpos(COALESCE(t.relevance::text, ''), ${ID_TEXT}) > 0
      OR t.trigger_ids && ARRAY(SELECT id FROM notification_triggers WHERE record_id = ${ID})
      OR t.id IN (SELECT n.outbox_id FROM notifications n WHERE strpos(COALESCE(n.link, ''), ${ID_TEXT}) > 0)`),
  },

  // ---- Quarantine's own free text --------------------------------------------------------------------------
  {
    table: 'quarantine_cases',
    project: `t.project_id ${P}`,
    owner: { kind: 't.item_kind', id: 't.item_id' },
    text: ['reason', 'close_reason'],
    items: each(ITEM_KINDS, (k) => `t.item_kind = '${k}' AND t.item_id ${P}`),
  },
  {
    table: 'quarantine_events',
    project: `t.project_id ${P}`,
    owner: { kind: 't.item_kind', id: 't.item_id' },
    text: ['reason'],
    json: ['detail'],
    items: each(ITEM_KINDS, (k) => `t.item_kind = '${k}' AND t.item_id ${P}`),
  },
  {
    // Organisation-level, but every grant names cases of projects: a grant belongs to each project it touches.
    table: 'quarantine_grants',
    project: `EXISTS (SELECT 1 FROM quarantine_grant_cases gc JOIN quarantine_cases c ON c.id = gc.case_id
                       WHERE gc.grant_id = t.id AND c.project_id ${P})`,
    text: ['purpose', 'decision_reason', 'revoke_reason'],
  },

  // ---- Project-level reasons and text (no item; itemSql = the item's whole project, see projectWide) --------------------------------------------------------------
  { table: 'projects', project: `t.id ${P}`, text: ['name', 'purpose'] },
  { table: 'project_transitions', project: `t.project_id ${P}`, text: ['reason'] },
  { table: 'project_archive_events', project: `t.project_id ${P}`, text: ['reason'] },
  { table: 'project_department_changes', project: `t.project_id ${P}`, text: ['reason'] },
  { table: 'project_stage_periods', project: `t.project_id ${P}`, text: ['substage', 'reason'] },
  { table: 'holidays', project: `t.project_id ${P}`, text: ['name'] },
  { table: 'closure_delegations', project: `t.project_id ${P}`, text: ['reason'] },
  { table: 'record_deletion_delegations', project: `t.project_id ${P}`, text: ['reason', 'revoke_reason'] },
  // In the three *_settings_changes tables a row with project_id NULL is an organisation-level change: no project
  // scope, so out of the sweep (spec 7.4); its reason box runs the credential check.
  { table: 'analysis_settings_changes', project: `t.project_id ${P}`, text: ['reason'] },
  { table: 'approval_policy_changes', project: `t.project_id ${P}`, text: ['reason'] },
  { table: 'notification_settings_changes', project: `t.project_id ${P}`, text: ['reason'] },
  { table: 'memberships', project: `t.project_id ${P}`, text: ['revoke_reason', 'hold_reason', 'restore_reason'] },
  {
    table: 'membership_events',
    from: 'membership_events t JOIN memberships ms ON ms.id = t.membership_id',
    project: `ms.project_id ${P}`,
    text: ['reason'],
  },
  {
    table: 'membership_findings',
    from: 'membership_findings t JOIN memberships ms ON ms.id = t.membership_id',
    project: `ms.project_id ${P}`,
    text: ['finding'],
  },
  {
    table: 'access_grants',
    project: `t.project_id ${P}`,
    text: ['purpose', 'scope', 'decision_reason', 'suspend_reason', 'revoke_reason'],
  },
  {
    table: 'grant_events',
    from: 'grant_events t JOIN access_grants g ON g.id = t.grant_id',
    project: `g.project_id ${P}`,
    text: ['reason'],
  },
  {
    table: 'audience_events',
    from: 'audience_events t JOIN audiences a ON a.id = t.audience_id',
    project: `a.project_id ${P}`,
    text: ['reason'],
  },
];

/**
 * itemSql for a table whose rows belong to no item (project-level reasons, memberships, grants, spend notes): the
 * item's whole project, as for notices. Over-inclusion is safe; the sweep rewrites only values holding the marked
 * text, and without this cleanItem could never reach these rows.
 */
function projectWide(d: TableDef): Partial<Record<ItemKind, string>> {
  const where = d.project.split(ID).join('ip.project_id');
  return each(ITEM_KINDS, (k) => `EXISTS (SELECT 1 FROM (${ITEM_PROJECT[k]}) AS ip (project_id) WHERE ${where})`);
}

function select(d: TableDef, column: string, where: string): string {
  const key = (d.rowKey ?? ['id']).map((k) => `t.${k}`).join(', ');
  let kind = 'NULL::text';
  let id = 'NULL::uuid';
  if (d.owner) {
    const known = `(${d.owner.kind}) IN (${KIND_LIST}) AND (${d.owner.id}) IS NOT NULL`;
    kind = `CASE WHEN ${known} THEN (${d.owner.kind})::text END`;
    id = `CASE WHEN ${known} THEN (${d.owner.id})::uuid END`;
  }
  return `SELECT ${key}, t.${column} AS value, ${kind} AS item_kind, ${id} AS item_id FROM ${d.from ?? `${d.table} t`} WHERE (${where})`;
}

function columnsOf(d: TableDef): TextColumn[] {
  const kinds: Array<[string[] | undefined, Pick<TextColumn, 'json' | 'array' | 'binary'>]> = [
    [d.text, { json: false }],
    [d.json, { json: true }],
    [d.array, { json: false, array: true }],
    [d.binary, { json: false, binary: true }],
  ];
  const out: TextColumn[] = [];
  for (const [cols, flags] of kinds) {
    for (const column of cols ?? []) {
      const itemSql: Partial<Record<ItemKind, string>> = {};
      for (const [k, where] of Object.entries(d.items ?? projectWide(d)) as Array<[ItemKind, string]>) {
        const only = d.itemColumns?.[k];
        if (only && !only.includes(column)) continue;
        itemSql[k] = select(d, column, where);
      }
      out.push({
        table: d.table,
        column,
        ...flags,
        rowKey: d.rowKey ?? ['id'],
        projectSql: select(d, column, d.project),
        ...(Object.keys(itemSql).length > 0 ? { itemSql } : {}),
      });
    }
  }
  return out;
}

export const TEXT_COLUMNS: readonly TextColumn[] = TABLES.flatMap(columnsOf);

const ENUM = 'fixed value from a CHECK list or code constant, never typed by a person';
const ID_REF = 'kinds and ids of rows, never text';
const HASH = 'a hash, not the text it was computed from';
const ORG = 'organisation-level setting or record with no project scope (spec 7.4)';
const SETTING = 'a settings value (numbers, weekdays, modes) shown in a change list, never free text';
const IDENTITY = "a person's address or name used for identity and delivery, not content (spec 7.4: users)";

/** Text columns that hold no user text, each with the reason (spec 7.4). */
export const NO_USER_TEXT: Readonly<Record<string, string>> = {
  'access_grants.decision': ENUM,
  'access_grants.kind': ENUM,
  'ai_answers.review_state': ENUM,
  'ai_answers.visibility': ENUM,
  'ai_assist_events.action': ENUM,
  'ai_assist_events.target_kind': ENUM,
  'ai_feedback.category': ENUM,
  'ai_feedback.status': ENUM,
  'ai_feedback.target_kind': ENUM,
  'ai_request_material.marker': 'the citation marker Kainow numbers material with, e.g. [3]',
  'ai_request_material.record_kind': ENUM,
  'ai_requests.failure_code': ENUM,
  'ai_requests.kind': ENUM,
  'ai_requests.model_id': 'the configured model name copied from organisation settings',
  'ai_requests.scope': ENUM,
  'ai_requests.status': ENUM,
  'ai_spend_entries.model_id': 'the configured model name copied from organisation settings',
  'ai_spend_entries.purpose': ENUM,
  'ai_spend_entries.status': ENUM,
  'ai_spend_settings.daily_mode': ORG,
  'ai_spend_settings.model_id': ORG,
  'ai_spend_settings.user_monthly_mode': ORG,
  'analysis_runs.failure_code': ENUM,
  'analysis_runs.kind': ENUM,
  'analysis_runs.status': ENUM,
  'analysis_runs.trigger': ENUM,
  'analysis_settings_changes.field': ENUM,
  'analysis_settings_changes.from_value': SETTING,
  'analysis_settings_changes.to_value': SETTING,
  'approval_policy_changes.field': ENUM,
  'approval_policy_changes.new_value': SETTING,
  'approval_policy_changes.old_value': SETTING,
  'approval_policy_changes.pending_choice': ENUM,
  'audience_events.from_mode': ENUM,
  'audience_events.to_mode': ENUM,
  'audiences.mode': ENUM,
  'audit_events.action': 'audit_events never holds text by rule (spec 7.4); action names are code constants',
  'audit_events.detail': 'audit_events never holds text by rule (spec 7.4): ids, kinds and counts only',
  'audit_events.subject_id': 'audit_events never holds text by rule (spec 7.4); the id of the subject',
  'audit_events.subject_type': 'audit_events never holds text by rule (spec 7.4); a code constant',
  'away_periods.note': 'a person\'s own absence note, user-scoped with no project scope (spec 7.4: users)',
  'change_requests.kind': ENUM,
  'change_requests.status': ENUM,
  'change_requests.target_kind': ENUM,
  'closure_dispositions.disposition': ENUM,
  'closure_dispositions.record_kind': ENUM,
  'decisions.status': ENUM,
  'departments.name': 'departments have no project scope (spec 7.4)',
  'departments.status': ENUM,
  'discussion_events.action': ENUM,
  'discussion_messages.state': ENUM,
  'discussion_threads.kind': ENUM,
  'discussion_threads.state': ENUM,
  'eligible_domains.domain': ORG,
  'email_attempts.error_class': ENUM,
  'email_attempts.outcome': ENUM,
  'email_attempts.smtp_code': 'an SMTP status code',
  'email_outbox.attachments': 'only the organisation logos, inlined as images (organisation/email.ts)',
  'email_outbox.initiated_by': ENUM,
  'email_outbox.kind': ENUM,
  'email_outbox.last_reason': 'fixed delivery or cancellation wording, never the message or server text (email/transport.ts)',
  'email_outbox.status': ENUM,
  'email_outbox.to_address': IDENTITY,
  'email_preferences.choice': ENUM,
  'extraction_items.kind': ENUM,
  'extraction_items.review_status': ENUM,
  'extraction_runs.failure_code': ENUM,
  'extraction_runs.model_id': 'the configured model name copied from organisation settings',
  'extraction_runs.status': ENUM,
  'extraction_runs.trigger': ENUM,
  'feedback_events.action': ENUM,
  'feedback_events.from_status': ENUM,
  'feedback_events.to_status': ENUM,
  'golive_events.action': ENUM,
  'golive_events.note': 'go-live checklist note by an Administrator: organisation-level, no project scope (spec 7.4)',
  'golive_events.step_key': ENUM,
  'golive_steps.key': ENUM,
  'golive_steps.note': 'go-live checklist note by an Administrator: organisation-level, no project scope (spec 7.4)',
  'grant_events.kind': ENUM,
  'human_proposals.kind': ENUM,
  'human_proposals.review_status': ENUM,
  'invitations.display_name': IDENTITY,
  'invitations.email': IDENTITY,
  'invitations.kind': ENUM,
  'invitations.outgoing_role': ENUM,
  'invitations.role': ENUM,
  'invitations.status': ENUM,
  'invitations.token_hash': HASH,
  'login_codes.code_hash': HASH,
  'membership_events.kind': ENUM,
  'membership_findings.recommendation': ENUM,
  'memberships.role': ENUM,
  'message_versions.body_sha256': HASH,
  'minutes_drafts.origin': ENUM,
  'notification_settings.day_counting': ORG,
  'notification_settings_changes.field': ENUM,
  'notification_settings_changes.new_value': SETTING,
  'notification_settings_changes.old_value': SETTING,
  'notification_settings_changes.scope': ENUM,
  'notification_triggers.key': 'a deduplication key built from kinds, ids and dates',
  'notification_triggers.kind': ENUM,
  'notification_triggers.outcome': ENUM,
  'notification_triggers.record_kind': ENUM,
  'notifications.kind': ENUM,
  'notifications.link': 'an in-app route built from ids',
  'organisation.name': ORG,
  'organisation.recovery_custodian_contact': ORG,
  'organisation.recovery_custodian_name': ORG,
  'organisation_logos.content': 'an uploaded logo image: organisation-level, no project scope',
  'organisation_logos.mime': ENUM,
  'organisation_logos.shape': ENUM,
  'passages.owner_kind': ENUM,
  'project_archive_events.kind': ENUM,
  'project_department_changes.files_decision': ENUM,
  'project_notification_settings.day_counting': SETTING,
  'project_notification_settings.digest_frequency': SETTING,
  'project_stage_periods.stage': ENUM,
  'project_transitions.closure_outcome': ENUM,
  'project_transitions.from_status': ENUM,
  'project_transitions.to_status': ENUM,
  'projects.closure_outcome': ENUM,
  'projects.status': ENUM,
  'quarantine_cases.detector_kinds': 'names of the credential detectors that matched, never the match',
  'quarantine_cases.item_kind': ENUM,
  'quarantine_cases.state': ENUM,
  'quarantine_events.action': ENUM,
  'quarantine_events.item_kind': ENUM,
  'quarantine_grants.decision': ENUM,
  'quarantine_items.item_kind': ENUM,
  'quarantine_items.role': ENUM,
  'quarantine_originals.ciphertext': 'the encrypted original itself: the one place the marked text is kept (spec 7.3)',
  'quarantine_originals.cleaned_sha256': HASH,
  'quarantine_originals.column_name': 'a registered column name',
  'quarantine_originals.item_kind': ENUM,
  'quarantine_originals.key_id': 'the protected key id, a hash prefix',
  'quarantine_originals.nonce': 'the AES-GCM nonce, random bytes',
  'quarantine_originals.row_key': 'the cleaned row key (ids; for summary_marks the cleaned phrase), never the original',
  'quarantine_originals.table_name': 'a registered table name',
  'quarantine_originals.tag': 'the AES-GCM authentication tag',
  'quarantine_possible_copies.decision': ENUM,
  'quarantine_possible_copies.item_kind': ENUM,
  'questions.status': ENUM,
  'record_events.from_status': ENUM,
  'record_events.kind': ENUM,
  'record_events.record_kind': ENUM,
  'record_events.to_status': ENUM,
  'report_draft_versions.origin': ENUM,
  'report_drafts.chosen': 'the ids of the sources and threads chosen for the draft',
  'report_drafts.kind': ENUM,
  'report_drafts.review_state': ENUM,
  'review_flags.cause': ENUM,
  'review_flags.record_kind': ENUM,
  'risks.severity': ENUM,
  'risks.status': ENUM,
  'schema_migrations.checksum': HASH,
  'schema_migrations.name': 'a migration file name',
  'security_reviewer_events.kind': ENUM,
  'security_reviewer_events.reason': 'an Administrator designating a person: organisation-level, no project scope (spec 7.4, 7.6)',
  'sessions.token_hash': HASH,
  'setup_invitations.email': IDENTITY,
  'setup_invitations.kind': ENUM,
  'setup_invitations.prior_role': ENUM,
  'setup_invitations.prior_status': ENUM,
  'setup_invitations.token_hash': HASH,
  'source_events.kind': ENUM,
  'source_versions.media_type': ENUM,
  'source_versions.origin': ENUM,
  'source_versions.original_sha256': HASH,
  'source_versions.text_sha256': HASH,
  'sources.intended_mode': ENUM,
  'sources.kind': ENUM,
  'sources.publication': ENUM,
  'sources.status': ENUM,
  'summaries.intended_audience': 'the intended audience as a mode and user ids',
  'summaries.state': ENUM,
  'summary_marks.kind': ENUM,
  'summary_versions.origin': ENUM,
  'task_events.from_status': ENUM,
  'task_events.kind': ENUM,
  'task_events.to_status': ENUM,
  'tasks.status': ENUM,
  'users.display_name': IDENTITY,
  'users.email': IDENTITY,
  'users.role': ENUM,
  'users.status': ENUM,
};
