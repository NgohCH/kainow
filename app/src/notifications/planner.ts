// Pure trigger planner (spec §4). Turns a snapshot of one project's tasks, risks and
// settings into every trigger with a stable key and a fire time. No database, no clock.
import type { RiskStatus } from '../records/lifecycles';
import type { TaskStatus } from '../records/tasks';
import {
  type Calendar, deadlineOf, escalationAt, nextSlot, reminderAt, riskDueAt, riskMissedAt,
} from './calendar';

export type TriggerKind =
  | 'reminder' | 'overdue' | 'past_due_set' | 'parent_deadline'
  | 'risk_review_due' | 'risk_review_missed';

export interface TaskSnap {
  id: string;
  parentId: string | null;
  title: string;
  assigneeId: string;
  dueOn: string;
  status: TaskStatus;
  deadlineReviewRequired: boolean;
  dueSetAt: Date;
  reopenCount: number;
}

export interface RiskSnap {
  id: string;
  description: string;
  status: RiskStatus;
  responsibleId: string | null;
  reviewOn: string | null;
}

export interface Timings { leadDays: number[]; escalationDays: number }

export interface PlannedTrigger {
  key: string;
  kind: TriggerKind;
  recordKind: 'task' | 'risk';
  recordId: string;
  fireAt: Date;
  detail: Record<string, unknown>;
}

const isOpen = (t: TaskSnap): boolean => t.status !== 'completed' && t.status !== 'cancelled';
const later = (a: Date, b: Date): Date => (a.getTime() >= b.getTime() ? a : b);

/** Every trigger for open, not-under-review tasks and unresolved risks, regardless of now. */
export function planProject(input: {
  cal: Calendar; timings: Timings; tasks: TaskSnap[]; risks: RiskSnap[];
}): PlannedTrigger[] {
  const { cal, timings, tasks, risks } = input;
  const out: PlannedTrigger[] = [];
  const byId = new Map(tasks.map((t) => [t.id, t]));

  for (const t of tasks) {
    if (!isOpen(t) || t.deadlineReviewRequired) continue;
    const episode = `${t.dueOn}:${t.reopenCount}`;
    const base = { dueOn: t.dueOn, reopenCount: t.reopenCount, title: t.title };

    for (const lead of timings.leadDays) {
      const fireAt = reminderAt(cal, t.dueOn, lead);
      if (fireAt.getTime() < t.dueSetAt.getTime()) continue; // already past when the date took effect
      out.push({
        key: `task:${t.id}:reminder:${lead}:${episode}`, kind: 'reminder',
        recordKind: 'task', recordId: t.id, fireAt, detail: { ...base, lead },
      });
    }

    const setSlot = nextSlot(cal, t.dueSetAt);
    out.push({
      key: `task:${t.id}:overdue:${episode}`, kind: 'overdue', recordKind: 'task', recordId: t.id,
      fireAt: later(escalationAt(cal, t.dueOn, timings.escalationDays), setSlot), detail: { ...base },
    });

    if (t.dueSetAt.getTime() > deadlineOf(t.dueOn).getTime()) {
      out.push({
        key: `task:${t.id}:past_due_set:${episode}`, kind: 'past_due_set',
        recordKind: 'task', recordId: t.id, fireAt: setSlot, detail: { ...base },
      });
    }

    // Parent-deadline: one trigger per (this open task, open ancestor) pair.
    const seen = new Set<string>([t.id]);
    let p = t.parentId ? byId.get(t.parentId) : undefined;
    while (p && !seen.has(p.id)) {
      seen.add(p.id);
      if (isOpen(p) && !p.deadlineReviewRequired) {
        out.push({
          key: `task:${t.id}:parent_deadline:${p.id}:${p.dueOn}`, kind: 'parent_deadline',
          recordKind: 'task', recordId: t.id, fireAt: nextSlot(cal, deadlineOf(p.dueOn)),
          detail: { ...base, parentId: p.id, parentDueOn: p.dueOn, parentTitle: p.title },
        });
      }
      p = p.parentId ? byId.get(p.parentId) : undefined;
    }
  }

  for (const r of risks) {
    if (r.status === 'resolved' || r.reviewOn === null) continue;
    const detail = { reviewOn: r.reviewOn, description: r.description };
    out.push({
      key: `risk:${r.id}:review_due:${r.reviewOn}`, kind: 'risk_review_due',
      recordKind: 'risk', recordId: r.id, fireAt: riskDueAt(cal, r.reviewOn), detail,
    });
    out.push({
      key: `risk:${r.id}:review_missed:${r.reviewOn}`, kind: 'risk_review_missed',
      recordKind: 'risk', recordId: r.id, fireAt: riskMissedAt(cal, r.reviewOn), detail: { ...detail },
    });
  }
  return out;
}

/**
 * Triggers whose time has come. A reminder is obsolete once its task's deadline has passed,
 * or when a later reminder of the same task is also due. Triggers not yet due appear in neither list.
 */
export function dueNow(
  planned: PlannedTrigger[], now: Date,
): { fire: PlannedTrigger[]; obsolete: PlannedTrigger[] } {
  const due = planned.filter((p) => p.fireAt.getTime() <= now.getTime());
  const latest = new Map<string, PlannedTrigger>();
  for (const p of due) {
    if (p.kind !== 'reminder') continue;
    const cur = latest.get(p.recordId);
    if (!cur || p.fireAt.getTime() > cur.fireAt.getTime()) latest.set(p.recordId, p);
  }
  const fire: PlannedTrigger[] = [];
  const obsolete: PlannedTrigger[] = [];
  for (const p of due) {
    if (p.kind !== 'reminder') { fire.push(p); continue; }
    const passed = deadlineOf(String(p.detail.dueOn)).getTime() <= now.getTime();
    if (passed || latest.get(p.recordId) !== p) obsolete.push(p);
    else fire.push(p);
  }
  return { fire, obsolete };
}
