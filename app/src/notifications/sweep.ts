// The sweep (spec §4–§6): finds due triggers in every Active project, decides recipients and outcomes, records each
// trigger once with its in-app notifications, then queues notice emails by each person's choice.
import type { Pool } from 'pg';
import type { Clock } from '../auth/tokens';
import { uuidv7 } from '../common/uuid7';
import type { EmailNudge } from '../email/nudge';
import { todayUtc8 } from '../projects/membership';
import { type Decided, type Outcome, recordTrigger, recordedKeys } from './fire';
import { mailDue } from './mailing';
import { type PlannedTrigger, type RiskSnap, type TaskSnap, dueNow, planProject } from './planner';
import { type Holder, applyCover, loadAdmins, loadHolders, loadUnreachable, routeFor } from './recipients';
import { latestResumption, resumptionTrigger } from './resumption';
import { loadEffective, loadOrgRow, loadRiskSnaps, loadTaskSnaps } from './settings';
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
  if (obsolete) return skipped('skipped_obsolete');
  if (ctx.resumedAt && p.fireAt.getTime() < ctx.resumedAt.getTime()) return skipped('skipped_paused');

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
    for (const project of projects) {
      try {
        await this.sweepProject(project, now, admins, counts);
      } catch {
        log.warn('The sweep could not finish a project; it is tried again at the next sweep');
      }
    }
    try {
      counts.emails = await mailDue(pool, now, this.deps.appUrl);
    } catch {
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

  private async sweepProject(project: { id: string; name: string }, now: Date, admins: string[], counts: SweepCounts): Promise<void> {
    const { pool } = this.deps;
    const today = todayUtc8(now);
    const eff = await loadEffective(pool, project.id);
    const tasks = await loadTaskSnaps(pool, project.id);
    const risks = await loadRiskSnaps(pool, project.id);
    const { fire, obsolete } = dueNow(planProject({ cal: eff.cal, timings: eff.timings, tasks, risks }), now);
    const seen = await recordedKeys(pool, [...fire, ...obsolete].map((p) => p.key));
    const ctx: ProjectCtx = {
      project, now, today,
      holders: await loadHolders(pool, project.id, today),
      unreachable: await loadUnreachable(pool, project.id, today),
      admins,
      resumedAt: await latestResumption(pool, project.id),
      tasks: new Map(tasks.map((t) => [t.id, t])),
      risks: new Map(risks.map((r) => [r.id, r])),
    };

    const decided: Decided[] = [
      ...obsolete.filter((p) => !seen.has(p.key)).map((p) => decide(p, ctx, true)),
      ...fire.filter((p) => !seen.has(p.key)).map((p) => decide(p, ctx, false)),
    ];
    const unavailable = await unavailableTriggers(pool, project, ctx);
    const seenUnavailable = await recordedKeys(pool, unavailable.map((d) => d.key));
    decided.push(...unavailable.filter((d) => !seenUnavailable.has(d.key)));
    const resumed = await resumptionTrigger(pool, project, ctx);
    if (resumed) decided.push(resumed);

    for (const d of decided) {
      const r = await recordTrigger(pool, d, now);
      counts.triggers += r.triggers;
      counts.notifications += r.notifications;
    }
  }
}
