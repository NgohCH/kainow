import { BadRequestException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { writeAudit } from '../audit/audit';
import { toCsv, utc8Minute } from '../analytics/csv';
import { CLOCK, type AuthUser, type Clock } from '../auth/tokens';
import { UUID } from '../common/uuid7';
import { PG_POOL } from '../db/database.module';
import { DELETED_LINK, liveRecordSql } from '../history/deleted-sql';
import { type ProjectContext, ProjectAccess } from '../projects/access.service';
import { todayUtc8 } from '../projects/membership';
import { POSSIBLE_COPY_TEXT, UNDER_REVIEW_TEXT, possibleCopySql } from '../quarantine/labels';
import { KEPT_LABEL, NOT_KEPT, STORED_LABELS, filingFailedLabel } from './filing';
import { loadExportPolicy, mayExport } from './export-policy';
export { type ExportPolicy, loadExportPolicy, mayExport } from './export-policy';
import { isWholeProject, loadOutputAccessRow, readsOutput } from './readers';

/**
 * Project exports (D106, spec 7): a project's records as CSV, allowed when the organisation allows project exports,
 * the person may read the project's content, and one of their current roles (or Audit/Oversight grant kind) is among
 * the project's export roles. There is no matrix action for it: `mayExport` is the one check, made again when the
 * file is built.
 */

export const EXPORT_KINDS = ['tasks', 'decisions', 'questions', 'risks', 'outputs'] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];

export const EXPORTS_OFF = 'Project exports are turned off. An Enterprise Administrator can turn them on in Access and records settings.';
export const NOT_AN_EXPORT_ROLE = 'Your role in this project is not one of those allowed to export its records. A PM, Owner or Sponsor can change this in Project settings › Outputs.';
export const COVERAGE = 'All authorised records in the project except deleted ones and any under credential review';
/** A saved register export becomes a Project-wide output, so it holds only what every reader of the project may read. */
export const COVERAGE_SHARED = `${COVERAGE}. Restricted and unregistered outputs are omitted`;
const BAD_KIND = 'Choose what to export: tasks, decisions, questions, risks or outputs.';

/** Cut at this many characters per cell (spec 7.2). */
export const MAX_CELL = 2_000;

/** The columns of each export, exactly as spec 7.2 lists them. */
export const EXPORT_COLUMNS: Readonly<Record<ExportKind, readonly string[]>> = {
  tasks: ['id', 'parent id', 'title', 'assignee', 'assignee department', 'status', 'due date', 'next review', 'overdue (yes/no)', 'completed on', 'created on', 'authorised on'],
  decisions: ['id', 'statement', 'rationale', 'status', 'authorised on', 'replaced by'],
  questions: ['id', 'question', 'requester', 'status', 'answers (count)', 'resolved on'],
  risks: ['id', 'description', 'severity', 'status', 'responsible person', 'review date', 'accepted reason'],
  outputs: ['id', 'title', 'report type', 'categories', 'issue date', 'author', 'latest version', 'latest status', 'filing state', 'last check'],
};

const EXPORT_NAMES: Readonly<Record<ExportKind, string>> = { tasks: 'Tasks', decisions: 'Decisions', questions: 'Questions', risks: 'Risks', outputs: 'Output register' };

/** The screen filters an export may carry; each applies to the kinds noted. */
export interface ExportFilters {
  /** All kinds: the statuses to keep. */
  status?: string[];
  /** Tasks: one assignee. */
  assigneeId?: string;
  /** Tasks: only overdue ones. */
  overdue?: true;
  /** Risks: one severity. */
  severity?: string;
  /** Outputs: one report type (primary or additional). */
  reportTypeId?: string;
}

const STATUSES: Readonly<Record<ExportKind, readonly string[]>> = {
  tasks: ['not_started', 'in_progress', 'blocked', 'completed', 'cancelled'],
  decisions: ['active', 'superseded', 'withdrawn'],
  questions: ['open', 'answered', 'resolved', 'withdrawn'],
  risks: ['open', 'mitigating', 'resolved', 'accepted'],
  outputs: ['submitted', 'registered', 'declined'],
};
const SEVERITIES = ['low', 'medium', 'high', 'critical'];

export function parseExportKind(v: unknown): ExportKind {
  if (typeof v !== 'string' || !(EXPORT_KINDS as readonly string[]).includes(v)) throw new BadRequestException(BAD_KIND);
  return v as ExportKind;
}

