import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { headerOf } from '../analysis/transcript';
import { CLOCK, type AuthUser, type Clock } from '../auth/tokens';
import { UUID, uuidv7 } from '../common/uuid7';
import { PG_POOL } from '../db/database.module';
import { type AudienceChange, type AudienceRow, type Person, inAudience, parseAudienceChange } from '../discussion/audience';
import { AudienceService } from '../discussion/audience.service';
import { refuseSecrets } from '../discussion/messages';
import { liveSourceSql } from '../history/deleted-sql';
import { STALE_EDIT } from '../discussion/threads.service';
import { FROM_RESTRICTED_LABEL, NotesService, SUMMARY_APPROVED_LABEL, formatDay } from '../notes/notes.service';
import { NoteTextError, normaliseText, sha256Hex } from '../notes/text';
import { type ProjectContext, ProjectAccess, canReadContent } from '../projects/access.service';
import { grantGivesAccess } from '../projects/grants';
import { effectiveRoles } from '../projects/membership';
import { decide } from '../projects/matrix';
import { type AssistInput, CompletionRefused, type Refusal, registerCompletion, registerInputBuilder, registerRemovedCheck } from './assist-runner';
import { type Mark, type MarkKind, findMarks, parseLeaveOut } from './leave-out';
import { SUMMARY_SYSTEM, type SummaryOutput } from './prompts';
import { unavailableReason } from './questions.service';
import { ASSIST_QUEUE, type AssistQueue } from './queue';
import { SUMMARY_REVIEW_LABEL, SUMMARY_REVIEW_REASONS, type SummaryReviewCause, onMaterialRemoved } from './removal';
import { type AssistRequest, type RequestMaterial, type RequestStatus, createRequest } from './requests';

type Db = Pick<PoolClient, 'query'>;

/** Limits fixed in V1.0 (spec 7.1, 7.2). */
export const MAX_LEAVE_OUT = 1_000;
export const MAX_SUMMARY_BODY = 100_000;
export const MAX_SUMMARY_INPUT = 120_000;
const MAX_REASON = 500;

export const SUMMARY_DRAFT_LABEL = 'AI draft — not approved for sharing';
export const SUMMARY_UNAVAILABLE_PREFIX = 'AI summary unavailable: ';

/** The 4a refusal wording (4a spec 7.5), for a source and for a meeting. */
const TOO_LONG_SOURCE = 'This source is too long to summarise in one request.';
const TOO_LONG_MEETING = 'This meeting is too long to summarise in one request.';
const NOTHING_TO_SUMMARISE = 'There is nothing in this meeting to summarise yet.';
const NOT_RESTRICTED = 'Only a Restricted source or meeting can have a shareable summary; this one is already Project-wide.';
const NOT_A_MEETING = 'Only a meeting can have a shareable summary; a discussion is already open to the whole project.';
const NOT_A_SUMMARY_SOURCE = 'A shareable summary cannot itself be summarised.';
const NOT_PUBLISHED = 'A submission can be summarised only after a reviewer publishes it.';
const BAD_LEAVE_OUT = 'Leave out must be up to 1,000 characters.';
const BAD_BODY = 'A summary must be 1 to 100,000 characters.';
const BAD_BASE = 'Say which version you are editing.';
const BAD_VERSION = 'Say which version this is for.';
const UNCHANGED = 'Nothing has changed in this summary.';
const NO_VERSION = 'This summary has no version yet.';
const REASON_REQUIRED = 'A reason is required (up to 500 characters).';
const NOT_OPEN = 'This summary can no longer be changed.';
const ALREADY_APPROVED = 'This version is already approved.';
const MARKS_OPEN = 'Every marked phrase or name must be removed by editing or ticked Intended before this version can be approved.';
const MARK_ALREADY = 'This mark is already ticked Intended.';
const NOT_IN_REVIEW = 'This summary is not waiting for an access review.';
const MODERATED_SINCE = 'A message this draft was built from has since been hidden or deleted. Draft the summary again before approving.';

/** Why a summary request ended, in plain words, where the shared runner wording would not fit. */
const SUMMARY_REASONS: Readonly<Record<string, string>> = {
  summary_not_found: 'the summary for this request was not found',
  summary_too_long: 'the summary would be longer than 100,000 characters, so nothing was kept',
  too_long: 'the source is too long to summarise in one request',
  nothing_to_summarise: 'there was nothing left to summarise',
  requester_not_in_audience: 'the person who asked can no longer read the original',
  original_removed: 'the original was deleted',
  requester_cannot_request: 'the person who asked can no longer request a summary',
  queue_unavailable: 'the summary could not be queued; request it again',
  stalled: 'the summary drafting stopped without finishing; request it again',
};
const summaryReason = (code: string | null, detail: string | null) => (code && SUMMARY_REASONS[code]) || unavailableReason(code, detail);

// ---------------------------------------------------------------------------------------------------------------------
// Rows, the original and who may see a summary (spec 7.2)
// ---------------------------------------------------------------------------------------------------------------------

export type SummaryState = 'draft' | 'approved' | 'review_required' | 'hidden' | 'withdrawn';

export interface SummaryRow {
  id: string;
  projectId: string;
  originalSourceId: string | null;
  originalThreadId: string | null;
  intendedAudience: AudienceChange;
  leaveOut: string;
  state: SummaryState;
  summarySourceId: string | null;
  approvedVersionId: string | null;
  approvedBy: string | null;
  approvedAt: Date | null;
  reviewReason: string | null;
  createdBy: string;
  createdAt: Date;
}

const SUMMARY_ROW = `sm.id, sm.project_id AS "projectId", sm.original_source_id AS "originalSourceId", sm.original_thread_id AS "originalThreadId",
  sm.intended_audience AS "intendedAudience", sm.leave_out AS "leaveOut", sm.state, sm.summary_source_id AS "summarySourceId",
  sm.approved_version_id AS "approvedVersionId", sm.approved_by AS "approvedBy", sm.approved_at AS "approvedAt",
  sm.review_reason AS "reviewReason", sm.created_by AS "createdBy", sm.created_at AS "createdAt"`;

export async function loadSummaryRow(db: Db, id: string, lock = false): Promise<SummaryRow | undefined> {
  if (!UUID.test(id)) return undefined;
  const { rows } = await db.query(`SELECT ${SUMMARY_ROW} FROM summaries sm WHERE sm.id = $1 ${lock ? 'FOR UPDATE' : ''}`, [id]);
  return rows[0] as SummaryRow | undefined;
}

/** The summarised source or meeting: its title and its audience. */
export interface Original {
  kind: 'source' | 'meeting';
  id: string;
  title: string;
  audience: AudienceRow;
}

const NAMED = (a: string) => `COALESCE((SELECT array_agg(am.user_id ORDER BY am.user_id) FROM audience_members am WHERE am.audience_id = ${a}.id), ARRAY[]::uuid[])`;

