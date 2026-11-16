import { liveRecordSql } from '../history/deleted-sql';
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { CLOCK, type AuthUser, type Clock } from '../auth/tokens';
import { UUID, uuidv7 } from '../common/uuid7';
import { PG_POOL } from '../db/database.module';
import { type Person, audienceVisibleSql } from '../discussion/audience';
import { refuseSecrets } from '../discussion/messages';
import { STALE_EDIT } from '../discussion/threads.service';
import { NoteTextError, normaliseText, sha256Hex } from '../notes/text';
import { type ProjectContext, ProjectAccess, canReadContent } from '../projects/access.service';
import { todayUtc8 } from '../projects/membership';
import { decide } from '../projects/matrix';
import { hrefFor } from '../search/query';
import { type AssistInput, CompletionRefused, type Refusal, registerCompletion, registerInputBuilder, registerRemovedCheck } from './assist-runner';
import { MAX_RECORDS, type MaterialItem, type MaterialScope, type RecordKind, findMaterial, snapshotOf, sourceOkSql, stillReadable } from './material';
import { REPORT_SYSTEM, type ReportOutput, renderInput } from './prompts';
import { answerSources, unavailableReason } from './questions.service';
import { ASSIST_QUEUE, type AssistQueue } from './queue';
import {
  DRAFT_LABEL,
  KIND_LABELS,
  RECORD_KINDS,
  REPORT_KINDS,
  REPORT_SECTIONS,
  type Period,
  type ReportKind,
  type ReportRecords,
  SECTION_TERMS,
  assembleDraft,
  renderFacts,
} from './reports';
import { type AssistRequest, type RequestMaterial, type RequestStatus, createRequest } from './requests';

type Db = Pick<PoolClient, 'query'>;

export const MAX_TITLE = 200;
export const MAX_BRIEF = 2_000;
export const MAX_BODY = 100_000;
export const MAX_CHOSEN = 10;
export const PERIOD_DAYS = 14;

const BAD_KIND = 'Choose a kind of draft: status, decisions_actions, risks, specification or free_form.';
const BAD_TITLE = `A title must be 1 to ${MAX_TITLE} characters.`;
const BAD_BRIEF = 'A brief must be 1 to 2,000 characters.';
const BAD_CHOSEN = 'Choose 1 to 10 sources or threads.';
const CHOSEN_NOT_HERE = 'Sources and threads are chosen only for a specification or a free-form draft.';
const BAD_PERIOD = 'A period needs two dates (YYYY-MM-DD), the first not after the second.';
const NOTHING_FOUND = 'Nothing in this project could be used for this draft.';
const BAD_BODY = 'A draft must be 1 to 100,000 characters.';
const BAD_BASE = 'Say which version you are editing.';
const UNCHANGED = 'Nothing has changed in this draft.';
const IN_REVIEW = 'This draft is waiting for review.';
const BUSY = 'This draft is already being drafted.';
const NO_VERSION = 'This draft has no version yet.';
const ALREADY_SHARED = 'This draft is already shared.';
const NOT_SHARED = 'This draft is not shared.';
export const DRAFT_NO_LONGER_READABLE = 'This draft used information you can no longer read';
export const DRAFT_UNAVAILABLE_PREFIX = 'AI draft unavailable: ';
export const REGENERATE_WARNING = 'A new AI version does not include edits people made to earlier versions.';

/** Report wording where the question wording would not fit; everything else is the shared runner wording. */
const REPORT_REASONS: Readonly<Record<string, string>> = {
  material_unavailable: 'nothing found for this draft can be read any more',
  bad_response: 'the AI draft did not match its sources, so nothing was kept',
  draft_not_found: 'the draft for this request was not found',
  draft_too_long: 'the draft would be longer than 100,000 characters, so nothing was kept',
  queue_unavailable: 'the draft could not be queued; request it again',
  stalled: 'the drafting stopped without finishing; request it again',
};
const reportReason = (code: string | null, detail: string | null) => (code && REPORT_REASONS[code]) || unavailableReason(code, detail);

// ---------------------------------------------------------------------------------------------------------------------
// Draft rows and who may see them (spec 6.3)
// ---------------------------------------------------------------------------------------------------------------------

export type ReviewState = 'none' | 'review_required' | 'cleared' | 'withdrawn';

export interface DraftRow {
  id: string;
  projectId: string;
  kind: ReportKind;
  title: string;
  periodFrom: string | null;
  periodTo: string | null;
  brief: string | null;
  chosen: { sourceIds?: string[]; threadIds?: string[] };
  createdBy: string;
  createdAt: Date;
  shared: boolean;
  sharedAt: Date | null;
  reviewState: ReviewState;
}

const DRAFT_ROW = `d.id, d.project_id AS "projectId", d.kind, d.title, to_char(d.period_from, 'YYYY-MM-DD') AS "periodFrom",
  to_char(d.period_to, 'YYYY-MM-DD') AS "periodTo", d.brief, d.chosen, d.created_by AS "createdBy", d.created_at AS "createdAt",
  d.shared, d.shared_at AS "sharedAt", d.review_state AS "reviewState"`;

/** A draft row, or undefined. With `lock`, the row is locked for the transaction. */
export async function loadDraftRow(db: Db, id: string, lock = false): Promise<DraftRow | undefined> {
  if (!UUID.test(id)) return undefined;
  const { rows } = await db.query(`SELECT ${DRAFT_ROW} FROM report_drafts d WHERE d.id = $1 ${lock ? 'FOR UPDATE' : ''}`, [id]);
  return rows[0] as DraftRow | undefined;
}

