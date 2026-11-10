// Unavailable-assignee alerts (spec §5): an open task whose assignee no longer holds an Active role in the project
// (On Hold, expired, revoked), or whose awaited invitation was declined, revoked or expired. Each cause alerts once.
import type { Pool } from 'pg';
import { type MembershipRow, type ProjectRole, membershipState } from '../projects/membership';
import type { Decided } from './fire';
import { type Holder, applyCover, routeFor } from './recipients';
import { ADMIN_FALLBACK, linkFor, triggerSummary } from './summaries';

interface TaskRow {
  id: string;
  title: string;
  assigneeId: string;
  dueOn: string;
  reopenCount: number;
  invitationId: string | null;
  invStatus: string | null;
  invExpiresAt: Date | null;
}

type Membership = MembershipRow & { id: string };

/** The cause and its id when the task's assignee is unavailable, else null. */
export function causeOf(
  t: Pick<TaskRow, 'assigneeId' | 'invitationId' | 'invStatus' | 'invExpiresAt'>,
  holderIds: ReadonlySet<string>,
  memberships: Membership[],
  now: Date,
  today: string,
): { cause: 'hold' | 'membership' | 'invitation'; causeId: string } | null {
  if (t.invitationId) {
    const expired = t.invStatus === 'invited' && t.invExpiresAt !== null && t.invExpiresAt.getTime() < now.getTime();
    if (t.invStatus === 'declined' || t.invStatus === 'revoked' || expired) return { cause: 'invitation', causeId: t.invitationId };
    if (t.invStatus === 'invited') return null; // still waiting on the invitation
  }
  if (holderIds.has(t.assigneeId)) return null;
  const own = memberships.filter((m) => m.userId === t.assigneeId);
  const held = own
    .filter((m) => membershipState(m, today) === 'on_hold')
    .sort((a, b) => new Date(b.heldAt as Date).getTime() - new Date(a.heldAt as Date).getTime());
  if (held[0]) return { cause: 'hold', causeId: `${held[0].id}:${new Date(held[0].heldAt as Date).getTime()}` };
  const endedAt = (m: Membership): string => (m.revokedAt ? new Date(m.revokedAt).toISOString().slice(0, 10) : (m.expiresOn ?? ''));
  const ended = own
    .filter((m) => ['expired', 'revoked'].includes(membershipState(m, today)))
    .sort((a, b) => endedAt(b).localeCompare(endedAt(a)) || b.id.localeCompare(a.id));
  if (ended[0]) return { cause: 'membership', causeId: ended[0].id };
  return null; // e.g. a role that has not started yet: nothing to alert
}

/** Alerts not yet keyed for the project's open tasks. Recording (and the unique key) happens in the caller. */
export async function unavailableTriggers(
  pool: Pool,
  project: { id: string; name: string },
  ctx: { now: Date; today: string; holders: Holder[]; admins: string[]; unreachable: ReadonlySet<string> },
): Promise<Decided[]> {
  const tasks = (
    await pool.query(
      `SELECT t.id, t.title, t.assignee_id AS "assigneeId", to_char(t.due_on, 'YYYY-MM-DD') AS "dueOn",
              (SELECT count(*)::int FROM task_events e WHERE e.task_id = t.id AND e.kind = 'reopened') AS "reopenCount",
              t.invitation_id AS "invitationId", i.status AS "invStatus", i.expires_at AS "invExpiresAt"
         FROM tasks t LEFT JOIN invitations i ON i.id = t.invitation_id
        WHERE t.project_id = $1 AND t.status NOT IN ('completed', 'cancelled') AND NOT t.deadline_review_required
        ORDER BY t.id`,
      [project.id],
    )
  ).rows as TaskRow[];
  if (tasks.length === 0) return [];
  const memberships = (
    await pool.query(
      `SELECT id, user_id AS "userId", role, to_char(starts_on, 'YYYY-MM-DD') AS "startsOn", to_char(expires_on, 'YYYY-MM-DD') AS "expiresOn",
              revoked_at AS "revokedAt", held_at AS "heldAt", restored_at AS "restoredAt"
         FROM memberships WHERE project_id = $1`,
      [project.id],
    )
  ).rows.map((r) => ({ ...r, role: r.role as ProjectRole })) as Membership[];
  const holderIds = new Set(ctx.holders.map((h) => h.userId));

  const out: Decided[] = [];
  for (const t of tasks) {
    const c = causeOf(t, holderIds, memberships, ctx.now, ctx.today);
    if (!c) continue;
    const route = routeFor('assignee_unavailable', { holders: ctx.holders, assigneeId: t.assigneeId, admins: ctx.admins });
    const { to, covering } = applyCover('assignee_unavailable', route, { holders: ctx.holders, assigneeId: t.assigneeId, unreachable: ctx.unreachable });
    const base = { dueOn: t.dueOn, reopenCount: t.reopenCount, cause: c.cause, causeId: c.causeId, minimal: route.minimal, covering };
    out.push({
      key: `task:${t.id}:assignee_unavailable:${c.cause}:${c.causeId}`,
      kind: 'assignee_unavailable',
      projectId: project.id,
      recordKind: 'task',
      recordId: t.id,
      fireAt: ctx.now,
      // Only the Administrator fallback can come back empty (no Active Administrator); a PM or Owner list never does.
      outcome: to.length > 0 ? 'sent' : route.minimal ? 'cancelled_ineligible' : 'no_recipient',
      recipients: to,
      detail: route.minimal ? base : { ...base, title: t.title },
      summary: route.minimal ? ADMIN_FALLBACK(project.name) : triggerSummary('assignee_unavailable', { title: t.title }),
      link: route.minimal ? null : linkFor(project.id, 'task', t.id),
    });
  }
  return out;
}
