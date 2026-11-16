import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { findCredentials } from '../extraction/credentials';
import { type JsonSchemaModel, ModelBadResponse, ModelCallError, OpenAiModelClient } from '../extraction/model';
import { REQUEST_TIMEOUT_MS } from '../extraction/prompt';
import type { Usage } from '../spend/cost';
import { markersIn, normalizeMarker, validateCitations } from './citations';
import { findMarks, parseLeaveOut } from './leave-out';
import { MAX_CHARACTERS, MAX_PASSAGES } from './material';
import { splitPassages } from './passages';
import {
  ANSWER_MAX_OUTPUT_TOKENS,
  QUESTION_SCHEMA,
  QUESTION_SYSTEM,
  REPORT_MAX_OUTPUT_TOKENS,
  REPORT_SCHEMA,
  REPORT_SYSTEM,
  SUMMARY_MAX_OUTPUT_TOKENS,
  SUMMARY_SCHEMA,
  SUMMARY_SYSTEM,
  parseQuestion,
  parseReport,
  parseSummary,
  renderInput,
} from './prompts';
import { KIND_LABELS, RECORD_KINDS, REPORT_KINDS, REPORT_SECTIONS, type ReportKind, SECTION_TERMS } from './reports';
import { MAX_SUMMARY_INPUT } from './summaries.service';
import { buildTerms } from './terms';

/**
 * Real-model check of questions, draft reports and shareable summaries (spec 11). Needs no database.
 *
 *   OPENAI_API_KEY=... npm run probe-assist -- <folder> [model id] [--show]   (default model gpt-6.1-sol)
 *
 * Every .txt file in the folder is one notes or minutes document, except two optional files:
 *   questions.txt   one question per line (default: ten general questions in English and Malay);
 *   leave-out.txt   the Leave out list for the summaries, one item per line or comma-separated.
 * It asks every question, drafts two of each report kind (from the first document, then from all), and summarises
 * the first three documents. Material is chosen in memory the way the passage search does (split into passages,
 * terms from the question, best matches first, 40 passages or 30,000 characters); it approximates the database
 * ranking and is meant to test the model, not the search. Prints counts and token usage only (with --show, also the
 * AI text, so the Product Owner can judge usefulness). It never prints the key.
 */

const DEFAULT_MODEL = 'gpt-6.1-sol';
const SPECIAL = new Set(['questions.txt', 'leave-out.txt']);
const DEFAULT_QUESTIONS = [
  'What was decided in these meetings?',
  'What actions are open, who owns them and when are they due?',
  'What are the main risks and how are they being handled?',
  'What is the current status of the project?',
  'Which questions are still open?',
  'What changed since the last meeting?',
  'Apakah keputusan utama yang telah dibuat?',
  'Siapa bertanggungjawab untuk tindakan seterusnya?',
  'What did the team say about the schedule and the deadline?',
  'What is the budget position?',
];
const DEFAULT_LEAVE_OUT = 'budget, salary, gaji';

export interface ProbeDoc {
  name: string;
  text: string;
}

interface Passage {
  marker: string;
  location: string;
  text: string;
  doc: number;
  ordinal: number;
}

const ZERO: Usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
const addUsage = (a: Usage, b: Usage): Usage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
});
const usageText = (u: Usage): string => `${u.inputTokens} input, ${u.cachedInputTokens} cached input, ${u.outputTokens} output tokens`;
const norm = (s: string): string => s.normalize('NFC').toLowerCase().replace(/\s+/g, ' ');

/**
 * In-memory stand-in for the passage search: with terms, passages that contain a term (or a word starting with its
 * first letters, a rough stem) ranked by hits; without terms, document order. Then the material budget.
 */
