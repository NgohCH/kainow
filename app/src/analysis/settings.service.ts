import { BadRequestException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { writeAudit } from '../audit/audit';
import { CLOCK, type AuthUser, type Clock } from '../auth/tokens';
import { uuidv7 } from '../common/uuid7';
import { PG_POOL } from '../db/database.module';
import { ProjectAccess } from '../projects/access.service';

type Db = Pool | PoolClient;

export interface EffectiveAnalysisSettings {
  automatic: boolean;
  quietMinutes: number;
  projectsMayChange: boolean;
  source: { automatic: 'organisation' | 'project'; quietMinutes: 'organisation' | 'project' };
}

export const DEFAULT_QUIET_MINUTES = 5;
const QUIET_MESSAGE = 'The quiet period must be a whole number of minutes from 5 to 30.';
const NOT_DELEGATED = 'The Administrator has not allowed projects to change automatic analysis.';
const NOT_EDITOR = 'Only a Project Manager, Owner or Sponsor can change the project’s automatic analysis settings.';
/** Who may edit a project's values (never the Deputy), and in which project states. */
const EDITORS = ['pm', 'owner', 'sponsor'];
const EDITABLE_STATES = ['draft', 'planned', 'active'];

interface OrgRow { automatic: boolean; quietMinutes: number; projectsMayChange: boolean }
interface ProjectRow { automatic: boolean | null; quietMinutes: number | null }

/** No row means the defaults: on, 5 minutes, projects may not change it. */
async function loadOrg(db: Db, lock = false): Promise<OrgRow> {
  const { rows } = await db.query(
    `SELECT automatic, quiet_minutes AS "quietMinutes", projects_may_change AS "projectsMayChange" FROM analysis_settings WHERE id = 1${lock ? ' FOR UPDATE' : ''}`,
  );
  return rows[0] ?? { automatic: true, quietMinutes: DEFAULT_QUIET_MINUTES, projectsMayChange: false };
}

async function loadProject(db: Db, projectId: string, lock = false): Promise<ProjectRow> {
  const { rows } = await db.query(
    `SELECT automatic, quiet_minutes AS "quietMinutes" FROM project_analysis_settings WHERE project_id = $1${lock ? ' FOR UPDATE' : ''}`,
    [projectId],
  );
  return rows[0] ?? { automatic: null, quietMinutes: null };
}

/**
 * Effective values for many projects with two queries in all (the tick covers every project with unanalysed messages).
 * Importable without Nest (the worker tick passes a plain Pool).
 */
export async function effectiveAnalysisSettingsMany(db: Db, projectIds: string[]): Promise<Map<string, EffectiveAnalysisSettings>> {
  const org = await loadOrg(db);
  const own = new Map<string, ProjectRow>();
  if (projectIds.length > 0) {
    const { rows } = await db.query(
      `SELECT project_id AS "projectId", automatic, quiet_minutes AS "quietMinutes" FROM project_analysis_settings WHERE project_id = ANY($1::uuid[])`,
      [projectIds],
    );
    for (const r of rows) own.set(r.projectId, r);
  }
  const out = new Map<string, EffectiveAnalysisSettings>();
  for (const id of projectIds) {
    const p = own.get(id) ?? { automatic: null, quietMinutes: null };
    out.set(id, {
      automatic: p.automatic ?? org.automatic,
      quietMinutes: p.quietMinutes ?? org.quietMinutes,
      projectsMayChange: org.projectsMayChange,
      source: { automatic: p.automatic === null ? 'organisation' : 'project', quietMinutes: p.quietMinutes === null ? 'organisation' : 'project' },
    });
  }
  return out;
}

/** Importable without Nest (the worker tick passes a plain Pool). */
export async function effectiveAnalysisSettings(db: Db, projectId: string): Promise<EffectiveAnalysisSettings> {
  return (await effectiveAnalysisSettingsMany(db, [projectId])).get(projectId) as EffectiveAnalysisSettings;
}

const reasonOf = (v: unknown): string => {
  if (typeof v !== 'string' || v.trim() === '') throw new BadRequestException('Give a reason for the change.');
  if (v.trim().length > 500) throw new BadRequestException('The reason must be 500 characters or fewer.');
  return v.trim();
};
const quietOf = (v: unknown): number => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 5 || v > 30) throw new BadRequestException(QUIET_MESSAGE);
  return v;
};
const boolOf = (v: unknown, name: string): boolean => {
  if (typeof v !== 'boolean') throw new BadRequestException(`${name} must be true or false.`);
  return v;
};
const text = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const FIELD: Record<string, string> = { automatic: 'automatic', quietMinutes: 'quiet_minutes', projectsMayChange: 'projects_may_change' };