/**
 * The filters from a query string or a request body (a status may be a list or a comma-separated text). Only filters
 * that apply to the kind are kept; a value that is not one of the choices is refused.
 */
export function parseExportFilters(kind: ExportKind, input: unknown): ExportFilters {
  const src = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const out: ExportFilters = {};
  const one = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);
  const status = Array.isArray(src.status) ? src.status : typeof src.status === 'string' && src.status.trim() !== '' ? src.status.split(',') : [];
  const wanted = [...new Set(status.map((s) => (typeof s === 'string' ? s.trim() : s)).filter((s) => s !== ''))];
  if (wanted.length > 0) {
    if (wanted.some((s) => typeof s !== 'string' || !STATUSES[kind].includes(s))) throw new BadRequestException(`Choose statuses from: ${STATUSES[kind].join(', ')}.`);
    out.status = STATUSES[kind].filter((s) => wanted.includes(s));
  }
  if (kind === 'tasks') {
    const assignee = one(src.assigneeId);
    if (assignee !== undefined) {
      if (!UUID.test(assignee)) throw new BadRequestException('Choose an assignee from the project’s people.');
      out.assigneeId = assignee;
    }
    if (src.overdue === true || src.overdue === 'yes' || src.overdue === 'true') out.overdue = true;
  }
  if (kind === 'risks') {
    const severity = one(src.severity);
    if (severity !== undefined) {
      if (!SEVERITIES.includes(severity)) throw new BadRequestException(`Choose a severity from: ${SEVERITIES.join(', ')}.`);
      out.severity = severity;
    }
  }
  if (kind === 'outputs') {
    const type = one(src.reportTypeId);
    if (type !== undefined) {
      if (!UUID.test(type)) throw new BadRequestException('Choose a report type from the list.');
      out.reportTypeId = type;
    }
  }
  return out;
}

/** 403 with the plain reason when the person may not export now. */
export async function assertMayExport(db: Pool | PoolClient, ctx: ProjectContext): Promise<void> {
  const policy = await loadExportPolicy(db, ctx.project.id);
  if (!policy.allowed) throw new ForbiddenException(EXPORTS_OFF);
  if (!mayExport(ctx, policy)) throw new ForbiddenException(NOT_AN_EXPORT_ROLE);
}

export interface BuiltExport {
  filename: string;
  csv: Buffer;
  rows: number;
}

const cut = (s: string): string => {
  const chars = Array.from(s);
  return chars.length > MAX_CELL ? chars.slice(0, MAX_CELL).join('') : s;
};
const words = (s: string): string => (s === '' ? '' : `${s[0].toUpperCase()}${s.slice(1).replace(/_/g, ' ')}`);
const day = (v: string | null): string => v ?? '';

/** The label that stands in place of a record's text while it is under review or a possible copy awaits its check. */
const labelSql = (alias: string, kind: 'task' | 'decision' | 'question' | 'risk'): string =>
  `CASE WHEN ${alias}.held_case_id IS NOT NULL THEN '${UNDER_REVIEW_TEXT}' WHEN ${possibleCopySql(kind, `${alias}.id`)} THEN '${POSSIBLE_COPY_TEXT}' END`;
const UTC8_DAY = (col: string): string => `to_char(${col} AT TIME ZONE 'Asia/Kuala_Lumpur', 'YYYY-MM-DD')`;

type Table = unknown[][];
type Query = { sql: string; params: unknown[] };

function statusClause(alias: string, filters: ExportFilters, params: unknown[]): string {
  if (!filters.status) return '';
  params.push(filters.status);
  return ` AND ${alias}.status = ANY($${params.length}::text[])`;
}

