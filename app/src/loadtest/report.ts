import { JOURNEYS, type JourneyName } from './journeys';

/**
 * The load-test report (10b spec 13.1 step 4 and the aims of 13.2). Pure: the run gathers the numbers, this turns them
 * into Markdown. Percentiles are nearest-rank.
 */

/** One HTTP request made by a virtual person. A refusal is an answer the journey expects (approving a decided item). */
export interface Sample {
  journey: JourneyName;
  /** Method and path with ids replaced, e.g. `GET /projects/:id/records`. */
  label: string;
  method: string;
  status: number;
  ms: number;
  outcome: 'ok' | 'refusal' | 'error';
}

export interface AiResult {
  /** Extractions the journey asked for (answered 202). */
  requested: number;
  succeeded: number;
  failed: number;
  /** Still queued or running when the drain time ran out: counted as lost. */
  notFinished: number;
  /** From the request to the moment the fake provider received the call. */
  queueWaitMs: number[];
  /** The provider call itself (the fake's 3-8 s). */
  runMs: number[];
  /** The AI places setting (requests at once). */
  slots: number;
  /** Most calls the fake provider had open at once. */
  maxInFlight: number;
  /** The longest time one request waited while a place was free (pick-up and polling delay included). */
  maxIdleSlotWaitMs: number;
}

export interface EmailResult {
  produced: number;
  sent: number;
  notSent: number;
  sendDelayMs: number[];
}

export interface DbResult {
  /** Most connections open to the database (pooled idle ones included). */
  maxConnections: number;
  /** Most of them running a statement at once. */
  maxActive: number;
  sizeBeforeBytes: number;
  sizeAfterBytes: number;
  slowest: { query: string; calls: number; meanMs: number }[] | null;
  slowestNote: string;
}

export interface WorkerLag {
  queue: string;
  jobs: number;
  p95LagMs: number | null;
  maxLagMs: number | null;
}

export interface RunResult {
  params: { base: string; users: number; minutes: number; thinkMs: [number, number]; seed: number };
  startedAt: string;
  endedAt: string;
  /** Journeys started, by kind. */
  journeys: Record<JourneyName, number>;
  samples: Sample[];
  ai: AiResult;
  email: EmailResult;
  db: DbResult;
  worker: WorkerLag[];
  /** Conditions worth reading next to the numbers (shared database container, routes chosen). */
  notes: string[];
}

export interface Machine {
  label: string;
  os: string;
  cpu: string;
  cores: number;
  memoryGb: number;
  disk: string;
  docker: string;
  node: string;
  database: string;
}

/** Allowance for picking up a queued AI job when a place is free: the pg-boss fetch and the 1 s slot poll. */
export const IDLE_SLOT_ALLOWANCE_MS = 5000;
/** Spec 13.2: every email produced is sent within 5 minutes. */
export const EMAIL_LIMIT_MS = 5 * 60_000;

export function percentile(xs: number[], q: number): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)];
}

export interface Row {
  journey: JourneyName;
  count: number;
  errors: number;
  refusals: number;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
}

/** Per journey: requests, errors, expected refusals and response times (every request counted, refusals included). */
export function summarise(samples: Sample[]): Row[] {
  return JOURNEYS.map((journey) => {
    const mine = samples.filter((s) => s.journey === journey);
    const ms = mine.map((s) => s.ms);
    return {
      journey,
      count: mine.length,
      errors: mine.filter((s) => s.outcome === 'error').length,
      refusals: mine.filter((s) => s.outcome === 'refusal').length,
      p50Ms: percentile(ms, 0.5),
      p95Ms: percentile(ms, 0.95),
      p99Ms: percentile(ms, 0.99),
    };
  });
}

export interface AimRow {
  aim: string;
  target: string;
  measured: string;
  met: boolean;
}

const n = (x: number | null): string => (x === null ? '–' : Math.round(x).toLocaleString('en-GB'));
const sec = (x: number | null): string => (x === null ? '–' : `${(x / 1000).toFixed(1)} s`);

