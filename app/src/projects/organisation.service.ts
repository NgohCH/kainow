import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Pool } from 'pg';
import { writeAudit } from '../audit/audit';
import { CLOCK, type Clock } from '../auth/tokens';
import { uuidv7 } from '../common/uuid7';
import { PG_POOL } from '../db/database.module';
import { OrganisationState } from '../organisation/state';

const DOMAIN = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const UNIQUE_VIOLATION = '23505';

function cleanName(v: unknown): string {
  const name = typeof v === 'string' ? v.normalize('NFC').replace(/\s+/g, ' ').trim() : '';
  if (name === '') throw new BadRequestException('Give the department a name.');
  if (name.length > 200) throw new BadRequestException('A department name can be at most 200 characters.');
  return name;
}

const DUPLICATE_NAME = 'A department with that name already exists.';
const retiredName = (name: string) => `A retired department is called ${name}. Bring it back instead of making a second one.`;

/**
 * Organisation settings an Enterprise Administrator keeps: departments and eligible email domains. Departments are one
 * central list (Product Owner, 21 November 2026): only the Enterprise Administrator adds, renames, retires or brings
 * one back, everyone else picks from it, and a name is never used twice, by an active or a retired department (names
 * compared ignoring case and extra spaces).
 */
@Injectable()
export class OrganisationService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly now: Clock,
    private readonly organisation: OrganisationState,
  ) {}

  async listDepartments(includeRetired: boolean) {
    const { rows } = await this.pool.query(
      `SELECT id, name, status FROM departments ${includeRetired ? '' : `WHERE status = 'active'`} ORDER BY lower(name), id`,
    );
    return rows;
  }

  async addDepartment(nameIn: unknown, actorUserId: string) {
    const name = cleanName(nameIn);
    await this.refuseRetiredName(name, null);
    const id = uuidv7();
    const at = this.now();
    try {
      await this.pool.query(`INSERT INTO departments (id, name, created_by, created_at) VALUES ($1, $2, $3, $4)`, [id, name, actorUserId, at]);
    } catch (err) {
      if ((err as { code?: string }).code === UNIQUE_VIOLATION) throw new ConflictException(DUPLICATE_NAME);
      throw err;
    }
    await writeAudit(this.pool, { at, action: 'department.added', actorUserId, subjectType: 'department', subjectId: id, detail: { name } });
    return { id, name, status: 'active' };
  }

  async renameDepartment(id: string, nameIn: unknown, actorUserId: string) {
    const name = cleanName(nameIn);
    await this.refuseRetiredName(name, id);
    const at = this.now();
    let rows;
    try {
      ({ rows } = await this.pool.query(
        `UPDATE departments SET name = $2, updated_by = $3, updated_at = $4 WHERE id = $1 RETURNING id, name, status`,
        [id, name, actorUserId, at],
      ));
    } catch (err) {
      if ((err as { code?: string }).code === UNIQUE_VIOLATION) throw new ConflictException(DUPLICATE_NAME);
      throw err;
    }
    if (!rows[0]) throw new NotFoundException();
    await writeAudit(this.pool, { at, action: 'department.renamed', actorUserId, subjectType: 'department', subjectId: id, detail: { name } });
    return rows[0];
  }

  async retireDepartment(id: string, actorUserId: string) {
    const at = this.now();
    const { rows } = await this.pool.query(
      // After setup the organisation keeps at least one active department.
      `UPDATE departments SET status = 'retired', updated_by = $2, updated_at = $3
        WHERE id = $1 AND (NOT $4 OR EXISTS (SELECT 1 FROM departments WHERE status = 'active' AND id <> $1))
        RETURNING id, name, status`,
      [id, actorUserId, at, await this.organisation.isRegistered()],
    );
    if (!rows[0]) {
      const exists = (await this.pool.query(`SELECT 1 FROM departments WHERE id = $1`, [id])).rowCount;
      if (exists) throw new ConflictException('The organisation needs at least one active department.');
      throw new NotFoundException();
    }
    await writeAudit(this.pool, { at, action: 'department.retired', actorUserId, subjectType: 'department', subjectId: id });
    return rows[0];
  }

  /** Brings a retired department back into the list, under its name. Refused while an active department has that name. */
  async restoreDepartment(id: string, actorUserId: string) {
    const at = this.now();
    let rows;
    try {
      ({ rows } = await this.pool.query(
        `UPDATE departments SET status = 'active', updated_by = $2, updated_at = $3 WHERE id = $1 AND status = 'retired' RETURNING id, name, status`,
        [id, actorUserId, at],
      ));
    } catch (err) {
      if ((err as { code?: string }).code === UNIQUE_VIOLATION) throw new ConflictException(DUPLICATE_NAME);
      throw err;
    }
    if (!rows[0]) {
      const exists = (await this.pool.query(`SELECT 1 FROM departments WHERE id = $1`, [id])).rowCount;
      if (exists) throw new ConflictException('That department is not retired.');
      throw new NotFoundException();
    }
    await writeAudit(this.pool, { at, action: 'department.restored', actorUserId, subjectType: 'department', subjectId: id });
    return rows[0];
  }

  /**
   * A name a retired department already has (ignoring case and extra spaces) is refused, naming that department so the
   * Administrator can bring it back. `except` is the department being renamed.
   */
  private async refuseRetiredName(name: string, except: string | null): Promise<void> {
    const retired = (
      await this.pool.query<{ id: string; name: string }>(
        `SELECT id, name FROM departments
          WHERE status = 'retired' AND lower(regexp_replace(btrim(name), '[[:space:]]+', ' ', 'g')) = lower($1) AND ($2::uuid IS NULL OR id <> $2)
          ORDER BY id LIMIT 1`,
        [name, except],
      )
    ).rows[0];
    if (retired) {
      throw new ConflictException({ statusCode: 409, message: retiredName(retired.name), error: 'Conflict', retiredDepartment: retired });
    }
  }

  async listDomains() {
    const { rows } = await this.pool.query(`SELECT id, domain FROM eligible_domains WHERE removed_at IS NULL ORDER BY domain`);
    return rows;
  }

  async addDomain(domainIn: unknown, actorUserId: string) {
    const domain = typeof domainIn === 'string' ? domainIn.trim().toLowerCase() : '';
    if (!DOMAIN.test(domain)) throw new BadRequestException('Enter a domain such as example.com.');
    const id = uuidv7();
    const at = this.now();
    try {
      await this.pool.query(`INSERT INTO eligible_domains (id, domain, added_by, added_at) VALUES ($1, $2, $3, $4)`, [id, domain, actorUserId, at]);
    } catch (err) {
      if ((err as { code?: string }).code === UNIQUE_VIOLATION) throw new ConflictException('That domain is already eligible.');
      throw err;
    }
    await writeAudit(this.pool, { at, action: 'domain.added', actorUserId, subjectType: 'eligible_domain', subjectId: id, detail: { domain } });
    return { id, domain };
  }

  async removeDomain(id: string, actorUserId: string) {
    const at = this.now();
    const { rows } = await this.pool.query(
      // After setup the organisation keeps at least one email domain.
      `UPDATE eligible_domains SET removed_by = $2, removed_at = $3
        WHERE id = $1 AND removed_at IS NULL AND (NOT $4 OR EXISTS (SELECT 1 FROM eligible_domains WHERE removed_at IS NULL AND id <> $1))
        RETURNING domain`,
      [id, actorUserId, at, await this.organisation.isRegistered()],
    );
    if (!rows[0]) {
      const open = (await this.pool.query(`SELECT 1 FROM eligible_domains WHERE id = $1 AND removed_at IS NULL`, [id])).rowCount;
      if (open) throw new ConflictException('The organisation needs at least one email domain.');
      throw new NotFoundException();
    }
    await writeAudit(this.pool, { at, action: 'domain.removed', actorUserId, subjectType: 'eligible_domain', subjectId: id, detail: { domain: rows[0].domain } });
    return { removed: true };
  }

  /** True when the address's domain is currently eligible. */
  async isEligible(email: string): Promise<boolean> {
    const domain = email.trim().toLowerCase().split('@')[1] ?? '';
    const { rowCount } = await this.pool.query(`SELECT 1 FROM eligible_domains WHERE domain = $1 AND removed_at IS NULL`, [domain]);
    return (rowCount ?? 0) > 0;
  }
}