async function taskRows(db: Pool | PoolClient, projectId: string, filters: ExportFilters, at: Date): Promise<Table> {
  const params: unknown[] = [projectId];
  let where = statusClause('t', filters, params);
  if (filters.assigneeId) {
    params.push(filters.assigneeId);
    where += ` AND t.assignee_id = $${params.length}`;
  }
  const { rows } = await db.query(
    `SELECT t.id, t.parent_id AS "parentId", t.title, u.display_name AS assignee, t.status, to_char(t.due_on, 'YYYY-MM-DD') AS "dueOn",
            t.deadline_review_required AS "reviewRequired", ${UTC8_DAY('t.completed_at')} AS "completedOn", ${UTC8_DAY('t.authorised_at')} AS "authorisedOn",
            ${labelSql('t', 'task')} AS label
       FROM tasks t JOIN users u ON u.id = t.assignee_id
      WHERE t.project_id = $1 AND ${liveRecordSql('t')}${where}
      ORDER BY t.due_on, t.authorised_at, t.id`,
    params,
  );
  const today = todayUtc8(at);
  const out: Table = [];
  for (const r of rows) {
    const finished = r.status === 'completed' || r.status === 'cancelled';
    const overdue = !finished && !r.reviewRequired && today > r.dueOn;
    if (filters.overdue && !overdue) continue;
    // A task has no review date of its own and users have no department in Kainow: both columns stay empty.
    // Its creation is its authorisation: tasks are only ever made by authorising them.
    out.push([r.id, r.parentId ?? '', r.label ?? r.title, r.assignee, '', words(r.status), r.dueOn, '', overdue ? 'yes' : 'no', day(r.completedOn), r.authorisedOn, r.authorisedOn]);
  }
  return out;
}

async function decisionRows(db: Pool | PoolClient, projectId: string, filters: ExportFilters): Promise<Table> {
  const params: unknown[] = [projectId];
  const where = statusClause('d', filters, params);
  const { rows } = await db.query(
    `SELECT d.id, d.statement, d.rationale, d.status, ${UTC8_DAY('d.authorised_at')} AS "authorisedOn", ${labelSql('d', 'decision')} AS label,
            (SELECT json_build_object('id', n.id, 'live', ${liveRecordSql('n')}) FROM decisions n WHERE n.replaces_id = d.id
              ORDER BY n.authorised_at, n.id LIMIT 1) AS "replacedBy"
       FROM decisions d WHERE d.project_id = $1 AND ${liveRecordSql('d')}${where}
      ORDER BY d.authorised_at, d.id`,
    params,
  );
  return rows.map((r) => [r.id, r.label ?? r.statement, r.label ? r.label : (r.rationale ?? ''), words(r.status), r.authorisedOn, r.replacedBy ? (r.replacedBy.live ? r.replacedBy.id : DELETED_LINK) : '']);
}

async function questionRows(db: Pool | PoolClient, projectId: string, filters: ExportFilters): Promise<Table> {
  const params: unknown[] = [projectId];
  const where = statusClause('q', filters, params);
  const { rows } = await db.query(
    `SELECT q.id, q.text, u.display_name AS requester, q.status, ${labelSql('q', 'question')} AS label,
            (SELECT count(*)::int FROM question_answers a WHERE a.question_id = q.id) AS answers,
            (SELECT ${UTC8_DAY('e.at')} FROM record_events e WHERE e.record_kind = 'question' AND e.record_id = q.id AND e.kind = 'resolved' AND q.status = 'resolved'
              ORDER BY e.at DESC, e.id DESC LIMIT 1) AS "resolvedOn"
       FROM questions q JOIN users u ON u.id = q.requester_id
      WHERE q.project_id = $1 AND ${liveRecordSql('q')}${where}
      ORDER BY q.authorised_at, q.id`,
    params,
  );
  return rows.map((r) => [r.id, r.label ?? r.text, r.requester, words(r.status), r.answers, day(r.resolvedOn)]);
}

async function riskRows(db: Pool | PoolClient, projectId: string, filters: ExportFilters): Promise<Table> {
  const params: unknown[] = [projectId];
  let where = statusClause('r', filters, params);
  if (filters.severity) {
    params.push(filters.severity);
    where += ` AND r.severity = $${params.length}`;
  }
  const { rows } = await db.query(
    `SELECT r.id, r.description, r.severity, r.status, u.display_name AS responsible, to_char(r.review_on, 'YYYY-MM-DD') AS "reviewOn", ${labelSql('r', 'risk')} AS label,
            (SELECT e.note FROM record_events e WHERE e.record_kind = 'risk' AND e.record_id = r.id AND e.kind = 'accepted' AND r.status = 'accepted'
              ORDER BY e.at DESC, e.id DESC LIMIT 1) AS "acceptedReason"
       FROM risks r LEFT JOIN users u ON u.id = r.responsible_id
      WHERE r.project_id = $1 AND ${liveRecordSql('r')}${where}
      ORDER BY r.authorised_at, r.id`,
    params,
  );
  return rows.map((r) => [r.id, r.label ?? r.description, words(r.severity), words(r.status), r.responsible ?? '', day(r.reviewOn), r.label ? r.label : (r.acceptedReason ?? '')]);
}

