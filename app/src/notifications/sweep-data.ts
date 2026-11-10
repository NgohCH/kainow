// What the sweep reads about every Active project, loaded together for the whole run (a handful of queries) rather than
// project by project (about sixteen each). Every value equals what the per-project loaders return; they remain the
// loaders for everything else (settings pages, digests, eligibility checks).
import type { Pool } from 'pg';
import type { MembershipRow, ProjectRole } from '../projects/membership';
import type { RiskStatus } from '../records/lifecycles';
import type { TaskStatus } from '../records/tasks';
import type { RiskSnap, TaskSnap } from './planner';
import { type Effective, loadEffectiveMany } from './settings';

/** An open task with the invitation facts the unavailable-assignee check needs. */
export interface OpenTaskRow extends TaskSnap {
  invitationId: string | null;
  invStatus: string | null;
  invExpiresAt: Date | null;
}

export type MembershipWithId = MembershipRow & { id: string; userActive: boolean };

export interface LatestActive { id: string; from: string; at: Date }

export interface ProjectData {
  effective: Effective;
  tasks: OpenTaskRow[];
  risks: RiskSnap[];
  memberships: MembershipWithId[];
  /** Away today, or email preference Off for this project. */
  unreachable: Set<string>;
  /** The latest return to Active from Deferred or Closed. */
  resumedAt: Date | null;
  /** The latest transition into Active, of any origin. */
  latestActive: LatestActive | null;
}

const PAUSED = ['deferred', 'closed'];

export async function loadSweepData(pool: Pool, projectIds: string[], today: string): Promise<Map<string, ProjectData>> {
  const out = new Map<string, ProjectData>();
  if (projectIds.length === 0) return out;
  const effective = await loadEffectiveMany(pool, projectIds);
  for (const id of projectIds) {
    out.set(id, {
      effective: effective.get(id) as Effective, tasks: [], risks: [], memberships: [], unreachable: new Set(), resumedAt: null, latestActive: null,
    });
  }
  const of = (id: string): ProjectData => out.get(id) as ProjectData;

  const tasks = await pool.query(
    `SELECT t.project_id AS "projectId", t.id, t.parent_id AS "parentId", t.title, t.assignee_id AS "assigneeId",
            to_char(t.due_on, 'YYYY-MM-DD') AS "dueOn", t.status, t.deadline_review_required AS "deadlineReviewRequired",
            COALESCE((SELECT max(e.at) FROM task_events e
                       WHERE e.task_id = t.id AND (e.kind IN ('authorised', 'deadline_reviewed') OR (e.kind = 'amended' AND e.detail ? 'dueOn'))),
                     t.authorised_at) AS "dueSetAt",
            (SELECT count(*)::int FROM task_events e WHERE e.task_id = t.id AND e.kind = 'reopened') AS "reopenCount",
            t.invitation_id AS "invitationId", i.status AS "invStatus", i.expires_at AS "invExpiresAt"
       FROM tasks t LEFT JOIN invitations i ON i.id = t.invitation_id
      WHERE t.project_id = ANY($1::uuid[]) AND t.status NOT IN ('completed', 'cancelled')
      ORDER BY t.project_id, t.id`,
    [projectIds],
  );
  for (const r of tasks.rows) {
    const { projectId, ...row } = r;
    of(projectId).tasks.push({ ...row, status: row.status as TaskStatus });
  }

  const risks = await pool.query(
    `SELECT project_id AS "projectId", id, description, status, responsible_id AS "responsibleId", to_char(review_on, 'YYYY-MM-DD') AS "reviewOn"
       FROM risks WHERE project_id = ANY($1::uuid[]) AND status <> 'resolved' AND review_on IS NOT NULL ORDER BY project_id, id`,
    [projectIds],
  );
  for (const r of risks.rows) {
    const { projectId, ...row } = r;
    of(projectId).risks.push({ ...row, status: row.status as RiskStatus });
  }

  const members = await pool.query(
    `SELECT m.project_id AS "projectId", m.id, m.user_id AS "userId", m.role, to_char(m.starts_on, 'YYYY-MM-DD') AS "startsOn",
            to_char(m.expires_on, 'YYYY-MM-DD') AS "expiresOn", m.revoked_at AS "revokedAt", m.held_at AS "heldAt",
            m.restored_at AS "restoredAt", (u.status = 'active') AS "userActive"
       FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.project_id = ANY($1::uuid[]) ORDER BY m.project_id, m.user_id, m.id`,
    [projectIds],
  );
  for (const r of members.rows) {
    const { projectId, ...row } = r;
    of(projectId).memberships.push({ ...row, role: row.role as ProjectRole });
  }

  const away = new Set<string>(
    (await pool.query(`SELECT user_id AS "userId" FROM away_periods WHERE removed_at IS NULL AND starts_on <= $1::date AND ends_on >= $1::date`, [today]))
      .rows.map((x: { userId: string }) => x.userId),
  );
  for (const d of out.values()) d.unreachable = new Set(away);
  const off = await pool.query(
    `SELECT project_id AS "projectId", user_id AS "userId" FROM email_preferences WHERE choice = 'off' AND project_id = ANY($1::uuid[])`,
    [projectIds],
  );
  for (const r of off.rows) of(r.projectId).unreachable.add(r.userId);

  const resumed = await pool.query(
    `SELECT project_id AS "projectId", max(at) AS at FROM project_transitions
      WHERE project_id = ANY($1::uuid[]) AND to_status = 'active' AND from_status = ANY($2::text[]) GROUP BY project_id`,
    [projectIds, PAUSED],
  );
  for (const r of resumed.rows) of(r.projectId).resumedAt = r.at as Date;
  const latest = await pool.query(
    `SELECT DISTINCT ON (project_id) project_id AS "projectId", id, from_status AS "from", at FROM project_transitions
      WHERE project_id = ANY($1::uuid[]) AND to_status = 'active' ORDER BY project_id, at DESC, id DESC`,
    [projectIds],
  );
  for (const r of latest.rows) of(r.projectId).latestActive = { id: r.id, from: r.from, at: r.at };
  return out;
}
