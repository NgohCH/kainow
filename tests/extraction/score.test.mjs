import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreSupported, scoreCaptured, passes } from "./score.mjs";

const input = "Orang B akan menyemak senarai pelajar.\nNo one should announce the new date.";

test("quote must appear verbatim, ignoring whitespace and case", () => {
  const r = scoreSupported(
    [
      { source_quote: "orang  B akan menyemak senarai pelajar." },
      { source_quote: "A made-up sentence." },
    ],
    input,
  );
  assert.equal(r.supported, 1);
  assert.deepEqual(r.unsupported, ["A made-up sentence."]);
});

test("a proposal with no quote is unsupported", () => {
  const r = scoreSupported([{ text: "no quote" }], input);
  assert.equal(r.supported, 0);
});

test("expected item is captured when a quote contains its key phrase", () => {
  const r = scoreCaptured(
    [
      { id: "A1", key: "menyemak" },
      { id: "A2", key: "eight timetable clashes" },
    ],
    [{ source_quote: "Orang B akan menyemak senarai pelajar." }],
  );
  assert.equal(r.captured, 1);
  assert.deepEqual(r.missed, ["A2"]);
});

test("an expected item is also captured by any of its alternative phrases, and not by none of them", () => {
  const expected = [{ id: "A2", key: "Orang C akan menghubungi", alsoKeys: ["Sahkan senarai pelajar"] }];
  const viaAlternative = scoreCaptured(expected, [{ source_quote: "Orang C: Sahkan senarai pelajar yang membayar yuran lewat." }]);
  assert.equal(viaAlternative.captured, 1);
  const viaKey = scoreCaptured(expected, [{ source_quote: "Orang C akan menghubungi bahagian kewangan." }]);
  assert.equal(viaKey.captured, 1);
  const neither = scoreCaptured(expected, [{ source_quote: "Orang B akan menyemak senarai pelajar." }]);
  assert.deepEqual(neither.missed, ["A2"]);
});

test("passes only when both thresholds are met", () => {
  const t = { supportedProposals: 0.95, expectedItemsCaptured: 0.9 };
  assert.equal(passes({ rate: 1 }, { rate: 0.9 }, t), true);
  assert.equal(passes({ rate: 0.94 }, { rate: 1 }, t), false);
  assert.equal(passes({ rate: 1 }, { rate: 0.89 }, t), false);
});
