import { test } from "node:test";
import assert from "node:assert/strict";
import { locateQuote, normaliseText } from "./quote-locator";

test("finds a quote and returns its offsets", () => {
  const r = locateQuote("Alpha beta. Gamma delta.", "Gamma delta.");
  assert.deepEqual(r, { status: "found", span: { start: 12, end: 24, occurrence: 0 } });
});

test("matches NFC-equivalent text (decomposed e-acute in source)", () => {
  const source = "Pelajar étudiant hadir."; // decomposed
  const quote = "Pelajar étudiant"; // composed
  const r = locateQuote(source, quote);
  assert.equal(r.status, "found");
  if (r.status === "found") assert.equal(r.span.start, 0);
});

test("whitespace differences are not matched (exact matching)", () => {
  assert.deepEqual(locateQuote("Orang B  akan menyemak", "Orang B akan menyemak"), {
    status: "not_found",
  });
});

test("reports not_found for text absent from the source", () => {
  assert.deepEqual(locateQuote("abc", "xyz"), { status: "not_found" });
});

test("rejects an empty quote", () => {
  assert.deepEqual(locateQuote("abc", ""), { status: "empty_quote" });
});

test("repeated quote is ambiguous without an occurrence index", () => {
  assert.deepEqual(locateQuote("go. go. go.", "go."), { status: "ambiguous", matches: 3 });
});

test("occurrence index selects the repeat", () => {
  const r = locateQuote("go. go. go.", "go.", 1);
  assert.deepEqual(r, { status: "found", span: { start: 4, end: 7, occurrence: 1 } });
});

test("out-of-range occurrence is reported, not guessed", () => {
  assert.deepEqual(locateQuote("go. go.", "go.", 5), {
    status: "occurrence_out_of_range",
    matches: 2,
  });
});

test("overlapping matches are all counted", () => {
  assert.deepEqual(locateQuote("aaa", "aa"), { status: "ambiguous", matches: 2 });
});

test("normaliseText applies NFC", () => {
  assert.equal(normaliseText("é"), "é");
});