/** 'none' means 404 for the caller; 'no_longer_readable' shows the draft's existence with a notice instead of its text. */
export type DraftAccess = 'none' | 'readable' | 'no_longer_readable';

const mayReview = (ctx: ProjectContext) => decide({ action: 'assist.review', roles: ctx.roles, status: ctx.project.status }).allowed;

/** True when the viewer may read every passage and record that every AI version of the draft was built from. */
async function everyAiVersionReadable(db: Db, ctx: ProjectContext, draftId: string): Promise<boolean> {
  const { rows } = await db.query<{ requestId: string }>(
    `SELECT DISTINCT request_id AS "requestId" FROM report_draft_versions WHERE draft_id = $1 AND origin = 'ai'`,
    [draftId],
  );
  for (const r of rows) if (!(await stillReadable(db, ctx, r.requestId))) return false;
  return true;
}

/**
 * Who may see a draft now (spec 6.3, 5.5). Unshared: the requester only. Shared: anyone who can read the project's
 * content and may read every passage any of its AI versions used; others do not see it at all. In review: PM and
 * Deputy only. Withdrawn: nobody. The requester who can no longer read something it used still sees that the draft
 * exists, with a notice in place of its text; so does a reviewer looking at a draft in review.
 */
export async function draftAccess(db: Db, ctx: ProjectContext | null, row: DraftRow): Promise<DraftAccess> {
  if (!canReadContent(ctx) || ctx.project.id !== row.projectId) return 'none';
  if (row.reviewState === 'withdrawn') return 'none';
  const requester = row.createdBy === ctx.viewerId;
  const reviewer = mayReview(ctx);
  const inReview = row.reviewState === 'review_required';
  if (!row.shared && !requester) return 'none';
  if (inReview && !reviewer) return 'none';
  if (await everyAiVersionReadable(db, ctx, row.id)) return 'readable';
  return requester || inReview ? 'no_longer_readable' : 'none';
}

// ---------------------------------------------------------------------------------------------------------------------
// Records, material and the runner's part (spec 6.2)
// ---------------------------------------------------------------------------------------------------------------------

/** The project's records the facts are written from. Project-wide; dates of the period are applied by renderFacts. */
export async function loadReportRecords(db: Db, projectId: string): Promise<ReportRecords> {
  // One query at a time: db may be a single client inside a transaction.
  const tasks = await db.query(
      `SELECT t.id, t.title, u.display_name AS assignee, to_char(t.due_on, 'YYYY-MM-DD') AS "dueOn", t.status, t.authorised_at AS "authorisedAt",
              (SELECT max(e.at) FROM task_events e WHERE e.task_id = t.id AND e.kind = 'completed') AS "completedAt"
         FROM tasks t JOIN users u ON u.id = t.assignee_id WHERE t.project_id = $1 AND ${liveRecordSql('t')} ORDER BY t.due_on, t.id`,
      [projectId],
    );
  const decisions = await db.query(
    `SELECT d.id, d.statement, d.status, d.authorised_at AS "authorisedAt" FROM decisions d WHERE d.project_id = $1 AND ${liveRecordSql('d')} ORDER BY d.authorised_at, d.id`,
    [projectId],
  );
  const questions = await db.query(
      `SELECT q.id, q.text, q.status, u.display_name AS "askedBy", q.authorised_at AS "authorisedAt"
         FROM questions q JOIN users u ON u.id = q.requester_id WHERE q.project_id = $1 AND ${liveRecordSql('q')} ORDER BY q.authorised_at, q.id`,
      [projectId],
    );
  const risks = await db.query(
      `SELECT r.id, r.description, r.severity, r.status, u.display_name AS responsible, to_char(r.review_on, 'YYYY-MM-DD') AS "reviewOn",
              r.authorised_at AS "authorisedAt"
         FROM risks r LEFT JOIN users u ON u.id = r.responsible_id WHERE r.project_id = $1 AND ${liveRecordSql('r')} ORDER BY r.authorised_at, r.id`,
      [projectId],
    );
  const riskChanges = await db.query(
      `SELECT e.record_id AS "riskId", r.description, e.from_status AS "fromStatus", e.to_status AS "toStatus", e.at
         FROM record_events e JOIN risks r ON r.id = e.record_id
        WHERE e.record_kind = 'risk' AND r.project_id = $1 AND ${liveRecordSql('r')} AND e.to_status IS NOT NULL AND e.from_status IS DISTINCT FROM e.to_status
        ORDER BY e.at, e.id`,
      [projectId],
    );
  return { projectId, tasks: tasks.rows, decisions: decisions.rows, questions: questions.rows, risks: risks.rows, riskChanges: riskChanges.rows };
}

const day = (d: Date) => todayUtc8(d);
const short = (s: string) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > 80 ? `${t.slice(0, 79)}…` : t;
};

/**
 * Snapshots of the records the facts are about, most pressing first, at most 20 (spec 4.3): Kainow's own rendering of
 * each record (never a quote), sent so the narrative can explain them.
 */
