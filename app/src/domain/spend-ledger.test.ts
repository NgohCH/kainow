import { test } from "node:test";
import assert from "node:assert/strict";
import { committedSen, confirm, monthKeyUtc8, release, reserve, type Ledger } from "./spend-ledger";

const CAP = 2000; // MYR 20.00
const empty = (cap: number | null = CAP): Ledger => ({ monthlyCapSen: cap, reservations: [] });
const midMonth = new Date("2026-11-15T04:00:00Z"); // 12:00 UTC+8, November

test("month boundary is UTC+8, not UTC", () => {
  assert.equal(monthKeyUtc8(new Date("2026-11-30T15:59:59Z")), "2026-11"); // 23:59:59 UTC+8
  assert.equal(monthKeyUtc8(new Date("2026-11-30T16:00:00Z")), "2026-12"); // 00:00 UTC+8 on 1 Dec
});

test("reservation within the cap is accepted and counted", () => {
  const r = reserve(empty(), { id: "a", estimateSen: 1500, at: midMonth });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(committedSen(r.ledger, "2026-11"), 1500);
});

test("reservation that would exceed the cap is refused before any call", () => {
  const first = reserve(empty(), { id: "a", estimateSen: 1500, at: midMonth });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const second = reserve(first.ledger, { id: "b", estimateSen: 600, at: midMonth });
  assert.deepEqual(second, { ok: false, reason: "cap_exceeded", committedSen: 1500 });
});

test("a reservation that lands exactly on the cap is allowed", () => {
  const r = reserve(empty(), { id: "a", estimateSen: CAP, at: midMonth });
  assert.equal(r.ok, true);
});

test("unconfirmed reservations keep counting until reconciled", () => {
  const r = reserve(empty(), { id: "a", estimateSen: 1800, at: midMonth });
  if (!r.ok) throw new Error("setup failed");
  // Still reserved (no confirmation): a second 300 call must be refused.
  assert.equal(reserve(r.ledger, { id: "b", estimateSen: 300, at: midMonth }).ok, false);
});

test("confirming replaces the estimate with the actual cost", () => {
  const r = reserve(empty(), { id: "a", estimateSen: 1800, at: midMonth });
  if (!r.ok) throw new Error("setup failed");
  const after = confirm(r.ledger, "a", 900);
  assert.equal(committedSen(after, "2026-11"), 900);
  assert.equal(reserve(after, { id: "b", estimateSen: 1000, at: midMonth }).ok, true);
});

test("releasing a call that never ran frees its amount", () => {
  const r = reserve(empty(), { id: "a", estimateSen: 1800, at: midMonth });
  if (!r.ok) throw new Error("setup failed");
  const after = release(r.ledger, "a");
  assert.equal(committedSen(after, "2026-11"), 0);
});

test("null cap means no allowance is configured and calls are not blocked", () => {
  const r = reserve(empty(null), { id: "a", estimateSen: 10_000_000, at: midMonth });
  assert.equal(r.ok, true);
});

test("invalid estimates are refused", () => {
  assert.deepEqual(reserve(empty(), { id: "a", estimateSen: -1, at: midMonth }), {
    ok: false,
    reason: "invalid_estimate",
    committedSen: 0,
  });
  assert.equal(reserve(empty(), { id: "a", estimateSen: 1.5, at: midMonth }).ok, false);
});

test("a new month starts with a fresh allowance", () => {
  const r = reserve(empty(), { id: "a", estimateSen: CAP, at: midMonth });
  if (!r.ok) throw new Error("setup failed");
  const december = new Date("2026-12-02T02:00:00Z");
  assert.equal(reserve(r.ledger, { id: "b", estimateSen: CAP, at: december }).ok, true);
});

test("confirm and release refuse to change a finished reservation", () => {
  const r = reserve(empty(), { id: "a", estimateSen: 100, at: midMonth });
  if (!r.ok) throw new Error("setup failed");
  const done = confirm(r.ledger, "a", 80);
  assert.throws(() => release(done, "a"), /confirmed/);
  assert.throws(() => confirm(done, "missing", 1), /unknown reservation/);
});
