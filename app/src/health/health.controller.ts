import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import type { Pool } from 'pg';
import { Public } from '../auth/access';
import { PG_POOL } from '../db/database.module';

@Controller('health')
export class HealthController {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** Reports healthy only when the database answers. No error detail is exposed. */
  @Get()
  @Public()
  async check(): Promise<{ status: 'ok'; database: 'up' }> {
    try {
      await this.pool.query('SELECT 1');
    } catch {
      throw new ServiceUnavailableException({ status: 'degraded', database: 'down' });
    }
    return { status: 'ok', database: 'up' };
  }
}
