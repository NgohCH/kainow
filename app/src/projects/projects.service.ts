import { liveRecordRefSql, liveRecordSql } from '../history/deleted-sql';
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { readReason, refuseSecretsIn } from '../common/reason';
import type { Pool, PoolClient } from 'pg';
import { writeAudit } from '../audit/audit';
import { CLOCK, type AuthUser, type Clock } from '../auth/tokens';
import { openRecordDelegation } from '../history/delegation';
import { assertClosureReady, finaliseClosure, openDelegation } from '../changes/closure';
import { UUID, uuidv7 } from '../common/uuid7';
import { APP_CONFIG, type AppConfig } from '../config';
import { PG_POOL } from '../db/database.module';
import { closureNoticeEmail } from '../email/messages';
import { EMAIL_NUDGE, type EmailNudge } from '../email/nudge';
import { writeOutbox } from '../email/outbox';
import { isCalendarDate } from '../extraction/due';
import { type ProjectContext, ProjectAccess, managesGrants, managesRoles } from './access.service';
import { loadArchiveState } from './archive';
import { type CopiedFrom, copiedFromViews } from './copied-from';
import { DepartmentTransferService } from './department-transfer.service';
import { OrganisationService } from './organisation.service';
import { grantState } from './grants';
import { type ClosureOutcome, checkTransition } from './lifecycle';
import { type MembershipRow, membershipState, requiredRolesCheck, separationCheck } from './membership';
import { type ProjectStatus, PROJECT_STATUSES } from './matrix';
import { clipPeriods } from './stage-periods';
import { TEMPLATE_LIMITS } from './stage-templates';
import { refuseSecrets } from '../discussion/messages';

/** One of a project's own stages (D131): a copy of its template's stage, or one the project added. */
export interface ProjectStage {
  id: string;
  name: string;
  substages: string[];
  status: 'active' | 'retired';
}

/** A project in the list of the person's own projects. */
export interface ProjectSummary {
  id: string;
  name: string;
  status: ProjectStatus;
  owningDepartment: string;
  stage: { stage: string; substage: string | null } | null;
  deferred: { on: string; reason: string | null } | null;
  closed: { on: string; outcome: ClosureOutcome | null } | null;
}

/** The project's stages in their order, retired ones in their place. */
async function loadStages(db: Pool | PoolClient, projectId: string): Promise<ProjectStage[]> {
  return (await db.query(`SELECT id, name, substages, status FROM project_stages WHERE project_id = $1 ORDER BY position, id`, [projectId])).rows;
}

/** One recorded change to a project's own stages, as everyone who can see the stages reads it. */
export interface StageChange {
  id: string;
  kind: 'added' | 'reordered' | 'retired' | 'restored' | 'renamed';
  /** The stage added, retired, brought back or renamed, by the name this change left it with; null for a new order. */
  stage: string | null;
  actor: string;
  at: Date;
  reason: string;
  previous: Array<Omit<ProjectStage, 'id'>>;
  next: Array<Omit<ProjectStage, 'id'>>;
}

/** The changes to the project's stages, newest first. */
async function loadStageChanges(db: Pool | PoolClient, projectId: string): Promise<StageChange[]> {
  type Row = Omit<StageChange, 'stage' | 'previous' | 'next'> & { stageId: string | null; nameNow: string | null; previous: RecordedStage[]; next: RecordedStage[] };
  const { rows } = await db.query<Row>(
    `SELECT c.id, c.kind, c.stage_id AS "stageId", s.name AS "nameNow", u.display_name AS actor, c.at, c.reason, c.previous, c.next
       FROM project_stage_changes c JOIN users u ON u.id = c.actor_id LEFT JOIN project_stages s ON s.id = c.stage_id
      WHERE c.project_id = $1 ORDER BY c.at DESC, c.id DESC`,
    [projectId],
  );
  return rows.map(({ stageId, nameNow, previous, next, ...c }) => ({
    ...c,
    stage: stageId === null ? null : (nameAfter(stageId, previous, next) ?? nameNow),
    previous: previous.map(withoutId),
    next: next.map(withoutId),
  }));
}

/** A stage in a recorded list; lists from before stages could be renamed hold no ids. */
type RecordedStage = Omit<ProjectStage, 'id'> & { id?: string };
const withoutId = ({ name, substages, status }: RecordedStage): Omit<ProjectStage, 'id'> => ({ name, substages, status });

/**
 * The name a recorded change left its stage with, so a later rename does not alter the entry: by the stage's id, or in
 * a list without ids by the first place where the two lists differ (an addition, or a status). Undefined if neither tells.
 */
function nameAfter(stageId: string, previous: RecordedStage[], next: RecordedStage[]): string | undefined {
  return (next.find((s) => s.id === stageId) ?? next.find((s, i) => s.name !== previous[i]?.name || s.status !== previous[i]?.status))?.name;
}

/** A list of stages as the history keeps it. */
const recorded = (stages: ProjectStage[]): string => JSON.stringify(stages.map(({ id, name, substages, status }) => ({ id, name, substages, status })));

export const SAME_STAGE_NAME = 'This project already has a stage with that name.';

/** A project has at most as many stages in use as a template may have. */
function refuseTooManyStages(stages: ProjectStage[]): void {
  if (stages.filter((s) => s.status === 'active').length >= TEMPLATE_LIMITS.stages) {
    throw new BadRequestException(`A project can have at most ${TEMPLATE_LIMITS.stages} stages in use. Retire one first.`);
  }
}

