import { todayUtc8 } from '../projects/membership';
import { hrefFor } from '../search/query';
import { markersIn, normalizeMarker } from './citations';
import type { MaterialItem } from './material';
import type { ReportOutput } from './prompts';

/**
 * Draft reports and specifications (spec 6): the fixed sections, the facts Kainow writes from records, and the
 * assembled Markdown. Pure: no database. The AI writes only the narrative of each section; every name, date and
 * status in a draft's tables and lists comes from the records here.
 */

export type ReportKind = 'status' | 'decisions_actions' | 'risks' | 'specification' | 'free_form';
export const REPORT_KINDS: readonly ReportKind[] = ['status', 'decisions_actions', 'risks', 'specification', 'free_form'];

/** Kinds built from records for a period; the others are built only from chosen sources and threads. */
export const RECORD_KINDS: readonly ReportKind[] = ['status', 'decisions_actions', 'risks'];

export const KIND_LABELS: Readonly<Record<ReportKind, string>> = {
  status: 'Status report',
  decisions_actions: 'Decisions and actions log',
  risks: 'Risk summary',
  specification: 'Specification',
  free_form: 'Free-form draft',
};

/** Spec 6.1. */
export const REPORT_SECTIONS: Readonly<Record<ReportKind, string[]>> = {
  status: ['Summary', 'Progress', 'Overdue and blocked', 'Due in the next 14 days', 'Recent decisions', 'Open questions', 'Significant risks'],
  decisions_actions: ['Decisions', 'Actions'],
  risks: ['Open risks', 'Review dates', 'Changes in the period'],
  specification: ['Purpose', 'Scope', 'Requirements', 'Constraints', 'Open questions', 'Decisions referenced'],
  free_form: ['Draft'],
};

/** The search terms for the passages of the record-based kinds (at most 12, spec 4.3). */
export const SECTION_TERMS: Readonly<Record<ReportKind, string[]>> = {
  status: ['progress', 'completed', 'blocked', 'overdue', 'delay', 'due', 'deadline', 'decided', 'decision', 'question', 'risk', 'issue'],
  decisions_actions: ['decided', 'decision', 'agreed', 'approved', 'action', 'task', 'assigned', 'owner', 'due', 'follow'],
  risks: ['risk', 'issue', 'concern', 'mitigation', 'mitigate', 'threat', 'delay', 'failure', 'problem', 'impact'],
  specification: [],
  free_form: [],
};

export const DRAFT_LABEL = 'AI draft — not approved';

/** How far ahead "Due in the next 14 days" looks from the period's end. */
const AHEAD_DAYS = 14;
/** At most this many rows in one table; the rest are counted. */
const MAX_ROWS = 50;

export interface TaskFact {
  id: string;
  title: string;
  assignee: string;
  /** 'YYYY-MM-DD' (a date, no time zone). */
  dueOn: string;
  status: string;
  authorisedAt: Date;
  completedAt: Date | null;
}
export interface DecisionFact {
  id: string;
  statement: string;
  status: string;
  authorisedAt: Date;
}
export interface QuestionFact {
  id: string;
  text: string;
  status: string;
  askedBy: string;
  authorisedAt: Date;
}
export interface RiskFact {
  id: string;
  description: string;
  severity: string;
  status: string;
  responsible: string | null;
  reviewOn: string | null;
  authorisedAt: Date;
}
export interface RiskChange {
  riskId: string;
  description: string;
  fromStatus: string | null;
  toStatus: string | null;
  at: Date;
}
export interface ReportRecords {
  projectId: string;
  tasks: TaskFact[];
  decisions: DecisionFact[];
  questions: QuestionFact[];
  risks: RiskFact[];
  riskChanges: RiskChange[];
}

export interface Period {
  from: string;
  to: string;
}

