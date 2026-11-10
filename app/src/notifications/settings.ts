// Notification settings: reading the effective values for a project (no Nest), and validating proposed changes.
import { BadRequestException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import type { Calendar, DayCounting } from './calendar';
import type { RiskSnap, TaskSnap, Timings } from './planner';
import type { RiskStatus } from '../records/lifecycles';
import type { TaskStatus } from '../records/tasks';

type Db = Pool | PoolClient;

export interface DigestSchedule { frequency: 'daily' | 'weekly'; weekday: number | null; time: string }
export type Source = 'organisation' | 'project';
export type SettingKey = 'dayCounting' | 'weekdays' | 'leadDays' | 'escalationDays';

export interface Effective {
  cal: Calendar;
  timings: Timings;
  sweepMinutes: number;
  sources: Record<SettingKey, Source>;
  delegation: { calendar: boolean; timings: boolean; digest: boolean };
  digest: DigestSchedule | null;
}

export interface OrgRow {
  dayCounting: DayCounting;
  weekdays: number[];
  leadDays: number[];
  escalationDays: number;
  sweepMinutes: number;
  projectsMayChangeCalendar: boolean;
  projectsMayChangeTimings: boolean;
  projectsMayChangeDigest: boolean;
}

export interface ProjectRow {
  dayCounting: DayCounting | null;
  weekdays: number[] | null;
  leadDays: number[] | null;
  escalationDays: number | null;
  digestEnabled: boolean;
  digestFrequency: 'daily' | 'weekly' | null;
  digestWeekday: number | null;
  digestTime: string | null;
}

export const EMPTY_PROJECT: ProjectRow = {
  dayCounting: null, weekdays: null, leadDays: null, escalationDays: null,
  digestEnabled: false, digestFrequency: null, digestWeekday: null, digestTime: null,
};

export const NOT_ALLOWED = 'The Administrator has not allowed projects to change this setting.';
export const MSG = {
  reason: 'Write a reason for the change.',
  leadRange: 'Each reminder must be 1–30 days before the due date.',
  leadCount: 'At most 3 reminders, each on a different day.',
  escalation: 'The escalation delay must be 1–10 days.',
  sweep: 'The sweep interval must be 5–60 minutes.',
  weekdays: 'Choose at least one working weekday.',
  dayCounting: 'Choose working days or calendar days.',
  flag: 'Say yes or no for each switch.',
  digestFrequency: 'Choose daily or weekly digests.',
  digestWeekday: 'Choose the weekday for the weekly digest.',
  digestTime: 'Choose the digest time as HH:MM.',
  nothing: 'Choose a setting to change.',
};

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const asc = (a: number[]) => [...a].sort((x, y) => x - y);
const desc = (a: number[]) => [...a].sort((x, y) => y - x);

export function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function weekdaysOf(v: unknown): number[] {
  if (!Array.isArray(v) || v.length < 1 || v.length > 7 || !v.every((d) => isInt(d) && d >= 1 && d <= 7) || new Set(v).size !== v.length) {
    throw new BadRequestException(MSG.weekdays);
  }
  return asc(v as number[]);
}
function leadDaysOf(v: unknown): number[] {
  if (!Array.isArray(v) || !v.every((d) => isInt(d) && d >= 1 && d <= 30)) throw new BadRequestException(MSG.leadRange);
  if (v.length < 1 || v.length > 3 || new Set(v).size !== v.length) throw new BadRequestException(MSG.leadCount);
  return desc(v as number[]);
}
function escalationOf(v: unknown): number {
  if (!isInt(v) || v < 1 || v > 10) throw new BadRequestException(MSG.escalation);
  return v;
}
function sweepOf(v: unknown): number {
  if (!isInt(v) || v < 5 || v > 60) throw new BadRequestException(MSG.sweep);
  return v;
}
function countingOf(v: unknown): DayCounting {
  if (v !== 'working' && v !== 'calendar') throw new BadRequestException(MSG.dayCounting);
  return v;
}
function flagOf(v: unknown): boolean {
  if (typeof v !== 'boolean') throw new BadRequestException(MSG.flag);
  return v;
}

const ORG_PARSERS: Record<keyof OrgRow, (v: unknown) => unknown> = {
  dayCounting: countingOf, weekdays: weekdaysOf, leadDays: leadDaysOf, escalationDays: escalationOf, sweepMinutes: sweepOf,
  projectsMayChangeCalendar: flagOf, projectsMayChangeTimings: flagOf, projectsMayChangeDigest: flagOf,
};

const nullable = <T>(f: (v: unknown) => T) => (v: unknown): T | null => (v === null ? null : f(v));
const PROJECT_PARSERS: Record<keyof ProjectRow, (v: unknown) => unknown> = {
  dayCounting: nullable(countingOf), weekdays: nullable(weekdaysOf), leadDays: nullable(leadDaysOf), escalationDays: nullable(escalationOf),
  digestEnabled: flagOf,
  digestFrequency: nullable((v) => { if (v !== 'daily' && v !== 'weekly') throw new BadRequestException(MSG.digestFrequency); return v; }),
  digestWeekday: nullable((v) => { if (!isInt(v) || v < 1 || v > 7) throw new BadRequestException(MSG.digestWeekday); return v; }),
  digestTime: nullable((v) => { if (typeof v !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) throw new BadRequestException(MSG.digestTime); return v; }),
};

function parse<T>(raw: unknown, parsers: Record<string, (v: unknown) => unknown>): Partial<T> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new BadRequestException(MSG.nothing);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const p = Object.hasOwn(parsers, k) ? parsers[k] : undefined;
    if (!p) throw new BadRequestException(`Unknown setting: ${k.slice(0, 40)}`);
    out[k] = p(v);
  }
  if (Object.keys(out).length === 0) throw new BadRequestException(MSG.nothing);
  return out as Partial<T>;
}
export const parseOrgChanges = (raw: unknown): Partial<OrgRow> => parse<OrgRow>(raw, ORG_PARSERS);
export const parseProjectChanges = (raw: unknown): Partial<ProjectRow> => parse<ProjectRow>(raw, PROJECT_PARSERS);

