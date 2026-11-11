// The sweep (spec §4–§6): finds due triggers in every Active project, decides recipients and outcomes, records each
// trigger once with its in-app notifications, then queues notice emails by each person's choice.
import type { Pool } from 'pg';
import type { Clock } from '../auth/tokens';
import { uuidv7 } from '../common/uuid7';
import { runScheduledDigest } from '../digests/digest';
import type { EmailNudge } from '../email/nudge';
import { todayUtc8 } from '../projects/membership';
import { type Decided, type Outcome, recordTrigger, unrecordedKeys } from './fire';
import { mailDue } from './mailing';
import { type PlannedTrigger, type RiskSnap, type TaskSnap, dueNow, planProject } from './planner';
import { type Holder, applyCover, holdersOf, loadAdmins, routeFor } from './recipients';
import { resumptionTrigger } from './resumption';
import { loadOrgRow } from './settings';
import { type ProjectData, loadSweepData } from './sweep-data';
import { linkFor, triggerSummary } from './summaries';
import { unavailableTriggers } from './unavailable';

export interface SweepLog {
  /** Fixed messages only; never an error object or record content. */
  warn(message: string): void;
}

export interface SweepDeps {
  pool: Pool;
  clock: Clock;
  appUrl: string;
  nudge: EmailNudge;
  log: SweepLog;
}

export interface SweepCounts {
  /** Trigger rows recorded, whatever their outcome. */
  triggers: number;
  notifications: number;
  emails: number;
}

const COVERED = new Set(['overdue', 'parent_deadline']);

interface ProjectCtx {
  project: { id: string; name: string };
  now: Date;
  today: string;
  holders: Holder[];
  unreachable: ReadonlySet<string>;
  admins: string[];
  resumedAt: Date | null;
  tasks: Map<string, TaskSnap>;
  risks: Map<string, RiskSnap>;
}

/** Recipients, outcome and notice content for one planned trigger that is due. */
export function decide(p: PlannedTrigger, ctx: ProjectCtx, obsolete: boolean): Decided {
  const base = {
    key: p.key, kind: p.kind, projectId: ctx.project.id, recordKind: p.recordKind, recordId: p.recordId, fireAt: p.fireAt,
    summary: '', link: null,
  };
  const skipped = (outcome: Outcome): Decided => ({ ...base, outcome, recipients: [], detail: { ...p.detail } });
  // A time that fell while the project was paused is recorded as paused (spec §4.7), even when it is also obsolete.
  if (ctx.resumedAt && p.fireAt.getTime() < ctx.resumedAt.getTime()) return skipped('skipped_paused');
  if (obsolete) return skipped('skipped_obsolete');

  const assigneeId = p.recordKind === 'task' ? (ctx.tasks.get(p.recordId)?.assigneeId ?? null) : null;
  const responsibleId = p.recordKind === 'risk' ? (ctx.risks.get(p.recordId)?.responsibleId ?? null) : null;
  const route = routeFor(p.kind, { holders: ctx.holders, assigneeId, responsibleId, admins: [] });
  const { to, covering } = COVERED.has(p.kind)
    ? applyCover(p.kind, route, { holders: ctx.holders, assigneeId, unreachable: ctx.unreachable })
    : { to: route.to, covering: [] as string[] };
  const d = p.detail;
  return {
    ...base,
    outcome: route.noIndependent || to.length === 0 ? 'no_recipient' : 'sent',
    recipients: to,
    detail: { ...d, covering },
    summary: triggerSummary(p.kind, {
      title: d.title as string | undefined,
      dueOn: d.dueOn as string | undefined,
      parentDueOn: d.parentDueOn as string | undefined,
      description: d.description as string | undefined,
      reviewOn: d.reviewOn as string | undefined,
    }),
    link: linkFor(ctx.project.id, p.recordKind, p.recordId),
  };
}

/** One project's planned work for this run, before the recorded-key check. */
interface Prepared {
  ctx: ProjectCtx;
  fire: PlannedTrigger[];
  obsolete: PlannedTrigger[];
  unavailable: Decided[];
  resumed: Decided | null;
  /** Every key that may be recorded now (due, obsolete and unavailable). */
  keys: string[];
}

export class Sweep {
  constructor(private readonly deps: SweepDeps) {}

  /** Runs when `sweep_minutes` have passed since the last run started (or there was none). */
  async runIfDue(): Promise<boolean> {
    const now = this.deps.clock();
    const last = (await this.deps.pool.query(`SELECT max(started_at) AS at FROM sweep_runs`)).rows[0]?.at as Date | null;
    const minutes = (await loadOrgRow(this.deps.pool)).sweepMinutes;
    if (last && now.getTime() - last.getTime() < minutes * 60_000) return false;
    await this.run();
    return true;
  }

