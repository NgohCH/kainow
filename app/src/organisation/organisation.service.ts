import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { writeAudit } from '../audit/audit';
import { CLOCK, type Clock } from '../auth/tokens';
import { PG_POOL } from '../db/database.module';
import { OrganisationState } from './state';

export type LogoMeta = { width: number; height: number; byteSize: number; uploadedAt: Date };

/** The organisation name as stored: NFC, whitespace collapsed, trimmed, 1 to 200 characters. */
export function cleanOrganisationName(v: unknown): string {
  const name = typeof v === 'string' ? v.normalize('NFC').replace(/\s+/g, ' ').trim() : '';
  if (name === '') throw new BadRequestException('Give the organisation a name.');
  if (name.length > 200) throw new BadRequestException('An organisation name can be at most 200 characters.');
  return name;
}

/** The organisation this installation serves: its name, its setup, and (Task 4) its logos and branding. */
@Injectable()
export class OrganisationProfileService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly now: Clock,
    private readonly state: OrganisationState,
  ) {}

  async get() {
    const org = (await this.pool.query(`SELECT name, registered_at FROM organisation WHERE id = 1`)).rows[0];
    const logos = (await this.pool.query(`SELECT shape, width, height, byte_size, uploaded_at FROM organisation_logos`)).rows;
    const meta = (shape: string): LogoMeta | null => {
      const l = logos.find((r) => r.shape === shape);
      return l ? { width: l.width, height: l.height, byteSize: l.byte_size, uploadedAt: l.uploaded_at } : null;
    };
    return { registered: !!org?.registered_at, name: (org?.name as string | undefined) ?? null, logos: { wide: meta('wide'), square: meta('square') } };
  }

  /** Saves the name during onboarding; after setup it is a rename, recorded with the old and new name. */
  async setName(nameIn: unknown, actorUserId: string): Promise<{ name: string }> {
    const name = cleanOrganisationName(nameIn);
    const at = this.now();
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const before = (await c.query(`SELECT name, registered_at FROM organisation WHERE id = 1 FOR UPDATE`)).rows[0];
      await c.query(
        `INSERT INTO organisation (id, name, updated_by, updated_at) VALUES (1, $1, $2, $3)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
        [name, actorUserId, at],
      );
      if (before?.registered_at && before.name !== name) {
        await writeAudit(c, { at, action: 'organisation.renamed', actorUserId, subjectType: 'organisation', detail: { from: before.name, to: name } });
      }
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK');
      throw err;
    } finally {
      c.release();
    }
    return { name };
  }

  /** Registers the organisation once it has a name, an email domain and an active department. Repeating it changes nothing. */
  async finish(actorUserId: string): Promise<{ registered: true }> {
    const at = this.now();
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const org = (await c.query(`SELECT registered_at FROM organisation WHERE id = 1 FOR UPDATE`)).rows[0];
      if (!org) throw new BadRequestException('Give the organisation a name.');
      if (!org.registered_at) {
        const domains = (await c.query(`SELECT count(*)::int AS n FROM eligible_domains WHERE removed_at IS NULL`)).rows[0].n;
        if (domains === 0) throw new BadRequestException('Add at least one email domain.');
        const departments = (await c.query(`SELECT count(*)::int AS n FROM departments WHERE status = 'active'`)).rows[0].n;
        if (departments === 0) throw new BadRequestException('Add at least one department.');
        await c.query(`UPDATE organisation SET registered_by = $1, registered_at = $2, updated_by = $1, updated_at = $2 WHERE id = 1`, [actorUserId, at]);
        await writeAudit(c, { at, action: 'organisation.registered', actorUserId, subjectType: 'organisation' });
      }
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK');
      throw err;
    } finally {
      c.release();
    }
    this.state.markRegistered();
    return { registered: true };
  }
}