export function selectMaterial(docs: ProbeDoc[], terms: string[]): Passage[] {
  const all: Passage[] = [];
  docs.forEach((d, doc) => {
    for (const p of splitPassages(d.text, 'document')) all.push({ marker: '', location: `${d.name} — ${p.location}`, text: p.body, doc, ordinal: p.ordinal });
  });
  let ranked = all;
  if (terms.length > 0) {
    const stems = terms.map((t) => [...t].slice(0, Math.max(4, [...t].length - 2)).join(''));
    const score = (text: string) => {
      const words = norm(text).split(/[^\p{L}\p{N}]+/u);
      return words.filter((w) => stems.some((s) => w.startsWith(s))).length;
    };
    ranked = all
      .map((p, i) => ({ p, i, s: score(p.text) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || a.i - b.i)
      .map((x) => x.p);
  }
  const out: Passage[] = [];
  let characters = 0;
  for (const p of ranked) {
    if (out.length >= MAX_PASSAGES || characters + p.text.length > MAX_CHARACTERS) break;
    characters += p.text.length;
    out.push({ ...p, marker: `P${out.length + 1}` });
  }
  return out;
}

const MONTH = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|januari|februari|mac|mei|julai|ogos|okt|oktober|dis|disember)[a-z]*';
const DATES = new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH}(?:\\s+\\d{4})?\\b|\\b${MONTH}\\s+\\d{1,2}(?:,\\s*\\d{4})?\\b|\\b\\d{4}-\\d{2}-\\d{2}\\b|\\b\\d{1,2}/\\d{1,2}/\\d{2,4}\\b`, 'gi');

/** Dates written in the AI text that do not appear word-for-word in the text it was given (must be none). */
export function datesNotInInput(output: string, input: string): number {
  const hay = norm(input);
  return [...new Set((output.match(DATES) ?? []).map(norm))].filter((d) => !hay.includes(d)).length;
}

/** Never includes the key: provider errors are reduced to their status. */
function failure(err: unknown): string {
  if (err instanceof ModelCallError) return `FAILED: ${err.message}${err.status ? ` (status ${err.status})` : ''}`;
  if (err instanceof ModelBadResponse) return `FAILED: ${err.message} (usage still charged: ${usageText(err.usage)})`;
  return `FAILED: ${err instanceof Error ? err.name : 'unknown error'}`;
}

/** Counts of a cited text: markers written, listed, unknown (not sent) and unlisted, plus the runner's verdict. */
function citationLines(label: string, markdown: string, cited: string[], sent: string[]): string[] {
  const written = markersIn(markdown);
  const listed = cited.map(normalizeMarker);
  const unknown = [...new Set([...written, ...listed.filter((m): m is string => m !== null)])].filter((m) => !sent.includes(m));
  const check = validateCitations(markdown, cited, sent);
  return [
    `${label}: ${written.length} markers written, ${cited.length} listed as cited, ${unknown.length} unknown markers (cited but not sent: must be 0)${unknown.length ? ` ${unknown.join(', ')}` : ''}, ${listed.filter((m) => m === null).length} listed entries that are not markers`,
    `${label}: citation check ${check.ok ? 'passed' : `FAILED (the runner would reject this): ${check.detail}`}`,
  ];
}

export interface ProbeOptions {
  questions?: string[];
  leaveOut?: string;
  show?: boolean;
  log?: (line: string) => void;
}

/** Runs every request against the model; returns the total usage. Output is counts only unless `show`. */
export async function probeFolder(model: JsonSchemaModel, modelId: string, docs: ProbeDoc[], opts: ProbeOptions = {}): Promise<Usage> {
  const log = opts.log ?? console.log;
  let total = ZERO;
  const call = async (system: string, user: string, schema: object, maxOutputTokens: number): Promise<{ content: unknown; usage: Usage } | null> => {
    const found = findCredentials(`${system}\n${user}`);
    if (found.length > 0) {
      log(`  not sent: the input appears to contain ${found.map((f) => f.pattern).join(', ')}`);
      return null;
    }
    try {
      const r = await model.callJson({ modelId, system, user, maxOutputTokens, timeoutMs: REQUEST_TIMEOUT_MS }, schema);
      total = addUsage(total, r.usage);
      return r;
    } catch (err) {
      log(`  ${failure(err)}`);
      if (err instanceof ModelBadResponse) total = addUsage(total, err.usage);
      return null;
    }
  };
  const show = (text: string) => {
    if (opts.show) log(text.split('\n').map((l) => `    | ${l}`).join('\n'));
  };

  // Questions.
  const questions = (opts.questions ?? DEFAULT_QUESTIONS).filter((q) => q.trim() !== '');
  for (const [i, question] of questions.entries()) {
    log(`\n== Question ${i + 1} (${question.length} characters, ${buildTerms(question).length} terms)`);
    const material = selectMaterial(docs, buildTerms(question));
    if (material.length === 0) {
      log('  Nothing in this project matched your question: not sent');
      continue;
    }
    const user = `Question:\n${question}\n\nPassages:\n\n${renderInput(material)}`;
    const r = await call(QUESTION_SYSTEM, user, QUESTION_SCHEMA, ANSWER_MAX_OUTPUT_TOKENS);
    if (!r) continue;
    try {
      const o = parseQuestion(r.content, r.usage);
      log(`  ${material.length} passages sent; not_found ${o.not_found}; ${o.answer_markdown.length} characters`);
      for (const l of citationLines('  answer', o.answer_markdown, o.cited, material.map((m) => m.marker))) log(l);
      log(`  answer: dates not found word-for-word in the passages ${datesNotInInput(o.answer_markdown, user)} (must be 0)`);
      show(o.answer_markdown);
    } catch (err) {
      log(`  ${failure(err)}`);
    }
    log(`  usage: ${usageText(r.usage)}`);
  }

  // Reports: two of each kind, from the first document and then from all of them.
  for (const kind of REPORT_KINDS as readonly ReportKind[]) {
    for (const [j, chosen] of [docs.slice(0, 1), docs].entries()) {
      log(`\n== ${KIND_LABELS[kind]} ${j + 1} (${chosen.length} document${chosen.length === 1 ? '' : 's'})`);
      const terms = RECORD_KINDS.includes(kind) ? SECTION_TERMS[kind] : [];
      const material = selectMaterial(chosen, terms);
      if (material.length === 0) {
        log('  nothing matched: not sent');
        continue;
      }
      const lines = [
        `Draft: ${KIND_LABELS[kind]}`,
        `Title: Probe ${KIND_LABELS[kind].toLowerCase()} ${j + 1}`,
        'Sections (write one entry for each, with the section name exactly as given):',
        ...REPORT_SECTIONS[kind].map((s) => `- ${s}`),
      ];
      if (kind === 'free_form') lines.push('', 'Brief from the person who asked:', 'Write a short update on this work for the wider team.');
      const user = `${lines.join('\n')}\n\nPassages:\n\n${renderInput(material)}`;
      const r = await call(REPORT_SYSTEM, user, REPORT_SCHEMA, REPORT_MAX_OUTPUT_TOKENS);
      if (!r) continue;
      try {
        const o = parseReport(r.content, r.usage);
        const markdown = o.sections.map((s) => s.markdown).join('\n\n');
        const asked = REPORT_SECTIONS[kind];
        const missing = asked.filter((s) => !o.sections.some((x) => x.section === s));
        log(`  ${material.length} passages sent; ${o.sections.length} sections returned, ${missing.length} of ${asked.length} asked missing${missing.length ? ` (${missing.join(', ')})` : ''}`);
        for (const l of citationLines('  draft', markdown, [...new Set(o.sections.flatMap((s) => s.cited))], material.map((m) => m.marker))) log(l);
        log(`  draft: dates not found word-for-word in the passages ${datesNotInInput(markdown, user)} (must be 0)`);
        show(o.sections.map((s) => `## ${s.section}\n${s.markdown}`).join('\n\n'));
      } catch (err) {
        log(`  ${failure(err)}`);
      }
      log(`  usage: ${usageText(r.usage)}`);
    }
  }

  // Summaries of the first three documents, with the Leave out list.
  const leaveOut = opts.leaveOut ?? DEFAULT_LEAVE_OUT;
  const phrases = parseLeaveOut(leaveOut);
  for (const doc of docs.slice(0, 3)) {
    log(`\n== Summary of ${doc.name} (${doc.text.length} characters, ${phrases.length} Leave out items)`);
    if (doc.text.length > MAX_SUMMARY_INPUT) {
      log(`  too long for one summary (${doc.text.length} > ${MAX_SUMMARY_INPUT} characters): not sent`);
      continue;
    }
    const r = await call(SUMMARY_SYSTEM(leaveOut, 'everyone on the project'), doc.text, SUMMARY_SCHEMA, SUMMARY_MAX_OUTPUT_TOKENS);
    if (!r) continue;
    try {
      const o = parseSummary(r.content, r.usage);
      const surviving = [...new Set(findMarks(o.summary_markdown, phrases, []).map((m) => m.phrase))];
      log(`  ${o.summary_markdown.length} characters; omitted categories ${o.omitted_categories.length}`);
      log(`  Leave out phrases surviving into the draft: ${surviving.length}${surviving.length ? ` (${surviving.join(', ')})` : ''} (must be 0; the review marks them)`);
      log(`  summary: dates not found word-for-word in the original ${datesNotInInput(o.summary_markdown, doc.text)} (must be 0)`);
      show(o.summary_markdown);
    } catch (err) {
      log(`  ${failure(err)}`);
    }
    log(`  usage: ${usageText(r.usage)}`);
  }
  log(`\nTotal usage: ${usageText(total)}`);
  return total;
}

