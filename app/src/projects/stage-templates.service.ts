import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { writeAudit } from '../audit/audit';
import { CLOCK, type AuthUser, type Clock } from '../auth/tokens';
import { readReason } from '../common/reason';
import { UUID, uuidv7 } from '../common/uuid7';
import { PG_POOL } from '../db/database.module';
import { refuseSecrets } from '../discussion/messages';
import { TEMPLATE_LIMITS as L, type TemplateStage } from './stage-templates';

export interface StageTemplate {
  id: string;
  name: string;
  description: string | null;
  status: 'active' | 'retired';
  position: number;
  /** NULL for a template Kainow shipped. */
  createdBy: string | null;
  /** "Kainow" for a shipped template. */
  createdByName: string;
  createdAt: string;
  updatedBy: string | null;
  updatedAt: string | null;
  stages: TemplateStage[];
  /** Only in the Administrator's full list. */
  projectsUsing?: number;
}

/** What a create or change sets: the audit's previous and new values. */
interface TemplateContent {
  name: string;
  description: string | null;
  stages: TemplateStage[];
}

const NAME_TAKEN = 'There is already an active template with that name. Choose another name.';

/** Trimmed text of 1 to 80 characters, credential-checked, or the given refusal. */
function readName(input: unknown, refusal: string): string {
  const name = typeof input === 'string' ? input.normalize('NFC').trim() : '';
  if (name === '' || name.length > L.nameChars) throw new BadRequestException(refusal);
  refuseSecrets(name);
  return name;
}

/** `{ name, description?, stages }` from a request body, checked against spec 14's rules. */
export function readTemplateContent(body: Record<string, unknown>): TemplateContent {
  const name = readName(body.name, `Give the template a name of 1 to ${L.nameChars} characters.`);

  let description: string | null = null;
  if (body.description !== undefined && body.description !== null) {
    if (typeof body.description !== 'string') throw new BadRequestException(`Give a description of up to ${L.descriptionChars} characters, or leave it empty.`);
    const d = body.description.normalize('NFC').trim();
    if (d.length > L.descriptionChars) throw new BadRequestException(`Give a description of up to ${L.descriptionChars} characters, or leave it empty.`);
    if (d !== '') {
      refuseSecrets(d);
      description = d;
    }
  }

  if (!Array.isArray(body.stages) || body.stages.length === 0) throw new BadRequestException('A template needs at least one stage.');
  if (body.stages.length > L.stages) throw new BadRequestException(`A template can have at most ${L.stages} stages.`);
  const stages: TemplateStage[] = [];
  const seen = new Set<string>();
  for (const raw of body.stages) {
    const s = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    const stageName = readName(s.name, `Give each stage a name of 1 to ${L.nameChars} characters.`);
    const key = stageName.toLowerCase();
    if (seen.has(key)) throw new BadRequestException(`Stage names must differ within a template: "${stageName}" appears twice.`);
    seen.add(key);
    const rawSubs = s.substages === undefined || s.substages === null ? [] : s.substages;
    if (!Array.isArray(rawSubs)) throw new BadRequestException(`Give the substages of ${stageName} as a list.`);
    if (rawSubs.length > L.substagesPerStage) throw new BadRequestException(`A stage can have at most ${L.substagesPerStage} substages: ${stageName} has ${rawSubs.length}.`);
    const substages = rawSubs.map((x) => readName(x, `Give each substage a name of 1 to ${L.nameChars} characters.`));
    if (new Set(substages.map((x) => x.toLowerCase())).size !== substages.length) {
      throw new BadRequestException(`Substage names must differ within a stage: ${stageName} repeats one.`);
    }
    stages.push({ name: stageName, substages });
  }
  return { name, description, stages };
}

interface Row {
  id: string;
  name: string;
  description: string | null;
  status: 'active' | 'retired';
  position: number;
  created_by: string | null;
  created_by_name: string | null;
  created_at: Date;
  updated_by: string | null;
  updated_at: Date | null;
  projects_using: number;
}

const SELECT = `SELECT t.id, t.name, t.description, t.status, t.position, t.created_by, u.display_name AS created_by_name,
                       t.created_at, t.updated_by, t.updated_at,
                       (SELECT count(*)::int FROM projects p WHERE p.stage_template_id = t.id) AS projects_using
                  FROM stage_templates t LEFT JOIN users u ON u.id = t.created_by`;

