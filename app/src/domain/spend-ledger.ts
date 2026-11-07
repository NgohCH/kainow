// R10: each AI call reserves its estimated cost before it runs and stops when
// the monthly cap would be exceeded. Charges that cannot yet be confirmed keep
// counting against the cap until reconciled. Money is integer sen (1/100 MYR)
// to avoid floating-point drift. Calendar month boundary is UTC+8.

export type ReservationState = "reserved" | "confirmed" | "released";

export interface Reservation {
  id: string;
  monthKey: string; // "YYYY-MM" in UTC+8
  amountSen: number; // estimate while reserved; actual once confirmed
  state: ReservationState;
}

export interface Ledger {
  monthlyCapSen: number | null; // null = no allowance configured (unlimited)
  reservations: readonly Reservation[];
}

export type ReserveResult =
  | { ok: true; ledger: Ledger; reservation: Reservation }
  | { ok: false; reason: "cap_exceeded" | "invalid_estimate"; committedSen: number };

const UTC8_OFFSET_MS = 8 * 60 * 60 * 1000;

export function monthKeyUtc8(instant: Date): string {
  const shifted = new Date(instant.getTime() + UTC8_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

// Amount counted against the cap in one month: reserved estimates plus
// confirmed actuals. Released reservations count for nothing.
export function committedSen(ledger: Ledger, monthKey: string): number {
  let total = 0;
  for (const r of ledger.reservations) {
    if (r.monthKey !== monthKey) continue;
    if (r.state === "reserved" || r.state === "confirmed") total += r.amountSen;
  }
  return total;
}

export function reserve(
  ledger: Ledger,
  input: { id: string; estimateSen: number; at: Date },
): ReserveResult {
  const monthKey = monthKeyUtc8(input.at);
  const committed = committedSen(ledger, monthKey);

  if (!Number.isInteger(input.estimateSen) || input.estimateSen < 0) {
    return { ok: false, reason: "invalid_estimate", committedSen: committed };
  }
  if (ledger.monthlyCapSen !== null && committed + input.estimateSen > ledger.monthlyCapSen) {
    return { ok: false, reason: "cap_exceeded", committedSen: committed };
  }

  const reservation: Reservation = {
    id: input.id,
    monthKey,
    amountSen: input.estimateSen,
    state: "reserved",
  };
  return {
    ok: true,
    ledger: { ...ledger, reservations: [...ledger.reservations, reservation] },
    reservation,
  };
}

// Replaces the estimate with the provider-reported cost once known.
export function confirm(ledger: Ledger, id: string, actualSen: number): Ledger {
  if (!Number.isInteger(actualSen) || actualSen < 0) {
    throw new RangeError("actualSen must be a non-negative integer");
  }
  return updateOne(ledger, id, (r) => {
    if (r.state !== "reserved") throw new Error(`reservation ${id} is ${r.state}`);
    return { ...r, state: "confirmed", amountSen: actualSen };
  });
}

// Used when the call never ran, so nothing was charged.
export function release(ledger: Ledger, id: string): Ledger {
  return updateOne(ledger, id, (r) => {
    if (r.state !== "reserved") throw new Error(`reservation ${id} is ${r.state}`);
    return { ...r, state: "released", amountSen: 0 };
  });
}

function updateOne(
  ledger: Ledger,
  id: string,
  change: (r: Reservation) => Reservation,
): Ledger {
  const index = ledger.reservations.findIndex((r) => r.id === id);
  if (index === -1) throw new Error(`unknown reservation ${id}`);
  const reservations = ledger.reservations.slice();
  reservations[index] = change(reservations[index]);
  return { ...ledger, reservations };
}
