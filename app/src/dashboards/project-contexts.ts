import type { Pool } from 'pg';
import type { AuthUser } from '../auth/tokens';
import { loadAccessSettings } from '../organisation/access-settings';
import { type MembershipRecord, type ProjectContext, buildProjectContext } from '../projects/access.service';
import { archiveState } from '../projects/archive';
import type { GrantRow } from '../projects/grants';
import type { ProjectStatus } from '../projects/matrix';

/** Batched project loading shared by the personal dashboard and the leadership summary: a fixed number of queries however many projects. */

export function groupBy<T>(rows: T[], key: (r: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    const list = m.get(k);
    if (list) list.push(r);
    else m.set(k, [r]);
  }
  return m;
}

/** Every candidate's context, built by the rule `ProjectAccess.load` uses, from three batched queries. */
export async function loadProjectContexts(pool: Pool, user: AuthUser, ids: string[], today: string) {
  const projects = (
    await pool.query(
      `SELECT p.id, p.name, p.status, to_char(p.created_at AT TIME ZONE 'Asia/Kuala_Lumpur', 'YYYY-MM-DD') AS "createdOn", d.name AS "owningDepartment"
         FROM projects p JOIN departments d ON d.id = p.owning_department_id WHERE p.id = ANY($1::uuid[])`,
      [ids],
    )
  ).rows as Array<{ id: string; name: string; status: ProjectStatus; createdOn: string; owningDepartment: string }>;
  const members = groupBy(
    (
      await pool.query(
        `SELECT m.project_id AS "projectId", m.id, m.user_id AS "userId", m.role, to_char(m.starts_on, 'YYYY-MM-DD') AS "startsOn",
                to_char(m.expires_on, 'YYYY-MM-DD') AS "expiresOn", m.revoked_at AS "revokedAt",
                m.held_at AS "heldAt", m.restored_at AS "restoredAt", m.hold_reason AS "holdReason",
                u.display_name AS "displayName", u.email
           FROM memberships m JOIN users u ON u.id = m.user_id
          WHERE m.project_id = ANY($1::uuid[]) ORDER BY m.starts_on, m.id`,
        [ids],
      )
    ).rows as Array<MembershipRecord & { projectId: string }>,
    (r) => r.projectId,
  );
  const grants = groupBy(
    (
      await pool.query(
        `SELECT project_id AS "projectId", id, user_id AS "userId", kind, to_char(starts_on, 'YYYY-MM-DD') AS "startsOn", to_char(expires_on, 'YYYY-MM-DD') AS "expiresOn",
                requested_by AS "requestedBy", decision, suspended_at AS "suspendedAt", revoked_at AS "revokedAt",
                inspect_deleted AS "inspectDeleted"
           FROM access_grants WHERE project_id = ANY($1::uuid[]) ORDER BY requested_at, id`,
        [ids],
      )
    ).rows as Array<GrantRow & { projectId: string }>,
    (r) => r.projectId,
  );
  const out = new Map<string, { ctx: ProjectContext; name: string; owningDepartment: string }>();
  for (const p of projects) {
    const strip = <T extends { projectId: string }>(rows: T[]) => rows.map(({ projectId: _p, ...rest }) => rest);
    const ctx = buildProjectContext({
      project: { id: p.id, status: p.status, createdOn: p.createdOn },
      rows: strip(members.get(p.id) ?? []) as MembershipRecord[],
      grants: strip(grants.get(p.id) ?? []) as GrantRow[],
      user,
      today,
    });
    out.set(p.id, { ctx, name: p.name, owningDepartment: p.owningDepartment });
  }
  return out;
}

/** The archived ones among these Closed projects, by the archive rule (`archiveState`) with the settings in force. */
export async function archivedAmong(pool: Pool, closedIds: string[], today: string): Promise<Set<string>> {
  const out = new Set<string>();
  if (closedIds.length === 0) return out;
  const closings = new Map(
    (
      await pool.query(
        `SELECT DISTINCT ON (project_id) project_id AS "projectId", at FROM project_transitions
          WHERE project_id = ANY($1::uuid[]) AND to_status = 'closed' ORDER BY project_id, at DESC, id DESC`,
        [closedIds],
      )
    ).rows.map((r) => [r.projectId as string, new Date(r.at).toISOString()]),
  );
  const events = groupBy(
    (await pool.query(`SELECT project_id AS "projectId", kind, at FROM project_archive_events WHERE project_id = ANY($1::uuid[]) ORDER BY at, id`, [closedIds])).rows as Array<{
      projectId: string; kind: 'archived' | 'unarchived'; at: Date;
    }>,
    (r) => r.projectId,
  );
  const { archiveAfterMonths } = await loadAccessSettings(pool);
  for (const id of closedIds) {
    const s = archiveState({
      status: 'closed',
      closedAt: closings.get(id) ?? null,
      events: (events.get(id) ?? []).map((e) => ({ kind: e.kind, at: new Date(e.at).toISOString() })),
      today,
      afterMonths: archiveAfterMonths,
    });
    if (s.archived) out.add(id);
  }
  return out;
}