  async run(): Promise<SweepCounts> {
    const { pool, clock, log } = this.deps;
    const now = clock();
    const counts: SweepCounts = { triggers: 0, notifications: 0, emails: 0 };
    const projects = (await pool.query(`SELECT id, name FROM projects WHERE status = 'active' ORDER BY id`)).rows as { id: string; name: string }[];
    const admins = projects.length > 0 ? await loadAdmins(pool) : [];
    // Everything the per-project work reads, loaded together; a failure here is retried at the next sweep.
    let data = new Map<string, ProjectData>();
    try {
      data = await loadSweepData(pool, projects.map((p) => p.id), todayUtc8(now));
    } catch {
      log.warn('The sweep could not load the projects; it is tried again at the next sweep');
    }
    // Plan every project first, then ask once which of the due keys are not recorded yet, then record.
    const prepared: Prepared[] = [];
    for (const project of projects) {
      try {
        const d = data.get(project.id);
        if (d) prepared.push(await this.prepareProject(project, d, now, admins));
      } catch {
        log.warn('The sweep could not finish a project; it is tried again at the next sweep');
      }
    }
    let fresh = new Set<string>();
    let keysLoaded = false;
    try {
      fresh = await unrecordedKeys(pool, prepared.flatMap((p) => p.keys));
      keysLoaded = true;
    } catch {
      log.warn('The sweep could not check which triggers are recorded; it is tried again at the next sweep');
    }
    for (const p of keysLoaded ? prepared : []) {
      try {
        await this.recordProject(p, fresh, now, counts);
      } catch {
        log.warn('The sweep could not finish a project; it is tried again at the next sweep');
      }
    }
    let digestEmails = 0;
    for (const project of projects) {
      try {
        const eff = data.get(project.id)?.effective;
        if (!eff) continue;
        digestEmails += await runScheduledDigest(pool, project, eff.cal, eff.digest, now, this.deps.appUrl);
      } catch {
        log.warn('The sweep could not send a scheduled digest; it is tried again at the next sweep');
      }
    }
    try {
      counts.emails = (await mailDue(pool, now, this.deps.appUrl)) + digestEmails;
    } catch {
      counts.emails = digestEmails;
      log.warn('The sweep could not queue notice emails; they are tried again at the next sweep');
    }
    if (counts.emails > 0) {
      try {
        await this.deps.nudge.nudge();
      } catch {
        log.warn('The sweep could not nudge the email worker; the scheduled tick still finds the emails');
      }
    }
    const finished = clock();
    await pool.query(
      `INSERT INTO sweep_runs (id, started_at, finished_at, duration_ms, triggers_fired, emails_queued) VALUES ($1, $2, $3, $4, $5, $6)`,
      [uuidv7(), now, finished, Math.max(0, finished.getTime() - now.getTime()), counts.triggers, counts.emails],
    );
    return counts;
  }

  private async prepareProject(project: { id: string; name: string }, data: ProjectData, now: Date, admins: string[]): Promise<Prepared> {
    const { pool } = this.deps;
    const today = todayUtc8(now);
    const eff = data.effective;
    const tasks: TaskSnap[] = data.tasks;
    const risks = data.risks;
    const { fire, obsolete } = dueNow(planProject({ cal: eff.cal, timings: eff.timings, tasks, risks }), now);
    const holders = holdersOf(data.memberships.filter((m) => m.userActive), today);
    const ctx: ProjectCtx = {
      project, now, today, holders, unreachable: data.unreachable, admins, resumedAt: data.resumedAt,
      tasks: new Map(tasks.map((t) => [t.id, t])),
      risks: new Map(risks.map((r) => [r.id, r])),
    };
    const unavailable = await unavailableTriggers(pool, project, {
      ...ctx,
      preloaded: { tasks: data.tasks.filter((t) => !t.deadlineReviewRequired), memberships: data.memberships },
    });
    const resumed = await resumptionTrigger(pool, project, { ...ctx, latestActive: data.latestActive });
    const keys = [...fire, ...obsolete].map((p) => p.key).concat(unavailable.map((d) => d.key));
    return { ctx, fire, obsolete, unavailable, resumed, keys };
  }

  private async recordProject(p: Prepared, fresh: ReadonlySet<string>, now: Date, counts: SweepCounts): Promise<void> {
    const { ctx } = p;
    const decided: Decided[] = [
      ...p.obsolete.filter((t) => fresh.has(t.key)).map((t) => decide(t, ctx, true)),
      ...p.fire.filter((t) => fresh.has(t.key)).map((t) => decide(t, ctx, false)),
      ...p.unavailable.filter((d) => fresh.has(d.key)),
    ];
    if (p.resumed) decided.push(p.resumed);
    for (const d of decided) {
      const r = await recordTrigger(this.deps.pool, d, now);
      counts.triggers += r.triggers;
      counts.notifications += r.notifications;
    }
  }
}