export function aims(r: RunResult): AimRow[] {
  const reads = percentile(r.samples.filter((s) => s.method === 'GET').map((s) => s.ms), 0.95);
  const saves = percentile(r.samples.filter((s) => s.method !== 'GET').map((s) => s.ms), 0.95);
  const errors = r.samples.filter((s) => s.outcome === 'error').length;
  const ai = r.ai;
  const aiMet = ai.notFinished === 0 && ai.maxInFlight <= ai.slots && ai.maxIdleSlotWaitMs <= IDLE_SLOT_ALLOWANCE_MS;
  const emailMax = r.email.sendDelayMs.length ? Math.max(...r.email.sendDelayMs) : null;
  const emailMet = r.email.notSent === 0 && (emailMax === null || emailMax <= EMAIL_LIMIT_MS);
  return [
    { aim: 'Page reads (GET)', target: 'p95 under 1 s', measured: `${n(reads)} ms`, met: reads !== null && reads < 1000 },
    { aim: 'Saves (POST/PUT/PATCH/DELETE)', target: 'p95 under 2 s', measured: `${n(saves)} ms`, met: saves !== null && saves < 2000 },
    { aim: 'Errors', target: 'none, other than expected refusals', measured: `${errors}`, met: errors === 0 },
    {
      aim: 'AI queue',
      target: `${ai.slots} places honoured, none lost, no wait while a place is free (allowance ${sec(IDLE_SLOT_ALLOWANCE_MS)})`,
      measured: `${ai.requested} requested, ${ai.succeeded} succeeded, ${ai.failed} failed, ${ai.notFinished} lost; at most ${ai.maxInFlight} at once; longest wait with a free place ${sec(ai.maxIdleSlotWaitMs)}`,
      met: aiMet,
    },
    {
      aim: 'Email queue',
      target: 'every email sent within 5 minutes',
      measured: `${r.email.produced} produced, ${r.email.sent} sent, ${r.email.notSent} not sent; slowest ${sec(emailMax)}`,
      met: emailMet,
    },
  ];
}

function grouped(samples: Sample[], outcome: Sample['outcome']): string {
  const counts = new Map<string, { journey: string; label: string; status: number; count: number }>();
  for (const s of samples.filter((x) => x.outcome === outcome)) {
    const key = `${s.journey}\u0000${s.label}\u0000${s.status}`;
    const row = counts.get(key) ?? { journey: s.journey, label: s.label, status: s.status, count: 0 };
    row.count++;
    counts.set(key, row);
  }
  const rows = [...counts.values()].sort((a, b) => b.count - a.count || a.journey.localeCompare(b.journey) || a.label.localeCompare(b.label) || a.status - b.status);
  if (rows.length === 0) return 'None.';
  return ['| Journey | Request | Status | Count |', '|---|---|---|---|', ...rows.map((r) => `| ${r.journey} | ${r.label} | ${r.status} | ${r.count} |`)].join('\n');
}