/**
 * The register as this viewer reads it (a download is a personal view): not deleted, held or withdrawn, and only what
 * `readsOutput` lets them see. A `shared` export (saved as a Project-wide output) holds only outputs every reader of the
 * project may read: `isWholeProject`.
 */
async function outputRows(db: Pool | PoolClient, projectId: string, filters: ExportFilters, viewer: ProjectContext, shared: boolean, at: Date): Promise<Table> {
  const params: unknown[] = [projectId];
  let where = statusClause('o', filters, params);
  if (filters.reportTypeId) {
    params.push(filters.reportTypeId);
    where += ` AND (o.report_type_id = $${params.length} OR EXISTS (SELECT 1 FROM output_categories oc WHERE oc.output_id = o.id AND oc.report_type_id = $${params.length}))`;
  }
  const { rows } = await db.query<{ id: string; title: string; type: string | null; issueDate: string | null; author: string }>(
    `SELECT o.id, o.title, t.name AS type, to_char(o.issue_date, 'YYYY-MM-DD') AS "issueDate", u.display_name AS author
       FROM outputs o JOIN users u ON u.id = o.author_id LEFT JOIN report_types t ON t.id = o.report_type_id
      WHERE o.project_id = $1 AND o.deleted_at IS NULL AND o.held_case_id IS NULL AND o.status <> 'withdrawn'${where}
      ORDER BY o.issue_date DESC NULLS LAST, lower(o.title), o.id`,
    params,
  );
  const visible: typeof rows = [];
  for (const r of rows) {
    const access = await loadOutputAccessRow(db, r.id);
    if (!access) continue;
    if (shared ? await isWholeProject(db, r.id, at) : await readsOutput(db, viewer, access)) visible.push(r);
  }
  if (visible.length === 0) return [];
  const ids = visible.map((r) => r.id);
  const categories = new Map<string, string[]>();
  for (const c of (
    await db.query<{ id: string; name: string }>(
      `SELECT oc.output_id AS id, t.name FROM output_categories oc JOIN report_types t ON t.id = oc.report_type_id
        WHERE oc.output_id = ANY($1::uuid[]) ORDER BY oc.output_id, t.position, lower(t.name), t.id`,
      [ids],
    )
  ).rows) categories.set(c.id, [...(categories.get(c.id) ?? []), c.name]);
  const latest = new Map<string, { no: number; status: string; state: string | null; failure: string | null; check: string | null; checkedAt: Date | null; kept: boolean }>();
  for (const v of (
    await db.query(
      `SELECT DISTINCT ON (v.output_id) v.output_id AS id, v.version_no AS no, v.status, f.state, f.failure_code AS failure, f.check_status AS check,
              f.last_checked_at AS "checkedAt", (b.bytes IS NOT NULL) AS kept
         FROM output_versions v LEFT JOIN stored_files f ON f.id = v.stored_file_id LEFT JOIN output_version_bytes b ON b.output_version_id = v.id
        WHERE v.output_id = ANY($1::uuid[]) AND v.held_case_id IS NULL
        ORDER BY v.output_id, v.version_no DESC`,
      [ids],
    )
  ).rows) latest.set(v.id, v);
  return visible.map((o) => {
    const v = latest.get(o.id);
    let filing = '';
    if (v) {
      if ((!v.state || v.state === 'failed') && !v.kept) filing = NOT_KEPT;
      else if (!v.state) filing = 'Not filed';
      else if (v.state === 'failed') filing = filingFailedLabel(v.failure);
      else if (v.state === 'linked') filing = KEPT_LABEL;
      else filing = STORED_LABELS[v.state] ?? v.state;
    }
    const checked = v && (v.state === 'stored' || v.state === 'linked') && v.checkedAt ? utc8Minute(new Date(v.checkedAt).toISOString()) : '';
    return [o.id, o.title, o.type ?? '', (categories.get(o.id) ?? []).join('; '), day(o.issueDate), o.author, v ? v.no : '', v ? words(v.status) : '', filing, checked];
  });
}

