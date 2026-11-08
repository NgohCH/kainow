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
    required: ["meeting_date", "items"],
    properties: {
      meeting_date: { type: ["string", "null"] },
      items: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["kind", "text", "owner", "due", "due_event", "alternatives", "source_quote"],
          properties: {
            kind: { type: "string", enum: ["decision", "action", "question", "risk"] },
            text: { type: "string" },
            owner: { type: ["string", "null"] },
            due: { type: ["string", "null"] },
            due_event: { type: ["string", "null"] },
            alternatives: { type: "array", items: { type: "string" } },
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
            "from the notes. The source_quote must contain the whole clause that gives the item " +
            "its meaning, including any approval, condition, exception or deadline that applies " +
            "(for example, a rule plus the exception that needs written approval). " +
            "Do not shorten a quote to one sentence if the rule depends on a following sentence. " +
            "A source_quote must be ONE contiguous passage copied from one place in the notes. " +
            "Never join text from separate sections, lines or table rows, and never add a separator " +
            "such as a line break or table marker between two passages. If one item needs two places, " +
            "split it into two items, each with its own quote. " +
            "If the same decision, action, question or risk is stated in more than one place, for example " +
            "in a summary paragraph and again in a table, report it once, using the quote from the place " +
            "that states it most completely. " +
            "The date or time of the next meeting is not a decision. " +
            "The owner is the person who will do the work or is accountable for the result, not someone " +
            "who only approves or is consulted; use null if the notes name only an approver. " +
            "The due value is the deadline for the item, not the date of the meeting or of an event. " +
            "Report meeting_date as the date of the meeting stated in the notes, in the form YYYY-MM-DD, or null if the notes do not state it. " +
            "Copy the due value as the notes word it, for example 'End of November' or 'Immediate'; do not turn it into a date. " +
            "When an item depends on an event rather than a date, for example 'after the Dean's approval', put the event in due_event; otherwise due_event is null. " +
            "Propose a decision only when the notes make clear it was decided. A decision with a stated condition stays a decision and keeps the condition. " +
            "When the notes leave open whether something is going ahead, for example it was only proposed or is waiting for someone, propose it as a question instead, worded so the open point is explicit, for example 'Is the pilot going ahead now, or waiting for the commercial proposal?' " +
            "Every question must say what is being asked; never only ask to clarify something. " +
            "For a question, list in alternatives two to four short possible answers taken from the notes, or none if the notes suggest none; for other kinds alternatives is empty. " +
            "The owner of a question is the person the notes say must answer it. " +
            "Do not invent items. Use null when owner or due is not stated.",
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
  let captured = null;
  try {
    const exp = JSON.parse(readFileSync(expectedPath, "utf8"));
    captured = scoreCaptured(exp.items, items);
  } catch {
    captured = { total: 0, captured: 0, rate: 0, missed: [], note: "no expected file: NOT SCORED" };
  }
  // A missing expected file must fail, never pass by default.
  // Per-dataset policy: each dataset must meet both thresholds on its own.
  const ok = captured.total > 0 && passes(supported, captured, config.thresholds);
  results.push({ file, model, supported, captured, pass: ok, items });
  console.log(
    `${ok ? "PASS" : "FAIL"} ${file}: supported ${(supported.rate * 100).toFixed(0)}%, ` +
      `expected captured ${captured.total ? (captured.rate * 100).toFixed(0) + "%" : "NOT SCORED"}` +
      (captured.missed?.length ? `, missed ${captured.missed.join(",")}` : ""),
  );
}

mkdirSync(join(here, "out"), { recursive: true });
writeFileSync(join(here, "out", `run-${Date.now()}.json`), JSON.stringify(results, null, 2));
console.log("Full results written to tests/extraction/out/ (git-ignored).");