function recordMaterial(kind: ReportKind, r: ReportRecords, period: Period): MaterialItem[] {
  const out: MaterialItem[] = [];
  const add = (recordKind: RecordKind, id: string, text: string, row: Parameters<typeof snapshotOf>[1], name: string) => {
    if (out.some((o) => o.recordId === id)) return;
    const snapshot = snapshotOf(recordKind, row);
    out.push({
      marker: '',
      passageId: null,
      recordKind,
      recordId: id,
      recordAudienceId: null,
      snapshot,
      text: snapshot,
      location: `${name} — ${short(text)}`,
      href: hrefFor({ kind: recordKind, projectId: r.projectId, itemId: id, runId: null, versionNo: null, isCurrent: true }),
      rank: 0,
    });
  };
  const inPeriod = (d: Date | null) => d !== null && day(d) >= period.from && day(d) <= period.to;
  const open = (s: string) => s !== 'completed' && s !== 'cancelled';
  const known = (d: Date) => day(d) <= period.to;
  const task = (t: ReportRecords['tasks'][number]) => add('task', t.id, t.title, { text: t.title, status: t.status, person: t.assignee, due: t.dueOn }, 'Task');
  const decision = (d: ReportRecords['decisions'][number]) =>
    add('decision', d.id, d.statement, { text: d.statement, status: d.status, authorisedOn: day(d.authorisedAt) }, 'Decision');
  const risk = (x: ReportRecords['risks'][number]) =>
    add('risk', x.id, x.description, { text: x.description, severity: x.severity, status: x.status, person: x.responsible, due: x.reviewOn }, 'Risk');
  const severity = ['critical', 'high', 'medium', 'low'];
  const openRisks = r.risks.filter((x) => known(x.authorisedAt) && (x.status === 'open' || x.status === 'mitigating')).sort((a, b) => severity.indexOf(a.severity) - severity.indexOf(b.severity));
  const tasks = r.tasks.filter((t) => known(t.authorisedAt));
  if (kind === 'status') {
    tasks.filter((t) => open(t.status) && (t.dueOn < period.to || t.status === 'blocked')).forEach(task);
    r.decisions.filter((d) => inPeriod(d.authorisedAt)).forEach(decision);
    openRisks.filter((x) => x.severity === 'critical' || x.severity === 'high').forEach(risk);
    r.questions
      .filter((q) => q.status === 'open' && known(q.authorisedAt))
      .forEach((q) => add('question', q.id, q.text, { text: q.text, status: q.status, person: q.askedBy }, 'Question'));
    tasks.filter((t) => open(t.status) && t.dueOn >= period.to).forEach(task);
    tasks.filter((t) => t.status === 'completed' && inPeriod(t.completedAt)).forEach(task);
  } else if (kind === 'decisions_actions') {
    r.decisions.filter((d) => inPeriod(d.authorisedAt)).forEach(decision);
    tasks.filter((t) => inPeriod(t.authorisedAt)).forEach(task);
  } else if (kind === 'risks') {
    openRisks.forEach(risk);
    const changed = new Set(r.riskChanges.filter((c) => inPeriod(c.at)).map((c) => c.riskId));
    r.risks.filter((x) => changed.has(x.id) || inPeriod(x.authorisedAt)).forEach(risk);
  }
  return out.slice(0, MAX_RECORDS);
}

/** What a draft is built from: the kind, its period and its chosen sources and threads. */
interface DraftSpec {
  kind: ReportKind;
  period: Period | null;
  chosen: { sourceIds: string[]; threadIds: string[] };
  /** Specification and free-form: a period the person gave, which then limits the passages (there is no default). */
  periodGiven: boolean;
}

/**
 * The material of a draft (spec 6.2), found with the requester's own reading rights. Record-based kinds: passages
 * found by the sections' terms within the period, plus the snapshots of the period's records. Specification and
 * free-form: passages of the chosen sources and threads only, in document order, never Project-wide records.
 */
async function draftMaterial(db: Db, ctx: ProjectContext, spec: DraftSpec): Promise<MaterialItem[]> {
  const scope: MaterialScope = { kind: 'personal', ctx };
  let items: MaterialItem[];
  if (RECORD_KINDS.includes(spec.kind)) {
    const period = spec.period as Period;
    const passages = await findMaterial(db, scope, SECTION_TERMS[spec.kind], { period, recordKinds: [] });
    items = [...passages, ...recordMaterial(spec.kind, await loadReportRecords(db, ctx.project.id), period)];
  } else {
    items = await findMaterial(db, scope, [], {
      sourceIds: spec.chosen.sourceIds,
      threadIds: spec.chosen.threadIds,
      recordKinds: [],
      ...(spec.periodGiven && spec.period ? { period: spec.period } : {}),
    });
  }
  items.forEach((item, i) => {
    item.marker = `P${i + 1}`;
  });
  return items;
}

/**
 * The draft a report request was made for. Each request is linked by its `draft_requested` event, written in the same
 * transaction at the request's own time: found through ai_assist_events_project_idx (project_id, at).
 */
