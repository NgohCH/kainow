import type { Currency } from './money';

export type Adj = { kind: 'correction' | 'refund' | 'conversion'; amount: bigint; approvedAt: Date };

/**
 * The amount that counts towards the project's total, in the reporting currency.
 * null: a foreign-currency entry that has not been converted yet.
 */
export function countedAmount(entry: { amount: bigint; currency: Currency }, reporting: Currency, adjs: Adj[]): bigint | null {
  let counted: bigint | null = entry.currency === reporting ? entry.amount : null;
  const ordered = [...adjs].sort((a, b) => a.approvedAt.getTime() - b.approvedAt.getTime());
  for (const a of ordered) {
    if (a.kind === 'refund') {
      if (counted !== null) counted -= a.amount;
    } else if (a.kind === 'conversion') {
      counted = a.amount;
    } else if (entry.currency === reporting || counted !== null) {
      counted = a.amount;
    }
  }
  return counted;
}

/** The most a further refund may take: the current counted amount (null before conversion). */
export function refundLimit(entry: { amount: bigint; currency: Currency }, reporting: Currency, adjs: Adj[]): bigint | null {
  return countedAmount(entry, reporting, adjs);
}

export type Figures = {
  budget: bigint | null;
  spent: bigint;
  balance: bigint | null;
  percentUsed: number | null;
  overBudget: boolean;
  level: 0 | 1 | 2;
  notInTotals: { currency: Currency; amount: bigint }[];
};

export function figures(input: {
  budget: bigint | null;
  entries: { amount: bigint; currency: Currency; adjustments: Adj[] }[];
  reporting: Currency;
  warn: [number, number];
}): Figures {
  const { budget, entries, reporting, warn } = input;
  let spent = 0n;
  const pending = new Map<Currency, bigint>();
  for (const e of entries) {
    const counted = countedAmount(e, reporting, e.adjustments);
    if (counted === null) pending.set(e.currency, (pending.get(e.currency) ?? 0n) + e.amount);
    else spent += counted;
  }
  const notInTotals = [...pending.entries()]
    .map(([currency, amount]) => ({ currency, amount }))
    .sort((a, b) => (a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0));

  if (budget === null) {
    return { budget, spent, balance: null, percentUsed: null, overBudget: false, level: 0, notInTotals };
  }
  const balance = budget - spent;
  const overBudget = spent > budget;
  if (budget === 0n) {
    return { budget, spent, balance, percentUsed: null, overBudget, level: overBudget ? 2 : 0, notInTotals };
  }
  const percentUsed = Number((spent * 100n) / budget);
  const level = percentUsed >= warn[1] ? 2 : percentUsed >= warn[0] ? 1 : 0;
  return { budget, spent, balance, percentUsed, overBudget, level, notInTotals };
}
