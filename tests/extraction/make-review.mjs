// Turns a run output file into a CSV review sheet for the human reviewer.
// Usage: node tests/extraction/make-review.mjs <run-output.json> [inputsDir]
// Writes tests/extraction/out/review-<name>.csv (git-ignored).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { normalise } from "./score.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const [runPath, inputsArg] = process.argv.slice(2);
if (!runPath) {
  console.error("Usage: node make-review.mjs <run-output.json> [inputsDir]");
  process.exit(1);
}
const inputsDir = inputsArg ?? join(here, "inputs", "synthetic");
const rows = JSON.parse(readFileSync(runPath, "utf8"));

const csv = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
const header = [
  "file", "model", "item_no", "kind", "text", "owner", "due", "source_quote",
  "quote_verbatim", "classification_ok", "owner_ok", "conditional_ok",
  "duplicate_of", "reviewer_notes",
];
const lines = [header.join(",")];

for (const r of rows) {
  const inputPath = join(inputsDir, r.file);
  const input = existsSync(inputPath) ? normalise(readFileSync(inputPath, "utf8")) : null;
  r.items.forEach((it, i) => {
    const verbatim = input === null ? "INPUT MISSING" : input.includes(normalise(it.source_quote ?? "")) ? "yes" : "NO";
    lines.push([
      r.file, r.model, i + 1, it.kind, it.text, it.owner ?? "", it.due ?? "", it.source_quote,
      verbatim, "", "", "", "", "",
    ].map(csv).join(","));
  });
}

mkdirSync(join(here, "out"), { recursive: true });
const outPath = join(here, "out", `review-${basename(runPath).replace(/\.json$/, "")}.csv`);
writeFileSync(outPath, lines.join("\n") + "\n", "utf8");
console.log(`Wrote ${lines.length - 1} items to ${outPath}`);
