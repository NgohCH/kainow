import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from '../db/database.module';

/** Whether this installation's organisation is set up. Once it is, it stays so, and the answer is remembered. */
@Injectable()
export class OrganisationState {
  private registered = false;

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async isRegistered(): Promise<boolean> {
    if (this.registered) return true;
    const { rowCount } = await this.pool.query(`SELECT 1 FROM organisation WHERE registered_at IS NOT NULL`);
    this.registered = (rowCount ?? 0) > 0;
    return this.registered;
  }

  markRegistered(): void {
    this.registered = true;
  }
}
