import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { CLOCK, type AuthUser, type Clock } from '../auth/tokens';
import { PG_POOL } from '../db/database.module';
import { type Prefs, normalisePrefs } from './preferences';

/** Own display preferences. Presentation only: no reason, no audit row (spec section 8). */
@Injectable()
export class PreferencesService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async get(user: AuthUser): Promise<Prefs> {
    const { rows } = await this.pool.query(`SELECT prefs FROM user_preferences WHERE user_id = $1`, [user.id]);
    return normalisePrefs(rows[0]?.prefs);
  }

  async put(user: AuthUser, body: unknown): Promise<Prefs> {
    const prefs = normalisePrefs(body);
    await this.pool.query(
      `INSERT INTO user_preferences (user_id, prefs, updated_at) VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE SET prefs = EXCLUDED.prefs, updated_at = EXCLUDED.updated_at`,
      [user.id, JSON.stringify(prefs), this.clock()],
    );
    return prefs;
  }
}