export async function draftOfRequest(db: Db, request: Pick<AssistRequest, 'id' | 'projectId' | 'createdAt'>): Promise<string | undefined> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT e.target_id AS id FROM ai_assist_events e
      WHERE e.project_id = $2 AND e.at = $3 AND e.action = 'draft_requested' AND e.target_kind = 'report_draft' AND e.detail->>'requestId' = $1::text`,
    [request.id, request.projectId, request.createdAt],
  );
  return rows[0]?.id;
}

const periodOf = (row: Pick<DraftRow, 'periodFrom' | 'periodTo'>): Period | null =>
  row.periodFrom && row.periodTo ? { from: row.periodFrom, to: row.periodTo } : null;

/** A report's prompt: what to write, then the passages and record snapshots still readable. */
export async function reportInput(db: Db, request: AssistRequest, material: RequestMaterial[]): Promise<AssistInput | Refusal> {
  if (material.length === 0) {
    return { code: 'material_unavailable', detail: 'Nothing found for this draft can be read any more, so nothing was sent to the AI.' };
  }
  const draftId = await draftOfRequest(db, request);
  const draft = draftId ? await loadDraftRow(db, draftId) : undefined;
  if (!draft) return { code: 'draft_not_found', detail: 'The draft for this request was not found, so nothing was sent to the AI.' };
  const period = periodOf(draft);
  const lines = [
    `Draft: ${KIND_LABELS[draft.kind]}`,
    `Title: ${draft.title}`,
    ...(period ? [`Period: ${period.from} to ${period.to}`] : []),
    'Sections (write one entry for each, with the section name exactly as given):',
    ...REPORT_SECTIONS[draft.kind].map((s) => `- ${s}`),
  ];
  if (draft.brief) lines.push('', 'Brief from the person who asked:', draft.brief);
  return { system: REPORT_SYSTEM, user: `${lines.join('\n')}\n\nPassages:\n\n${renderInput(material)}` };
}

/**
 * Writes the AI version: Kainow's heading and facts from the records now, the AI's narrative, footnotes and sources.
 * The draft row is locked; a draft withdrawn or sent to review while the AI call ran gets no new version (the request
 * still ends as the runner decides, and nothing is shown).
 */
export async function completeReport(db: PoolClient, request: AssistRequest, output: unknown, at: Date): Promise<void> {
  const draftId = await draftOfRequest(db, request);
  if (!draftId) throw new Error(`assist ${request.id}: no draft for this report request`);
  const draft = (await loadDraftRow(db, draftId, true)) as DraftRow;
  if (draft.reviewState === 'withdrawn' || draft.reviewState === 'review_required') return;
  const requester = (await db.query<{ name: string }>(`SELECT display_name AS name FROM users WHERE id = $1`, [request.requestedBy])).rows[0]?.name ?? 'someone';
  const period = periodOf(draft);
  const facts = period ? renderFacts(draft.kind, await loadReportRecords(db, draft.projectId), period) : {};
  const sources = (await answerSources(db, request.id, draft.projectId)).filter((s) => !s.dropped && s.location !== null && s.href !== null);
  const body = assembleDraft(
    { title: draft.title, kind: draft.kind, period, requester, date: todayUtc8(at) },
    facts,
    output as ReportOutput,
    sources.map((s) => ({ marker: s.marker, location: s.location as string, href: s.href as string })),
  );
  // Asking again would not help: the request ends failed now (no retry, no second charge), and nothing is kept.
  if (body.length > MAX_BODY) {
    throw new CompletionRefused('draft_too_long', `The assembled draft would be longer than ${MAX_BODY.toLocaleString('en-US')} characters, so nothing was kept.`);
  }
  const no = Number((await db.query(`SELECT coalesce(max(version_no), 0) AS n FROM report_draft_versions WHERE draft_id = $1`, [draft.id])).rows[0].n) + 1;
  await db.query(
    `INSERT INTO report_draft_versions (id, draft_id, version_no, origin, body, request_id, created_by, created_at) VALUES ($1, $2, $3, 'ai', $4, $5, $6, $7)`,
    [uuidv7(at.getTime()), draft.id, no, body, request.id, request.requestedBy, at],
  );
}

/** The removal hook withdrew the draft or sent it to review (spec 5.5, 6.3): the request does not run. */
export async function reportRemoved(db: Db, request: AssistRequest): Promise<boolean> {
  const draftId = await draftOfRequest(db, request);
  if (!draftId) return false;
  const state = (await db.query<{ state: ReviewState }>(`SELECT review_state AS state FROM report_drafts WHERE id = $1`, [draftId])).rows[0]?.state;
  return state === 'withdrawn' || state === 'review_required';
}

registerInputBuilder('report', reportInput);
registerCompletion('report', completeReport);
registerRemovedCheck('report', reportRemoved);

// ---------------------------------------------------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------------------------------------------------

export type DraftStatus = 'queued' | 'running' | 'ready' | 'failed' | 'blocked';

export interface DraftVersionView {
  /** The version row's id (the feedback target `report_version`). */
  id: string;
  no: number;
  origin: 'ai' | 'human';
  /** The person who asked (ai) or who edited (human). */
  createdBy: Person | null;
  /** "Edited by <name>" on human versions; null on AI versions. */
  editedByLabel: string | null;
  createdAt: Date;
}

export interface ReportView {
  id: string;
  projectId: string;
  kind: ReportKind;
  kindLabel: string;
  title: string;
  period: Period | null;
  brief: string | null;
  chosen: { sourceIds: string[]; threadIds: string[] };
  requestedBy: Person;
  createdAt: Date;
  shared: boolean;
  sharedAt: Date | null;
  /** Shared and waiting for PM or Deputy review (only they see it then). */
  inReview: boolean;
  label: typeof DRAFT_LABEL;
  /** The latest AI request's state: 'ready' once it succeeded. */
  status: DraftStatus;
  unavailableReason: string | null;
  notice: string | null;
  canEdit: boolean;
  canRegenerate: boolean;
  canShare: boolean;
  canUnshare: boolean;
  versions: DraftVersionView[];
  /** The newest version and its text; null before the first version, or when the viewer can no longer read it. */
  current: (DraftVersionView & { body: string }) | null;
}

export interface ReportListItem {
  id: string;
  kind: ReportKind;
  kindLabel: string;
  title: string;
  requestedBy: Person;
  createdAt: Date;
  shared: boolean;
  inReview: boolean;
  status: DraftStatus;
  versionCount: number;
  updatedAt: Date;
  notice: string | null;
}

interface LatestRequest {
  status: RequestStatus;
  failureCode: string | null;
  failureDetail: string | null;
}

/** The draft's request still waiting or running (there is at most one), else its newest. */
async function latestRequest(db: Db, draftId: string): Promise<LatestRequest | undefined> {
  const { rows } = await db.query(
    `SELECT r.status, r.failure_code AS "failureCode", r.failure_detail AS "failureDetail"
       FROM ai_assist_events e JOIN ai_requests r ON r.id = (e.detail->>'requestId')::uuid
      WHERE e.target_kind = 'report_draft' AND e.target_id = $1 AND e.action = 'draft_requested'
      ORDER BY (r.status IN ('queued', 'running')) DESC, e.at DESC, e.id DESC LIMIT 1`,
    [draftId],
  );
  return rows[0] as LatestRequest | undefined;
}

const statusOf = (r: LatestRequest | undefined): DraftStatus => (!r || r.status === 'succeeded' ? 'ready' : r.status);

interface VersionRow {
  id: string;
  no: number;
  origin: 'ai' | 'human';
  body: string;
  createdById: string | null;
  createdByName: string | null;
  createdAt: Date;
}

async function versionRows(db: Db, draftId: string): Promise<VersionRow[]> {
  const { rows } = await db.query(
    `SELECT v.id, v.version_no AS no, v.origin, v.body, v.created_by AS "createdById", u.display_name AS "createdByName", v.created_at AS "createdAt"
       FROM report_draft_versions v LEFT JOIN users u ON u.id = v.created_by WHERE v.draft_id = $1 ORDER BY v.version_no`,
    [draftId],
  );
  return rows as VersionRow[];
}

const versionView = (v: VersionRow): DraftVersionView => ({
  id: v.id,
  no: v.no,
  origin: v.origin,
  createdBy: v.createdById ? { id: v.createdById, displayName: v.createdByName ?? '' } : null,
  editedByLabel: v.origin === 'human' ? `Edited by ${v.createdByName ?? 'someone'}` : null,
  createdAt: v.createdAt,
});

const allowed = (ctx: ProjectContext, action: 'report.request' | 'report.manage') => decide({ action, roles: ctx.roles, status: ctx.project.status }).allowed;

/** Edit and share: the requester (a participant), or PM and Deputy on a shared draft; never while it is in review. */
function mayEdit(ctx: ProjectContext, row: DraftRow): boolean {
  if (row.reviewState === 'review_required') return false;
  if (row.createdBy === ctx.viewerId && allowed(ctx, 'report.request')) return true;
  return row.shared && allowed(ctx, 'report.manage');
}

const chosenOf = (row: DraftRow) => ({ sourceIds: row.chosen?.sourceIds ?? [], threadIds: row.chosen?.threadIds ?? [] });

/**
 * The chosen sources and threads this person can read now, in the chosen order: in the project, published and not
 * deleted (sources, by the material rule), and in an audience they are in.
 */
async function readableChosen(db: Db, ctx: ProjectContext, chosen: { sourceIds: string[]; threadIds: string[] }): Promise<{ sourceIds: string[]; threadIds: string[] }> {
  const keep = async (wanted: string[], sql: string) => {
    if (wanted.length === 0) return [];
    const found = new Set((await db.query<{ id: string }>(sql, [wanted, ctx.project.id, ctx.viewerId, ctx.today])).rows.map((r) => r.id));
    return wanted.filter((id) => found.has(id));
  };
  return {
    sourceIds: await keep(
      chosen.sourceIds,
      `SELECT s.id FROM sources s JOIN audiences au ON au.id = s.audience_id
        WHERE s.id = ANY($1::uuid[]) AND s.project_id = $2 AND ${sourceOkSql('s')} AND ${audienceVisibleSql('au', '$3', '$4')}`,
    ),
    threadIds: await keep(
      chosen.threadIds,
      `SELECT th.id FROM discussion_threads th JOIN audiences au ON au.id = th.audience_id
        WHERE th.id = ANY($1::uuid[]) AND th.project_id = $2 AND ${audienceVisibleSql('au', '$3', '$4')}`,
    ),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------------------------------------------------

function cleanText(raw: unknown, max: number, message: string, required: boolean): string | null {
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '' && !required)) {
    if (required) throw new BadRequestException(message);
    return null;
  }
  if (typeof raw !== 'string') throw new BadRequestException(message);
  let text: string;
  try {
    text = normaliseText(raw).trim();
  } catch (err) {
    if (err instanceof NoteTextError) throw new BadRequestException(message);
    throw err;
  }
  if (text.length < 1 || text.length > max) throw new BadRequestException(message);
  refuseSecrets(text);
  return text;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (s: unknown): s is string => typeof s === 'string' && DATE.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function idList(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.some((x) => typeof x !== 'string' || !UUID.test(x))) throw new BadRequestException(BAD_CHOSEN);
  return [...new Set(raw as string[])];
}

export interface NewReportBody {
  kind: unknown;
  title?: unknown;
  periodFrom?: unknown;
  periodTo?: unknown;
  brief?: unknown;
  chosen?: unknown;
}

/** Draft reports and specifications (spec 6): requesting, versions, editing, regenerating, sharing and download. */
@Injectable()
export class ReportsService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly now: Clock,
    @Inject(ASSIST_QUEUE) private readonly queue: AssistQueue,
    private readonly access: ProjectAccess,
  ) {}

  private async inTransaction<T>(work: (db: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** Queues a stored request; if the queue cannot take it, the request ends failed so it is not left waiting. */
  private async enqueue(id: string): Promise<void> {
    try {
      await this.queue.enqueue(id);
    } catch {
      await this.pool.query(
        `UPDATE ai_requests SET status = 'failed', failure_code = 'queue_unavailable', failure_detail = 'The draft could not be queued; request it again.', finished_at = $2
          WHERE id = $1 AND status = 'queued'`,
        [id, this.now()],
      );
    }
  }

  /**
   * The period: both dates or neither. Neither means the last 14 days to today (UTC+8) for the record-based kinds, and
   * no period for a specification or free-form draft (their material is then not limited by date, and the heading shows
   * no period).
   */
  private period(kind: ReportKind, from: unknown, to: unknown, today: string): { period: Period | null; given: boolean } {
    const absent = (v: unknown) => v === undefined || v === null || v === '';
    if (absent(from) && absent(to)) {
      return { period: RECORD_KINDS.includes(kind) ? { from: addDays(today, -(PERIOD_DAYS - 1)), to: today } : null, given: false };
    }
    if (!validDate(from) || !validDate(to) || from > to) throw new BadRequestException(BAD_PERIOD);
    return { period: { from, to }, given: true };
  }

  /**
   * Chosen sources and threads must be ones the requester can read now (spec 6.2): in the project, published and not
   * deleted (sources), and in an audience they are in. Anything else is not found (404), as a direct link would be.
   */
  private async assertChosenReadable(db: Db, ctx: ProjectContext, chosen: { sourceIds: string[]; threadIds: string[] }): Promise<void> {
    const ok = await readableChosen(db, ctx, chosen);
    if (ok.sourceIds.length !== chosen.sourceIds.length || ok.threadIds.length !== chosen.threadIds.length) throw new NotFoundException();
  }

  /** Stores the request with its material and its `draft_requested` event (no text: lengths only). */
  private async requestDraft(db: PoolClient, ctx: ProjectContext, draft: { id: string; projectId: string }, spec: DraftSpec, userId: string, at: Date, detail: Record<string, unknown>): Promise<string> {
    const material = await draftMaterial(db, ctx, spec);
    if (material.length === 0) throw new ConflictException(NOTHING_FOUND);
    const requestId = await createRequest(db, { projectId: draft.projectId, kind: 'report', requestedBy: userId, scope: 'personal', material, at });
    await db.query(
      `INSERT INTO ai_assist_events (id, project_id, actor_id, action, target_kind, target_id, detail, at) VALUES ($1, $2, $3, 'draft_requested', 'report_draft', $4, $5, $6)`,
      [uuidv7(at.getTime()), draft.projectId, userId, draft.id, { requestId, kind: spec.kind, material: material.length, ...detail }, at],
    );
    return requestId;
  }

  /** Requests a draft (spec 6.1): any participant in a Draft, Planned or Active project, charged to their own cap. */
  async create(user: AuthUser, projectId: string, body: NewReportBody): Promise<ReportView> {
    const { id, requestId, ctx } = await this.inTransaction(async (db) => {
      const ctx = await this.access.authorize(user, 'report.request', projectId, db);
      if (typeof body.kind !== 'string' || !REPORT_KINDS.includes(body.kind as ReportKind)) throw new BadRequestException(BAD_KIND);
      const kind = body.kind as ReportKind;
      const title = cleanText(body.title, MAX_TITLE, BAD_TITLE, kind === 'free_form') ?? KIND_LABELS[kind];
      const brief = cleanText(body.brief, MAX_BRIEF, BAD_BRIEF, kind === 'free_form');
      const { period, given } = this.period(kind, body.periodFrom, body.periodTo, ctx.today);
      const rawChosen = (body.chosen ?? {}) as Record<string, unknown>;
      if (typeof rawChosen !== 'object' || Array.isArray(rawChosen)) throw new BadRequestException(BAD_CHOSEN);
      const chosen = { sourceIds: idList(rawChosen.sourceIds), threadIds: idList(rawChosen.threadIds) };
      const count = chosen.sourceIds.length + chosen.threadIds.length;
      if (RECORD_KINDS.includes(kind)) {
        if (count > 0) throw new BadRequestException(CHOSEN_NOT_HERE);
      } else {
        if (count < 1 || count > MAX_CHOSEN) throw new BadRequestException(BAD_CHOSEN);
        await this.assertChosenReadable(db, ctx, chosen);
      }
      const at = this.now();
      const id = uuidv7(at.getTime());
      await db.query(
        `INSERT INTO report_drafts (id, project_id, kind, title, period_from, period_to, brief, chosen, created_by, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [id, projectId, kind, title, period?.from ?? null, period?.to ?? null, brief, chosen, user.id, at],
      );
      const requestId = await this.requestDraft(db, ctx, { id, projectId }, { kind, period, chosen, periodGiven: given }, user.id, at, {
        regenerate: false,
        titleLength: title.length,
        briefLength: brief?.length ?? 0,
        chosen: count,
      });
      return { id, requestId, ctx };
    });
    await this.enqueue(requestId);
    return this.mustView(ctx, id);
  }

  /** The drafts this person may see in the project: their own, and shared ones they may read (spec 6.3). Any state. */
  async list(user: AuthUser, projectId: string): Promise<ReportListItem[]> {
    const ctx = await this.access.authorize(user, 'note.view', projectId);
    const { rows } = await this.pool.query(
      `SELECT ${DRAFT_ROW}, u.display_name AS "byName",
              (SELECT count(*) FROM report_draft_versions v WHERE v.draft_id = d.id)::int AS "versionCount",
              coalesce((SELECT max(v.created_at) FROM report_draft_versions v WHERE v.draft_id = d.id), d.created_at) AS "updatedAt"
         FROM report_drafts d JOIN users u ON u.id = d.created_by
        WHERE d.project_id = $1 AND d.review_state <> 'withdrawn' AND (d.created_by = $2 OR d.shared)
        ORDER BY d.created_at DESC, d.id DESC LIMIT 200`,
      [projectId, user.id],
    );
    const out: ReportListItem[] = [];
    for (const row of rows as Array<DraftRow & { byName: string; versionCount: number; updatedAt: Date }>) {
      const seen = await draftAccess(this.pool, ctx, row);
      if (seen === 'none') continue;
      const latest = await latestRequest(this.pool, row.id);
      out.push({
        id: row.id,
        kind: row.kind,
        kindLabel: KIND_LABELS[row.kind],
        title: row.title,
        requestedBy: { id: row.createdBy, displayName: row.byName },
        createdAt: row.createdAt,
        shared: row.shared,
        inReview: row.reviewState === 'review_required',
        status: statusOf(latest),
        versionCount: row.versionCount,
        updatedAt: row.updatedAt,
        notice: seen === 'no_longer_readable' ? DRAFT_NO_LONGER_READABLE : null,
      });
    }
    return out;
  }

  async get(user: AuthUser, id: string): Promise<ReportView> {
    const row = await loadDraftRow(this.pool, id);
    if (!row) throw new NotFoundException();
    const ctx = await this.access.load(row.projectId, user);
    if (!ctx) throw new NotFoundException();
    return this.mustView(ctx, id);
  }

  /** One version's text, for comparing versions; the same visibility as the draft. */
  async version(user: AuthUser, id: string, rawNo: string): Promise<DraftVersionView & { body: string }> {
    const v = await this.readableVersion(user, id, rawNo);
    return { ...versionView(v.version), body: v.version.body };
  }

  /** Download Markdown (spec 6.3): for anyone who can see the draft; the label goes at the top of the file. */
  async markdown(user: AuthUser, id: string, rawNo: string): Promise<{ filename: string; text: string }> {
    const { row, version } = await this.readableVersion(user, id, rawNo);
    const slug = row.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'draft';
    return { filename: `${slug}-v${version.no}.md`, text: `> ${DRAFT_LABEL}\n\n${version.body}` };
  }

  private async readableVersion(user: AuthUser, id: string, rawNo: string): Promise<{ row: DraftRow; version: VersionRow }> {
    const row = await loadDraftRow(this.pool, id);
    if (!row) throw new NotFoundException();
    const ctx = await this.access.load(row.projectId, user);
    if ((await draftAccess(this.pool, ctx, row)) !== 'readable') throw new NotFoundException();
    const no = /^\d{1,9}$/.test(rawNo) ? Number(rawNo) : NaN;
    const version = (await versionRows(this.pool, row.id)).find((v) => v.no === no);
    if (!version) throw new NotFoundException();
    return { row, version };
  }

  /**
   * The draft, locked, for a change by this person: 404 for anyone who may not see it; then 403 from the matrix
   * (`report.request` for the requester, `report.manage` for PM and Deputy on someone else's shared draft).
   */
  private async changeable(db: PoolClient, user: AuthUser, id: string, requesterOnly = false): Promise<{ row: DraftRow; ctx: ProjectContext }> {
    const row = await loadDraftRow(db, id, true);
    if (!row) throw new NotFoundException();
    const seen = await draftAccess(db, await this.access.load(row.projectId, user, db), row);
    if (seen === 'none') throw new NotFoundException();
    const own = row.createdBy === user.id;
    if (requesterOnly && !own) throw new ForbiddenException('Only the person who requested this draft can regenerate it.');
    const ctx = await this.access.authorize(user, own ? 'report.request' : 'report.manage', row.projectId, db);
    if (row.reviewState === 'review_required') throw new ConflictException(IN_REVIEW);
    if (seen !== 'readable') throw new ConflictException(DRAFT_NO_LONGER_READABLE);
    return { row, ctx };
  }

  /** A human version (spec 6.3): Markdown up to 100,000 characters, secret check, refused when someone changed it since. */
  async edit(user: AuthUser, id: string, body: { body: unknown; basedOnVersion: unknown }): Promise<ReportView> {
    const ctx = await this.inTransaction(async (db) => {
      const { row, ctx } = await this.changeable(db, user, id);
      const based = body.basedOnVersion;
      if (typeof based !== 'number' || !Number.isInteger(based) || based < 1) throw new BadRequestException(BAD_BASE);
      const text = cleanText(body.body, MAX_BODY, BAD_BODY, true) as string;
      const versions = await versionRows(db, row.id);
      const latest = versions[versions.length - 1];
      if (!latest) throw new ConflictException(NO_VERSION);
      if (latest.no !== based) {
        const current = await this.view(db, ctx, row.id);
        throw new ConflictException({ statusCode: 409, message: STALE_EDIT, error: 'Conflict', current });
      }
      if (latest.body === text) throw new BadRequestException(UNCHANGED);
      const at = this.now();
      await db.query(
        `INSERT INTO report_draft_versions (id, draft_id, version_no, origin, body, edited_from_id, created_by, created_at) VALUES ($1, $2, $3, 'human', $4, $5, $6, $7)`,
        [uuidv7(at.getTime()), row.id, latest.no + 1, text, latest.id, user.id, at],
      );
      await db.query(
        `INSERT INTO ai_assist_events (id, project_id, actor_id, action, target_kind, target_id, detail, at) VALUES ($1, $2, $3, 'draft_edited', 'report_draft', $4, $5, $6)`,
        [uuidv7(at.getTime()), row.projectId, user.id, row.id, { version: latest.no + 1, bodyLength: text.length, bodySha256: sha256Hex(text) }, at],
      );
      return ctx;
    });
    return this.mustView(ctx, id);
  }

  /** A new AI version from the material as it is now (spec 6.3), by the requester, charged to them. */
  async regenerate(user: AuthUser, id: string): Promise<ReportView & { warning: string }> {
    const { requestId, ctx } = await this.inTransaction(async (db) => {
      const { row, ctx } = await this.changeable(db, user, id, true);
      const latest = await latestRequest(db, row.id);
      if (latest && (latest.status === 'queued' || latest.status === 'running')) throw new ConflictException(BUSY);
      const chosen = chosenOf(row);
      if (!RECORD_KINDS.includes(row.kind)) await this.assertChosenReadable(db, ctx, chosen);
      const period = periodOf(row);
      const at = this.now();
      const requestId = await this.requestDraft(db, ctx, row, { kind: row.kind, period, chosen, periodGiven: period !== null }, user.id, at, {
        regenerate: true,
      });
      return { requestId, ctx };
    });
    await this.enqueue(requestId);
    return { ...(await this.mustView(ctx, id)), warning: REGENERATE_WARNING };
  }

  /**
   * Share with project, or unshare (spec 6.3): the requester, or PM and Deputy. A PM or Deputy who unshares someone
   * else's draft can no longer see it, so they get `{ id, shared: false, visible: false }` instead of the view.
   */
  private async setShared(user: AuthUser, id: string, share: boolean): Promise<ReportView | { id: string; shared: false; visible: false }> {
    const ctx = await this.inTransaction(async (db) => {
      const { row, ctx } = await this.changeable(db, user, id);
      if (row.shared === share) throw new ConflictException(share ? ALREADY_SHARED : NOT_SHARED);
      if (share && (await versionRows(db, row.id)).length === 0) throw new ConflictException(NO_VERSION);
      const at = this.now();
      await db.query(`UPDATE report_drafts SET shared = $2, shared_at = $3 WHERE id = $1`, [row.id, share, share ? at : null]);
      await db.query(
        `INSERT INTO ai_assist_events (id, project_id, actor_id, action, target_kind, target_id, at) VALUES ($1, $2, $3, $4, 'report_draft', $5, $6)`,
        [uuidv7(at.getTime()), row.projectId, user.id, share ? 'draft_shared' : 'draft_unshared', row.id, at],
      );
      return ctx;
    });
    return (await this.view(this.pool, ctx, id)) ?? { id, shared: false, visible: false };
  }

  share(user: AuthUser, id: string) {
    return this.setShared(user, id, true);
  }

  unshare(user: AuthUser, id: string) {
    return this.setShared(user, id, false);
  }

  /** The draft as this viewer may see it, or undefined when they may not see it at all. */
  private async view(db: Db, ctx: ProjectContext, id: string): Promise<ReportView | undefined> {
    const row = await loadDraftRow(db, id);
    if (!row) return undefined;
    const seen = await draftAccess(db, ctx, row);
    if (seen === 'none') return undefined;
    const by = (await db.query<{ name: string }>(`SELECT display_name AS name FROM users WHERE id = $1`, [row.createdBy])).rows[0]?.name ?? '';
    const latest = await latestRequest(db, row.id);
    const status = statusOf(latest);
    const ended = status === 'failed' || status === 'blocked';
    const reason = ended && latest ? reportReason(latest.failureCode, latest.failureDetail) : null;
    const versions = await versionRows(db, row.id);
    const readable = seen === 'readable';
    const editable = readable && mayEdit(ctx, row);
    const own = row.createdBy === ctx.viewerId;
    const last = versions[versions.length - 1];
    return {
      id: row.id,
      projectId: row.projectId,
      kind: row.kind,
      kindLabel: KIND_LABELS[row.kind],
      title: row.title,
      period: periodOf(row),
      brief: readable ? row.brief : null,
      // Only the chosen items this viewer can read: the ids of others are not revealed.
      chosen: await readableChosen(db, ctx, chosenOf(row)),
      requestedBy: { id: row.createdBy, displayName: by },
      createdAt: row.createdAt,
      shared: row.shared,
      sharedAt: row.sharedAt,
      inReview: row.reviewState === 'review_required',
      label: DRAFT_LABEL,
      status,
      unavailableReason: reason,
      notice: !readable ? DRAFT_NO_LONGER_READABLE : ended ? `${DRAFT_UNAVAILABLE_PREFIX}${reason}` : null,
      canEdit: editable && last !== undefined,
      canRegenerate: editable && own && status !== 'queued' && status !== 'running',
      canShare: editable && !row.shared && last !== undefined,
      canUnshare: editable && row.shared,
      versions: versions.map(versionView),
      current: readable && last ? { ...versionView(last), body: last.body } : null,
    };
  }

  private async mustView(ctx: ProjectContext, id: string): Promise<ReportView> {
    const view = await this.view(this.pool, ctx, id);
    if (!view) throw new NotFoundException();
    return view;
  }
}
