/** Daily and monthly cap periods begin at midnight UTC+8 (AI configuration rules). */
const UTC8_OFFSET_MS = 8 * 3_600_000;

export interface Period {
  /** Inclusive. */
  start: Date;
  /** Exclusive. */
  end: Date;
}

export function monthPeriod(at: Date): Period {
  const local = new Date(at.getTime() + UTC8_OFFSET_MS);
  const year = local.getUTCFullYear();
  const month = local.getUTCMonth();
  return {
    start: new Date(Date.UTC(year, month, 1) - UTC8_OFFSET_MS),
    end: new Date(Date.UTC(year, month + 1, 1) - UTC8_OFFSET_MS),
  };
}

export function dayPeriod(at: Date): Period {
  const local = new Date(at.getTime() + UTC8_OFFSET_MS);
  const year = local.getUTCFullYear();
  const month = local.getUTCMonth();
  const day = local.getUTCDate();
  return {
    start: new Date(Date.UTC(year, month, day) - UTC8_OFFSET_MS),
    end: new Date(Date.UTC(year, month, day + 1) - UTC8_OFFSET_MS),
  };
}
