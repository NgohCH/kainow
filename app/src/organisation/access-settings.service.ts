import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { writeAudit } from '../audit/audit';
import { CLOCK, type AuthUser, type Clock } from '../auth/tokens';
import { readReason } from '../common/reason';
import { uuidv7 } from '../common/uuid7';
import { PG_POOL } from '../db/database.module';
import { archiveState } from '../projects/archive';
import { todayUtc8 } from '../projects/membership';
import { ACCESS_BOUNDS, ACCESS_DEFAULTS, ACCESS_KEYS, type AccessSettings, loadAccessSettings, validateAccessSettings } from './access-settings';

export interface ArchivePreviewRow {
  projectId: string;
  name: string;
  closedOn: string;
  archivedNow: boolean;
  archivedAfter: boolean;
}

const REASON = 'Give a reason for the change (up to 1,000 characters).';

/** Keeps only the known keys of a request body. */
function pick(next: unknown): Partial<AccessSettings> {
  const src = next && typeof next === 'object' ? (next as Record<string, unknown>) : {};
  const out: Record<string, unknown> = {};
  for (const k of ACCESS_KEYS) if (src[k] !== undefined) out[k] = src[k];
  return out as Partial<AccessSettings>;
}

@Injectable()
export class AccessSettingsService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly now: Clock,
  ) {}

  async get() {
    const { rows } = await this.pool.query(
      `SELECT h.id, h.at, h.reason, h.actor_id AS "actorId", u.display_name AS actor, h.previous, h.next
         FROM access_settings_changes h JOIN users u ON u.id = h.actor_id
        ORDER BY h.at DESC, h.id DESC`,
    );
    return { settings: await loadAccessSettings(this.pool), defaults: ACCESS_DEFAULTS, bounds: ACCESS_BOUNDS, changes: rows };
  }

  private async merged(db: Pool | PoolClient, next: Partial<AccessSettings>, lock = false): Promise<AccessSettings> {
    const check = validateAccessSettings({ ...(await loadAccessSettings(db, lock)), ...pick(next) });
    if (!check.ok) throw new BadRequestException(check.message);
    return check.value;
  }

  /** Every Closed project whose archive state the new values would change, now against after. */
  async preview(next: Partial<AccessSettings>, today: string): Promise<ArchivePreviewRow[]> {
    const current = await loadAccessSettings(this.pool);
    const after = await this.merged(this.pool, next);
    const { rows: projects } = await this.pool.query(
      `SELECT p.id, p.name,
              (SELECT t.at FROM project_transitions t WHERE t.project_id = p.id AND t.to_status = 'closed' ORDER BY t.at DESC, t.id DESC LIMIT 1) AS "closedAt"
         FROM projects p WHERE p.status = 'closed' ORDER BY p.name, p.id`,
    );
    const { rows: events } = await this.pool.query(
      `SELECT e.project_id AS "projectId", e.kind, e.at FROM project_archive_events e JOIN projects p ON p.id = e.project_id
        WHERE p.status = 'closed' ORDER BY e.at, e.id`,
    );
    const byProject = new Map<string, Array<{ kind: 'archived' | 'unarchived'; at: string }>>();
    for (const e of events) {
      const list = byProject.get(e.projectId) ?? [];
      list.push({ kind: e.kind, at: new Date(e.at).toISOString() });
      byProject.set(e.projectId, list);
    }
    const out: ArchivePreviewRow[] = [];
    for (const p of projects) {
      if (!p.closedAt) continue;
      const closedAt = new Date(p.closedAt).toISOString();
      const input = { status: 'closed' as const, closedAt, events: byProject.get(p.id) ?? [], today };
      const now = archiveState({ ...input, afterMonths: current.archiveAfterMonths }).archived;
      const later = archiveState({ ...input, afterMonths: after.archiveAfterMonths }).archived;
      if (now !== later) out.push({ projectId: p.id, name: p.name, closedOn: todayUtc8(new Date(closedAt)), archivedNow: now, archivedAfter: later });
    }
    return out;
  }

  /** Writes the row, one history row and the audit event together. */
  async update(user: AuthUser, next: Partial<AccessSettings>, reasonInput: unknown): Promise<AccessSettings> {
    const reason = readReason(reasonInput, 'a reason', { refusal: REASON });
    const at = this.now();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const previous = await loadAccessSettings(client, true);
      const value = await this.merged(client, next, true);
      try {
        await client.query(
          `UPDATE access_settings SET archive_after_months = $1, grant_default_days = $2, grant_max_days = $3, invitation_valid_days = $4, analytics_export_allowed = $5 WHERE id`,
          [value.archiveAfterMonths, value.grantDefaultDays, value.grantMaxDays, value.invitationValidDays, value.analyticsExportAllowed],
        );
      } catch (err) {
        // Validation runs first; a CHECK failure here is only a fallback.
        if ((err as { code?: string }).code === '23514') throw new BadRequestException('One of the values is outside its allowed range.');
        throw err;
      }
      await client.query(`INSERT INTO access_settings_changes (id, actor_id, at, reason, previous, next) VALUES ($1, $2, $3, $4, $5, $6)`, [
        uuidv7(at.getTime()), user.id, at, reason, JSON.stringify(previous), JSON.stringify(value),
      ]);
      const fields = ACCESS_KEYS.filter((k) => previous[k] !== value[k]);
      await writeAudit(client, { at, action: 'access_settings.changed', actorUserId: user.id, subjectType: 'organisation', detail: { fields } });
      await client.query('COMMIT');
      return value;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}
