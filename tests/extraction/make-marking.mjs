// Creates a CSV for a human to mark each expected item by meaning, per model.
// Usage: node tests/extraction/make-marking.mjs <run-output.json>
// Writes tests/extraction/out/marking-<name>.csv (git-ignored).
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const runPath = process.argv[2];
if (!runPath) {
  console.error("Usage: node make-marking.mjs <run-output.json>");
  process.exit(1);
}
const rows = JSON.parse(readFileSync(runPath, "utf8"));
const csv = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
const lines = ["file,model,expected_id,kind,expected_meaning,best_matching_model_item,marking,reason"];

for (const r of rows) {
  const id = r.file.slice(0, 6);
  const expectedPath = join(here, "expected", `${id}.json`);
  let expected;
  try {
    expected = JSON.parse(readFileSync(expectedPath, "utf8")).items;
  } catch {
    lines.push([r.file, r.model, "", "", "NO EXPECTED FILE", "", "", ""].map(csv).join(","));
    continue;
  }
  for (const e of expected) {
    // Show the closest model items by shared owner or due date to help the marker.
    const candidates = r.items
      .filter((it) => (e.owner && it.owner && it.owner.toLowerCase().includes(e.owner.toLowerCase())) ||
                      (e.due && it.due && it.due.toLowerCase().includes(e.due.toLowerCase().split(" ")[0])))
      .map((it) => `[${it.kind}] ${it.text} | quote: ${it.source_quote}`)
      .join(" || ");
    lines.push([r.file, r.model, e.id, e.kind, e.key, candidates, "", ""].map(csv).join(","));
  }
}
mkdirSync(join(here, "out"), { recursive: true });
const outPath = join(here, "out", `marking-${basename(runPath).replace(/\.json$/, "")}.csv`);
writeFileSync(outPath, lines.join("\n") + "\n", "utf8");
console.log(`Wrote ${lines.length - 1} rows to ${outPath}`);
