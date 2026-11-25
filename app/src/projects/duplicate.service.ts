import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { writeAudit } from '../audit/audit';
import { CLOCK, type AuthUser, type Clock } from '../auth/tokens';
import { refuseSecretsIn } from '../common/reason';
import { uuidv7 } from '../common/uuid7';
import { PG_POOL } from '../db/database.module';
import { isCalendarDate } from '../extraction/due';
import { unheldRecordSql } from '../history/deleted-sql';
import {
  EMPTY_PROJECT, GROUP_OF, NOT_ALLOWED, type ProjectRow, applyProject, insertHoliday, loadOrgRow, loadProjectRow, parseProjectChanges, sameValue, saveProjectRow,
} from '../notifications/settings';
import { holidayInput } from '../notifications/settings.service';
import {
  DEFAULT_EXPORT_ROLES, NOT_DELEGATED, type ProjectOutputSettingsRow, parseOutputSettingsBody, readOutputSettings, saveOutputSettings,
} from '../outputs/output-settings.service';
import { possibleCopySql } from '../quarantine/labels';
import { quarantineMarkSql, shareSweeps } from '../quarantine/sweep-lock';
import { type ProposedSubtask, insertHumanProposal } from '../records/human-proposal';
import { readTaskDescription } from '../records/task-description';
import { EMPTY, type Values, insertLine, mergeLineValues } from '../resources/lines.service';
import { loadStorageSettings } from '../storage/settings';
import { ProjectAccess } from './access.service';
import { type CarriedText, DUPLICATE_LIMITS, duplicateProblems, unconfirmedTerms } from './duplicate';
import { ProjectsService, SAME_STAGE_NAME, readStageName } from './projects.service';
import { TEMPLATE_LIMITS } from './stage-templates';

/** The reason in the histories a copied setting starts. It never names the original (the leak rule). */
export const COPIED_REASON = 'Copied from another project when this one was created';

type Db = Pool | PoolClient;
type Obj = Record<string, unknown>;
/** What the copied output settings may hold: no destination, which names a connection and a folder. */
type OutputChoices = Omit<ProjectOutputSettingsRow, 'destinationId'>;

const MAX_WORDING = 2_000;
const MAX_HOLIDAYS = 500;
/** More keys than the limits leave room for are refused before they are looked at. */
const MAX_KEYS = 5_000;
const DEFAULT_OUTPUTS: OutputChoices = { inputFormats: null, outputFormats: null, exportRoles: [...DEFAULT_EXPORT_ROLES] };
const APPROVALS_KEPT =
  "Keep the original's number of approvals or leave it to the organisation; the new project's Owner or a Sponsor can change it later.";

export const LOAD_AGAIN = 'Load the project again.';
export const REVIEWED_SINCE = 'Something in the original was put under review or cleaned after you opened this page. Load the project again.';
export const UNDER_REVIEW = 'Something in the original is under review for a suspected credential. Create the copy when the review has ended.';
export const JUST_CREATED = 'You created this project a moment ago.';
const PAGE_HOURS = 24;
/** A second Create of the same copy within this time is the same click sent twice. */
const SAME_CREATE_MINUTES = 10;

/** Why a setting of the original starts at the organisation's value in the new project. */
const notCarried = (what: string) => `The Administrator does not let projects set ${what} now, so the new project uses the organisation's.`;
const NOT_CARRIED = {
  requiredApprovals: notCarried('their own number of approvals'),
  holidays: notCarried('their own holidays'),
  calendar: notCarried('their own working days'),
  timings: notCarried('their own reminder times'),
  digest: notCarried('their own digest'),
  formats: notCarried('their own formats'),
  exportRoles: notCarried('who may export'),
} as const;
type CarriedSetting = keyof typeof NOT_CARRIED;

const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const trimmed = (v: unknown): string => (typeof v === 'string' ? v.normalize('NFC').trim() : '');
const bad = (message: string): never => {
  throw new BadRequestException(message);
};

/** A list in the body; left out means none. */
function list(v: unknown, what: string): Obj[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) return bad(`Give the ${what} as a list.`);
  return v.map(obj);
}

function strings(v: unknown, what: string): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) return bad(`Give the ${what} as a list.`);
  return v as string[];
}

