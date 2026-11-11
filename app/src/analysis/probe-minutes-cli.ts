import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DISCUSSION_PREAMBLE, EXTRACTION_SYSTEM_PROMPT, MAX_OUTPUT_TOKENS, REQUEST_TIMEOUT_MS } from '../extraction/prompt';
import { ModelBadResponse, ModelCallError, OpenAiModelClient } from '../extraction/model';
import type { Usage } from '../spend/cost';
import { MAX_MINUTES_INPUT_CHARS, MINUTES_SYSTEM_PROMPT } from './minutes';
import { type TranscriptMessage, buildTranscript, headerOf, placeItem } from './transcript';

/**
 * Real-model check of minutes drafting and discussion analysis (spec 12). Needs no database.
 *
 *   OPENAI_API_KEY=... npm run probe-minutes -- <folder of .txt files> [model id]   (default model gpt-6.1-sol)
 *
 * Each .txt file is one typed meeting or thread. Blocks separated by a blank line are messages; a block that starts with
 * "Name: " is by that person, otherwise by "Participant". The first 40 percent of the messages are earlier context for the
 * analysis and the rest are new (so repeated items can show up). Prints counts and token usage; it never prints the key.
 */

const DEFAULT_MODEL = 'gpt-6.1-sol';
const START = Date.UTC(2026, 10, 11, 2, 0, 0);

export function parseMessages(text: string): TranscriptMessage[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter((b) => b !== '')
    .map((block, i) => {
      const m = /^([\p{L}][\p{L} .'-]{0,40}):\s+([\s\S]+)$/u.exec(block);
      return {
        no: i + 1,
        versionId: `v${i + 1}`,
        authorId: m ? m[1] : 'Participant',
        authorName: m ? m[1] : 'Participant',
        at: new Date(START + i * 60_000),
        body: m ? m[2] : block,
        isContext: false,
      };
    });
}

const addUsage = (a: Usage, b: Usage): Usage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
});
const norm = (s: string): string => s.normalize('NFC').toLowerCase();
const usageText = (u: Usage): string => `${u.inputTokens} input, ${u.cachedInputTokens} cached input, ${u.outputTokens} output tokens`;

export interface FileReport {
  file: string;
  lines: string[];
  usage: Usage;
}

export async function probeFile(client: OpenAiModelClient, modelId: string, file: string, text: string): Promise<FileReport> {
  const messages = parseMessages(text);
  const lines: string[] = [];
  let usage: Usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
  lines.push(`${messages.length} messages, ${text.length} characters`);
  if (messages.length === 0) return { file, lines: [...lines, 'nothing to read'], usage };

  // Minutes drafting: the same input the minutes runner builds.
  const input = messages.map((m) => `${headerOf(m)}\n${m.body}`).join('\n\n');
  if (input.length > MAX_MINUTES_INPUT_CHARS) {
    lines.push(`minutes: too long for one request (${input.length} > ${MAX_MINUTES_INPUT_CHARS} characters); not sent`);
  } else {
    try {
      const a = await client.draftMinutes({ modelId, system: MINUTES_SYSTEM_PROMPT, user: input, maxOutputTokens: MAX_OUTPUT_TOKENS, timeoutMs: REQUEST_TIMEOUT_MS });
      usage = addUsage(usage, a.usage);
      const haystack = norm(messages.map((m) => m.body).join('\n'));
      const owners = a.actionItems.filter((i) => i.owner !== null);
      const dues = a.actionItems.filter((i) => i.due !== null);
      const invented = (xs: Array<string | null>) => xs.filter((x): x is string => x !== null && !haystack.includes(norm(x)));
      lines.push(
        `minutes: ${a.decisions.length} decisions, ${a.actionItems.length} action items, ${a.openQuestions.length} open questions, ${a.risks.length} risks, ${a.discussionPoints.length} discussion points`,
        `minutes: owners stated ${owners.length} of ${a.actionItems.length}, dues stated ${dues.length} of ${a.actionItems.length}`,
        `minutes: owners not found word-for-word in the messages ${invented(a.actionItems.map((i) => i.owner)).length}, dues not found word-for-word ${invented(a.actionItems.map((i) => i.due)).length} (must be 0; a non-zero count needs a human look)`,
        `minutes usage: ${usageText(a.usage)}`,
      );
    } catch (err) {
      lines.push(`minutes: ${failure(err)}`);
      if (err instanceof ModelBadResponse) usage = addUsage(usage, err.usage);
    }
  }

  // Discussion analysis: the first 40 percent are earlier context, the rest are new messages.
  const split = Math.floor(messages.length * 0.4);
  const earlier = messages.slice(0, split).map((m) => ({ ...m, isContext: true }));
  const fresh = messages.slice(split);
  const { text: transcript, spans } = buildTranscript(fresh, earlier);
  try {
    const r = await client.extract({
      modelId,
      system: `${DISCUSSION_PREAMBLE} ${EXTRACTION_SYSTEM_PROMPT}`,
      user: transcript,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    usage = addUsage(usage, r.usage);
    let located = 0;
    let unlocated = 0;
    let repeated = 0;
    for (const item of r.items) {
      const placed = placeItem(item.source_quote, transcript, spans);
      if (placed.kind === 'new') located++;
      else if (placed.kind === 'context_only') repeated++;
      else unlocated++;
    }
    const haystack = norm(messages.map((m) => m.body).join('\n'));
    const missing = (xs: Array<string | null>) => xs.filter((x): x is string => x !== null && !haystack.includes(norm(x))).length;
    lines.push(
      `analysis: ${r.items.length} items; quotes located ${located}, unlocated ${unlocated}, repeated (found only in earlier context) ${repeated}`,
      `analysis: owners stated ${r.items.filter((i) => i.owner !== null).length}, dues stated ${r.items.filter((i) => i.due !== null || i.due_event !== null).length}; owners not found word-for-word in the messages ${missing(r.items.map((i) => i.owner))}`,
      `analysis usage: ${usageText(r.usage)}`,
    );
  } catch (err) {
    lines.push(`analysis: ${failure(err)}`);
    if (err instanceof ModelBadResponse) usage = addUsage(usage, err.usage);
  }
  return { file, lines, usage };
}

/** Never includes the key: provider errors are reduced to their status. */
function failure(err: unknown): string {
  if (err instanceof ModelCallError) return `FAILED: ${err.message}${err.status ? ` (status ${err.status})` : ''}`;
  if (err instanceof ModelBadResponse) return `FAILED: ${err.message} (usage still charged: ${usageText(err.usage)})`;
  return `FAILED: ${err instanceof Error ? err.name : 'unknown error'}`;
}

async function main(): Promise<void> {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) throw new Error('Set OPENAI_API_KEY first.');
  const folder = process.argv[2];
  if (!folder) throw new Error('Usage: npm run probe-minutes -- <folder of .txt files> [model id]');
  const modelId = process.argv[3] ?? DEFAULT_MODEL;
  const files = readdirSync(folder).filter((f) => f.toLowerCase().endsWith('.txt')).sort();
  if (files.length === 0) throw new Error('The folder holds no .txt files.');
  const client = new OpenAiModelClient(key);
  let total: Usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
  for (const f of files) {
    const report = await probeFile(client, modelId, f, readFileSync(join(folder, f), 'utf8'));
    total = addUsage(total, report.usage);
    console.log(`\n== ${f}`);
    for (const l of report.lines) console.log(l);
  }
  console.log(`\nTotal usage over ${files.length} file(s): ${usageText(total)}`);
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