/** Applies project changes and checks the digest group is consistent as a whole. */
export function applyProject(cur: ProjectRow, changes: Partial<ProjectRow>): ProjectRow {
  const next: ProjectRow = { ...cur, ...changes };
  if (next.digestEnabled) {
    if (!next.digestFrequency) throw new BadRequestException(MSG.digestFrequency);
    if (!next.digestTime) throw new BadRequestException(MSG.digestTime);
    if (next.digestFrequency === 'weekly' && next.digestWeekday === null) throw new BadRequestException(MSG.digestWeekday);
    if (next.digestFrequency === 'daily') next.digestWeekday = null;
  }
  return next;
}

export const GROUP_OF: Record<keyof ProjectRow, 'calendar' | 'timings' | 'digest'> = {
  dayCounting: 'calendar', weekdays: 'calendar', leadDays: 'timings', escalationDays: 'timings',
  digestEnabled: 'digest', digestFrequency: 'digest', digestWeekday: 'digest', digestTime: 'digest',
};

export const snake = (k: string): string => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
/** Value as stored in the change history: text, arrays as JSON. */
export const historyText = (v: unknown): string | null => (v === null || v === undefined ? null : Array.isArray(v) ? JSON.stringify(v) : String(v));

const toNums = (a: unknown): number[] => (a as (number | string)[]).map(Number);

export async function loadOrgRow(db: Db, lock = false): Promise<OrgRow> {
  const { rows } = await db.query(
    `SELECT day_counting AS "dayCounting", weekdays, lead_days AS "leadDays", escalation_days AS "escalationDays", sweep_minutes AS "sweepMinutes",
            projects_may_change_calendar AS "projectsMayChangeCalendar", projects_may_change_timings AS "projectsMayChangeTimings",
            projects_may_change_digest AS "projectsMayChangeDigest"
       FROM notification_settings WHERE id = 1 ${lock ? 'FOR UPDATE' : ''}`,
  );
  const r = rows[0];
  return { ...r, weekdays: asc(toNums(r.weekdays)), leadDays: desc(toNums(r.leadDays)) };
}

export async function loadProjectRow(db: Db, projectId: string, lock = false): Promise<ProjectRow> {
  const { rows } = await db.query(
    `SELECT day_counting AS "dayCounting", weekdays, lead_days AS "leadDays", escalation_days AS "escalationDays",
            digest_enabled AS "digestEnabled", digest_frequency AS "digestFrequency", digest_weekday AS "digestWeekday",
            to_char(digest_time, 'HH24:MI') AS "digestTime"
       FROM project_notification_settings WHERE project_id = $1 ${lock ? 'FOR UPDATE' : ''}`,
    [projectId],
  );
  const r = rows[0];
  if (!r) return { ...EMPTY_PROJECT };
  return {
    ...r,
    weekdays: r.weekdays ? asc(toNums(r.weekdays)) : null,
    leadDays: r.leadDays ? desc(toNums(r.leadDays)) : null,
  };
}

/** Current holidays: the organisation's, plus the project's when given. */
export async function loadHolidayDates(db: Db, projectId: string | null): Promise<Set<string>> {
  const { rows } = await db.query(
    `SELECT to_char(on_date, 'YYYY-MM-DD') AS d FROM holidays WHERE removed_at IS NULL AND (project_id IS NULL OR project_id = $1)`,
    [projectId],
  );
  return new Set(rows.map((r) => r.d as string));
}

/**
 * What applies to a project: the project's own value whenever one is set, else the organisation's. The Administrator's
 * switches only decide whether a project may change a group (`canEdit`); turning one off keeps existing project values
 * in force, read-only (spec §9.2, ruling R28). The Administrator can clear them.
 */