/** A title or a risk's wording as a person leaves it on the review page: the limits of proposing it by hand. */
function readWording(v: unknown, what: string): string {
  const text = typeof v === 'string' ? v.trim() : '';
  if (text === '' || text.length > MAX_WORDING) return bad(`Give each ${what} 1 to ${MAX_WORDING.toLocaleString('en-US')} characters.`);
  refuseSecretsIn(text);
  return text;
}

function readNewDue(v: unknown): string | null {
  if (v === undefined || v === null || v === '') return null;
  if (!isCalendarDate(v)) return bad('Dates must be in the form YYYY-MM-DD.');
  return v;
}

/** `n` ids made now, in the order they are to be listed (a list of proposals made together is ordered by id). */
const orderedIds = (n: number, at: Date): string[] => Array.from({ length: n }, () => uuidv7(at.getTime())).sort();

interface Delegations {
  calendar: boolean;
  timings: boolean;
  digest: boolean;
  formats: boolean;
  exportRoles: boolean;
  approvals: boolean;
}

interface OfferedTask {
  id: string;
  parentId: string | null;
  title: string;
  description: string | null;
}
interface OfferedLine {
  id: string;
  item: { id: string; kind: string; reference: string; name: string } | null;
  oneOffKind: string | null;
  description: string;
  quantity: string | null;
  unit: string | null;
}
interface Offer {
  original: {
    id: string;
    name: string;
    purpose: string;
    plannedEnd: string | null;
    stageTemplateId: string | null;
    owningDepartment: { id: string; name: string; retired: boolean };
    contributingDepartments: Array<{ id: string; name: string; retired: boolean }>;
  };
  stages: Array<{ id: string; name: string; substages: string[] }>;
  holidays: Array<{ id: string; date: string; name: string }>;
  requiredApprovals: number | null;
  notifications: ProjectRow;
  outputs: OutputChoices;
  /** Exceptions the original has that a project may not set now, so they are not carried. */
  notCarried: CarriedSetting[];
  mayChange: Delegations;
  /** Top-level tasks, each with everything offered below it (a parent always before its own subtasks). */
  tasks: Array<OfferedTask & { subtasks: OfferedTask[] }>;
  risks: Array<{ id: string; text: string }>;
  resources: OfferedLine[];
}

/** Keys of the texts, the same on the review page and in what it sends back. */
const key = {
  stage: (id: string) => `stage:${id}`,
  substage: (id: string, n: number) => `stage:${id}:substage:${n}`,
  holiday: (id: string) => `holiday:${id}`,
  title: (id: string) => `task:${id}:title`,
  description: (id: string) => `task:${id}:description`,
  risk: (id: string) => `risk:${id}`,
  resource: (id: string) => `resource:${id}`,
};

