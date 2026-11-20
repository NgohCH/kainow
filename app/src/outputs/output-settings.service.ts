import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { writeAudit } from '../audit/audit';
import { CLOCK, type AuthUser, type Clock } from '../auth/tokens';
import { readReason } from '../common/reason';
import { UUID, uuidv7 } from '../common/uuid7';
import { PG_POOL } from '../db/database.module';
import { ProjectAccess } from '../projects/access.service';
import { PROJECT_MATRIX, decide } from '../projects/matrix';
import type { ProjectRole } from '../projects/membership';
import { INPUT_FORMATS, OUTPUT_FORMATS, loadStorageSettings } from '../storage/settings';
import { effectiveFormats } from './formats';

const ACTION = 'outputs.settings';

export const EXPORT_ROLES = ['pm', 'deputy', 'owner', 'sponsor', 'member', 'audit', 'oversight'] as const;
export type ExportRole = (typeof EXPORT_ROLES)[number];
export const DEFAULT_EXPORT_ROLES: readonly ExportRole[] = ['pm', 'deputy', 'owner', 'sponsor'];

/** The stored export role value for a project role (the spec says "deputy"; the code's role is deputy_pm). */
export const exportRoleOf = (role: ProjectRole): ExportRole => (role === 'deputy_pm' ? 'deputy' : role);

export interface ProjectOutputSettingsRow {
  inputFormats: string[] | null;
  outputFormats: string[] | null;
  destinationId: string | null;
  exportRoles: string[];
}

export interface OutputSettingsPatch {
  destinationId?: string | null;
  inputFormats?: string[] | null;
  outputFormats?: string[] | null;
  exportRoles?: string[];
}

const NOT_DELEGATED = {
  destination: 'The Administrator has not allowed projects to choose their own output destination.',
  formats: 'The Administrator has not allowed projects to change their own formats.',
  exportRoles: 'The Administrator has not allowed projects to set their own export roles.',
} as const;

/** Reads and checks the body of PUT /projects/:id/output-settings. Fields left out stay as they are. */
export function parseOutputSettingsBody(body: unknown): { reason: string; patch: OutputSettingsPatch } {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const reason = readReason(b.reason);
  const patch: OutputSettingsPatch = {};
  if ('destinationId' in b) {
    if (b.destinationId !== null && (typeof b.destinationId !== 'string' || !UUID.test(b.destinationId))) throw new BadRequestException('Choose an output destination from the list.');
    patch.destinationId = b.destinationId as string | null;
  }
  const list = (key: string, catalogue: readonly string[], nullable: boolean): string[] | null | undefined => {
    if (!(key in b)) return undefined;
    const v = b[key];
    if (v === null && nullable) return null;
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !catalogue.includes(x))) throw new BadRequestException(`Choose from: ${catalogue.join(', ')}.`);
    return catalogue.filter((f) => v.includes(f));
  };
  const input = list('inputFormats', INPUT_FORMATS, true);
  if (input !== undefined) {
    if (input !== null && input.length === 0) throw new BadRequestException('A project needs at least one input format.');
    patch.inputFormats = input;
  }
  const output = list('outputFormats', OUTPUT_FORMATS, true);
  if (output !== undefined) patch.outputFormats = output;
  const roles = list('exportRoles', EXPORT_ROLES, false);
  if (roles !== undefined) {
    if (!roles || roles.length === 0) throw new BadRequestException('Choose at least one export role.');
    patch.exportRoles = roles;
  }
  return { reason, patch };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

async function readRow(db: Pool | PoolClient, projectId: string, lock = false): Promise<(ProjectOutputSettingsRow & { updatedAt: Date | null }) | null> {
  const { rows } = await db.query(
    `SELECT destination_id, input_formats, output_formats, export_roles, updated_at FROM project_output_settings WHERE project_id = $1 ${lock ? 'FOR UPDATE' : ''}`,
    [projectId],
  );
  const r = rows[0];
  return r ? { destinationId: r.destination_id, inputFormats: r.input_formats, outputFormats: r.output_formats, exportRoles: r.export_roles, updatedAt: r.updated_at } : null;
}