export async function loadOriginal(db: Db, row: Pick<SummaryRow, 'originalSourceId' | 'originalThreadId'>): Promise<Original | undefined> {
  const source = row.originalSourceId !== null;
  const { rows } = await db.query(
    source
      ? `SELECT s.id, s.title, a.id AS "audienceId", a.project_id AS "projectId", a.mode, ${NAMED('a')} AS "namedUserIds"
           FROM sources s JOIN audiences a ON a.id = s.audience_id WHERE s.id = $1`
      : `SELECT t.id, t.title, a.id AS "audienceId", a.project_id AS "projectId", a.mode, ${NAMED('a')} AS "namedUserIds"
           FROM discussion_threads t JOIN audiences a ON a.id = t.audience_id WHERE t.id = $1`,
    [source ? row.originalSourceId : row.originalThreadId],
  );
  const r = rows[0];
  if (!r) return undefined;
  return {
    kind: source ? 'source' : 'meeting',
    id: r.id,
    title: r.title,
    audience: { id: r.audienceId, projectId: r.projectId, mode: r.mode, namedUserIds: r.namedUserIds },
  };
}

/**
 * The audience an approval publishes to: the summary source's audience as it is now once one exists (it may have been
 * changed since the first approval), otherwise the intended audience.
 */
async function publishedAudience(db: Db, row: Pick<SummaryRow, 'summarySourceId' | 'intendedAudience'>): Promise<AudienceChange> {
  if (!row.summarySourceId) return row.intendedAudience;
  const r = (
    await db.query<AudienceChange>(
      `SELECT a.mode, ${NAMED('a')} AS "namedUserIds" FROM sources s JOIN audiences a ON a.id = s.audience_id WHERE s.id = $1`,
      [row.summarySourceId],
    )
  ).rows[0];
  return r ?? row.intendedAudience;
}

/**
 * Whether this viewer may see the summary's draft and versions: someone who can read the project's content and is in
 * the original's audience (spec 7.2). The wider audience reads only the approved `summary` source (notes, search).
 */
export async function summaryVisible(db: Db, ctx: ProjectContext | null, row: SummaryRow): Promise<boolean> {
  if (!canReadContent(ctx) || ctx.project.id !== row.projectId) return false;
  const original = await loadOriginal(db, row);
  return original !== undefined && inAudience(ctx, original.audience);
}

// ---------------------------------------------------------------------------------------------------------------------
// The input, the marks and the runner's part (spec 7.1, 7.2)
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The text the summary is drafted from: the source's current version, or the meeting's visible messages (current
 * versions). Null when the original source is no longer active (deleted): nothing of it may be sent.
 */
async function originalText(db: Db, row: Pick<SummaryRow, 'originalSourceId' | 'originalThreadId'>): Promise<string | null> {
  if (row.originalSourceId) {
    const { rows } = await db.query<{ text: string }>(
      `SELECT v.text_content AS text FROM sources s JOIN source_versions v ON v.source_id = s.id
        WHERE s.id = $1 AND ${liveSourceSql('s')} ORDER BY v.version_no DESC LIMIT 1`,
      [row.originalSourceId],
    );
    return rows[0]?.text ?? null;
  }
  const { rows } = await db.query<{ no: number; authorName: string; at: Date; body: string }>(
    `SELECT m.message_no AS no, u.display_name AS "authorName", m.created_at AS at, v.body
       FROM discussion_messages m
       JOIN LATERAL (SELECT body FROM message_versions WHERE message_id = m.id ORDER BY version_no DESC LIMIT 1) v ON true
       JOIN users u ON u.id = m.author_id
      WHERE m.thread_id = $1 AND m.state = 'visible'
      ORDER BY m.message_no`,
    [row.originalThreadId],
  );
  return rows.map((m) => `${headerOf(m)}\n${m.body}`).join('\n\n');
}

/** "everyone on the project", or the Restricted audience in words with the named people's display names. */
async function audienceDescription(db: Db, a: AudienceChange): Promise<string> {
  if (a.mode === 'project') return 'everyone on the project';
  const names = a.namedUserIds.length
    ? (await db.query<{ name: string }>(`SELECT display_name AS name FROM users WHERE id = ANY($1::uuid[]) ORDER BY display_name, id`, [a.namedUserIds])).rows.map((r) => r.name)
    : [];
  return `the Project Manager, Deputies, Owner and Sponsors${names.length ? `, and named participants: ${names.join(', ')}` : ''}`;
}

/** The display names of the project's members (any membership not revoked), for the name marks. */
async function memberNames(db: Db, projectId: string): Promise<string[]> {
  const { rows } = await db.query<{ name: string }>(
    `SELECT DISTINCT u.display_name AS name FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.project_id = $1 AND m.revoked_at IS NULL`,
    [projectId],
  );
  return rows.map((r) => r.name).filter((n) => n.trim() !== '');
}