@Injectable()
export class AnalysisSettingsService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly now: Clock,
    private readonly access: ProjectAccess,
  ) {}

  private async tx<T>(work: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const out = await work(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  private async history(projectId: string | null) {
    const { rows } = await this.pool.query(
      `SELECT h.id, h.field, h.from_value AS "oldValue", h.to_value AS "newValue", h.reason, u.display_name AS actor, h.actor_id AS "actorId", h.at
         FROM analysis_settings_changes h JOIN users u ON u.id = h.actor_id
        WHERE h.project_id IS NOT DISTINCT FROM $1
        ORDER BY h.at DESC, h.id DESC`,
      [projectId],
    );
    return rows;
  }

  private async log(c: Db, projectId: string | null, field: string, from: unknown, to: unknown, reason: string, actorId: string, at: Date) {
    await c.query(
      `INSERT INTO analysis_settings_changes (id, project_id, field, from_value, to_value, reason, actor_id, at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [uuidv7(at.getTime()), projectId, FIELD[field], text(from), text(to), reason, actorId, at],
    );
  }

  // ---- Organisation ----

  async organisationView() {
    return { ...(await loadOrg(this.pool)), history: await this.history(null) };
  }

  /** { automatic?, quietMinutes?, projectsMayChange?, reason } by the Administrator. */
  async setOrganisation(user: AuthUser, b: Record<string, unknown>): Promise<void> {
    const changes: Partial<OrgRow> = {};
    if (b.automatic !== undefined) changes.automatic = boolOf(b.automatic, 'Automatic analysis');
    if (b.quietMinutes !== undefined) changes.quietMinutes = quietOf(b.quietMinutes);
    if (b.projectsMayChange !== undefined) changes.projectsMayChange = boolOf(b.projectsMayChange, 'Projects may change automatic analysis');
    const reason = reasonOf(b.reason);
    const at = this.now();
    await this.tx(async (c) => {
      await c.query(`INSERT INTO analysis_settings (id, updated_at) VALUES (1, $1) ON CONFLICT (id) DO NOTHING`, [at]);
      const old = await loadOrg(c, true);
      const next: OrgRow = { ...old, ...changes };
      const changed = (Object.keys(changes) as (keyof OrgRow)[]).filter((k) => old[k] !== next[k]);
      if (changed.length === 0) return;
      for (const k of changed) await this.log(c, null, k, old[k], next[k], reason, user.id, at);
      await c.query(
        `UPDATE analysis_settings SET automatic = $1, quiet_minutes = $2, projects_may_change = $3, updated_by = $4, updated_at = $5 WHERE id = 1`,
        [next.automatic, next.quietMinutes, next.projectsMayChange, user.id, at],
      );
      await writeAudit(c, { at, action: 'analysis_settings.changed', actorUserId: user.id, subjectType: 'organisation', detail: { fields: changed.map((k) => FIELD[k]) } });
    });
  }

  // ---- Project ----

  async projectView(user: AuthUser, projectId: string) {
    const ctx = await this.access.context(user, projectId);
    const eff = await effectiveAnalysisSettings(this.pool, projectId);
    const role = ctx.roles.some((r) => EDITORS.includes(r)) && EDITABLE_STATES.includes(ctx.project.status);
    return {
      automatic: eff.automatic,
      quietMinutes: eff.quietMinutes,
      projectsMayChange: eff.projectsMayChange,
      source: eff.source,
      own: await loadProject(this.pool, projectId),
      canEdit: role && eff.projectsMayChange,
      history: await this.history(projectId),
    };
  }

  /** { automatic?: boolean | null, quietMinutes?: number | null, reason }; null returns to the organisation value. */
  async setProject(user: AuthUser, projectId: string, b: Record<string, unknown>): Promise<void> {
    await this.access.context(user, projectId); // a non-reader gets 404 first
    const at = this.now();
    await this.tx(async (c) => {
      const ctx = await this.access.context(user, projectId, c, true);
      if (!ctx.roles.some((r) => EDITORS.includes(r)) || !EDITABLE_STATES.includes(ctx.project.status)) throw new ForbiddenException(NOT_EDITOR);
      if (!(await loadOrg(c, true)).projectsMayChange) throw new ForbiddenException(NOT_DELEGATED);
      const changes: Partial<ProjectRow> = {};
      if (b.automatic !== undefined) changes.automatic = b.automatic === null ? null : boolOf(b.automatic, 'Automatic analysis');
      if (b.quietMinutes !== undefined) changes.quietMinutes = b.quietMinutes === null ? null : quietOf(b.quietMinutes);
      const reason = reasonOf(b.reason);
      await c.query(`INSERT INTO project_analysis_settings (project_id, updated_at) VALUES ($1, $2) ON CONFLICT (project_id) DO NOTHING`, [projectId, at]);
      const old = await loadProject(c, projectId, true);
      const next: ProjectRow = { ...old, ...changes };
      const changed = (Object.keys(changes) as (keyof ProjectRow)[]).filter((k) => old[k] !== next[k]);
      if (changed.length === 0) return;
      for (const k of changed) await this.log(c, projectId, k, old[k], next[k], reason, user.id, at);
      await c.query(`UPDATE project_analysis_settings SET automatic = $2, quiet_minutes = $3, updated_by = $4, updated_at = $5 WHERE project_id = $1`, [projectId, next.automatic, next.quietMinutes, user.id, at]);
      await writeAudit(c, { at, action: 'analysis_settings.project_changed', actorUserId: user.id, subjectType: 'project', subjectId: projectId, detail: { fields: changed.map((k) => FIELD[k]) } });
    });
  }
}