const mb = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/** The report as Markdown. */
export function writeReport(r: RunResult, m: Machine): string {
  const rows = summarise(r.samples);
  const aimRows = aims(r);
  const missed = aimRows.filter((a) => !a.met);
  const all = r.samples.map((s) => s.ms);
  const out: string[] = [];
  out.push(`## Result of ${r.startedAt.slice(0, 10)}`, '');
  out.push(`_measured on ${m.label}; not a hardware guarantee_`, '');
  out.push('### Machine', '');
  out.push('| | |', '|---|---|');
  out.push(`| Operating system | ${m.os} |`, `| CPU | ${m.cpu} (${m.cores} logical cores) |`, `| Memory | ${m.memoryGb} GB |`, `| Disk | ${m.disk} |`);
  out.push(`| Docker | ${m.docker} |`, `| Node | ${m.node} |`, `| Database | ${m.database} |`, '');
  out.push('### Parameters', '');
  out.push(`- ${r.params.users} virtual people at once for ${r.params.minutes} minutes, think time ${r.params.thinkMs[0] / 1000}–${r.params.thinkMs[1] / 1000} s, journey seed ${r.params.seed}.`);
  out.push(`- From ${r.startedAt} to ${r.endedAt}; ${r.samples.length.toLocaleString('en-GB')} requests in ${Object.values(r.journeys).reduce((a, b) => a + b, 0).toLocaleString('en-GB')} journeys.`);
  out.push(`- Journeys started: ${JOURNEYS.map((j) => `${j} ${r.journeys[j]}`).join(', ')}.`, '');
  out.push('### Aims', '');
  out.push('| Aim | Target | Measured | Result |', '|---|---|---|---|');
  for (const a of aimRows) out.push(`| ${a.aim} | ${a.target} | ${a.measured} | ${a.met ? 'met' : 'missed'} |`);
  out.push('');
  out.push(missed.length === 0 ? 'Every aim was met.' : `Missed: ${missed.map((a) => a.aim).join('; ')}. Reported to the Product Owner, who decides.`, '');
  out.push('### Response times by activity', '');
  out.push('| Activity | Requests | Errors | Expected refusals | p50 ms | p95 ms | p99 ms |', '|---|---|---|---|---|---|---|');
  for (const row of rows) out.push(`| ${row.journey} | ${row.count} | ${row.errors} | ${row.refusals} | ${n(row.p50Ms)} | ${n(row.p95Ms)} | ${n(row.p99Ms)} |`);
  out.push(`| all | ${all.length} | ${r.samples.filter((s) => s.outcome === 'error').length} | ${r.samples.filter((s) => s.outcome === 'refusal').length} | ${n(percentile(all, 0.5))} | ${n(percentile(all, 0.95))} | ${n(percentile(all, 0.99))} |`, '');
  out.push('### Errors', '', grouped(r.samples, 'error'), '');
  out.push('### Expected refusals', '', grouped(r.samples, 'refusal'), '');
  out.push('### AI and email jobs', '');
  out.push('| Queue | Jobs | Wait p50 | Wait p95 | Wait max | Run p50 | Run p95 |', '|---|---|---|---|---|---|---|');
  const ai = r.ai;
  out.push(
    `| AI (extraction, fake provider) | ${ai.requested} | ${sec(percentile(ai.queueWaitMs, 0.5))} | ${sec(percentile(ai.queueWaitMs, 0.95))} | ${sec(ai.queueWaitMs.length ? Math.max(...ai.queueWaitMs) : null)} | ${sec(percentile(ai.runMs, 0.5))} | ${sec(percentile(ai.runMs, 0.95))} |`,
  );
  const em = r.email;
  out.push(`| Email (created to sent) | ${em.produced} | ${sec(percentile(em.sendDelayMs, 0.5))} | ${sec(percentile(em.sendDelayMs, 0.95))} | ${sec(em.sendDelayMs.length ? Math.max(...em.sendDelayMs) : null)} | – | – |`, '');
  out.push('### Database', '');
  out.push(`- Connections (most seen, sampled every 5 s): ${r.db.maxConnections} open, ${r.db.maxActive} running a statement at once.`);
  out.push(`- Size before ${mb(r.db.sizeBeforeBytes)}, after ${mb(r.db.sizeAfterBytes)}.`);
  if (r.db.slowest && r.db.slowest.length) {
    out.push('- Slowest statements (pg_stat_statements, mean time):', '', '| Mean ms | Calls | Statement |', '|---|---|---|');
    for (const s of r.db.slowest) out.push(`| ${s.meanMs.toFixed(1)} | ${s.calls} | \`${s.query.replace(/\s+/g, ' ').replace(/\|/g, '\\|').slice(0, 160)}\` |`);
    out.push('');
  } else {
    out.push(`- Slowest statements: ${r.db.slowestNote}.`, '');
  }
  out.push('### Worker lag (job created to job started)', '');
  if (r.worker.length === 0) out.push('No worker jobs were recorded.', '');
  else {
    out.push('| Queue | Jobs | p95 | Max |', '|---|---|---|---|');
    for (const w of r.worker) out.push(`| ${w.queue} | ${w.jobs} | ${sec(w.p95LagMs)} | ${sec(w.maxLagMs)} |`);
    out.push('');
  }
  if (r.notes.length) {
    out.push('### Conditions', '');
    for (const note of r.notes) out.push(`- ${note}`);
    out.push('');
  }
  return out.join('\n');
}
