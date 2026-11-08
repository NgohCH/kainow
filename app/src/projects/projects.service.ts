import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { writeAudit } from '../audit/audit';
import { CLOCK, type AuthUser, type Clock } from '../auth/tokens';
import { uuidv7 } from '../common/uuid7';
import { PG_POOL } from '../db/database.module';
import { isCalendarDate } from '../extraction/due';
import { type ProjectContext, ProjectAccess } from './access.service';
import { type ClosureOutcome, STAGES, checkTransition } from './lifecycle';
import { membershipState, requiredRolesCheck, separationCheck } from './membership';
import { type ProjectStatus, PROJECT_STATUSES } from './matrix';

/** The documents' optional default substages; projects may leave them unused. */
export const SUBSTAGES: Readonly<Record<string, readonly string[]>> = {
  Initiation: ['Define Purpose', 'Identify Participants', 'Confirm Accountability'],
  Planning: ['Define Scope', 'Break Down Work', 'Identify Resources', 'Approve Plan'],
  Execution: ['In Progress', 'Monitoring & Follow-up'],
  'Review & Acceptance': ['Review Deliverables', 'Resolve Outstanding Items', 'Confirm Acceptance'],
  Closure: ['Record Outcome', 'Handover', 'Close Project'],
};

const OUTCOMES: readonly ClosureOutcome[] = ['delivered', 'partially_delivered', 'abandoned'];

const text = (v: unknown): string => (typeof v === 'string' ? v.normalize('NFC').trim() : '');
const optionalText = (v: unknown): string | null => {
  const t = text(v);
  return t === '' ? null : t;
};