/** The Enterprise Administrator's stage template catalogue (D131, spec 14). Editing a template never changes a project. */
@Injectable()
export class StageTemplatesService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Active templates in catalogue order; with `all`, retired ones too and how many projects use each. */
  async list(all: boolean): Promise<StageTemplate[]> {
    return this.read(this.pool, all ? '' : `WHERE t.status = 'active'`, [], all);
  }

  async create(user: AuthUser, body: Record<string, unknown>): Promise<StageTemplate> {
    const next = readTemplateContent(body);
    const reason = readReason(body.reason, 'a reason', { max: L.reasonChars });
    const at = this.clock();
    const id = uuidv7(at.getTime());
    return this.inTransaction(async (c) => {
      await this.assertNameFree(c, next.name, null);
      const pos = (await c.query<{ p: number }>(`SELECT COALESCE(max(position), 0) + 1 AS p FROM stage_templates`)).rows[0].p;
      await c.query(
        `INSERT INTO stage_templates (id, name, description, status, position, created_by, created_at) VALUES ($1, $2, $3, 'active', $4, $5, $6)`,
        [id, next.name, next.description, pos, user.id, at],
      );
      await this.writeStages(c, id, next.stages);
      await writeAudit(c, { at, action: 'stage_template.created', actorUserId: user.id, subjectType: 'stage_template', subjectId: id, detail: { previous: null, next, reason } });
      return this.one(c, id);
    });
  }

  /** Replaces the name, description and stage list; the template keeps its place and status. */
  async change(user: AuthUser, id: string, body: Record<string, unknown>): Promise<StageTemplate> {
    const next = readTemplateContent(body);
    const reason = readReason(body.reason, 'a reason', { max: L.reasonChars });
    return this.withCurrent(id, async (c, current, at) => {
      if (current.status === 'active') await this.assertNameFree(c, next.name, id);
      await c.query(`UPDATE stage_templates SET name = $2, description = $3, updated_by = $4, updated_at = $5 WHERE id = $1`, [id, next.name, next.description, user.id, at]);
      await c.query(`DELETE FROM stage_template_stages WHERE template_id = $1`, [id]);
      await this.writeStages(c, id, next.stages);
      const previous: TemplateContent = { name: current.name, description: current.description, stages: current.stages };
      await writeAudit(c, { at, action: 'stage_template.changed', actorUserId: user.id, subjectType: 'stage_template', subjectId: id, detail: { previous, next, reason } });
      return this.one(c, id);
    });
  }

  /** Retiring stops it being offered for new projects; projects that came from it keep their stages. One stays active. */
  async retire(user: AuthUser, id: string, reasonInput: unknown): Promise<StageTemplate> {
    const reason = readReason(reasonInput, 'a reason', { max: L.reasonChars });
    return this.withCurrent(id, async (c, current, at) => {
      if (current.status === 'retired') throw new BadRequestException('That template is already retired.');
      const active = (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM stage_templates WHERE status = 'active'`)).rows[0].n;
      if (active <= 1) throw new BadRequestException('At least one template must stay active, so the last one cannot be retired.');
      return this.setStatus(c, user, current, 'retired', at, reason);
    });
  }

  async restore(user: AuthUser, id: string, reasonInput: unknown): Promise<StageTemplate> {
    const reason = readReason(reasonInput, 'a reason', { max: L.reasonChars });
    return this.withCurrent(id, async (c, current, at) => {
      if (current.status === 'active') throw new BadRequestException('That template is already active.');
      await this.assertNameFree(c, current.name, id);
      return this.setStatus(c, user, current, 'active', at, reason);
    });
  }

  private async setStatus(c: PoolClient, user: AuthUser, current: StageTemplate, status: 'active' | 'retired', at: Date, reason: string): Promise<StageTemplate> {
    await c.query(`UPDATE stage_templates SET status = $2, updated_by = $3, updated_at = $4 WHERE id = $1`, [current.id, status, user.id, at]);
    await writeAudit(c, {
      at,
      action: status === 'retired' ? 'stage_template.retired' : 'stage_template.restored',
      actorUserId: user.id,
      subjectType: 'stage_template',
      subjectId: current.id,
      detail: { name: current.name, previous: { status: current.status }, next: { status }, reason },
    });
    return this.one(c, current.id);
  }

  private async writeStages(c: PoolClient, templateId: string, stages: TemplateStage[]): Promise<void> {
    for (const [i, s] of stages.entries()) {
      await c.query(`INSERT INTO stage_template_stages (id, template_id, position, name, substages) VALUES ($1, $2, $3, $4, $5)`, [uuidv7(), templateId, i + 1, s.name, s.substages]);
    }
  }

  private async assertNameFree(c: PoolClient, name: string, exceptId: string | null): Promise<void> {
    const { rowCount } = await c.query(
      `SELECT 1 FROM stage_templates WHERE status = 'active' AND lower(name) = lower($1) AND ($2::uuid IS NULL OR id <> $2)`,
      [name, exceptId],
    );
    if (rowCount) throw new BadRequestException(NAME_TAKEN);
  }

  private async one(c: PoolClient, id: string): Promise<StageTemplate> {
    return (await this.read(c, 'WHERE t.id = $1', [id], false))[0];
  }

  private async read(db: Pool | PoolClient, where: string, params: unknown[], withCounts: boolean): Promise<StageTemplate[]> {
    const { rows } = await db.query<Row>(`${SELECT} ${where} ORDER BY t.position, lower(t.name), t.id`, params);
    if (rows.length === 0) return [];
    const stages = (
      await db.query<{ template_id: string; name: string; substages: string[] }>(
        `SELECT template_id, name, substages FROM stage_template_stages WHERE template_id = ANY($1) ORDER BY template_id, position`,
        [rows.map((r) => r.id)],
      )
    ).rows;
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      status: r.status,
      position: r.position,
      createdBy: r.created_by,
      createdByName: r.created_by === null ? 'Kainow' : (r.created_by_name ?? ''),
      createdAt: r.created_at.toISOString(),
      updatedBy: r.updated_by,
      updatedAt: r.updated_at ? r.updated_at.toISOString() : null,
      stages: stages.filter((s) => s.template_id === r.id).map((s) => ({ name: s.name, substages: s.substages })),
      ...(withCounts ? { projectsUsing: r.projects_using } : {}),
    }));
  }

  private async withCurrent(id: string, fn: (c: PoolClient, current: StageTemplate, at: Date) => Promise<StageTemplate>): Promise<StageTemplate> {
    if (!UUID.test(id)) throw new NotFoundException();
    const at = this.clock();
    return this.inTransaction(async (c) => {
      const current = (await this.read(c, 'WHERE t.id = $1', [id], false))[0];
      if (!current) throw new NotFoundException();
      return fn(c, current, at);
    });
  }

  /** One writer at a time: the name and "one stays active" checks read the whole catalogue. */
  private async inTransaction<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`LOCK TABLE stage_templates IN SHARE ROW EXCLUSIVE MODE`);
      const result = await fn(c);
      await c.query('COMMIT');
      return result;
    } catch (err) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
  }
}
