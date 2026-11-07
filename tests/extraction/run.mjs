// Runs the extraction check against each input. Needs OPENAI_API_KEY on the machine
// running it. The sandbox cannot reach api.openai.com, so run this on your computer.
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { scoreSupported, scoreCaptured, passes } from "./score.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(here, "config.json"), "utf8"));
const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.log("OPENAI_API_KEY is not set. Skipping. Nothing was tested.");
  process.exit(0);
}
const inputsDir = process.env.KAINOW_TEST_INPUTS ?? join(here, "inputs", "synthetic");
const model = process.env.KAINOW_MODEL ?? config.model;

const schema = {
  name: "meeting_items",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["items"],
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["kind", "text", "owner", "due", "source_quote"],
          properties: {
            kind: { type: "string", enum: ["decision", "action", "question", "risk"] },
            text: { type: "string" },
            owner: { type: ["string", "null"] },
            due: { type: ["string", "null"] },
            source_quote: { type: "string" },
          },
        },
      },
    },
  },
};

async function extract(text) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content:
            "Extract decisions, actions, open questions and risks from meeting notes. " +
            "Each item must include source_quote copied exactly, character for character, " +
            "from the notes. Do not invent items. Use null when owner or due is not stated.",
        },
        { role: "user", content: text },
      ],
      response_format: { type: "json_schema", json_schema: schema },
    }),
  });
  if (!res.ok) throw new Error(`OpenAI returned ${res.status}: ${await res.text()}`);
  const body = await res.json();
  return JSON.parse(body.choices[0].message.content).items;
}

const results = [];
for (const file of readdirSync(inputsDir).filter((f) => f.endsWith(".md")).sort()) {
  const id = file.slice(0, 6); // SYN-01 etc.
  const expectedPath = join(here, "expected", `${id}.json`);
  const text = readFileSync(join(inputsDir, file), "utf8");
  const items = await extract(text);
  const supported = scoreSupported(items, text);
  let captured = { total: 0, captured: 0, rate: 1, missed: [] };
  try {
    const exp = JSON.parse(readFileSync(expectedPath, "utf8"));
    captured = scoreCaptured(exp.items, items);
  } catch {
    captured.note = "no expected file for this input";
  }
  const ok = passes(supported, captured, config.thresholds);
  results.push({ file, model, supported, captured, pass: ok, items });
  console.log(
    `${ok ? "PASS" : "FAIL"} ${file}: supported ${(supported.rate * 100).toFixed(0)}%, ` +
      `expected captured ${(captured.rate * 100).toFixed(0)}%` +
      (captured.missed?.length ? `, missed ${captured.missed.join(",")}` : ""),
  );
}

mkdirSync(join(here, "out"), { recursive: true });
writeFileSync(join(here, "out", `run-${Date.now()}.json`), JSON.stringify(results, null, 2));
console.log("Full results written to tests/extraction/out/ (git-ignored).");