const OPEN_TASK = (t: TaskFact) => t.status !== 'completed' && t.status !== 'cancelled';
const OPEN_RISK = (r: RiskFact) => r.status === 'open' || r.status === 'mitigating';
const day = (d: Date) => todayUtc8(d);
const inPeriod = (d: Date | null, p: Period) => d !== null && day(d) >= p.from && day(d) <= p.to;

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function label(s: string | null | undefined): string {
  const t = (s ?? '').replace(/_/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** Longest text in one table cell; record texts are cut so the facts always fit the draft. */
const MAX_CELL = 120;

/** One table cell: one line, at most 120 characters, no pipe that would split the cell, no bracket that would open a link. */
function cell(s: string | null | undefined): string {
  const flat = (s ?? '').replace(/\s+/g, ' ').trim();
  const t = flat.length > MAX_CELL ? `${flat.slice(0, MAX_CELL - 1).trimEnd()}…` : flat;
  return t === '' ? '—' : t.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/([[\]])/g, '\\$1');
}

const link = (projectId: string, kind: 'task' | 'decision' | 'question' | 'risk', id: string, text: string) =>
  `[${cell(text)}](${hrefFor({ kind, projectId, itemId: id, runId: null, versionNo: null, isCurrent: true })})`;

function table(head: string[], rows: string[][]): string {
  if (rows.length === 0) return '_None._';
  const shown = rows.slice(0, MAX_ROWS);
  const lines = [`| ${head.join(' | ')} |`, `|${head.map(() => ' --- ').join('|')}|`, ...shown.map((r) => `| ${r.join(' | ')} |`)];
  if (rows.length > shown.length) lines.push('', `_And ${rows.length - shown.length} more._`);
  return lines.join('\n');
}

const byDue = (a: TaskFact, b: TaskFact) => a.dueOn.localeCompare(b.dueOn) || a.title.localeCompare(b.title);
const byTime = <T extends { authorisedAt: Date }>(a: T, b: T) => a.authorisedAt.getTime() - b.authorisedAt.getTime();

function taskTable(projectId: string, tasks: TaskFact[]): string {
  return table(
    ['Task', 'Assignee', 'Due date', 'Status'],
    tasks.map((t) => [link(projectId, 'task', t.id, t.title), cell(t.assignee), t.dueOn, label(t.status)]),
  );
}

function riskTable(projectId: string, risks: RiskFact[]): string {
  return table(
    ['Risk', 'Severity', 'Responsible', 'Review date', 'Status'],
    risks.map((r) => [link(projectId, 'risk', r.id, r.description), label(r.severity), cell(r.responsible), r.reviewOn ?? '—', label(r.status)]),
  );
}

function decisionTable(projectId: string, decisions: DecisionFact[]): string {
  return table(
    ['Decision', 'Authorised on', 'Status'],
    decisions.map((d) => [link(projectId, 'decision', d.id, d.statement), day(d.authorisedAt), label(d.status)]),
  );
}

/**
 * Kainow's facts for each section, as Markdown, from the records only (spec 6.2): title with link, assignee, due date,
 * status. Dates are UTC+8. "Due in the next 14 days" counts from the period's end. A section with no facts of its own
 * (Summary's narrative, and every section of a specification or free-form draft) is absent or a single line.
 */
export function renderFacts(kind: ReportKind, records: ReportRecords, period: Period): Record<string, string> {
  const p = records.projectId;
  // Only what existed by the end of the period.
  const tasks = records.tasks.filter((t) => day(t.authorisedAt) <= period.to);
  const decisions = records.decisions.filter((d) => inPeriod(d.authorisedAt, period)).sort(byTime);
  const risks = records.risks.filter((r) => day(r.authorisedAt) <= period.to);
  switch (kind) {
    case 'status': {
      const overdue = tasks.filter((t) => OPEN_TASK(t) && t.dueOn < period.to);
      const blocked = tasks.filter((t) => t.status === 'blocked' && !overdue.includes(t));
      const ahead = addDays(period.to, AHEAD_DAYS);
      const due = tasks.filter((t) => OPEN_TASK(t) && t.dueOn >= period.to && t.dueOn <= ahead).sort(byDue);
      const done = tasks.filter((t) => t.status === 'completed' && inPeriod(t.completedAt, period));
      const progress = [...done, ...tasks.filter((t) => t.status === 'in_progress')].sort(byDue);
      const open = records.questions.filter((q) => q.status === 'open' && day(q.authorisedAt) <= period.to).sort(byTime);
      const significant = risks.filter((r) => OPEN_RISK(r) && (r.severity === 'high' || r.severity === 'critical'));
      return {
        Summary: [
          `Tasks: ${tasks.filter(OPEN_TASK).length} open, ${overdue.length} overdue, ${tasks.filter((t) => t.status === 'blocked').length} blocked, ${done.length} completed in the period.`,
          `Decisions in the period: ${decisions.length}. Open questions: ${open.length}. Significant open risks: ${significant.length}.`,
        ].join('\n'),
        Progress: taskTable(p, progress),
        'Overdue and blocked': taskTable(p, [...overdue.sort(byDue), ...blocked.sort(byDue)]),
        'Due in the next 14 days': taskTable(p, due),
        'Recent decisions': decisionTable(p, decisions),
        'Open questions': table(
          ['Question', 'Asked by', 'Recorded on', 'Status'],
          open.map((q) => [link(p, 'question', q.id, q.text), cell(q.askedBy), day(q.authorisedAt), label(q.status)]),
        ),
        'Significant risks': riskTable(p, significant),
      };
    }
    case 'decisions_actions':
      return {
        Decisions: decisionTable(p, decisions),
        Actions: taskTable(p, tasks.filter((t) => inPeriod(t.authorisedAt, period)).sort(byTime)),
      };
    case 'risks': {
      const open = risks.filter(OPEN_RISK);
      const ahead = addDays(period.to, AHEAD_DAYS);
      const reviews = open.filter((r) => r.reviewOn !== null && r.reviewOn <= ahead).sort((a, b) => (a.reviewOn as string).localeCompare(b.reviewOn as string));
      const recorded = risks.filter((r) => inPeriod(r.authorisedAt, period)).map((r) => ({ at: r.authorisedAt, row: [link(p, 'risk', r.id, r.description), day(r.authorisedAt), 'Recorded'] }));
      const changed = records.riskChanges
        .filter((c) => inPeriod(c.at, period))
        .map((c) => ({ at: c.at, row: [link(p, 'risk', c.riskId, c.description), day(c.at), `${label(c.fromStatus) || '—'} → ${label(c.toStatus) || '—'}`] }));
      return {
        'Open risks': riskTable(p, open),
        'Review dates': riskTable(p, reviews),
        'Changes in the period': table(['Risk', 'On', 'Change'], [...recorded, ...changed].sort((a, b) => a.at.getTime() - b.at.getTime()).map((x) => x.row)),
      };
    }
    default:
      return {};
  }
}

export interface DraftHead {
  title: string;
  kind: ReportKind;
  period: Period | null;
  requester: string;
  /** UTC+8 'YYYY-MM-DD'. */
  date: string;
}

const STRICT_GROUP = /\[\s*(P\d+(?:\s*[,;]\s*P\d+)*)\s*\](?!\()/gi;

/** `[P3]` and `[P1, P4]` become footnote references `[^P3]`, `[^P1][^P4]`. */
function footnotes(markdown: string): string {
  return markdown.replace(STRICT_GROUP, (_all, inner: string) =>
    inner
      .split(/[,;]/)
      .map((m) => `[^${normalizeMarker(m) ?? m.trim()}]`)
      .join(''),
  );
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * The AI writes text only: its own footnote definitions, links and images are removed (the link text stays), so every
 * source link in a draft is one Kainow rendered from the material. Raw HTML tags are removed too.
 */
export function plainNarrative(markdown: string): string {
  return markdown
    .split('\n')
    .filter((line) => !/^\s{0,3}\[\^[^\]]*\]:/.test(line) && !/^\s{0,3}\[[^\]]+\]:\s*\S/.test(line))
    .join('\n')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<\/?[a-z][^>]*>/gi, '')
    .replace(/\[\^([^\]]*)\]/g, '[$1]');
}