/** The `Filters` line: what was chosen, in words, or that nothing was. */
async function describeFilters(db: Pool | PoolClient, projectId: string, f: ExportFilters): Promise<string> {
  const parts: string[] = [];
  if (f.status) parts.push(`status: ${f.status.map(words).join(', ')}`);
  if (f.assigneeId) parts.push(`assignee: ${(await db.query(`SELECT u.display_name FROM users u WHERE u.id = $1 AND EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = u.id AND m.project_id = $2)`, [f.assigneeId, projectId])).rows[0]?.display_name ?? f.assigneeId}`);
  if (f.overdue) parts.push('overdue only');
  if (f.severity) parts.push(`severity: ${words(f.severity)}`);
  if (f.reportTypeId) parts.push(`report type: ${(await db.query(`SELECT name FROM report_types WHERE id = $1`, [f.reportTypeId])).rows[0]?.name ?? f.reportTypeId}`);
  return parts.length > 0 ? parts.join('; ') : 'None (every record of this kind)';
}

/**
 * The CSV for one kind of record under the filters, for `viewer`: UTF-8 with a byte order mark, CRLF, `#` lines (Export,
 * Project, Filters, Computed at, Coverage), the formula guard, and cells cut at 2,000 characters. Deleted records and
 * those held and not yet cleaned are left out; a cleaned held record shows "Credential removed — under review" in place
 * of its text. Nothing here reads source text, message text, quotes or private AI questions. The caller checks
 * `mayExport` first and records `project.exported`.
 */
export async function buildExport(db: Pool | PoolClient, projectId: string, kind: ExportKind, filters: ExportFilters, viewer: ProjectContext, at: Date, opts: { shared?: boolean } = {}): Promise<BuiltExport> {
  const table =
    kind === 'tasks' ? await taskRows(db, projectId, filters, at)
    : kind === 'decisions' ? await decisionRows(db, projectId, filters)
    : kind === 'questions' ? await questionRows(db, projectId, filters)
    : kind === 'risks' ? await riskRows(db, projectId, filters)
    : await outputRows(db, projectId, filters, viewer, opts.shared === true, at);
  const project = (await db.query<{ name: string }>(`SELECT name FROM projects WHERE id = $1`, [projectId])).rows[0]?.name ?? '';
  const meta = {
    Export: EXPORT_NAMES[kind],
    Project: project,
    Filters: await describeFilters(db, projectId, filters),
    'Computed at': utc8Minute(at.toISOString()),
    Coverage: kind === 'outputs' && opts.shared ? COVERAGE_SHARED : COVERAGE,
  };
  const rows = table.map((r) => r.map((c) => (typeof c === 'string' ? cut(c) : c)));
  const text = toCsv(meta, [...EXPORT_COLUMNS[kind]], rows, { bom: true });
  return { filename: `kainow-${kind}-export-${todayUtc8(at)}.csv`, csv: Buffer.from(text, 'utf8'), rows: rows.length };
}

/** The audit event every export writes: what was exported, never the data. */
export async function recordExport(db: Pool | PoolClient, at: Date, actorId: string, projectId: string, kind: ExportKind, filters: ExportFilters, rows: number, extra: Record<string, unknown> = {}): Promise<void> {
  await writeAudit(db, { at, action: 'project.exported', actorUserId: actorId, subjectType: 'project', subjectId: projectId, detail: { projectId, kind, filters, rows, ...extra } });
}

export const defaultExportTitle = (kind: ExportKind, at: Date): string => `${EXPORT_NAMES[kind]} export ${todayUtc8(at)}`;

@Injectable()
export class ExportsService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly access: ProjectAccess,
  ) {}

  /** The file for a person who may export now (404 for a non-participant, 403 with the reason otherwise); the export is recorded. */
  /** 404 for a non-participant: checked before any request body is read. */
  async participant(user: AuthUser, projectId: string): Promise<void> {
    await this.access.context(user, projectId);
  }

  async download(user: AuthUser, projectId: string, query: unknown): Promise<BuiltExport> {
    const ctx = await this.access.context(user, projectId);
    const kind = parseExportKind((query as Record<string, unknown> | null)?.kind);
    const filters = parseExportFilters(kind, query);
    await assertMayExport(this.pool, ctx);
    const at = this.clock();
    const built = await buildExport(this.pool, projectId, kind, filters, ctx, at);
    await recordExport(this.pool, at, user.id, projectId, kind, filters, built.rows);
    return built;
  }
}