const NOT_OFFERED = 'Choose a type of project that is still offered.';

/** A stage or substage name: trimmed, 1 to 80 characters, credential-checked. */
export function readStageName(input: unknown, refusal: string): string {
  const name = typeof input === 'string' ? input.normalize('NFC').trim() : '';
  if (name === '' || name.length > TEMPLATE_LIMITS.nameChars) throw new BadRequestException(refusal);
  refuseSecrets(name);
  return name;
}

const OUTCOMES: readonly ClosureOutcome[] = ['delivered', 'partially_delivered', 'abandoned'];

const text = (v: unknown): string => (typeof v === 'string' ? v.normalize('NFC').trim() : '');
const optionalText = (v: unknown): string | null => {
  const t = text(v);
  return t === '' ? null : t;
};

export interface Details {
  name: string;
  purpose: string;
  owningDepartmentId: string;
  contributingDepartmentIds: string[];
  plannedEnd: string | null;
}

@Injectable()
export class ProjectsService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly now: Clock,
    private readonly access: ProjectAccess,
    private readonly org: OrganisationService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(EMAIL_NUDGE) private readonly nudge: EmailNudge,
    private readonly transfers: DepartmentTransferService,
  ) {}

  /** Checks a full or partial set of project details. Missing keys keep `current` values. */
  async cleanDetails(db: Pool | PoolClient, input: Record<string, unknown>, current?: Details): Promise<Details> {
    const name = 'name' in input || !current ? text(input.name) : current.name;
    if (name === '') throw new BadRequestException('Give the project a name.');
    if (name.length > 200) throw new BadRequestException('A project name can be at most 200 characters.');
    const purpose = 'purpose' in input || !current ? text(input.purpose) : current.purpose;
    if (purpose === '') throw new BadRequestException("Describe the project's purpose.");
    if (purpose.length > 4000) throw new BadRequestException('The purpose can be at most 4000 characters.');
    refuseSecretsIn(purpose);
    const owning = 'owningDepartmentId' in input || !current ? input.owningDepartmentId : current.owningDepartmentId;
    const contributing = 'contributingDepartmentIds' in input || !current ? (input.contributingDepartmentIds ?? []) : current.contributingDepartmentIds;
    if (!Array.isArray(contributing) || !contributing.every((d) => typeof d === 'string')) {
      throw new BadRequestException('contributingDepartmentIds must be a list of department ids.');
    }
    const active = async (id: unknown) =>
      typeof id === 'string' &&
      UUID.test(id) &&
      ((await db.query(`SELECT 1 FROM departments WHERE id = $1 AND status = 'active'`, [id])).rowCount ?? 0) > 0;
    // A department retired later stays on the projects that already use it; only ones being added must be active.
    const kept = (id: unknown) => current !== undefined && (id === current.owningDepartmentId || current.contributingDepartmentIds.includes(id as string));
    if (!kept(owning) && !(await active(owning))) throw new BadRequestException('Choose an active owning department.');
    const contributingIds = [...new Set(contributing as string[])];
    if (contributingIds.includes(owning as string)) throw new BadRequestException('A contributing department cannot also be the owning department.');
    for (const d of contributingIds) if (!kept(d) && !(await active(d))) throw new BadRequestException('Choose active contributing departments.');
    const plannedEndIn = 'plannedEnd' in input || !current ? input.plannedEnd : current.plannedEnd;
    let plannedEnd: string | null = null;
    if (plannedEndIn !== undefined && plannedEndIn !== null && plannedEndIn !== '') {
      if (!isCalendarDate(plannedEndIn)) throw new BadRequestException('The planned end must be a date in the form YYYY-MM-DD.');
      plannedEnd = plannedEndIn;
    }
    return { name, purpose, owningDepartmentId: owning as string, contributingDepartmentIds: contributingIds, plannedEnd };
  }

  async create(user: AuthUser, input: Record<string, unknown>) {
    const at = this.now();
    const client = await this.pool.connect();
    let id: string;
    try {
      await client.query('BEGIN');
      const first = await this.beginCreation(client, user);
      const d = await this.cleanDetails(client, input);
      const templateId = await this.chooseTemplate(client, input.stageTemplateId);
      // The project keeps its own copy of the template's stages (spec 14): later template edits never reach it.
      const stages = (
        await client.query<{ name: string; substages: string[] }>(`SELECT name, substages FROM stage_template_stages WHERE template_id = $1 ORDER BY position, id`, [templateId])
      ).rows;
      id = await this.insertNew(client, user, at, { details: d, stages, stageTemplateId: templateId, first });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    return this.detail(user, id);
  }

  /** Takes the creating lock and checks that this person may create a project now. True for the very first project. */
  async beginCreation(c: PoolClient, user: AuthUser): Promise<boolean> {
    // One project at a time decides "first", so two administrators racing cannot both skip the rule.
    await c.query(`SELECT pg_advisory_xact_lock(hashtext('kainow.projects.create'))`);
    const first = ((await c.query(`SELECT 1 FROM projects LIMIT 1`)).rowCount ?? 0) === 0;
    if (first && user.role !== 'enterprise_administrator') throw new ForbiddenException('An Enterprise Administrator creates the first project.');
    await this.assertMayCreate(user);
    return first;
  }

  /** Later projects are created by eligible existing users; eligibility is checked again now (V1.0 D01). */
  async assertMayCreate(user: AuthUser): Promise<void> {
    if (user.role !== 'enterprise_administrator' && !(await this.org.isEligible(user.email))) {
      throw new ForbiddenException('Your email domain is no longer eligible; ask an Administrator.');
    }
  }

  /** Writes a new Draft project from checked details, in its first stage, with its creator as Project Manager (not for the first project). */
  async insertNew(
    c: PoolClient,
    user: AuthUser,
    at: Date,
    p: { details: Details; stages: Array<{ name: string; substages: string[] }>; stageTemplateId: string | null; first: boolean; copiedFromId?: string },
  ): Promise<string> {
    const id = uuidv7(at.getTime());
    const d = p.details;
    await c.query(
      `INSERT INTO projects (id, name, purpose, owning_department_id, planned_end, status, created_by, created_at, stage_template_id, copied_from_id)
       VALUES ($1, $2, $3, $4, $5, 'draft', $6, $7, $8, $9)`,
      [id, d.name, d.purpose, d.owningDepartmentId, d.plannedEnd, user.id, at, p.stageTemplateId, p.copiedFromId ?? null],
    );
    for (const dep of d.contributingDepartmentIds) {
      await c.query(`INSERT INTO project_departments (project_id, department_id) VALUES ($1, $2)`, [id, dep]);
    }
    for (const [i, s] of p.stages.entries()) {
      await c.query(
        `INSERT INTO project_stages (id, project_id, position, name, substages, status, added_by, added_at) VALUES ($1, $2, $3, $4, $5, 'active', $6, $7)`,
        [uuidv7(at.getTime()), id, i + 1, s.name, s.substages, user.id, at],
      );
    }
    await c.query(
      `INSERT INTO project_stage_periods (id, project_id, stage, started_at, started_by) VALUES ($1, $2, $3, $4, $5)`,
      [uuidv7(at.getTime()), id, p.stages[0].name, at, user.id],
    );
    // The administrator who creates the first project appoints its roles; anyone else becomes its first PM.
    if (!p.first) {
      const m = uuidv7(at.getTime());
      const today = this.access.today();
      await c.query(`INSERT INTO memberships (id, project_id, user_id, role, starts_on) VALUES ($1, $2, $3, 'pm', $4)`, [m, id, user.id, today]);
      await c.query(
        `INSERT INTO membership_events (id, membership_id, kind, new_starts_on, actor_id, reason, at) VALUES ($1, $2, 'appointed', $3, $4, 'Created the project', $5)`,
        [uuidv7(at.getTime()), m, today, user.id, at],
      );
    }
    await writeAudit(c, {
      at, action: 'project.created', actorUserId: user.id, subjectType: 'project', subjectId: id,
      detail: { first: p.first, stageTemplateId: p.stageTemplateId, ...(p.copiedFromId ? { copiedFromId: p.copiedFromId } : {}) },
    });
    return id;
  }

  /**
   * The active template a new project copies: the one asked for, else the active template named General, else the first
   * active one. Its row is locked so it cannot be retired or changed while it is copied.
   */
  private async chooseTemplate(db: PoolClient, requested: unknown): Promise<string> {
    if (requested === undefined || requested === null || requested === '') {
      const { rows } = await db.query(
        `SELECT id FROM stage_templates WHERE status = 'active' ORDER BY (lower(name) = 'general') DESC, position, id LIMIT 1 FOR SHARE`,
      );
      if (!rows[0]) throw new BadRequestException(NOT_OFFERED);
      return rows[0].id;
    }
    if (typeof requested !== 'string' || !UUID.test(requested)) throw new BadRequestException(NOT_OFFERED);
    const { rowCount } = await db.query(`SELECT 1 FROM stage_templates WHERE id = $1 AND status = 'active' FOR SHARE`, [requested]);
    if (!rowCount) throw new BadRequestException(NOT_OFFERED);
    return requested;
  }

  /** The person's own projects; for an administrator also every project's name, status and role holders. */
  async list(user: AuthUser) {
    const ids = await this.access.visibleProjectIds(user.id);
    const projects = [];
    const summaries = await this.summaries(ids);
    for (const id of ids) {
      // A held membership or a suspended grant leaves a candidate with no access: it is simply not listed.
      const ctx = await this.access.load(id, user);
      if (!ctx || (ctx.roles.length === 0 && ctx.grantKinds.length === 0)) continue;
      const p = summaries.get(id) as ProjectSummary;
      projects.push({
        ...p,
        myRoles: ctx.roles,
        access: ctx.roles.length === 0 ? ctx.grantKinds[0] : null,
        missingAccountability: ctx.missingAccountability,
        onHold: managesRoles(ctx) && ctx.onHold,
        ...(await loadArchiveState(this.pool, id, ctx.project.status, ctx.today)),
        myOpenTasks: (
          await this.pool.query(
            `SELECT count(*)::int AS n FROM tasks t WHERE t.project_id = $1 AND t.assignee_id = $2 AND t.status NOT IN ('completed', 'cancelled') AND ${liveRecordSql('t')}`,
            [id, user.id],
          )
        ).rows[0].n as number,
      });
    }
    projects.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    if (user.role !== 'enterprise_administrator') return { projects };
    const { rows } = await this.pool.query(
      `SELECT p.id, p.name, p.status, d.name AS "owningDepartment",
              COALESCE(json_agg(json_build_object(
                'displayName', u.display_name, 'role', m.role, 'startsOn', to_char(m.starts_on, 'YYYY-MM-DD'),
                'expiresOn', to_char(m.expires_on, 'YYYY-MM-DD'), 'revokedAt', m.revoked_at, 'heldAt', m.held_at, 'restoredAt', m.restored_at
              ) ORDER BY m.starts_on, m.id) FILTER (WHERE m.id IS NOT NULL), '[]') AS members
         FROM projects p JOIN departments d ON d.id = p.owning_department_id
         LEFT JOIN memberships m ON m.project_id = p.id LEFT JOIN users u ON u.id = m.user_id
        GROUP BY p.id, d.name ORDER BY lower(p.name), p.id`,
    );
    const today = this.access.today();
    const all = rows.map(({ members, ...r }) => ({
      ...r,
      roleHolders: (members as Array<MembershipRow & { displayName: string; heldAt: string | null; restoredAt: string | null; revokedAt: string | null }>)
        .map((m) => ({
          ...m,
          revokedAt: m.revokedAt ? new Date(m.revokedAt) : null,
          heldAt: m.heldAt ? new Date(m.heldAt) : null,
          restoredAt: m.restoredAt ? new Date(m.restoredAt) : null,
        }))
        .map((m) => ({ displayName: m.displayName, role: m.role, state: membershipState(m, today) }))
        .filter((m) => m.state === 'active' || m.state === 'scheduled'),
    }));
    return { projects, all };
  }

  /**
   * Name, status, department and latest stage; for a Deferred or Closed project also since when (UTC+8) and why (D138).
   * Only for people with a role or a grant in the project, who read the same reason and outcome in its detail: the
   * administrator's list of every project does not use it.
   */
  private async summaries(ids: string[]): Promise<Map<string, ProjectSummary>> {
    const { rows } = await this.pool.query<ProjectSummary>(
      `SELECT p.id, p.name, p.status, d.name AS "owningDepartment",
              (SELECT json_build_object('stage', s.stage, 'substage', s.substage) FROM project_stage_periods s
                WHERE s.project_id = p.id AND s.ended_at IS NULL) AS stage,
              CASE WHEN p.status = 'deferred' AND x."on" IS NOT NULL THEN json_build_object('on', x."on", 'reason', x.reason) END AS deferred,
              CASE WHEN p.status = 'closed' AND x."on" IS NOT NULL THEN json_build_object('on', x."on", 'outcome', p.closure_outcome) END AS closed
         FROM projects p JOIN departments d ON d.id = p.owning_department_id
         LEFT JOIN LATERAL (
           SELECT to_char(t.at AT TIME ZONE 'Asia/Kuala_Lumpur', 'YYYY-MM-DD') AS "on", t.reason FROM project_transitions t
            WHERE t.project_id = p.id AND t.to_status = p.status ORDER BY t.at DESC, t.id DESC LIMIT 1
         ) x ON p.status IN ('deferred', 'closed')
        WHERE p.id = ANY($1::uuid[])`,
      [ids],
    );
    return new Map(rows.map((r) => [r.id, r]));
  }

  async detail(user: AuthUser, id: string) {
    const ctx = await this.access.context(user, id);
    return { project: await this.render(ctx, user) };
  }

  private async recordDelegation(projectId: string) {
    const d = await openRecordDelegation(this.pool, projectId);
    return d === null ? null : { pm: d.pm, by: d.by, reason: d.reason, at: d.at };
  }

  private async render(ctx: ProjectContext, user: AuthUser) {
    const id = ctx.project.id;
    const { copiedFromId, ...p } = (
      await this.pool.query(
        `SELECT p.id, p.name, p.purpose, to_char(p.planned_end, 'YYYY-MM-DD') AS "plannedEnd", p.status, p.closure_outcome AS "closureOutcome",
                p.created_at AS "createdAt", p.copied_from_id AS "copiedFromId", json_build_object('id', d.id, 'name', d.name) AS "owningDepartment",
                CASE WHEN t.id IS NULL THEN NULL ELSE json_build_object('id', t.id, 'name', t.name) END AS "stageTemplate"
           FROM projects p JOIN departments d ON d.id = p.owning_department_id LEFT JOIN stage_templates t ON t.id = p.stage_template_id
          WHERE p.id = $1`,
        [id],
      )
    ).rows[0];
    const contributing = (
      await this.pool.query(
        `SELECT d.id, d.name FROM project_departments pd JOIN departments d ON d.id = pd.department_id WHERE pd.project_id = $1 ORDER BY lower(d.name)`,
        [id],
      )
    ).rows;
    const storedPeriods = (
      await this.pool.query<{ stage: string; substage: string | null; startedAt: Date; endedAt: Date | null; reason: string | null }>(
        `SELECT stage, substage, started_at AS "startedAt", ended_at AS "endedAt", reason FROM project_stage_periods
          WHERE project_id = $1 ORDER BY started_at, id`,
        [id],
      )
    ).rows;
    const transitions = (
      await this.pool.query(
        `SELECT t.from_status AS "from", t.to_status AS "to", t.reason, t.closure_outcome AS outcome, t.fast_track AS "fastTrack", t.at,
                u.display_name AS "actor"
           FROM project_transitions t JOIN users u ON u.id = t.actor_id WHERE t.project_id = $1 ORDER BY t.at, t.id`,
        [id],
      )
    ).rows;
    const stagePeriods = clipPeriods(storedPeriods, transitions);
    // The project team sees pending invitations (V1.0 invitation rules, section 4); never the token.
    const now = this.now();
    const invitations = (
      await this.pool.query(
        `SELECT id, email, role, kind, to_char(starts_on, 'YYYY-MM-DD') AS "startsOn", to_char(expires_on, 'YYYY-MM-DD') AS "expiresOn",
                issued_at AS "issuedAt", expires_at AS "expiresAt",
                CASE WHEN status = 'invited' AND expires_at <= $2 THEN 'expired' ELSE status END AS status
           FROM invitations WHERE project_id = $1 AND status <> 'replaced' ORDER BY issued_at DESC, id`,
        [id, now],
      )
    ).rows;
    const copiedFrom: CopiedFrom = (await copiedFromViews(this.pool, this.access, user, [copiedFromId]))(copiedFromId);
    return {
      ...p,
      copiedFrom,
      invitations,
      contributingDepartments: contributing,
      // The latest stage, also while Deferred or Closed (resuming offers it); `stopped` says it is not under way.
      stage: stagePeriods.find((_, i) => storedPeriods[i].endedAt === null) ?? null,
      stagePeriods,
      stages: await loadStages(this.pool, id),
      stageChanges: await loadStageChanges(this.pool, id),
      transitions,
      memberships: ctx.rows.map((m) => ({
        id: m.id,
        userId: m.userId,
        displayName: m.displayName,
        email: m.email,
        role: m.role,
        startsOn: m.startsOn,
        expiresOn: m.expiresOn,
        state: membershipState(m, ctx.today),
        ...(managesRoles(ctx) && membershipState(m, ctx.today) === 'on_hold' ? { holdReason: m.holdReason ?? null } : {}),
      })),
      myRoles: ctx.roles,
      isAdmin: ctx.isAdmin,
      openReviewFlags: Number((await this.pool.query(`SELECT count(*) AS n FROM review_flags f WHERE f.project_id = $1 AND f.cleared_at IS NULL AND ${liveRecordRefSql('f.record_kind', 'f.record_id')}`, [id])).rows[0].n),
      missingAccountability: ctx.missingAccountability,
      missingRoles: ctx.missingRoles,
      onHold: managesRoles(ctx) && ctx.onHold,
      access: ctx.roles.length === 0 && ctx.grantKinds.length > 0 ? ctx.grantKinds[0] : null,
      // The viewer's own Active grant includes Inspect Deleted Content: the project page shows its Deleted items list.
      inspectDeleted: ctx.inspectDeleted === true,
      grants: await this.grantsFor(ctx),
      recordDeletionDelegation: await this.recordDelegation(id),
      ...(await loadArchiveState(this.pool, id, ctx.project.status, ctx.today)),
    };
  }

  async archive(user: AuthUser, id: string, kind: 'archived' | 'unarchived', input: Record<string, unknown>) {
    const at = this.now();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const ctx = await this.access.authorize(user, 'project.archive', id, client, true);
      const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
      readReason(reason, 'a reason', { refusal: 'A reason is required.' });
      const current = await loadArchiveState(client, id, ctx.project.status, ctx.today);
      if (kind === 'archived' && current.archived) throw new ConflictException('This project is already archived.');
      if (kind === 'unarchived' && !current.archived) throw new ConflictException('This project is not archived.');
      await client.query(`INSERT INTO project_archive_events (id, project_id, kind, actor_id, reason, at) VALUES ($1, $2, $3, $4, $5, $6)`, [
        uuidv7(at.getTime()), id, kind, user.id, reason, at,
      ]);
      await writeAudit(client, { at, action: `project.${kind}`, actorUserId: user.id, subjectType: 'project', subjectId: id });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    return this.detail(user, id);
  }

  /**
   * The Administrator moves a project to another owning department (Consolidated Specification §3): the same transfer
   * as `PUT /projects/:id/owning-department` (spec 10, D108), answered with the project's details as before.
   */
  async moveDepartment(user: AuthUser, id: string, input: Record<string, unknown>) {
    await this.transfers.transferDepartment(user, id, { departmentId: input.departmentId, reason: input.reason, folderChoice: input.folderChoice });
    return this.detail(user, id);
  }


  /** Grant managers and the Administrator see every grant; anyone else only their own. */
  private async grantsFor(ctx: ProjectContext) {
    const all = managesGrants(ctx);
    const { rows } = await this.pool.query(
      `SELECT g.id, g.kind, g.purpose, g.scope, to_char(g.starts_on, 'YYYY-MM-DD') AS "startsOn", to_char(g.expires_on, 'YYYY-MM-DD') AS "expiresOn",
              json_build_object('id', u.id, 'displayName', u.display_name, 'email', u.email) AS "user",
              r.display_name AS "requestedBy", g.requested_by AS "requestedById", d.display_name AS "decidedBy", g.decision_reason AS "decisionReason",
              g.suspend_reason AS "suspendReason", g.revoke_reason AS "revokeReason", g.inspect_deleted AS "inspectDeleted"
         FROM access_grants g JOIN users u ON u.id = g.user_id JOIN users r ON r.id = g.requested_by LEFT JOIN users d ON d.id = g.decided_by
        WHERE g.project_id = $1 ORDER BY g.requested_at, g.id`,
      [ctx.project.id],
    );
    const viewer = ctx.viewerId;
    return rows
      .map(({ requestedById, ...r }) => {
        const state = grantState(ctx.grants.find((g) => g.id === r.id)!, ctx.today);
        // Only a manager who is neither the grantee nor the recorder decides a waiting request.
        const mayDecide = all && state === 'requested' && r.user.id !== viewer && requestedById !== viewer;
        // 'self': the viewer's own access, which they may not extend or restore.
        return { ...r, state, mayDecide, self: r.user.id === viewer };
      })
      .filter((r) => all || r.user.id === viewer);
  }

  async edit(user: AuthUser, id: string, input: Record<string, unknown>) {
    const at = this.now();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.access.authorize(user, 'project.edit', id, client, true);
      const cur = (
        await client.query(
          `SELECT name, purpose, owning_department_id AS "owningDepartmentId", to_char(planned_end, 'YYYY-MM-DD') AS "plannedEnd",
                  ARRAY(SELECT department_id::text FROM project_departments WHERE project_id = $1) AS "contributingDepartmentIds"
             FROM projects WHERE id = $1`,
          [id],
        )
      ).rows[0] as Details;
      const d = await this.cleanDetails(client, input, cur);
      // Consolidated Specification §3: only the Enterprise Administrator transfers departmental ownership.
      if (d.owningDepartmentId !== cur.owningDepartmentId) {
        throw new ForbiddenException('Only an Enterprise Administrator can move a project to another owning department.');
      }
      await client.query(`UPDATE projects SET name = $2, purpose = $3, owning_department_id = $4, planned_end = $5 WHERE id = $1`, [
        id, d.name, d.purpose, d.owningDepartmentId, d.plannedEnd,
      ]);
      await client.query(`DELETE FROM project_departments WHERE project_id = $1`, [id]);
      for (const dep of d.contributingDepartmentIds) {
        await client.query(`INSERT INTO project_departments (project_id, department_id) VALUES ($1, $2)`, [id, dep]);
      }
      const changed = (Object.keys(d) as Array<keyof Details>).filter((k) => JSON.stringify(d[k]) !== JSON.stringify(cur[k]));
      await writeAudit(client, { at, action: 'project.edited', actorUserId: user.id, subjectType: 'project', subjectId: id, detail: { changed } });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    return this.detail(user, id);
  }

  async transition(user: AuthUser, id: string, input: Record<string, unknown>) {
    const to = input.to as ProjectStatus;
    if (!PROJECT_STATUSES.includes(to)) throw new BadRequestException('Choose the status to move to.');
    const outcome = (input.outcome ?? null) as ClosureOutcome | null;
    if (outcome !== null && !OUTCOMES.includes(outcome)) throw new BadRequestException('Choose a closure outcome.');
    const reason = optionalText(input.reason);
    refuseSecretsIn(reason);
    const stage = optionalText(input.stage);
    const objectivesMet = input.objectivesMet === true;
    const at = this.now();
    let notified = 0;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const ctx = await this.access.context(user, id, client, true);
      const from = ctx.project.status;
      const delegation = to === 'closed' ? await openDelegation(client, id) : null;
      const delegatedPm = delegation !== null && delegation.pmUserId === user.id && ctx.roles.includes('pm');
      const verdict = checkTransition({
        from,
        to,
        roles: ctx.roles,
        isAdmin: ctx.isAdmin,
        reason,
        outcome,
        stage,
        stages: (await loadStages(client, id)).filter((s) => s.status === 'active').map((s) => s.name),
        missingAccepted: requiredRolesCheck(ctx.rows, ctx.today, 'accepted').missing,
        missingActive: requiredRolesCheck(ctx.rows, ctx.today, 'active').missing,
        separationOk: separationCheck(ctx.rows, ctx.today).ok,
        delegatedPm,
      });
      if (!verdict.allowed) {
        // "Only …" names who may act: a permission refusal. Everything else is the request or the project's state.
        if (verdict.reason.startsWith('Only ')) throw new ForbiddenException(verdict.reason);
        throw new ConflictException(verdict.reason);
      }
      if (to === 'closed') {
        // Every open item accounted for (spec §6); the dispositions take effect and become final with the transition.
        await assertClosureReady(client, id, { outcome, objectivesMet });
        await finaliseClosure(client, id, user.id, at);
        if (delegatedPm && !ctx.roles.some((r) => r === 'owner' || r === 'sponsor')) {
          const recipients = new Map(
            ctx.rows
              .filter((m) => (m.role === 'owner' || m.role === 'sponsor') && membershipState(m, ctx.today) === 'active' && m.userId !== user.id)
              .map((m) => [m.email, m.userId] as const),
          );
          const name = (await client.query(`SELECT name FROM projects WHERE id = $1`, [id])).rows[0].name as string;
          const outcomeLabel = { delivered: 'Delivered', partially_delivered: 'Partially Delivered', abandoned: 'Abandoned' }[outcome as ClosureOutcome];
          const mail = closureNoticeEmail(name, outcomeLabel, `${this.config.appUrl}/#/projects/${id}`);
          // Queued in this transaction, so the notice exists exactly when the closure does.
          for (const [email, userId] of recipients) {
            await writeOutbox(client, {
              toUserId: userId,
              toAddress: email,
              subject: mail.subject,
              body: mail.body,
              kind: 'closure_notice',
              projectId: id,
              initiatedBy: 'person',
              initiatedByUser: user.id,
              relevance: { kind: 'none', scope: 'account' },
              now: at,
            });
            notified += 1;
          }
        }
      }
      await client.query(`UPDATE projects SET status = $2, closure_outcome = $3 WHERE id = $1`, [id, to, to === 'closed' ? outcome : null]);
      // Outstanding tasks need a new authorised date before they restart (spec §7).
      const marked = to === 'deferred' || to === 'closed' ? ((await client.query(`SELECT mark_deadline_review($1, $2) AS n`, [id, user.id])).rows[0].n as number) : 0;
      await client.query(
        `INSERT INTO project_transitions (id, project_id, from_status, to_status, actor_id, reason, closure_outcome, fast_track, at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [uuidv7(at.getTime()), id, from, to, user.id, reason, to === 'closed' ? outcome : null, from === 'draft' && to === 'active', at],
      );
      // Resuming or reopening starts a new period in the chosen stage; earlier periods are kept.
      if (to === 'active' && (from === 'deferred' || from === 'closed')) {
        await this.startStage(client, id, stage as string, null, reason, user.id, at);
      }
      await writeAudit(client, {
        at,
        action: 'project.transition',
        actorUserId: user.id,
        subjectType: 'project',
        subjectId: id,
        detail: { from, to, ...(marked > 0 ? { markedForDeadlineReview: marked } : {}), ...(to === 'closed' ? { outcome, objectivesMet, ...(delegatedPm ? { delegatedPm } : {}) } : {}) },
      });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    if (notified > 0) {
      try {
        await this.nudge.nudge();
      } catch {
        // The notices are committed; the scheduled email tick still sends them.
        console.error('Could not nudge the email worker after a closure; the scheduled tick still sends the notices');
      }
    }
    return this.detail(user, id);
  }

  async changeStage(user: AuthUser, id: string, input: Record<string, unknown>) {
    const stage = optionalText(input.stage);
    const substage = optionalText(input.substage);
    const at = this.now();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.access.authorize(user, 'project.stage', id, client, true);
      // Any of the project's own active stages may be next (stages are not sequential, C09).
      // Two names can be equal once a credential was removed from each: the one with the substage asked for is meant.
      const named = (await loadStages(client, id)).filter((s) => s.status === 'active' && s.name === stage);
      const chosen = named.find((s) => substage !== null && s.substages.includes(substage)) ?? named[0];
      if (stage === null || !chosen) throw new BadRequestException('Choose a stage.');
      if (substage !== null && !chosen.substages.includes(substage)) throw new BadRequestException(`Choose a substage of ${stage}.`);
      refuseSecretsIn(input.reason);
      await this.startStage(client, id, stage, substage, optionalText(input.reason), user.id, at);
      await writeAudit(client, { at, action: 'project.stage', actorUserId: user.id, subjectType: 'project', subjectId: id, detail: { stageId: chosen.id } });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    return this.detail(user, id);
  }

  /** `{ name, substages?, position, reason }`: a new active stage at `position` (1 = first) in the project's list. */
  async addStage(user: AuthUser, id: string, input: Record<string, unknown>) {
    const name = readStageName(input.name, `Give the stage a name of 1 to ${TEMPLATE_LIMITS.nameChars} characters.`);
    const rawSubs = input.substages === undefined || input.substages === null ? [] : input.substages;
    if (!Array.isArray(rawSubs)) throw new BadRequestException(`Give the substages of ${name} as a list.`);
    if (rawSubs.length > TEMPLATE_LIMITS.substagesPerStage) throw new BadRequestException(`A stage can have at most ${TEMPLATE_LIMITS.substagesPerStage} substages.`);
    const substages = rawSubs.map((x) => readStageName(x, `Give each substage a name of 1 to ${TEMPLATE_LIMITS.nameChars} characters.`));
    if (new Set(substages.map((x) => x.toLowerCase())).size !== substages.length) throw new BadRequestException('Substage names must differ within a stage.');
    const position = input.position;
    const reason = readReason(input.reason, 'a reason', { max: TEMPLATE_LIMITS.reasonChars });
    return this.changeStages(user, id, reason, async (c, stages, at) => {
      if (typeof position !== 'number' || !Number.isInteger(position) || position < 1 || position > stages.length + 1) {
        throw new BadRequestException(`Choose a place from 1 to ${stages.length + 1}.`);
      }
      if (stages.some((s) => s.name.toLowerCase() === name.toLowerCase())) throw new BadRequestException(SAME_STAGE_NAME);
      refuseTooManyStages(stages);
      const stageId = uuidv7(at.getTime());
      await c.query(
        `INSERT INTO project_stages (id, project_id, position, name, substages, status, added_by, added_at) VALUES ($1, $2, $3, $4, $5, 'active', $6, $7)`,
        [stageId, id, position, name, substages, user.id, at],
      );
      const order = stages.map((s) => s.id);
      order.splice(position - 1, 0, stageId);
      await this.writeOrder(c, order);
      return { kind: 'added', stageId, action: 'project.stage_added', detail: { stageId, position } };
    });
  }

  /** `{ ids, reason }`: every one of the project's stages (retired ones too), once, in the new order. */
  async reorderStages(user: AuthUser, id: string, input: Record<string, unknown>) {
    const ids = input.ids;
    const reason = readReason(input.reason, 'a reason', { max: TEMPLATE_LIMITS.reasonChars });
    return this.changeStages(user, id, reason, async (c, stages) => {
      const known = new Set(stages.map((s) => s.id));
      if (!Array.isArray(ids) || ids.length !== stages.length || new Set(ids).size !== ids.length || !ids.every((x) => known.has(x))) {
        throw new BadRequestException('List every stage of the project once.');
      }
      await this.writeOrder(c, ids as string[]);
      return { kind: 'reordered', stageId: null, action: 'project.stages_reordered', detail: { stages: stages.length } };
    });
  }

  /** Retires a stage so it can no longer be chosen, or brings it back; past periods keep its name either way. */
  async setStageStatus(user: AuthUser, id: string, stageId: string, status: 'active' | 'retired', input: Record<string, unknown>) {
    const reason = readReason(input.reason, 'a reason', { max: TEMPLATE_LIMITS.reasonChars });
    return this.changeStages(user, id, reason, async (c, stages, at) => {
      const stage = stages.find((s) => s.id === stageId);
      if (!stage) throw new NotFoundException('That stage is not in this project.');
      if (stage.status === status) throw new ConflictException(status === 'retired' ? 'That stage is already retired.' : 'That stage is not retired.');
      if (status === 'retired') {
        const current = (await c.query(`SELECT stage FROM project_stage_periods WHERE project_id = $1 AND ended_at IS NULL`, [id])).rows[0]?.stage;
        if (current === stage.name) throw new ConflictException('This is the current stage. Move to another stage first.');
      } else refuseTooManyStages(stages);
      await c.query(`UPDATE project_stages SET status = $2, retired_by = $3, retired_at = $4 WHERE id = $1`, [
        stageId, status, status === 'retired' ? user.id : null, status === 'retired' ? at : null,
      ]);
      return { kind: status === 'retired' ? 'retired' : 'restored', stageId, action: status === 'retired' ? 'project.stage_retired' : 'project.stage_restored', detail: { stageId } };
    });
  }

  /**
   * `{ name, reason }`: a new name for a stage, retired or not, in its current and past periods too (D137). A period
   * holds only the name, so where another stage has the same one (possible only after a credential was removed from
   * both) the periods cannot be told apart and stay as they are. The lock of changeStages holds the project row, as
   * changing the stage and reopening do, so no period can be started under the old name meanwhile.
   */
  async renameStage(user: AuthUser, id: string, stageId: string, input: Record<string, unknown>) {
    const name = readStageName(input.name, `Give the stage a name of 1 to ${TEMPLATE_LIMITS.nameChars} characters.`);
    const reason = readReason(input.reason, 'a reason', { max: TEMPLATE_LIMITS.reasonChars });
    return this.changeStages(user, id, reason, async (c, stages) => {
      const stage = stages.find((s) => s.id === stageId);
      if (!stage) throw new NotFoundException('That stage is not in this project.');
      if (stage.name === name) throw new BadRequestException('Give the stage a different name.');
      const others = stages.filter((s) => s.id !== stageId);
      if (others.some((s) => s.name.toLowerCase() === name.toLowerCase())) throw new BadRequestException(SAME_STAGE_NAME);
      await c.query(`UPDATE project_stages SET name = $2 WHERE id = $1`, [stageId, name]);
      if (!others.some((s) => s.name === stage.name)) {
        await c.query(`UPDATE project_stage_periods SET stage = $3 WHERE project_id = $1 AND stage = $2`, [id, stage.name, name]);
      }
      return { kind: 'renamed', stageId, action: 'project.stage_renamed', detail: { stageId } };
    });
  }

  /**
   * Delegated to the Project Manager, Owner and Sponsors while the project is open. Each change is recorded in the
   * project's stage history with its reason and the list before and after; the audit event holds ids and counts only.
   */
  private async changeStages(
    user: AuthUser,
    id: string,
    reason: string,
    fn: (c: PoolClient, stages: ProjectStage[], at: Date) => Promise<{ kind: StageChange['kind']; stageId: string | null; action: string; detail: Record<string, unknown> }>,
  ) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.access.authorize(user, 'project.stages', id, client, true);
      // Read once the lock is held, so the history is in the order the changes took effect.
      const at = this.now();
      const previous = await loadStages(client, id);
      const { kind, stageId, action, detail } = await fn(client, previous, at);
      await client.query(
        `INSERT INTO project_stage_changes (id, project_id, kind, stage_id, actor_id, at, reason, previous, next) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [uuidv7(at.getTime()), id, kind, stageId, user.id, at, reason, recorded(previous), recorded(await loadStages(client, id))],
      );
      await writeAudit(client, { at, action, actorUserId: user.id, subjectType: 'project', subjectId: id, detail });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      // The database compares names by its own rules, which differ from JavaScript's for a few letters.
      if ((err as { constraint?: string }).constraint === 'project_stages_name') throw new BadRequestException(SAME_STAGE_NAME);
      throw err;
    } finally {
      client.release();
    }
    return this.detail(user, id);
  }

  private async writeOrder(c: PoolClient, ids: string[]) {
    for (const [i, stageId] of ids.entries()) await c.query(`UPDATE project_stages SET position = $2 WHERE id = $1`, [stageId, i + 1]);
  }

  private async startStage(db: PoolClient, id: string, stage: string, substage: string | null, reason: string | null, userId: string, at: Date) {
    await db.query(`UPDATE project_stage_periods SET ended_at = $2 WHERE project_id = $1 AND ended_at IS NULL`, [id, at]);
    await db.query(
      `INSERT INTO project_stage_periods (id, project_id, stage, substage, started_at, started_by, reason) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [uuidv7(at.getTime()), id, stage, substage, at, userId, reason],
    );
  }
}
