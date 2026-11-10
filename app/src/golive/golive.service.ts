import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Pool } from 'pg';
import { CLOCK, type AuthUser, type Clock } from '../auth/tokens';
import { uuidv7 } from '../common/uuid7';
import { PG_POOL } from '../db/database.module';
import { MSG, STEPS, TOTAL, refreshChecklist } from './checklist';

export interface StepView {
  key: string; position: number; text: string; explanation: string; link: string; mode: string; done: boolean;
  tickedBy: { id: string; name: string } | 'kainow' | null; tickedAt: string | null; note: string | null; skipped: boolean; canTick: boolean; canUntick: boolean;
}

@Injectable()
export class GoLiveService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool, @Inject(CLOCK) private readonly now: Clock) {}

  /** Only Active Enterprise Administrators; everyone else is told the page does not exist. */
  private async admin(user: AuthUser): Promise<void> {
    const ok = user.role === 'enterprise_administrator'
      && (await this.pool.query(`SELECT 1 FROM users WHERE id = $1 AND status = 'active'`, [user.id])).rowCount === 1;
    if (!ok) throw new NotFoundException();
  }

  async view(user: AuthUser) {
    await this.admin(user);
    await refreshChecklist(this.pool, this.now());
    const closedAt = (await this.pool.query(`SELECT closed_at FROM golive_checklist WHERE id = 1`)).rows[0].closed_at as Date | null;
    const rows = (await this.pool.query(
      `SELECT s.key, s.position, s.ticked_by, u.display_name, s.ticked_at, s.note, s.skipped
         FROM golive_steps s LEFT JOIN users u ON u.id = s.ticked_by ORDER BY s.position`,
    )).rows;
    const sent = await this.testEmailSent();
    const steps: StepView[] = STEPS.map((def) => {
      const r = rows.find((x) => x.key === def.key);
      const done = r.ticked_at !== null;
      return {
        key: def.key, position: r.position, text: def.text, explanation: def.explanation, link: def.link, mode: def.mode, done,
        tickedBy: !done ? null : r.ticked_by ? { id: r.ticked_by, name: r.display_name } : 'kainow',
        tickedAt: done ? (r.ticked_at as Date).toISOString() : null,
        note: r.note, skipped: r.skipped,
        canUntick: !closedAt && def.mode !== 'auto' && done && r.ticked_by !== null,
        canTick: !closedAt && def.mode !== 'auto' && !done && (def.key !== 'test_email' || sent),
      };
    });
    // Not done at close: steps without a tick, or ticked only after the checklist closed.
    const notDoneAtClose = closedAt
      ? rows.filter((r) => r.ticked_at === null || (r.ticked_at as Date).getTime() > closedAt.getTime()).map((r) => r.key as string)
      : [];
    return { closedAt: closedAt ? closedAt.toISOString() : null, steps, notDoneAtClose };
  }

  async summary(user: AuthUser) {
    await this.admin(user);
    await refreshChecklist(this.pool, this.now());
    const closed = (await this.pool.query(`SELECT closed_at FROM golive_checklist WHERE id = 1`)).rows[0].closed_at;
    const done = (await this.pool.query(`SELECT count(*)::int AS n FROM golive_steps WHERE ticked_at IS NOT NULL`)).rows[0].n as number;
    return { open: !closed, done, total: TOTAL };
  }

  private async testEmailSent(): Promise<boolean> {
    return (await this.pool.query(`SELECT 1 FROM email_outbox WHERE kind = 'test' AND status = 'sent' LIMIT 1`)).rowCount === 1;
  }

  private noteOf(body: Record<string, unknown>): string | null {
    const n = body.note;
    if (n === undefined || n === null) return null;
    if (typeof n !== 'string') throw new BadRequestException(MSG.noteLong);
    const t = n.trim();
    if (t.length > 200) throw new BadRequestException(MSG.noteLong);
    return t === '' ? null : t;
  }

  /** action: tick | untick | skip (skip is for the logos step only). */
  async change(user: AuthUser, key: string, action: 'tick' | 'untick' | 'skip', body: Record<string, unknown>) {
    await this.admin(user);
    const def = STEPS.find((s) => s.key === key);
    if (!def) throw new NotFoundException();
    if (action === 'skip' && key !== 'logos') throw new NotFoundException();
    // The logos step can be done by the Administrator only as "skipped"; other automatic steps are Kainow's alone.
    if (def.mode === 'auto' || (def.mode === 'auto_or_skip' && action === 'tick')) throw new ConflictException(MSG.autoStep);
    const note = action === 'untick' ? null : this.noteOf(body);
    const now = this.now();
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const closed = (await c.query(`SELECT closed_at FROM golive_checklist WHERE id = 1 FOR UPDATE`)).rows[0].closed_at;
      if (closed) throw new ConflictException(MSG.closed);
      const row = (await c.query(`SELECT ticked_by, ticked_at FROM golive_steps WHERE key = $1 FOR UPDATE`, [key])).rows[0];
      if (key === 'logos' && row.ticked_at !== null && row.ticked_by === null) throw new ConflictException(MSG.autoStep);
      // A tick never overwrites who and when; an untick of a step that is not done records nothing.
      if (action === 'untick' && row.ticked_at === null) throw new ConflictException(MSG.notDone);
      if (action !== 'untick' && row.ticked_at !== null) throw new ConflictException(MSG.alreadyDone);
      if (action === 'tick' && key === 'test_email' &&
        (await c.query(`SELECT 1 FROM email_outbox WHERE kind = 'test' AND status = 'sent' LIMIT 1`)).rowCount !== 1) {
        throw new ConflictException(MSG.testEmailFirst);
      }
      if (action === 'untick') {
        await c.query(`UPDATE golive_steps SET ticked_by = NULL, ticked_at = NULL, note = NULL, skipped = false WHERE key = $1`, [key]);
      } else {
        await c.query(`UPDATE golive_steps SET ticked_by = $2, ticked_at = $3, note = $4, skipped = $5 WHERE key = $1`, [key, user.id, now, note, action === 'skip']);
      }
      await c.query(
        `INSERT INTO golive_events (id, step_key, action, actor_id, note, at) VALUES ($1, $2, $3, $4, $5, $6)`,
        [uuidv7(), key, action === 'untick' ? 'unticked' : 'ticked', user.id, action === 'skip' ? (note ? `Skipped. ${note}` : 'Skipped') : note, now],
      );
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
    return this.view(user);
  }
}