@Injectable()
export class OutputSettingsService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly access: ProjectAccess,
  ) {}

  /** The effective values, where each comes from, and which of them this person may change now (Q01). */
  async get(user: AuthUser, projectId: string) {
    const ctx = await this.access.context(user, projectId); // a non-participant gets 404
    const storage = await loadStorageSettings(this.pool);
    const own = await readRow(this.pool, projectId);
    const stateOk = PROJECT_MATRIX[ACTION].states.includes(ctx.project.status);
    const decided = decide({ action: ACTION, roles: ctx.roles, status: ctx.project.status });
    const may = (delegated: boolean) => stateOk && (ctx.isAdmin || (decided.allowed && delegated));
    const dest = own?.destinationId
      ? ((await this.pool.query(`SELECT id, label, kind, status FROM storage_destinations WHERE id = $1`, [own.destinationId])).rows[0] ?? null)
      : null;
    const available = (
      await this.pool.query(
        `SELECT id, label, kind FROM storage_destinations WHERE purpose = 'outputs' AND status = 'approved'
          ORDER BY (kind = 'sharepoint_library') DESC, lower(label), id`,
      )
    ).rows;
    return {
      destination: dest ? { id: dest.id, label: dest.label, kind: dest.kind, status: dest.status, needsNewLocation: dest.status !== 'approved' } : null,
      availableDestinations: available,
      formats: effectiveFormats(storage, own ? { inputFormats: own.inputFormats, outputFormats: own.outputFormats } : null),
      approvedFormats: { input: storage.approvedInputFormats, output: storage.approvedOutputFormats },
      projectFormats: { input: own?.inputFormats ?? null, output: own?.outputFormats ?? null },
      exportRoles: own?.exportRoles ?? [...DEFAULT_EXPORT_ROLES],
      editable: {
        destination: may(storage.projectsMayChooseDestination),
        formats: may(storage.projectsMayChangeFormats),
        exportRoles: may(storage.projectsMaySetExportRoles),
      },
      sources: {
        destination: own?.destinationId ? 'project' : 'none',
        formats: { input: own?.inputFormats ? 'project' : 'organisation', output: own?.outputFormats ? 'project' : 'organisation' },
        exportRoles: own ? 'project' : 'organisation',
      },
      updatedAt: own?.updatedAt ?? null,
    };
  }

  async update(user: AuthUser, projectId: string, patch: OutputSettingsPatch, reason: string): Promise<void> {
    await this.access.context(user, projectId); // 404 first
    const at = this.clock();
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const ctx = await this.access.context(user, projectId, c, true);
      const row = PROJECT_MATRIX[ACTION];
      if (!row.states.includes(ctx.project.status)) throw new ForbiddenException(row.refusal);
      const storage = await loadStorageSettings(c);
      const existing = await readRow(c, projectId, true);
      const previous: ProjectOutputSettingsRow = existing
        ? { destinationId: existing.destinationId, inputFormats: existing.inputFormats, outputFormats: existing.outputFormats, exportRoles: existing.exportRoles }
        : { destinationId: null, inputFormats: null, outputFormats: null, exportRoles: [...DEFAULT_EXPORT_ROLES] };
      const next: ProjectOutputSettingsRow = { ...previous, ...patch };
      if (!ctx.isAdmin) {
        const verdict = decide({ action: ACTION, roles: ctx.roles, status: ctx.project.status });
        if (!verdict.allowed) throw new ForbiddenException(verdict.reason);
        if (!same(next.destinationId, previous.destinationId) && !storage.projectsMayChooseDestination) throw new ForbiddenException(NOT_DELEGATED.destination);
        const formatsChanged = !same(next.inputFormats, previous.inputFormats) || !same(next.outputFormats, previous.outputFormats);
        if (formatsChanged && !storage.projectsMayChangeFormats) throw new ForbiddenException(NOT_DELEGATED.formats);
        if (!same(next.exportRoles, previous.exportRoles) && !storage.projectsMaySetExportRoles) throw new ForbiddenException(NOT_DELEGATED.exportRoles);
      }
      if (next.destinationId && next.destinationId !== previous.destinationId) {
        const ok = await c.query(`SELECT 1 FROM storage_destinations WHERE id = $1 AND purpose = 'outputs' AND status = 'approved'`, [next.destinationId]);
        if (!ok.rowCount) throw new BadRequestException('Choose an approved outputs destination.');
      }
      if (same(previous, next)) {
        await c.query('COMMIT');
        return;
      }
      await c.query(
        `INSERT INTO project_output_settings (project_id, destination_id, input_formats, output_formats, export_roles, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (project_id) DO UPDATE SET destination_id = EXCLUDED.destination_id, input_formats = EXCLUDED.input_formats,
           output_formats = EXCLUDED.output_formats, export_roles = EXCLUDED.export_roles, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
        [projectId, next.destinationId, next.inputFormats, next.outputFormats, next.exportRoles, user.id, at],
      );
      await c.query(`INSERT INTO project_output_settings_changes (id, project_id, actor_id, at, reason, previous, next) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [
        uuidv7(at.getTime()),
        projectId,
        user.id,
        at,
        reason,
        JSON.stringify(previous),
        JSON.stringify(next),
      ]);
      await writeAudit(c, { at, action: 'project.output_settings_changed', actorUserId: user.id, subjectType: 'project', subjectId: projectId, detail: { previous, next } });
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
  }
}