/**
 * The draft (spec 6.2): Kainow's heading block, then each section of the kind in order, Kainow's facts first and the
 * AI narrative after, with citations as footnote links, then the Sources list of every cited marker. Sections the AI
 * wrote that the kind does not have are left out.
 */
export function assembleDraft(head: DraftHead, facts: Record<string, string>, narrative: ReportOutput, material: Array<Pick<MaterialItem, 'marker' | 'location' | 'href'>>): string {
  const lines: string[] = [`# ${head.title.replace(/\s+/g, ' ').trim()}`, '', `${KIND_LABELS[head.kind]}`];
  // The caller passes a period only when the draft's material and facts are limited by it.
  if (head.period) lines.push(`Period: ${head.period.from} to ${head.period.to}`);
  lines.push(`Drafted by AI for ${head.requester} on ${head.date}`);
  const cited: string[] = [];
  for (const section of REPORT_SECTIONS[head.kind]) {
    lines.push('', `## ${section}`, '');
    const parts: string[] = [];
    const fact = facts[section]?.trim();
    if (fact) parts.push(fact);
    const written = narrative.sections.filter((s) => sameName(s.section, section));
    for (const s of written) {
      const text = plainNarrative(s.markdown).trim();
      if (text !== '') parts.push(footnotes(text));
      for (const m of [...markersIn(text), ...s.cited.map((c) => normalizeMarker(c)).filter((c): c is string => c !== null)]) {
        if (!cited.includes(m)) cited.push(m);
      }
    }
    lines.push(parts.length > 0 ? parts.join('\n\n') : '_Nothing to report._');
  }
  lines.push('', '## Sources', '');
  const sources = cited
    .map((m) => material.find((x) => x.marker === m))
    .filter((x): x is Pick<MaterialItem, 'marker' | 'location' | 'href'> => x !== undefined)
    .sort((a, b) => Number(a.marker.slice(1)) - Number(b.marker.slice(1)));
  if (sources.length === 0) lines.push('No sources were cited.');
  else lines.push(...sources.map((s) => `[^${s.marker}]: [${s.location.replace(/([[\]])/g, '\\$1')}](${s.href})`));
  return `${lines.join('\n')}\n`;
}