/** Stores the marks of a new version: each Leave out phrase and member name found in it, once per phrase and kind. */
async function writeMarks(db: Db, versionId: string, body: string, leaveOut: string, projectId: string): Promise<void> {
  const found = findMarks(body, parseLeaveOut(leaveOut), await memberNames(db, projectId));
  const unique = new Map<string, { phrase: string; kind: MarkKind }>();
  for (const m of found) unique.set(`${m.kind}\n${m.phrase}`, { phrase: m.phrase, kind: m.kind });
  for (const m of unique.values()) {
    await db.query(`INSERT INTO summary_marks (version_id, phrase, kind) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [versionId, m.phrase, m.kind]);
  }
}

/** The summary a request was made for, through its `summary_requested` event written at the request's own time. */
export async function summaryOfRequest(db: Db, request: Pick<AssistRequest, 'id' | 'projectId' | 'createdAt'>): Promise<string | undefined> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT e.target_id AS id FROM ai_assist_events e
      WHERE e.project_id = $2 AND e.at = $3 AND e.action = 'summary_requested' AND e.target_kind = 'summary' AND e.detail->>'requestId' = $1::text`,
    [request.id, request.projectId, request.createdAt],
  );
  return rows[0]?.id;
}

/**
 * A summary's prompt: the standing rules, the Leave out text and the audience in the system part; only the original's
 * text in the user part. Built from the original as it is now (a message hidden since the request is not sent). The
 * requester must still hold a role that may request summaries and still be in the original's audience, judged at job
 * start (`at`), so a role that ended while the request waited stops it before any AI call.
 */
export async function summaryInput(db: Db, request: AssistRequest, _material: RequestMaterial[], at: Date): Promise<AssistInput | Refusal> {
  const id = await summaryOfRequest(db, request);
  const row = id ? await loadSummaryRow(db, id) : undefined;
  if (!row) return { code: 'summary_not_found', detail: 'The summary for this request was not found, so nothing was sent to the AI.' };
  const user = (await db.query(`SELECT id, email, display_name AS "displayName", role FROM users WHERE id = $1`, [request.requestedBy])).rows[0] as AuthUser | undefined;
  const ctx = user ? await new ProjectAccess(db as unknown as Pool, () => at).load(request.projectId, user, db as PoolClient) : null;
  if (ctx && !allowed(ctx, 'summary.request')) {
    return { code: 'requester_cannot_request', detail: 'The person who asked can no longer request a summary, so nothing was sent to the AI.' };
  }
  if (!(await summaryVisible(db, ctx, row))) {
    return { code: 'requester_not_in_audience', detail: 'The person who asked can no longer read the original, so nothing was sent to the AI.' };
  }
  const text = await originalText(db, row);
  if (text === null) return { code: 'original_removed', detail: 'The original was deleted, so nothing was sent to the AI.' };
  if (text.trim() === '') return { code: 'nothing_to_summarise', detail: 'There was nothing left to summarise, so nothing was sent to the AI.' };
  if (text.length > MAX_SUMMARY_INPUT) return { code: 'too_long', detail: row.originalSourceId ? TOO_LONG_SOURCE : TOO_LONG_MEETING };
  return { system: SUMMARY_SYSTEM(row.leaveOut, await audienceDescription(db, row.intendedAudience)), user: text };
}

/**
 * Writes the AI version with the omitted categories, and its marks. A summary withdrawn or hidden while the AI call
 * ran gets no new version (the request still ends as the runner decides, and nothing is shown).
 */
export async function completeSummary(db: PoolClient, request: AssistRequest, output: unknown, at: Date): Promise<void> {
  const id = await summaryOfRequest(db, request);
  if (!id) throw new Error(`assist ${request.id}: no summary for this request`);
  const row = (await loadSummaryRow(db, id, true)) as SummaryRow;
  if (row.state === 'withdrawn' || row.state === 'hidden') return;
  const o = output as SummaryOutput;
  const body = o.summary_markdown.trim();
  if (body.length > MAX_SUMMARY_BODY) {
    throw new CompletionRefused('summary_too_long', `The summary would be longer than ${MAX_SUMMARY_BODY.toLocaleString('en-US')} characters, so nothing was kept.`);
  }
  const no = Number((await db.query(`SELECT coalesce(max(version_no), 0) AS n FROM summary_versions WHERE summary_id = $1`, [row.id])).rows[0].n) + 1;
  const versionId = uuidv7(at.getTime());
  await db.query(
    `INSERT INTO summary_versions (id, summary_id, version_no, origin, body, request_id, omitted_categories, created_by, created_at)
     VALUES ($1, $2, $3, 'ai', $4, $5, $6, $7, $8)`,
    [versionId, row.id, no, body, request.id, o.omitted_categories.map((c) => c.trim()).filter((c) => c !== ''), request.requestedBy, at],
  );
  await writeMarks(db, versionId, body, row.leaveOut, row.projectId);
}

/** A summary withdrawn or hidden while its request waited: the AI is not called and nothing is charged. */
export async function summaryRemoved(db: Db, request: AssistRequest): Promise<boolean> {
  const id = await summaryOfRequest(db, request);
  if (!id) return false;
  const state = (await db.query<{ state: SummaryState }>(`SELECT state FROM summaries WHERE id = $1`, [id])).rows[0]?.state;
  return state === 'withdrawn' || state === 'hidden';
}

registerInputBuilder('summary', summaryInput);
registerCompletion('summary', completeSummary);
registerRemovedCheck('summary', summaryRemoved);

// ---------------------------------------------------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------------------------------------------------

export type SummaryStatus = 'queued' | 'running' | 'ready' | 'failed' | 'blocked';

/**
 * A mark's id in routes: opaque (no phrase or name in URLs or logs), derived from the mark row's identity (version,
 * kind, phrase), so it names one mark of one version.
 */
export const markIdOf = (versionId: string, kind: MarkKind, phrase: string) => sha256Hex(`${versionId}\n${kind}\n${phrase}`).slice(0, 32);

export interface MarkView {
  id: string;
  phrase: string;
  kind: MarkKind;
  /** Where it appears in the version's text (each place). */
  places: { start: number; end: number }[];
  intended: boolean;
  intendedBy: Person | null;
  intendedAt: Date | null;
}

export interface SummaryVersionView {
  id: string;
  no: number;
  origin: 'ai' | 'human';
  createdBy: Person | null;
  editedByLabel: string | null;
  createdAt: Date;
  /** This is the version the wider audience now reads. */
  approved: boolean;
  label: typeof SUMMARY_DRAFT_LABEL | typeof SUMMARY_APPROVED_LABEL;
}

export interface SummaryView {
  /** The full view, for people in the original's audience. */
  view: 'full';
  id: string;
  projectId: string;
  /** The original, for people in its audience (the only people who see this view). */
  original: { kind: 'source' | 'meeting'; id: string; title: string };
  intendedAudience: { mode: 'project' | 'restricted'; namedUsers: Person[]; covers: Person[] };
  leaveOut: string;
  state: SummaryState;
  label: typeof SUMMARY_DRAFT_LABEL | typeof SUMMARY_APPROVED_LABEL;
  status: SummaryStatus;
  unavailableReason: string | null;
  notice: string | null;
  approved: { versionNo: number; by: Person; at: Date; sourceId: string | null } | null;
  requestedBy: Person;
  createdAt: Date;
  versions: SummaryVersionView[];
  current: (SummaryVersionView & { body: string; omittedCategories: string[]; marks: MarkView[]; openMarks: number; approvalRequested: boolean }) | null;
  canEdit: boolean;
  canMarkIntended: boolean;
  canAskApproval: boolean;
  /** PM, Owner or Sponsor, on a version with every mark removed or intended and not yet approved. */
  canApprove: boolean;
  /** For those who may approve: the version, the audience, and exactly who gains access by approving it. */
  approval: { versionNo: number; audience: 'project' | 'restricted'; gainAccess: Person[] } | null;
  /** "Access review required" with its reason, for PM, Owner and Sponsor while in review or hidden (spec 7.3). */
  reviewLabel: typeof SUMMARY_REVIEW_LABEL | null;
  reviewReason: string | null;
  /** PM, Owner or Sponsor, while in review or hidden: Confirm or Withdraw (any project state). */
  canReview: boolean;
}

/**
 * What the summary's wider audience sees at /summaries/:id while it is approved or in an access review (spec 7.2):
 * the approved text and its labels only. Never a draft, a mark, the Leave out text, omitted categories, or the
 * original's title or link.
 */
export interface SharedSummaryView {
  view: 'shared';
  id: string;
  projectId: string;
  label: typeof SUMMARY_APPROVED_LABEL;
  approved: string;
  from: typeof FROM_RESTRICTED_LABEL;
  sourceId: string;
  body: string;
}

export interface SummaryListItem {
  id: string;
  original: { kind: 'source' | 'meeting'; id: string; title: string };
  state: SummaryState;
  label: string;
  requestedBy: Person;
  createdAt: Date;
  latestVersionNo: number | null;
  openMarks: number;
  approvalRequested: boolean;
  /** Why an access review is needed, in plain words; null for a draft. */
  reason: string | null;
}

interface VersionRow {
  id: string;
  no: number;
  origin: 'ai' | 'human';
  body: string;
  omittedCategories: string[];
  createdById: string | null;
  createdByName: string | null;
  createdAt: Date;
}

async function versionRows(db: Db, summaryId: string): Promise<VersionRow[]> {
  const { rows } = await db.query(
    `SELECT v.id, v.version_no AS no, v.origin, v.body, v.omitted_categories AS "omittedCategories", v.created_by AS "createdById",
            u.display_name AS "createdByName", v.created_at AS "createdAt"
       FROM summary_versions v LEFT JOIN users u ON u.id = v.created_by WHERE v.summary_id = $1 ORDER BY v.version_no`,
    [summaryId],
  );
  return rows as VersionRow[];
}

interface LatestRequest {
  status: RequestStatus;
  failureCode: string | null;
  failureDetail: string | null;
}

async function latestRequest(db: Db, summaryId: string): Promise<LatestRequest | undefined> {
  const { rows } = await db.query(
    `SELECT r.status, r.failure_code AS "failureCode", r.failure_detail AS "failureDetail"
       FROM ai_assist_events e JOIN ai_requests r ON r.id = (e.detail->>'requestId')::uuid
      WHERE e.target_kind = 'summary' AND e.target_id = $1 AND e.action = 'summary_requested'
      ORDER BY (r.status IN ('queued', 'running')) DESC, e.at DESC, e.id DESC LIMIT 1`,
    [summaryId],
  );
  return rows[0] as LatestRequest | undefined;
}

const statusOf = (r: LatestRequest | undefined): SummaryStatus => (!r || r.status === 'succeeded' ? 'ready' : r.status);

async function marksOf(db: Db, versionId: string, body: string): Promise<MarkView[]> {
  const { rows } = await db.query<{ phrase: string; kind: MarkKind; intendedById: string | null; intendedByName: string | null; intendedAt: Date | null }>(
    `SELECT k.phrase, k.kind, k.intended_by AS "intendedById", u.display_name AS "intendedByName", k.intended_at AS "intendedAt"
       FROM summary_marks k LEFT JOIN users u ON u.id = k.intended_by WHERE k.version_id = $1 ORDER BY k.kind, k.phrase`,
    [versionId],
  );
  return rows.map((r) => {
    const places: Mark[] = findMarks(body, r.kind === 'leave_out' ? [r.phrase] : [], r.kind === 'name' ? [r.phrase] : []);
    return {
      id: markIdOf(versionId, r.kind, r.phrase),
      phrase: r.phrase,
      kind: r.kind,
      places: places.map((p) => ({ start: p.start, end: p.end })),
      intended: r.intendedById !== null,
      intendedBy: r.intendedById ? { id: r.intendedById, displayName: r.intendedByName ?? '' } : null,
      intendedAt: r.intendedAt,
    };
  });
}

async function approvalRequested(db: Db, summaryId: string, versionNo: number): Promise<boolean> {
  const { rowCount } = await db.query(
    `SELECT 1 FROM ai_assist_events WHERE target_kind = 'summary' AND target_id = $1 AND action = 'summary_approval_requested' AND (detail->>'versionNo')::int = $2 LIMIT 1`,
    [summaryId, versionNo],
  );
  return (rowCount ?? 0) > 0;
}

const allowed = (ctx: ProjectContext, action: 'summary.request' | 'summary.approve' | 'summary.review') =>
  ctx.roles.length > 0 && decide({ action, roles: ctx.roles, status: ctx.project.status }).allowed;

const changeableState = (s: SummaryState) => s === 'draft' || s === 'approved';
const inReview = (s: SummaryState) => s === 'review_required' || s === 'hidden';
const reviewReasonText = (code: string | null) => (code && SUMMARY_REVIEW_REASONS[code as SummaryReviewCause]) || null;

/** Everyone among the project's current readers who would be in the audience `change` (spec 7.1: shown with the people it covers). */
async function coveredBy(db: Db, ctx: ProjectContext, change: AudienceChange): Promise<Person[]> {
  const ids = new Set<string>([...ctx.rows.map((r) => r.userId), ...ctx.grants.map((g) => g.userId)]);
  const { rows } = await db.query<Person>(`SELECT id, display_name AS "displayName" FROM users WHERE id = ANY($1::uuid[]) ORDER BY display_name, id`, [[...ids]]);
  const audience: AudienceRow = { id: '', projectId: ctx.project.id, mode: change.mode, namedUserIds: change.namedUserIds };
  return rows.filter((p) =>
    inAudience(
      {
        ...ctx,
        viewerId: p.id,
        isAdmin: false,
        roles: effectiveRoles(ctx.rows, p.id, ctx.today),
        grantKinds: [...new Set(ctx.grants.filter((g) => g.userId === p.id && grantGivesAccess(g, ctx.today, ctx.rows)).map((g) => g.kind))],
      },
      audience,
    ),
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------------------------------------------------

function cleanText(raw: unknown, max: number, message: string, required: boolean): string {
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    if (required) throw new BadRequestException(message);
    return '';
  }
  if (typeof raw !== 'string') throw new BadRequestException(message);
  let text: string;
  try {
    text = normaliseText(raw).trim();
  } catch (err) {
    if (err instanceof NoteTextError) throw new BadRequestException(message);
    throw err;
  }
  if ((required && text.length < 1) || text.length > max) throw new BadRequestException(message);
  if (text !== '') refuseSecrets(text);
  return text;
}

const versionNoOf = (raw: unknown, message: string): number => {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) throw new BadRequestException(message);
  return raw;
};

/** Shareable summaries of restricted sources (spec 7): drafting, editing, the leave-out marks, asking for approval and approval. */
@Injectable()
export class SummariesService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly now: Clock,
    @Inject(ASSIST_QUEUE) private readonly queue: AssistQueue,
    private readonly access: ProjectAccess,
    private readonly audiences: AudienceService,
    private readonly notes: NotesService,
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

  private async enqueue(id: string): Promise<void> {
    try {
      await this.queue.enqueue(id);
    } catch {
      await this.pool.query(
        `UPDATE ai_requests SET status = 'failed', failure_code = 'queue_unavailable', failure_detail = 'The summary could not be queued; request it again.', finished_at = $2
          WHERE id = $1 AND status = 'queued'`,
        [id, this.now()],
      );
    }
  }

  /** Draft shareable summary of a Restricted published note or minutes (spec 7.1). */
  async requestForSource(user: AuthUser, sourceId: string, body: { intendedAudience: unknown; leaveOut: unknown }): Promise<SummaryView> {
    return this.request(user, body, async (db) => {
      // 404 for anyone who may not see the source, before any 403.
      const { ctx: seen, row } = await this.audiences.assertSourceReadable(user, sourceId, db);
      if (row.kind === 'discussion') throw new NotFoundException();
      const ctx = await this.access.authorize(user, 'summary.request', seen.project.id, db);
      if (row.kind === 'summary') throw new ConflictException(NOT_A_SUMMARY_SOURCE);
      if (row.publication !== 'published') throw new ConflictException(NOT_PUBLISHED);
      const active = (await db.query(`SELECT 1 FROM sources s WHERE s.id = $1 AND ${liveSourceSql('s')}`, [sourceId])).rowCount;
      if (!active) throw new NotFoundException();
      if (row.audience.mode !== 'restricted') throw new ConflictException(NOT_RESTRICTED);
      return { ctx, original: { originalSourceId: sourceId, originalThreadId: null } };
    });
  }

  /** Draft shareable summary of a Restricted meeting, from its visible messages (spec 7.1). */
  async requestForThread(user: AuthUser, threadId: string, body: { intendedAudience: unknown; leaveOut: unknown }): Promise<SummaryView> {
    return this.request(user, body, async (db) => {
      if (!UUID.test(threadId)) throw new NotFoundException();
      const t = (
        await db.query<{ projectId: string; audienceId: string; kind: string }>(
          `SELECT project_id AS "projectId", audience_id AS "audienceId", kind FROM discussion_threads WHERE id = $1`,
          [threadId],
        )
      ).rows[0];
      if (!t) throw new NotFoundException();
      const audience = await this.audiences.load(t.audienceId, db);
      const seen = await this.access.load(t.projectId, user, db);
      if (!seen || !inAudience(seen, audience)) throw new NotFoundException();
      const ctx = await this.access.authorize(user, 'summary.request', t.projectId, db);
      if (t.kind !== 'meeting') throw new ConflictException(NOT_A_MEETING);
      if (audience.mode !== 'restricted') throw new ConflictException(NOT_RESTRICTED);
      return { ctx, original: { originalSourceId: null, originalThreadId: threadId } };
    });
  }

  private async request(
    user: AuthUser,
    body: { intendedAudience: unknown; leaveOut: unknown },
    find: (db: PoolClient) => Promise<{ ctx: ProjectContext; original: Pick<SummaryRow, 'originalSourceId' | 'originalThreadId'> }>,
  ): Promise<SummaryView> {
    const { id, requestId, ctx } = await this.inTransaction(async (db) => {
      const { ctx, original } = await find(db);
      const intended = parseAudienceChange(body.intendedAudience);
      // Named people must be in the project today, as for any audience.
      this.audiences.assertNamable(ctx, intended);
      const leaveOut = cleanText(body.leaveOut, MAX_LEAVE_OUT, BAD_LEAVE_OUT, false);
      // The input limit is checked now, so nothing is queued (or charged) for a source too long to send.
      const text = await originalText(db, original);
      if (text === null) throw new NotFoundException();
      if (text.trim() === '') throw new ConflictException(NOTHING_TO_SUMMARISE);
      if (text.length > MAX_SUMMARY_INPUT) throw new BadRequestException(original.originalSourceId ? TOO_LONG_SOURCE : TOO_LONG_MEETING);
      const at = this.now();
      const id = uuidv7(at.getTime());
      await db.query(
        `INSERT INTO summaries (id, project_id, original_source_id, original_thread_id, intended_audience, leave_out, created_by, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, ctx.project.id, original.originalSourceId, original.originalThreadId, intended, leaveOut, user.id, at],
      );
      const requestId = await createRequest(db, { projectId: ctx.project.id, kind: 'summary', requestedBy: user.id, scope: 'personal', material: [], at });
      // No Leave out text in the event row: its length and hash only.
      await db.query(
        `INSERT INTO ai_assist_events (id, project_id, actor_id, action, target_kind, target_id, detail, at) VALUES ($1, $2, $3, 'summary_requested', 'summary', $4, $5, $6)`,
        [
          uuidv7(at.getTime()),
          ctx.project.id,
          user.id,
          id,
          {
            requestId,
            original: original.originalSourceId ? 'source' : 'meeting',
            audience: intended.mode,
            named: intended.namedUserIds.length,
            inputLength: text.length,
            leaveOutLength: leaveOut.length,
            ...(leaveOut ? { leaveOutSha256: sha256Hex(leaveOut) } : {}),
          },
          at,
        ],
      );
      return { id, requestId, ctx };
    });
    await this.enqueue(requestId);
    return this.mustView(ctx, id);
  }

  /**
   * The full view for the original's audience; for the summary's wider audience, the approved summary only while it
   * is approved or in an access review (404 once hidden or withdrawn, and for everyone else).
   */
  async get(user: AuthUser, id: string): Promise<SummaryView | SharedSummaryView> {
    const row = await loadSummaryRow(this.pool, id);
    if (!row) throw new NotFoundException();
    const ctx = await this.access.load(row.projectId, user);
    if (!ctx) throw new NotFoundException();
    const full = await this.view(this.pool, ctx, id);
    if (full) return full;
    const shared = await this.sharedView(user, row);
    if (!shared) throw new NotFoundException();
    return shared;
  }

  /**
   * The approved summary for its wider audience: only while approved or in an access review (a hidden one is for the
   * original's audience, who get the full view), and only to someone the summary source's own check
   * (AudienceService.assertSourceReadable, the rule every source route uses) lets read it.
   */
  private async sharedView(user: AuthUser, row: SummaryRow): Promise<SharedSummaryView | undefined> {
    if ((row.state !== 'approved' && row.state !== 'review_required') || !row.summarySourceId || !row.approvedVersionId || !row.approvedAt) return undefined;
    try {
      await this.audiences.assertSourceReadable(user, row.summarySourceId);
    } catch (err) {
      if (err instanceof NotFoundException || err instanceof ForbiddenException) return undefined;
      throw err;
    }
    const r = (
      await this.pool.query<{ body: string; by: string | null }>(
        `SELECT v.body, u.display_name AS by FROM summary_versions v LEFT JOIN users u ON u.id = $2 WHERE v.id = $1`,
        [row.approvedVersionId, row.approvedBy],
      )
    ).rows[0];
    if (!r) return undefined;
    return {
      view: 'shared',
      id: row.id,
      projectId: row.projectId,
      label: SUMMARY_APPROVED_LABEL,
      approved: `Approved by ${r.by ?? 'someone'} on ${formatDay(row.approvedAt)}`,
      from: FROM_RESTRICTED_LABEL,
      sourceId: row.summarySourceId,
      body: r.body,
    };
  }

  /** One version's text, for comparing versions; the original's audience only. */
  async version(user: AuthUser, id: string, rawNo: string): Promise<SummaryVersionView & { body: string; omittedCategories: string[] }> {
    const row = await loadSummaryRow(this.pool, id);
    if (!row) throw new NotFoundException();
    const ctx = await this.access.load(row.projectId, user);
    if (!(await summaryVisible(this.pool, ctx, row))) throw new NotFoundException();
    const no = /^\d{1,9}$/.test(rawNo) ? Number(rawNo) : NaN;
    const v = (await versionRows(this.pool, row.id)).find((x) => x.no === no);
    if (!v) throw new NotFoundException();
    return { ...this.versionView(row, v), body: v.body, omittedCategories: v.omittedCategories };
  }

  /**
   * The summary, locked, for a change: 404 for anyone outside the original's audience, then 403 from the matrix, then
   * 409 when it is no longer a draft or an approved summary (in review, hidden or withdrawn).
   */
  private async changeable(db: PoolClient, user: AuthUser, id: string, action: 'summary.request' | 'summary.approve'): Promise<{ row: SummaryRow; ctx: ProjectContext }> {
    const row = await loadSummaryRow(db, id, true);
    if (!row) throw new NotFoundException();
    if (!(await summaryVisible(db, await this.access.load(row.projectId, user, db), row))) throw new NotFoundException();
    const ctx = await this.access.authorize(user, action, row.projectId, db);
    if (!changeableState(row.state)) throw new ConflictException(NOT_OPEN);
    return { row, ctx };
  }

  /**
   * Whether a message of the meeting that this version may be built from has been hidden or deleted since its drafting
   * began (spec 7.3, before approval): posted by the time this version was written (for a human version, its own time,
   * which covers everything the editor could have seen) and moderated after the earliest AI request in its chain of
   * versions. A message hidden before that request was never sent, so it does not count.
   */
  private async moderatedSince(db: PoolClient, threadId: string, versionId: string): Promise<boolean> {
    const { rowCount } = await db.query(
      `WITH RECURSIVE chain AS (
         SELECT id, edited_from_id, request_id, created_at FROM summary_versions WHERE id = $2
         UNION ALL
         SELECT v.id, v.edited_from_id, v.request_id, v.created_at FROM summary_versions v JOIN chain c ON v.id = c.edited_from_id
       )
       SELECT 1 FROM discussion_messages m
        WHERE m.thread_id = $1 AND m.state IN ('hidden', 'deleted')
          AND m.created_at <= (SELECT created_at FROM summary_versions WHERE id = $2)
          AND m.state_at > COALESCE((SELECT min(r.created_at) FROM chain c JOIN ai_requests r ON r.id = c.request_id), '-infinity'::timestamptz)
        LIMIT 1`,
      [threadId, versionId],
    );
    return (rowCount ?? 0) > 0;
  }

  /** The newest version, which must be the one the person was looking at; otherwise 409 with the summary as it is now. */
  private async latestAs(db: PoolClient, ctx: ProjectContext, row: SummaryRow, based: number): Promise<VersionRow> {
    const versions = await versionRows(db, row.id);
    const latest = versions[versions.length - 1];
    if (!latest) throw new ConflictException(NO_VERSION);
    if (latest.no !== based) {
      const current = await this.view(db, ctx, row.id);
      throw new ConflictException({ statusCode: 409, message: STALE_EDIT, error: 'Conflict', current });
    }
    return latest;
  }

  /** A human version (spec 7.2): up to 100,000 characters, secret check, refused when someone changed it since. Marks are found again. */
  async edit(user: AuthUser, id: string, body: { body: unknown; basedOnVersion: unknown }): Promise<SummaryView> {
    const ctx = await this.inTransaction(async (db) => {
      const { row, ctx } = await this.changeable(db, user, id, 'summary.request');
      const based = versionNoOf(body.basedOnVersion, BAD_BASE);
      const text = cleanText(body.body, MAX_SUMMARY_BODY, BAD_BODY, true);
      const latest = await this.latestAs(db, ctx, row, based);
      if (latest.body === text) throw new BadRequestException(UNCHANGED);
      const at = this.now();
      const versionId = uuidv7(at.getTime());
      await db.query(
        `INSERT INTO summary_versions (id, summary_id, version_no, origin, body, edited_from_id, created_by, created_at) VALUES ($1, $2, $3, 'human', $4, $5, $6, $7)`,
        [versionId, row.id, latest.no + 1, text, latest.id, user.id, at],
      );
      await writeMarks(db, versionId, text, row.leaveOut, row.projectId);
      await db.query(
        `INSERT INTO ai_assist_events (id, project_id, actor_id, action, target_kind, target_id, detail, at) VALUES ($1, $2, $3, 'summary_edited', 'summary', $4, $5, $6)`,
        [uuidv7(at.getTime()), row.projectId, user.id, row.id, { version: latest.no + 1, bodyLength: text.length, bodySha256: sha256Hex(text) }, at],
      );
      return ctx;
    });
    return this.mustView(ctx, id);
  }

  /** Ticks one mark of the newest version (which must be the version given) Intended (spec 7.2); recorded with the version, by whom and when. */
  async markIntended(user: AuthUser, id: string, markId: string, body: { versionNo: unknown }): Promise<SummaryView> {
    const ctx = await this.inTransaction(async (db) => {
      const { row, ctx } = await this.changeable(db, user, id, 'summary.request');
      // The version the person was looking at must still be the newest, so a tick lands only where it was seen.
      const latest = await this.latestAs(db, ctx, row, versionNoOf(body.versionNo, BAD_VERSION));
      const marks = await db.query<{ phrase: string; kind: MarkKind; intended: boolean }>(
        `SELECT phrase, kind, intended_by IS NOT NULL AS intended FROM summary_marks WHERE version_id = $1`,
        [latest.id],
      );
      const mark = marks.rows.find((m) => markIdOf(latest.id, m.kind, m.phrase) === markId);
      if (!mark) throw new NotFoundException();
      if (mark.intended) throw new ConflictException(MARK_ALREADY);
      await db.query(`UPDATE summary_marks SET intended_by = $4, intended_at = $5 WHERE version_id = $1 AND phrase = $2 AND kind = $3`, [
        latest.id,
        mark.phrase,
        mark.kind,
        user.id,
        this.now(),
      ]);
      return ctx;
    });
    return this.mustView(ctx, id);
  }

  /** The people told when approval is asked for: everyone holding PM, Owner or Sponsor today, except the one asking. */
  private approvers(ctx: ProjectContext, except: string): string[] {
    return [...new Set(ctx.rows.map((r) => r.userId))].filter(
      (id) => id !== except && effectiveRoles(ctx.rows, id, ctx.today).some((r) => r === 'pm' || r === 'owner' || r === 'sponsor'),
    );
  }

  /**
   * Ask for approval (spec 7.4): an explicit action by anyone who may request a summary (typically a Deputy). PM, Owner
   * and Sponsors get an in-app notice with the original's title only; recorded as `summary_approval_requested`.
   */
  async askApproval(user: AuthUser, id: string, body: { versionNo: unknown }): Promise<SummaryView & { notified: number }> {
    const { ctx, notified } = await this.inTransaction(async (db) => {
      const { row, ctx } = await this.changeable(db, user, id, 'summary.request');
      const latest = await this.latestAs(db, ctx, row, versionNoOf(body.versionNo, BAD_VERSION));
      if (row.approvedVersionId === latest.id) throw new ConflictException(ALREADY_APPROVED);
      const original = (await loadOriginal(db, row)) as Original;
      const at = this.now();
      const to = this.approvers(ctx, user.id);
      for (const userId of to) {
        await db.query(
          `INSERT INTO notifications (id, user_id, project_id, kind, summary, link, created_at, email_off) VALUES ($1, $2, $3, 'summary_approval_requested', $4, $5, $6, true)`,
          [uuidv7(at.getTime()), userId, row.projectId, `Shareable summary waiting for approval: ${original.title}`, `#/summaries/${row.id}`, at],
        );
      }
      await db.query(
        `INSERT INTO ai_assist_events (id, project_id, actor_id, action, target_kind, target_id, detail, at) VALUES ($1, $2, $3, 'summary_approval_requested', 'summary', $4, $5, $6)`,
        [uuidv7(at.getTime()), row.projectId, user.id, row.id, { versionNo: latest.no, notified: to.length }, at],
      );
      return { ctx, notified: to.length };
    });
    return { ...(await this.mustView(ctx, id)), notified };
  }

  /**
   * Approve (spec 7.2): PM, Owner or Sponsor in the original's audience, on the newest version with every mark removed
   * or ticked Intended, with a reason. The first approval publishes a `summary` source with its own audience (the
   * intended one); a later one adds a version to it. Its passages are indexed with the version.
   */
  async approve(user: AuthUser, id: string, body: { versionNo: unknown; reason: unknown }): Promise<SummaryView & { gainedAccess: Person[] }> {
    const { ctx, gained } = await this.inTransaction(async (db) => {
      const { row, ctx } = await this.changeable(db, user, id, 'summary.approve');
      const latest = await this.latestAs(db, ctx, row, versionNoOf(body.versionNo, BAD_VERSION));
      if (row.approvedVersionId === latest.id) throw new ConflictException(ALREADY_APPROVED);
      const open = Number((await db.query(`SELECT count(*) AS n FROM summary_marks WHERE version_id = $1 AND intended_by IS NULL`, [latest.id])).rows[0].n);
      if (open > 0) throw new ConflictException(MARKS_OPEN);
      if (row.originalThreadId && (await this.moderatedSince(db, row.originalThreadId, latest.id))) throw new ConflictException(MODERATED_SINCE);
      // An AI version is not checked when written, so the text approved for sharing is checked here (D79): kind only.
      refuseSecrets(latest.body);
      const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
      if (reason === '' || reason.length > MAX_REASON) throw new BadRequestException(REASON_REQUIRED);
      refuseSecrets(reason);
      const original = (await loadOriginal(db, row)) as Original;
      const target = await publishedAudience(db, row);
      const gained = (await this.audiences.preview(ctx, original.audience, target)).gain;
      const at = this.now();
      let sourceId = row.summarySourceId;
      if (!sourceId) {
        const audienceId = await this.audiences.create(db, row.projectId, row.intendedAudience, user);
        sourceId = uuidv7(at.getTime());
        await db.query(
          `INSERT INTO sources (id, title, created_by, created_at, project_id, publication, kind, audience_id, summary_id)
           VALUES ($1, $2, $3, $4, $5, 'published', 'summary', $6, $7)`,
          [sourceId, `Shareable summary — ${formatDay(at)}`, user.id, at, row.projectId, audienceId, row.id],
        );
      } else {
        await db.query(`SELECT 1 FROM sources WHERE id = $1 FOR UPDATE`, [sourceId]);
      }
      // The same text as the source's current version (an edit back to the approved wording) approves that text again,
      // with no new source version.
      const current = (
        await db.query<{ no: number; sha: string }>(
          `SELECT version_no AS no, text_sha256 AS sha FROM source_versions WHERE source_id = $1 ORDER BY version_no DESC LIMIT 1`,
          [sourceId],
        )
      ).rows[0];
      const sourceVersionNo =
        current && current.sha === sha256Hex(latest.body)
          ? current.no
          : (await this.notes.addVersionText(db, sourceId, latest.body, user.id, at, { summary: true })).versionNo;
      await db.query(
        `UPDATE summaries SET state = 'approved', summary_source_id = $2, approved_version_id = $3, approved_by = $4, approved_at = $5, review_reason = NULL WHERE id = $1`,
        [row.id, sourceId, latest.id, user.id, at],
      );
      await db.query(
        `INSERT INTO ai_assist_events (id, project_id, actor_id, action, target_kind, target_id, reason, detail, at) VALUES ($1, $2, $3, 'summary_approved', 'summary', $4, $5, $6, $7)`,
        [
          uuidv7(at.getTime()),
          row.projectId,
          user.id,
          row.id,
          reason,
          { versionNo: latest.no, versionId: latest.id, sourceId, sourceVersionNo, audience: target.mode, gained: gained.length },
          at,
        ],
      );
      return { ctx, gained };
    });
    return { ...(await this.mustView(ctx, id)), gainedAccess: gained };
  }

  /**
   * The summary in an access review, locked, for Confirm or Withdraw: 404 for anyone outside the original's audience,
   * then 403 unless PM, Owner or Sponsor (any project state: protective), then 409 when it is not in review or hidden.
   * A reason is required (up to 500 characters, secret check); it is recorded, never the summary text.
   */
  private async reviewing(db: PoolClient, user: AuthUser, id: string, rawReason: unknown): Promise<{ row: SummaryRow; ctx: ProjectContext; reason: string }> {
    const row = await loadSummaryRow(db, id, true);
    if (!row) throw new NotFoundException();
    if (!(await summaryVisible(db, await this.access.load(row.projectId, user, db), row))) throw new NotFoundException();
    const ctx = await this.access.authorize(user, 'summary.review', row.projectId, db);
    if (!inReview(row.state)) throw new ConflictException(NOT_IN_REVIEW);
    const reason = typeof rawReason === 'string' ? rawReason.trim() : '';
    if (reason === '' || reason.length > MAX_REASON) throw new BadRequestException(REASON_REQUIRED);
    refuseSecrets(reason);
    return { row, ctx, reason };
  }

  private async reviewEvent(db: PoolClient, row: SummaryRow, user: AuthUser, action: 'summary_confirmed' | 'summary_withdrawn', reason: string, at: Date) {
    await db.query(
      `INSERT INTO ai_assist_events (id, project_id, actor_id, action, target_kind, target_id, reason, detail, at) VALUES ($1, $2, $3, $4, 'summary', $5, $6, $7, $8)`,
      [uuidv7(at.getTime()), row.projectId, user.id, action, row.id, reason, { from: row.state, cause: row.reviewReason }, at],
    );
  }

  /**
   * Confirm (spec 7.3): back to approved, the label cleared; a hidden summary is visible to its wider audience again.
   * Answers and drafts already withdrawn or sent to review because of it are not brought back.
   */
  async confirm(user: AuthUser, id: string, body: { reason: unknown }): Promise<SummaryView> {
    const ctx = await this.inTransaction(async (db) => {
      const { row, ctx, reason } = await this.reviewing(db, user, id, body.reason);
      const at = this.now();
      await db.query(`UPDATE summaries SET state = 'approved', review_reason = NULL WHERE id = $1`, [row.id]);
      await this.reviewEvent(db, row, user, 'summary_confirmed', reason, at);
      return ctx;
    });
    return this.mustView(ctx, id);
  }

  /**
   * Withdraw (spec 7.3): the summary source is no longer readable through notes, search or material, and answers and
   * drafts that used it are removed material (private ones withdrawn, shared ones to review). Kept in history.
   * Locks: the summary row, then (in the hook) answers and drafts.
   */
  async withdraw(user: AuthUser, id: string, body: { reason: unknown }): Promise<SummaryView> {
    const ctx = await this.inTransaction(async (db) => {
      const { row, ctx, reason } = await this.reviewing(db, user, id, body.reason);
      const at = this.now();
      await db.query(`UPDATE summaries SET state = 'withdrawn', review_reason = NULL WHERE id = $1`, [row.id]);
      await this.reviewEvent(db, row, user, 'summary_withdrawn', reason, at);
      if (row.summarySourceId) await onMaterialRemoved(db, { sourceIds: [row.summarySourceId] }, 'summary_withdrawn', at);
      return ctx;
    });
    return this.mustView(ctx, id);
  }

  /**
   * Summaries to review (spec 7.2, 10): for PM, Owner and Sponsor, the project's summaries in their original's audience
   * that are drafts with a version, or that need an access review. Titles and states only.
   */
  async toReview(user: AuthUser, projectId: string): Promise<SummaryListItem[]> {
    const ctx = await this.access.authorize(user, 'summary.review', projectId);
    const { rows } = await this.pool.query(
      `SELECT ${SUMMARY_ROW}, u.display_name AS "byName",
              (SELECT max(v.version_no) FROM summary_versions v WHERE v.summary_id = sm.id) AS "latestNo"
         FROM summaries sm JOIN users u ON u.id = sm.created_by
        WHERE sm.project_id = $1 AND sm.state IN ('draft', 'review_required', 'hidden')
        ORDER BY sm.created_at DESC, sm.id DESC LIMIT 200`,
      [projectId],
    );
    const out: SummaryListItem[] = [];
    for (const r of rows as Array<SummaryRow & { byName: string; latestNo: number | null }>) {
      if (r.state === 'draft' && r.latestNo === null) continue;
      const original = await loadOriginal(this.pool, r);
      if (!original || !inAudience(ctx, original.audience)) continue;
      const versions = r.latestNo === null ? [] : await versionRows(this.pool, r.id);
      const latest = versions[versions.length - 1];
      const open = latest ? Number((await this.pool.query(`SELECT count(*) AS n FROM summary_marks WHERE version_id = $1 AND intended_by IS NULL`, [latest.id])).rows[0].n) : 0;
      out.push({
        id: r.id,
        original: { kind: original.kind, id: original.id, title: original.title },
        state: r.state,
        label: r.state === 'draft' ? SUMMARY_DRAFT_LABEL : SUMMARY_REVIEW_LABEL,
        requestedBy: { id: r.createdBy, displayName: r.byName },
        createdAt: r.createdAt,
        latestVersionNo: latest?.no ?? null,
        openMarks: open,
        approvalRequested: latest ? await approvalRequested(this.pool, r.id, latest.no) : false,
        reason: r.state === 'draft' ? null : reviewReasonText(r.reviewReason),
      });
    }
    return out;
  }

  private versionView(row: SummaryRow, v: VersionRow): SummaryVersionView {
    const approved = row.approvedVersionId === v.id;
    return {
      id: v.id,
      no: v.no,
      origin: v.origin,
      createdBy: v.createdById ? { id: v.createdById, displayName: v.createdByName ?? '' } : null,
      editedByLabel: v.origin === 'human' ? `Edited by ${v.createdByName ?? 'someone'}` : null,
      createdAt: v.createdAt,
      approved,
      label: approved ? SUMMARY_APPROVED_LABEL : SUMMARY_DRAFT_LABEL,
    };
  }

  /** The summary for someone in the original's audience, or undefined for anyone else. */
  private async view(db: Db, ctx: ProjectContext, id: string): Promise<SummaryView | undefined> {
    const row = await loadSummaryRow(db, id);
    if (!row || !(await summaryVisible(db, ctx, row))) return undefined;
    const original = (await loadOriginal(db, row)) as Original;
    const latestReq = await latestRequest(db, row.id);
    const status = statusOf(latestReq);
    const ended = status === 'failed' || status === 'blocked';
    const reason = ended && latestReq ? summaryReason(latestReq.failureCode, latestReq.failureDetail) : null;
    const versions = await versionRows(db, row.id);
    const last = versions[versions.length - 1];
    const people = async (ids: string[]) => this.audiences.people(ids, db as Pool);
    const open = changeableState(row.state);
    const mayRequest = open && allowed(ctx, 'summary.request');
    const mayApprove = open && allowed(ctx, 'summary.approve');
    let current: SummaryView['current'] = null;
    if (last) {
      const marks = await marksOf(db, last.id, last.body);
      current = {
        ...this.versionView(row, last),
        body: last.body,
        omittedCategories: last.omittedCategories,
        marks,
        openMarks: marks.filter((m) => !m.intended).length,
        approvalRequested: await approvalRequested(db, row.id, last.no),
      };
    }
    const approvedVersion = versions.find((v) => v.id === row.approvedVersionId);
    const approvable = mayApprove && current !== null && current.openMarks === 0 && !current.approved;
    const by = (await people([row.createdBy]))[0] ?? { id: row.createdBy, displayName: '' };
    const review = inReview(row.state) && allowed(ctx, 'summary.review');
    let approval: SummaryView['approval'] = null;
    if (mayApprove && current !== null && !current.approved) {
      const target = await publishedAudience(db, row);
      approval = { versionNo: current.no, audience: target.mode, gainAccess: (await this.audiences.preview(ctx, original.audience, target)).gain };
    }
    return {
      view: 'full',
      id: row.id,
      projectId: row.projectId,
      original: { kind: original.kind, id: original.id, title: original.title },
      intendedAudience: {
        mode: row.intendedAudience.mode,
        namedUsers: await people(row.intendedAudience.namedUserIds),
        covers: await coveredBy(db, ctx, row.intendedAudience),
      },
      leaveOut: row.leaveOut,
      state: row.state,
      label: current?.approved ? SUMMARY_APPROVED_LABEL : SUMMARY_DRAFT_LABEL,
      status,
      unavailableReason: reason,
      notice: ended ? `${SUMMARY_UNAVAILABLE_PREFIX}${reason}` : null,
      approved:
        approvedVersion && row.approvedBy && row.approvedAt
          ? { versionNo: approvedVersion.no, by: (await people([row.approvedBy]))[0], at: row.approvedAt, sourceId: row.summarySourceId }
          : null,
      requestedBy: by,
      createdAt: row.createdAt,
      versions: versions.map((v) => this.versionView(row, v)),
      current,
      canEdit: mayRequest && last !== undefined,
      canMarkIntended: mayRequest && current !== null && current.openMarks > 0,
      canAskApproval: mayRequest && current !== null && !current.approved,
      canApprove: approvable,
      approval,
      reviewLabel: review ? SUMMARY_REVIEW_LABEL : null,
      reviewReason: review ? reviewReasonText(row.reviewReason) : null,
      canReview: review,
    };
  }

  private async mustView(ctx: ProjectContext, id: string): Promise<SummaryView> {
    const view = await this.view(this.pool, ctx, id);
    if (!view) throw new NotFoundException();
    return view;
  }
}