@Injectable()
export class DuplicateService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly now: Clock,
    private readonly access: ProjectAccess,
    private readonly projects: ProjectsService,
  ) {}

  /**
   * What may be carried over, read now: only what the Project Manager can read in the project, without anything Deleted,
   * held, masked as a possible copy or cancelled (the strict rule for text that leaves the record views). With `lock`
   * the rows are held to the end of the transaction, so none is deleted or held while it is copied.
   */
  private async load(db: Db, projectId: string, lock = false): Promise<Offer> {
    const may = await this.delegations(db);
    const share = (alias: string) => (lock ? `FOR SHARE OF ${alias}` : '');
    const p = (
      await db.query(
        `SELECT p.id, p.name, p.purpose, to_char(p.planned_end, 'YYYY-MM-DD') AS "plannedEnd",
                (SELECT st.id FROM stage_templates st WHERE st.id = p.stage_template_id AND st.status = 'active') AS "stageTemplateId", p.required_approvals AS "requiredApprovals",
                json_build_object('id', d.id, 'name', d.name, 'retired', d.status <> 'active') AS "owningDepartment"
           FROM projects p JOIN departments d ON d.id = p.owning_department_id WHERE p.id = $1`,
        [projectId],
      )
    ).rows[0];
    const contributing = (
      await db.query(
        `SELECT d.id, d.name, d.status <> 'active' AS retired FROM project_departments pd JOIN departments d ON d.id = pd.department_id WHERE pd.project_id = $1 ORDER BY lower(d.name), d.id`,
        [projectId],
      )
    ).rows;
    const stages = (await db.query(`SELECT id, name, substages FROM project_stages WHERE project_id = $1 AND status = 'active' ORDER BY position, id`, [projectId])).rows;
    const holidays = (
      await db.query(`SELECT id, to_char(on_date, 'YYYY-MM-DD') AS date, name FROM holidays WHERE project_id = $1 AND removed_at IS NULL ORDER BY on_date, id`, [projectId])
    ).rows;
    const own = await readOutputSettings(db, projectId);
    const notifications = await loadProjectRow(db, projectId);
    const outputs: OutputChoices = own ? { inputFormats: own.inputFormats, outputFormats: own.outputFormats, exportRoles: own.exportRoles } : { ...DEFAULT_OUTPUTS };
    let requiredApprovals = p.requiredApprovals as number | null;
    // An exception is carried only where a project could set it now; elsewhere the new project starts as any other does.
    const dropped = new Set<CarriedSetting>();
    if (!may.approvals && requiredApprovals !== null) {
      dropped.add('requiredApprovals');
      requiredApprovals = null;
    }
    if (!may.calendar && holidays.length > 0) {
      dropped.add('holidays');
      holidays.length = 0;
    }
    for (const k of Object.keys(EMPTY_PROJECT) as (keyof ProjectRow)[]) {
      if (may[GROUP_OF[k]] || sameValue(notifications[k], EMPTY_PROJECT[k])) continue;
      dropped.add(GROUP_OF[k]);
      (notifications as unknown as Obj)[k] = EMPTY_PROJECT[k];
    }
    for (const k of ['inputFormats', 'outputFormats', 'exportRoles'] as const) {
      const group = k === 'exportRoles' ? 'exportRoles' : 'formats';
      if (may[group] || sameValue(outputs[k], DEFAULT_OUTPUTS[k])) continue;
      dropped.add(group);
      (outputs as unknown as Obj)[k] = DEFAULT_OUTPUTS[k];
    }
    const flat = (
      await db.query<OfferedTask>(
        `SELECT t.id, t.parent_id AS "parentId", t.title, t.description FROM tasks t
          WHERE t.project_id = $1 AND t.status <> 'cancelled' AND ${unheldRecordSql('t')} AND NOT ${possibleCopySql('task', 't.id')}
          ORDER BY t.authorised_at, t.id ${share('t')}`,
        [projectId],
      )
    ).rows;
    // A subtask needs its parent: below a task that is not offered, nothing is.
    const below = (id: string): OfferedTask[] => flat.filter((t) => t.parentId === id).flatMap((t) => [t, ...below(t.id)]);
    const risks = (
      await db.query(
        `SELECT k.id, k.description AS text FROM risks k
          WHERE k.project_id = $1 AND ${unheldRecordSql('k')} AND NOT ${possibleCopySql('risk', 'k.id')}
          ORDER BY k.authorised_at, k.id ${share('k')}`,
        [projectId],
      )
    ).rows;
    const lines = (
      await db.query(
        `SELECT l.id, l.one_off_kind AS "oneOffKind", l.description, l.quantity::text AS quantity, l.unit,
                CASE WHEN i.id IS NULL THEN NULL ELSE json_build_object('id', i.id, 'kind', i.kind, 'reference', i.reference, 'name', i.name) END AS item
           FROM resource_lines l LEFT JOIN resource_items i ON i.id = l.item_id
          WHERE l.project_id = $1 AND l.status <> 'cancelled' AND (l.item_id IS NULL OR i.status = 'active')
          ORDER BY coalesce(i.reference, l.description), l.created_at, l.id ${share('l')}`,
        [projectId],
      )
    ).rows;
    return {
      original: {
        id: p.id, name: p.name, purpose: p.purpose, plannedEnd: p.plannedEnd, stageTemplateId: p.stageTemplateId,
        owningDepartment: p.owningDepartment, contributingDepartments: contributing,
      },
      stages,
      holidays,
      requiredApprovals,
      notifications,
      outputs,
      notCarried: [...dropped],
      mayChange: may,
      tasks: flat.filter((t) => t.parentId === null).map((t) => ({ ...t, subtasks: below(t.id) })),
      risks,
      resources: lines,
    };
  }

  /** What the Administrator lets projects set now. */
  private async delegations(db: Db): Promise<Delegations> {
    const org = await loadOrgRow(db);
    const storage = await loadStorageSettings(db);
    return {
      calendar: org.projectsMayChangeCalendar,
      timings: org.projectsMayChangeTimings,
      digest: org.projectsMayChangeDigest,
      formats: storage.projectsMayChangeFormats,
      exportRoles: storage.projectsMaySetExportRoles,
      approvals: (await db.query(`SELECT projects_may_override AS may FROM approval_policy WHERE id = 1`)).rows[0].may as boolean,
    };
  }

  /** The review page's content: everything offered, each text with its key. */
  async offer(user: AuthUser, projectId: string) {
    await this.access.authorize(user, 'project.duplicate', projectId);
    await this.projects.assertMayCreate(user);
    const asOf = await this.asOf(projectId);
    const o = await this.load(this.pool, projectId);
    const { approvals: _ownersChoice, ...mayChange } = o.mayChange;
    const task = (t: OfferedTask) => ({ id: t.id, title: t.title, titleKey: key.title(t.id), description: t.description, descriptionKey: key.description(t.id) });
    const { stageTemplateId: _template, ...original } = o.original;
    return {
      asOf,
      original: { ...original, purposeKey: 'purpose' },
      stages: o.stages.map((s) => ({ id: s.id, key: key.stage(s.id), name: s.name, substages: s.substages.map((name, n) => ({ key: key.substage(s.id, n), name })) })),
      holidays: o.holidays.map((h) => ({ ...h, key: key.holiday(h.id) })),
      settings: {
        requiredApprovals: o.requiredApprovals, notifications: o.notifications, outputs: o.outputs,
        notCarried: o.notCarried.map((setting) => ({ setting, notCarried: true as const, reason: NOT_CARRIED[setting] })),
      },
      mayChange,
      tasks: o.tasks.map((t) => ({ ...task(t), subtasks: t.subtasks.map((s) => ({ ...task(s), parentId: s.parentId })) })),
      risks: o.risks.map((r) => ({ ...r, key: key.risk(r.id) })),
      resources: o.resources.map((l) => ({ ...l, key: l.oneOffKind === null ? null : key.resource(l.id) })),
      limits: DUPLICATE_LIMITS,
    };
  }

  /** When the page is loaded (the database's time) and how far the original's quarantine has come; read before any row. */
  private async asOf(projectId: string): Promise<string> {
    const { rows } = await this.pool.query<{ at: Date; mark: string }>(`SELECT clock_timestamp() AS at, ${quarantineMarkSql('$1::uuid')} AS mark`, [projectId]);
    return `${rows[0].at.toISOString()}~${rows[0].mark}`;
  }

  /**
   * Text cleaned or held since the page was loaded must not come back through the page. The sweep lock is held, so
   * whatever was reported or cleaned is committed and counted in the mark, or waits until this transaction has ended.
   */
  private async refuseReviewedSince(c: PoolClient, projectId: string, asOf: unknown): Promise<void> {
    const sent = typeof asOf === 'string' ? /^([^~]+)~(\d+:\d+:\d+)$/.exec(asOf) : null;
    const time = sent ? Date.parse(sent[1]) : Number.NaN;
    if (!sent || Number.isNaN(time)) return bad(LOAD_AGAIN);
    const now = (
      await c.query<{ at: Date; mark: string; open: boolean }>(
        `SELECT clock_timestamp() AS at, ${quarantineMarkSql('$1::uuid')} AS mark,
                EXISTS (SELECT 1 FROM quarantine_cases q WHERE q.project_id = $1::uuid AND q.state IN ('held', 'cleaned')) AS open`,
        [projectId],
      )
    ).rows[0];
    if (time > now.at.getTime() || time < now.at.getTime() - PAGE_HOURS * 3_600_000) bad(LOAD_AGAIN);
    if (now.open) throw new ConflictException(UNDER_REVIEW);
    if (now.mark !== sent[2]) throw new ConflictException(REVIEWED_SINCE);
  }

  /** Project names are not unique, so the same click sent twice would make two: the second is refused, with the first's id. */
  private async refuseSecondCreate(c: PoolClient, user: AuthUser, projectId: string, name: string, at: Date): Promise<void> {
    const { rows } = await c.query(
      `SELECT id FROM projects WHERE copied_from_id = $1 AND created_by = $2 AND name = $3 AND created_at > $4 ORDER BY created_at DESC LIMIT 1`,
      [projectId, user.id, name, new Date(at.getTime() - SAME_CREATE_MINUTES * 60_000)],
    );
    if (rows[0]) throw new ConflictException({ statusCode: 409, error: 'Conflict', message: JUST_CREATED, projectId: rows[0].id });
  }

  /** Creates the new Draft project with everything chosen, or nothing at all. */
  async duplicate(user: AuthUser, projectId: string, body: unknown) {
    // 404 or 403 before anything about the body is said.
    await this.access.authorize(user, 'project.duplicate', projectId);
    const b = obj(body);
    const at = this.now();
    const c = await this.pool.connect();
    let id: string;
    try {
      await c.query('BEGIN');
      // The sweep lock first, before any row lock, as everywhere.
      await shareSweeps(c, projectId);
      await this.projects.beginCreation(c, user);
      await this.access.authorize(user, 'project.duplicate', projectId, c, true);
      await this.refuseReviewedSince(c, projectId, b.asOf);
      await this.refuseSecondCreate(c, user, projectId, trimmed(b.name), at);
      id = await this.write(c, user, projectId, b, at);
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK').catch(() => undefined);
      // The database compares names by its own rules, which differ from JavaScript's for a few letters.
      if ((err as { constraint?: string }).constraint === 'project_stages_name') throw new BadRequestException(SAME_STAGE_NAME);
      throw err;
    } finally {
      c.release();
    }
    return this.projects.detail(user, id);
  }

  private async write(c: PoolClient, user: AuthUser, projectId: string, b: Obj, at: Date): Promise<string> {
    const tasksIn = list(b.tasks, 'tasks');
    const subtasksIn = tasksIn.map((t) => list(t.subtasks, 'subtasks'));
    const risksIn = list(b.risks, 'risks');
    const resourcesIn = list(b.resources, 'resources');
    const counts = { tasks: tasksIn.length + subtasksIn.reduce((n, s) => n + s.length, 0), risks: risksIn.length, resources: resourcesIn.length };
    const oldTerms = strings(b.oldTerms, 'old terms').map(trimmed).filter((t) => t !== '');
    if (oldTerms.length > DUPLICATE_LIMITS.terms) bad(`List at most ${DUPLICATE_LIMITS.terms} old terms.`);
    if (oldTerms.some((t) => t.length > DUPLICATE_LIMITS.termChars)) bad(`An old term can be at most ${DUPLICATE_LIMITS.termChars} characters.`);
    const confirmedKeys = strings(b.confirmedKeys, 'confirmed texts');
    if (confirmedKeys.length > MAX_KEYS) bad('Too many confirmed texts were sent.');
    const plannedEndIn = b.plannedEnd === undefined || b.plannedEnd === null || b.plannedEnd === '' ? null : b.plannedEnd;
    if (plannedEndIn !== null && !isCalendarDate(plannedEndIn)) bad('The planned end must be a date in the form YYYY-MM-DD.');

    const offer = await this.load(c, projectId, true);
    const choices = {
      original: offer.original,
      name: trimmed(b.name),
      plannedEnd: plannedEndIn as string | null,
      noPlannedEnd: b.noPlannedEnd === true,
      purpose: trimmed(b.purpose),
      purposeConfirmed: b.purposeConfirmed === true,
      oldTerms,
      confirmedKeys,
      counts,
    };
    // Too much to copy is said first, before the rest is read.
    const tooMany = duplicateProblems({ ...choices, counts, texts: [], oldTerms: [] }).filter((p) => p.startsWith('You chose '));
    if (tooMany.length > 0) this.refuse(tooMany);

    this.refuseUnavailable(offer, { stages: list(b.stages, 'stages'), holidays: list(b.holidays, 'holidays'), tasks: tasksIn, subtasks: subtasksIn, risks: risksIn, resources: resourcesIn });

    const texts: CarriedText[] = [{ key: 'name', text: choices.name }, { key: 'purpose', text: choices.purpose }];
    const stages = this.readStages(b.stages, offer, texts);
    const holidays = this.readHolidays(b.holidays, offer, offer.mayChange.calendar, texts);
    const settings = this.readSettings(b.settings, offer);
    const tasks = this.readTasks(tasksIn, subtasksIn, offer, texts);
    const risks = risksIn.map((r) => {
      const text = readWording(r.text === undefined ? offer.risks.find((k) => k.id === r.id)?.text : r.text, 'risk');
      texts.push({ key: key.risk(r.id as string), text });
      return text;
    });
    const lines = this.readLines(resourcesIn, offer, texts);

    const problems = duplicateProblems({ ...choices, texts });
    if (problems.length > 0) this.refuse(problems, unconfirmedTerms(texts, oldTerms, confirmedKeys));
    refuseSecretsIn(choices.name);
    const details = await this.projects.cleanDetails(c, {
      name: b.name, purpose: b.purpose, plannedEnd: plannedEndIn, owningDepartmentId: b.owningDepartmentId, contributingDepartmentIds: b.contributingDepartmentIds ?? [],
    });

    const id = await this.projects.insertNew(c, user, at, { details, stages, stageTemplateId: offer.original.stageTemplateId, first: false, copiedFromId: projectId });
    if (settings.requiredApprovals !== null) {
      await c.query(`UPDATE projects SET required_approvals = $2 WHERE id = $1`, [id, settings.requiredApprovals]);
      await c.query(
        `INSERT INTO approval_policy_changes (id, project_id, field, old_value, new_value, reason, pending_choice, actor_id, at) VALUES ($1, $2, 'required', NULL, $3, $4, 'keep', $5, $6)`,
        [uuidv7(at.getTime()), id, String(settings.requiredApprovals), COPIED_REASON, user.id, at],
      );
      await writeAudit(c, {
        at, action: 'approval_policy.project_changed', actorUserId: user.id, subjectType: 'project', subjectId: id,
        detail: { from: null, to: settings.requiredApprovals, pending: 'keep' },
      });
    }
    for (const h of holidays) await insertHoliday(c, id, h.date, h.name, COPIED_REASON, user.id, at);
    await saveProjectRow(c, id, EMPTY_PROJECT, settings.notifications, COPIED_REASON, user.id, at);
    if (!sameValue(settings.outputs, DEFAULT_OUTPUTS)) {
      await saveOutputSettings(c, id, { ...DEFAULT_OUTPUTS, destinationId: null }, { ...settings.outputs, destinationId: null }, COPIED_REASON, user.id, at);
    }
    const ids = orderedIds(tasks.length + risks.length, at);
    const proposals = [
      ...tasks.map((t) => ({ kind: 'action', text: t.title, description: t.description, due: t.due, proposedSubtasks: t.subtasks })),
      ...risks.map((text) => ({ kind: 'risk', text, description: null, due: null, proposedSubtasks: undefined })),
    ];
    for (const [i, p] of proposals.entries()) {
      await insertHumanProposal(c, { ...p, id: ids[i], projectId: id, owner: null, copiedFromProjectId: projectId }, user.id, at);
    }
    for (const v of lines) await insertLine(c, uuidv7(at.getTime()), id, v, user, at);
    await writeAudit(c, {
      at, action: 'project.duplicated', actorUserId: user.id, subjectType: 'project', subjectId: projectId,
      detail: { newProjectId: id, stages: stages.length, holidays: holidays.length, ...counts },
    });
    return id;
  }

  /** Refuses with every problem in plain words, and the texts that still hold an old term. */
  private refuse(problems: string[], terms: Array<{ key: string; term: string }> = []): never {
    throw new BadRequestException({ statusCode: 400, error: 'Bad Request', message: problems.join(' '), problems, ...(terms.length > 0 ? { terms } : {}) });
  }

  /**
   * Every id sent must be offered now, once, a subtask under its own task: an id of another project, or one deleted,
   * held, cancelled or retired since the page was opened, refuses the whole duplication in words that say only how many.
   */
  private refuseUnavailable(offer: Offer, sent: { stages: Obj[]; holidays: Obj[]; tasks: Obj[]; subtasks: Obj[][]; risks: Obj[]; resources: Obj[] }): void {
    const gone: Array<{ kind: string; id: string | null }> = [];
    const check = (kind: string, rows: Obj[], offered: Iterable<string>, mayBeNew = false) => {
      const left = new Set(offered);
      for (const r of rows) {
        if (mayBeNew && (r.id === undefined || r.id === null)) continue;
        if (typeof r.id !== 'string' || !left.delete(r.id)) gone.push({ kind, id: typeof r.id === 'string' ? r.id : null });
      }
    };
    check('stage', sent.stages, offer.stages.map((s) => s.id), true);
    check('holiday', sent.holidays, offer.holidays.map((h) => h.id), true);
    check('task', sent.tasks, offer.tasks.map((t) => t.id));
    const byId = new Map(offer.tasks.map((t) => [t.id, t]));
    for (const [i, t] of sent.tasks.entries()) {
      const under = byId.get(t.id as string)?.subtasks ?? [];
      check('subtask', sent.subtasks[i], under.map((s) => s.id));
      const chosen = new Set([t.id, ...sent.subtasks[i].map((s) => s.id)]);
      if (under.some((s) => chosen.has(s.id) && !chosen.has(s.parentId))) bad('A subtask can be copied only with the task it belongs to.');
    }
    check('risk', sent.risks, offer.risks.map((r) => r.id));
    check('resource line', sent.resources, offer.resources.map((l) => l.id));
    if (gone.length === 0) return;
    const kinds = [...new Set(gone.map((g) => g.kind))].map((k) => {
      const n = gone.filter((g) => g.kind === k).length;
      return `${n} ${k}${n === 1 ? '' : 's'}`;
    });
    throw new BadRequestException({
      statusCode: 400, error: 'Bad Request',
      message: `Some of what you chose can no longer be copied (${kinds.join(', ')}). Take it out and create the project again.`,
      unavailable: gone.map((g) => g.id).filter((x) => x !== null),
    });
  }

  /** The new project's stages in their order: names as when adding one, at least one, and a carried name under its key. */
  private readStages(input: unknown, offer: Offer, texts: CarriedText[]): Array<{ name: string; substages: string[] }> {
    const rows = list(input, 'stages');
    if (rows.length === 0) bad('Keep at least one stage.');
    if (rows.length > TEMPLATE_LIMITS.stages) bad(`A project can have at most ${TEMPLATE_LIMITS.stages} stages in use.`);
    const out = rows.map((r, i) => {
      const name = readStageName(r.name, `Give each stage a name of 1 to ${TEMPLATE_LIMITS.nameChars} characters.`);
      const raw = r.substages === undefined || r.substages === null ? [] : r.substages;
      if (!Array.isArray(raw)) return bad(`Give the substages of ${name} as a list.`);
      if (raw.length > TEMPLATE_LIMITS.substagesPerStage) bad(`A stage can have at most ${TEMPLATE_LIMITS.substagesPerStage} substages.`);
      const offered = offer.stages.find((s) => s.id === r.id);
      texts.push(offered ? { key: key.stage(offered.id), text: name } : { key: `new:stage:${i}`, text: name, typed: `The new stage "${name}"` });
      const substages = (raw as unknown[]).map((x, at) => {
        const given = typeof x === 'string' ? x : obj(x).name;
        const sub = readStageName(given, `Give each substage a name of 1 to ${TEMPLATE_LIMITS.nameChars} characters.`);
        // Carried: sent under its key, or as plain text exactly as it was. Anything else was typed here.
        const from = offered?.substages.findIndex((s, n) => (typeof x === 'string' ? s === sub : key.substage(offered.id, n) === obj(x).key)) ?? -1;
        texts.push(
          offered && from >= 0
            ? { key: key.substage(offered.id, from), text: sub }
            : { key: `new:stage:${i}:substage:${at}`, text: sub, typed: `The substage "${sub}" of "${name}"` },
        );
        return sub;
      });
      if (new Set(substages.map((x) => x.toLowerCase())).size !== substages.length) bad('Substage names must differ within a stage.');
      return { name, substages };
    });
    if (new Set(out.map((s) => s.name.toLowerCase())).size !== out.length) bad(SAME_STAGE_NAME);
    return out;
  }

  /** The project's own holidays, only where the Administrator lets projects change their calendar. */
  private readHolidays(input: unknown, offer: Offer, mayChange: boolean, texts: CarriedText[]): Array<{ date: string; name: string }> {
    const rows = list(input, 'holidays');
    if (rows.length > MAX_HOLIDAYS) bad(`At most ${MAX_HOLIDAYS} holidays can be copied at once.`);
    const dates = new Set<string>();
    return rows.map((r, i) => {
      const h = holidayInput(r);
      if (dates.has(h.date)) bad(`Two holidays are on ${h.date}; keep one of them.`);
      dates.add(h.date);
      const offered = offer.holidays.find((x) => x.id === r.id);
      if (!mayChange) bad(NOT_ALLOWED);
      texts.push(offered ? { key: key.holiday(offered.id), text: h.name } : { key: `new:holiday:${i}`, text: h.name, typed: `The new holiday "${h.name}"` });
      return h;
    });
  }

  /**
   * The settings as posted; a part left out is copied as offered. Copying gives the new project nothing a project could
   * not have now: any value but the default is taken only where the Administrator lets projects set it (the offer holds
   * none of the others), and the number of approvals (an Owner's or Sponsor's choice) is kept or left to the organisation.
   */
  private readSettings(
    input: unknown,
    offer: Offer,
  ): { requiredApprovals: number | null; notifications: ProjectRow; outputs: OutputChoices } {
    const s = obj(input);
    const requiredApprovals = s.requiredApprovals === undefined ? offer.requiredApprovals : s.requiredApprovals;
    if (requiredApprovals !== null && requiredApprovals !== offer.requiredApprovals) bad(APPROVALS_KEPT);

    const changes = s.notifications === undefined || s.notifications === null || Object.keys(obj(s.notifications)).length === 0 ? {} : parseProjectChanges(s.notifications);
    const notifications = applyProject(offer.notifications, changes);
    for (const k of Object.keys(EMPTY_PROJECT) as (keyof ProjectRow)[]) {
      if (!sameValue(notifications[k], EMPTY_PROJECT[k]) && !offer.mayChange[GROUP_OF[k]]) bad(NOT_ALLOWED);
    }

    const o = obj(s.outputs);
    const given = Object.fromEntries((['inputFormats', 'outputFormats', 'exportRoles'] as const).filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
    const { patch } = parseOutputSettingsBody({ ...given, reason: COPIED_REASON });
    const outputs: OutputChoices = { ...offer.outputs, ...(patch as Partial<OutputChoices>) };
    const isDefault = (k: keyof OutputChoices) => sameValue(outputs[k], DEFAULT_OUTPUTS[k]);
    if (!(isDefault('inputFormats') && isDefault('outputFormats')) && !offer.mayChange.formats) bad(NOT_DELEGATED.formats);
    if (!isDefault('exportRoles') && !offer.mayChange.exportRoles) bad(NOT_DELEGATED.exportRoles);
    return { requiredApprovals: requiredApprovals as number | null, notifications, outputs };
  }

  private readTasks(
    tasks: Obj[],
    subtasks: Obj[][],
    offer: Offer,
    texts: CarriedText[],
  ): Array<{ title: string; description: string | null; due: string | null; subtasks: ProposedSubtask[] }> {
    const offered = new Map(offer.tasks.flatMap((t) => [t, ...t.subtasks]).map((t) => [t.id, t]));
    const read = (r: Obj, what: string): ProposedSubtask => {
      const from = offered.get(r.id as string) as OfferedTask;
      const title = readWording(r.title === undefined ? from.title : r.title, what);
      const description = readTaskDescription(r.description === undefined ? from.description : r.description);
      texts.push({ key: key.title(from.id), text: title });
      if (description !== null) texts.push({ key: key.description(from.id), text: description });
      return { title, description, due: readNewDue(r.due) };
    };
    return tasks.map((t, i) => ({ ...read(t, 'task title'), subtasks: subtasks[i].map((s) => read(s, 'subtask title')) }));
  }

  /** Item and quantity only: no dates, notes or status; a one-off line keeps its description. */
  private readLines(rows: Obj[], offer: Offer, texts: CarriedText[]): Values[] {
    return rows.map((r) => {
      const l = offer.resources.find((x) => x.id === r.id) as OfferedLine;
      const quantity = r.quantity === undefined ? l.quantity : r.quantity;
      const unit = r.unit === undefined ? l.unit : r.unit;
      if (l.item) return mergeLineValues(EMPTY, { itemId: l.item.id, quantity, unit });
      const v = mergeLineValues(EMPTY, { oneOffKind: l.oneOffKind, description: r.description === undefined ? l.description : r.description, quantity, unit });
      refuseSecretsIn(v.description);
      texts.push({ key: key.resource(l.id), text: v.description });
      return v;
    });
  }
}