interface Details {
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
  ) {}

  /** Checks a full or partial set of project details. Missing keys keep `current` values. */
  private async cleanDetails(db: Pool | PoolClient, input: Record<string, unknown>, current?: Details): Promise<Details> {
    const name = 'name' in input || !current ? text(input.name) : current.name;
    if (name === '') throw new BadRequestException('Give the project a name.');
    if (name.length > 200) throw new BadRequestException('A project name can be at most 200 characters.');
    const purpose = 'purpose' in input || !current ? text(input.purpose) : current.purpose;
    if (purpose === '') throw new BadRequestException("Describe the project's purpose.");
    if (purpose.length > 4000) throw new BadRequestException('The purpose can be at most 4000 characters.');
    const owning = 'owningDepartmentId' in input || !current ? input.owningDepartmentId : current.owningDepartmentId;
    const contributing = 'contributingDepartmentIds' in input || !current ? (input.contributingDepartmentIds ?? []) : current.contributingDepartmentIds;
    if (!Array.isArray(contributing) || !contributing.every((d) => typeof d === 'string')) {
      throw new BadRequestException('contributingDepartmentIds must be a list of department ids.');
    }
    const active = async (id: unknown) =>
      typeof id === 'string' &&
      /^[0-9a-f-]{36}$/i.test(id) &&
      ((await db.query(`SELECT 1 FROM departments WHERE id = $1 AND status = 'active'`, [id])).rowCount ?? 0) > 0;
    if (!(await active(owning))) throw new BadRequestException('Choose an active owning department.');
    const contributingIds = [...new Set(contributing as string[])];
    if (contributingIds.includes(owning as string)) throw new BadRequestException('A contributing department cannot also be the owning department.');
    for (const d of contributingIds) if (!(await active(d))) throw new BadRequestException('Choose active contributing departments.');
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
      // One project at a time decides "first", so two administrators racing cannot both skip the rule.
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('kainow.projects.create'))`);
      const first = ((await client.query(`SELECT 1 FROM projects LIMIT 1`)).rowCount ?? 0) === 0;
      const isAdmin = user.role === 'enterprise_administrator';
      if (first && !isAdmin) throw new ForbiddenException('An Enterprise Administrator creates the first project.');
      const d = await this.cleanDetails(client, input);
      id = uuidv7(at.getTime());
      await client.query(
        `INSERT INTO projects (id, name, purpose, owning_department_id, planned_end, status, created_by, created_at)
         VALUES ($1, $2, $3, $4, $5, 'draft', $6, $7)`,
        [id, d.name, d.purpose, d.owningDepartmentId, d.plannedEnd, user.id, at],
      );
      for (const dep of d.contributingDepartmentIds) {
        await client.query(`INSERT INTO project_departments (project_id, department_id) VALUES ($1, $2)`, [id, dep]);
      }
      await client.query(
        `INSERT INTO project_stage_periods (id, project_id, stage, started_at, started_by) VALUES ($1, $2, 'Initiation', $3, $4)`,
        [uuidv7(at.getTime()), id, at, user.id],
      );
      // The administrator who creates the first project appoints its roles; anyone else becomes its first PM.
      if (!first) {
        const m = uuidv7(at.getTime());
        const today = this.access.today();
        await client.query(`INSERT INTO memberships (id, project_id, user_id, role, starts_on) VALUES ($1, $2, $3, 'pm', $4)`, [m, id, user.id, today]);
        await client.query(
          `INSERT INTO membership_events (id, membership_id, kind, new_starts_on, actor_id, reason, at) VALUES ($1, $2, 'appointed', $3, $4, 'Created the project', $5)`,
          [uuidv7(at.getTime()), m, today, user.id, at],
        );
      }
      await writeAudit(client, { at, action: 'project.created', actorUserId: user.id, subjectType: 'project', subjectId: id, detail: { first } });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    return this.detail(user, id);
  }

  /** The person's own projects; for an administrator also every project's name, status and role holders. */
  async list(user: AuthUser) {
    const ids = await this.access.visibleProjectIds(user.id);
    const projects = [];
    for (const id of ids) {
      const ctx = await this.access.context(user, id);
      const p = await this.summary(id);
      projects.push({ ...p, myRoles: ctx.roles, missingAccountability: ctx.missingAccountability });
    }
    projects.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    if (user.role !== 'enterprise_administrator') return { projects };
    const { rows } = await this.pool.query(
      `SELECT p.id, p.name, p.status, d.name AS "owningDepartment" FROM projects p JOIN departments d ON d.id = p.owning_department_id ORDER BY lower(p.name), p.id`,
    );
    const all = [];
    for (const r of rows) {
      const ctx = await this.access.load(r.id, user);
      all.push({
        ...r,
        roleHolders: (ctx?.rows ?? [])
          .map((m) => ({ displayName: m.displayName, role: m.role, state: membershipState(m, ctx!.today) }))
          .filter((m) => m.state === 'active' || m.state === 'scheduled'),
      });
    }
    return { projects, all };
  }

  private async summary(id: string) {
    const { rows } = await this.pool.query(
      `SELECT p.id, p.name, p.status, d.name AS "owningDepartment",
              (SELECT json_build_object('stage', s.stage, 'substage', s.substage) FROM project_stage_periods s
                WHERE s.project_id = p.id AND s.ended_at IS NULL) AS stage
         FROM projects p JOIN departments d ON d.id = p.owning_department_id WHERE p.id = $1`,
      [id],
    );
    return rows[0];
  }

  async detail(user: AuthUser, id: string) {
    const ctx = await this.access.context(user, id);
    return { project: await this.render(ctx) };
  }

  private async render(ctx: ProjectContext) {
    const id = ctx.project.id;
    const p = (
      await this.pool.query(
        `SELECT p.id, p.name, p.purpose, to_char(p.planned_end, 'YYYY-MM-DD') AS "plannedEnd", p.status, p.closure_outcome AS "closureOutcome",
                p.created_at AS "createdAt", json_build_object('id', d.id, 'name', d.name) AS "owningDepartment"
           FROM projects p JOIN departments d ON d.id = p.owning_department_id WHERE p.id = $1`,
        [id],
      )
    ).rows[0];
    const contributing = (
      await this.pool.query(
        `SELECT d.id, d.name FROM project_departments pd JOIN departments d ON d.id = pd.department_id WHERE pd.project_id = $1 ORDER BY lower(d.name)`,
        [id],
      )
    ).rows;
    const stagePeriods = (
      await this.pool.query(
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
    // The project team sees pending invitations (V1.0 invitation rules, section 4); never the token.
    const now = this.now();
    const invitations = (
      await this.pool.query(
        `SELECT id, email, role, to_char(starts_on, 'YYYY-MM-DD') AS "startsOn", to_char(expires_on, 'YYYY-MM-DD') AS "expiresOn",
                issued_at AS "issuedAt", expires_at AS "expiresAt",
                CASE WHEN status = 'invited' AND expires_at <= $2 THEN 'expired' ELSE status END AS status
           FROM invitations WHERE project_id = $1 AND status <> 'replaced' ORDER BY issued_at DESC, id`,
        [id, now],
      )
    ).rows;
    return {
      ...p,
      invitations,
      contributingDepartments: contributing,
      stage: stagePeriods.find((s) => s.endedAt === null) ?? null,
      stagePeriods,
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
      })),
      myRoles: ctx.roles,
      isAdmin: ctx.isAdmin,
      missingAccountability: ctx.missingAccountability,
      missingRoles: ctx.missingRoles,
    };
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
    const stage = optionalText(input.stage);
    const at = this.now();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const ctx = await this.access.context(user, id, client, true);
      const from = ctx.project.status;
      const verdict = checkTransition({
        from,
        to,
        roles: ctx.roles,
        isAdmin: ctx.isAdmin,
        reason,
        outcome,
        stage,
        requiredAccepted: requiredRolesCheck(ctx.rows, ctx.today, 'accepted').ok,
        requiredActive: requiredRolesCheck(ctx.rows, ctx.today, 'active').ok,
        separationOk: separationCheck(ctx.rows, ctx.today).ok,
      });
      if (!verdict.allowed) {
        // "Only …" names who may act: a permission refusal. Everything else is the request or the project's state.
        if (verdict.reason.startsWith('Only ')) throw new ForbiddenException(verdict.reason);
        throw new ConflictException(verdict.reason);
      }
      await client.query(`UPDATE projects SET status = $2, closure_outcome = $3 WHERE id = $1`, [id, to, to === 'closed' ? outcome : null]);
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
        detail: { from, to, ...(to === 'closed' ? { outcome } : {}) },
      });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    return this.detail(user, id);
  }

  async changeStage(user: AuthUser, id: string, input: Record<string, unknown>) {
    const stage = optionalText(input.stage);
    if (stage === null || !STAGES.includes(stage)) throw new BadRequestException('Choose a stage.');
    const substage = optionalText(input.substage);
    if (substage !== null && !SUBSTAGES[stage].includes(substage)) throw new BadRequestException(`Choose a substage of ${stage}.`);
    const at = this.now();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.access.authorize(user, 'project.stage', id, client, true);
      await this.startStage(client, id, stage, substage, optionalText(input.reason), user.id, at);
      await writeAudit(client, { at, action: 'project.stage', actorUserId: user.id, subjectType: 'project', subjectId: id, detail: { stage, substage } });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    return this.detail(user, id);
  }

  private async startStage(db: PoolClient, id: string, stage: string, substage: string | null, reason: string | null, userId: string, at: Date) {
    await db.query(`UPDATE project_stage_periods SET ended_at = $2 WHERE project_id = $1 AND ended_at IS NULL`, [id, at]);
    await db.query(
      `INSERT INTO project_stage_periods (id, project_id, stage, substage, started_at, started_by, reason) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [uuidv7(at.getTime()), id, stage, substage, at, userId, reason],
    );
  }
}