async function main(): Promise<void> {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) throw new Error('Set OPENAI_API_KEY first.');
  const args = process.argv.slice(2).filter((a) => a !== '--show');
  const folder = args[0];
  if (!folder) throw new Error('Usage: npm run probe-assist -- <folder of .txt files> [model id] [--show]');
  const modelId = args[1] ?? DEFAULT_MODEL;
  const names = readdirSync(folder).filter((f) => f.toLowerCase().endsWith('.txt'));
  const docs = names
    .filter((f) => !SPECIAL.has(f.toLowerCase()))
    .sort()
    .map((name) => ({ name, text: readFileSync(join(folder, name), 'utf8').replace(/\r\n?/g, '\n').normalize('NFC') }));
  if (docs.length === 0) throw new Error('The folder holds no .txt documents.');
  const special = (name: string) => {
    const f = names.find((n) => n.toLowerCase() === name);
    return f ? readFileSync(join(folder, f), 'utf8') : undefined;
  };
  const questions = special('questions.txt')?.split(/\r?\n/).map((q) => q.trim()).filter((q) => q !== '');
  console.log(`${docs.length} document(s), model ${modelId}`);
  await probeFolder(new OpenAiModelClient(key), modelId, docs, { questions, leaveOut: special('leave-out.txt'), show: process.argv.includes('--show') });
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