export function resolveEffective(org: OrgRow, proj: ProjectRow, holidays: ReadonlySet<string>): Effective {
  const delegation = { calendar: org.projectsMayChangeCalendar, timings: org.projectsMayChangeTimings, digest: org.projectsMayChangeDigest };
  const pick = <K extends SettingKey>(k: K): [NonNullable<ProjectRow[K]> | OrgRow[K], Source] => {
    const own = proj[k];
    return own !== null ? [own as NonNullable<ProjectRow[K]>, 'project'] : [org[k], 'organisation'];
  };
  const [dayCounting, sDay] = pick('dayCounting');
  const [weekdays, sWeek] = pick('weekdays');
  const [leadDays, sLead] = pick('leadDays');
  const [escalationDays, sEsc] = pick('escalationDays');
  const digest: DigestSchedule | null =
    proj.digestEnabled && proj.digestFrequency && proj.digestTime
      ? { frequency: proj.digestFrequency, weekday: proj.digestFrequency === 'weekly' ? proj.digestWeekday : null, time: proj.digestTime }
      : null;
  return {
    cal: { dayCounting, weekdays, holidays },
    timings: { leadDays, escalationDays },
    sweepMinutes: org.sweepMinutes,
    sources: { dayCounting: sDay, weekdays: sWeek, leadDays: sLead, escalationDays: sEsc },
    delegation,
    digest,
  };
}

/** Effective settings for a project, or (null) the organisation's own. */
export async function loadEffective(db: Db, projectId: string | null): Promise<Effective> {
  const org = await loadOrgRow(db);
  const proj = projectId ? await loadProjectRow(db, projectId) : { ...EMPTY_PROJECT };
  return resolveEffective(org, proj, await loadHolidayDates(db, projectId));
}

/**
 * Effective settings for many projects with three queries in all (the same values `loadEffective` gives each one).
 * The sweep uses this once per run instead of three queries per project.
 */
export async function loadEffectiveMany(db: Db, projectIds: string[]): Promise<Map<string, Effective>> {
  const org = await loadOrgRow(db);
  const out = new Map<string, Effective>();
  if (projectIds.length === 0) return out;
  const projects = new Map<string, ProjectRow>();
  const { rows: prs } = await db.query(
    `SELECT project_id AS "projectId", day_counting AS "dayCounting", weekdays, lead_days AS "leadDays", escalation_days AS "escalationDays",
            digest_enabled AS "digestEnabled", digest_frequency AS "digestFrequency", digest_weekday AS "digestWeekday",
            to_char(digest_time, 'HH24:MI') AS "digestTime"
       FROM project_notification_settings WHERE project_id = ANY($1::uuid[])`,
    [projectIds],
  );
  for (const r of prs) {
    const { projectId, ...row } = r;
    projects.set(projectId, {
      ...row,
      weekdays: row.weekdays ? asc(toNums(row.weekdays)) : null,
      leadDays: row.leadDays ? desc(toNums(row.leadDays)) : null,
    });
  }
  const orgHolidays = new Set<string>();
  const projectHolidays = new Map<string, Set<string>>();
  const { rows: hs } = await db.query(
    `SELECT project_id AS "projectId", to_char(on_date, 'YYYY-MM-DD') AS d FROM holidays
      WHERE removed_at IS NULL AND (project_id IS NULL OR project_id = ANY($1::uuid[]))`,
    [projectIds],
  );
  for (const h of hs) {
    if (h.projectId === null) orgHolidays.add(h.d);
    else projectHolidays.set(h.projectId, (projectHolidays.get(h.projectId) ?? new Set()).add(h.d));
  }
  for (const id of projectIds) {
    const holidays = new Set([...orgHolidays, ...(projectHolidays.get(id) ?? [])]);
    out.set(id, resolveEffective(org, projects.get(id) ?? { ...EMPTY_PROJECT }, holidays));
  }
  return out;
}

/** Every open task of the project (open ancestors included: the planner needs them for parent deadlines). */
export async function loadTaskSnaps(db: Db, projectId: string): Promise<TaskSnap[]> {
  const { rows } = await db.query(
    `SELECT t.id, t.parent_id AS "parentId", t.title, t.assignee_id AS "assigneeId", to_char(t.due_on, 'YYYY-MM-DD') AS "dueOn",
            t.status, t.deadline_review_required AS "deadlineReviewRequired",
            COALESCE((SELECT max(e.at) FROM task_events e
                       WHERE e.task_id = t.id AND (e.kind IN ('authorised', 'deadline_reviewed') OR (e.kind = 'amended' AND e.detail ? 'dueOn'))),
                     t.authorised_at) AS "dueSetAt",
            (SELECT count(*)::int FROM task_events e WHERE e.task_id = t.id AND e.kind = 'reopened') AS "reopenCount"
       FROM tasks t
      WHERE t.project_id = $1 AND t.status NOT IN ('completed', 'cancelled')
      ORDER BY t.id`,
    [projectId],
  );
  return rows.map((r) => ({ ...r, status: r.status as TaskStatus }));
}

export async function loadRiskSnaps(db: Db, projectId: string): Promise<RiskSnap[]> {
  const { rows } = await db.query(
    `SELECT id, description, status, responsible_id AS "responsibleId", to_char(review_on, 'YYYY-MM-DD') AS "reviewOn"
       FROM risks WHERE project_id = $1 AND status <> 'resolved' AND review_on IS NOT NULL ORDER BY id`,
    [projectId],
  );
  return rows.map((r) => ({ ...r, status: r.status as RiskStatus }));
}
