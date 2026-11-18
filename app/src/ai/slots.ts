import { Pool } from 'pg';

/**
 * Slots for AI requests at once (A05, D87). The limit lives in the database so it holds across worker processes.
 * A slot is free when it has no holder or its lease has ended; lease times use the database clock.
 * The holder is `${requestId}:${attemptNo}`.
 */
export async function takeSlot(pool: Pool, holder: string, limit: number, leaseMs: number): Promise<number | null> {
  const { rows } = await pool.query<{ slot: number }>(
    `UPDATE ai_call_slots
        SET holder = $1, leased_until = now() + ($3::double precision * interval '1 millisecond')
      WHERE slot = (
        SELECT slot FROM ai_call_slots
         WHERE slot <= $2 AND (holder IS NULL OR leased_until < now())
         ORDER BY slot
         LIMIT 1
         FOR UPDATE SKIP LOCKED)
      RETURNING slot`,
    [holder, limit, leaseMs],
  );
  return rows.length === 0 ? null : rows[0].slot;
}

export async function waitForSlot(
  pool: Pool,
  holder: string,
  limit: () => Promise<number>,
  leaseMs: number,
  opts: { maxWaitMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<number | null> {
  const maxWaitMs = opts.maxWaitMs ?? 120_000;
  const pollMs = opts.pollMs ?? 1_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let waited = 0;
  for (;;) {
    const slot = await takeSlot(pool, holder, await limit(), leaseMs);
    if (slot !== null) return slot;
    if (waited >= maxWaitMs) return null;
    await sleep(pollMs);
    waited += pollMs;
  }
}

export async function releaseSlot(pool: Pool, slot: number, holder: string): Promise<void> {
  await pool.query(`UPDATE ai_call_slots SET holder = NULL, leased_until = NULL WHERE slot = $1 AND holder = $2`, [slot, holder]);
}
