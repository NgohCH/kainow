import type { Pool } from 'pg';
import { archivedAmong } from '../dashboards/project-contexts';
import type { ProjectStatus } from '../projects/matrix';
import type { AnalyticsFilters } from './filters';

export interface Scoped {
  id: string;
  name: string;
  status: ProjectStatus;
  departmentId: string;
  department: string;
  contributing: string[];
}

const byName = (a: { name: string; id: string }, b: { name: string; id: string }) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

/** The projects the analytics filters select (status, department with owned/contributed, archived), ordered by name. Shared by every panel. */
export async function selectProjects(pool: Pool, f: AnalyticsFilters, today: string): Promise<Scoped[]> {
  const params: unknown[] = [f.statuses];
  let dept = '';
  if (f.departmentId) {
    params.push(f.departmentId);
    const owned = 'p.owning_department_id = $2';
    const contributed = 'EXISTS (SELECT 1 FROM project_departments pd WHERE pd.project_id = p.id AND pd.department_id = $2 AND p.owning_department_id <> $2)';
    dept = ` AND (${f.ownership === 'owned' ? owned : f.ownership === 'contributed' ? contributed : `${owned} OR ${contributed}`})`;
  }
  let rows = (
    await pool.query(
      `SELECT p.id, p.name, p.status, p.owning_department_id AS "departmentId", d.name AS department,
              COALESCE((SELECT array_agg(pd.department_id::text) FROM project_departments pd WHERE pd.project_id = p.id AND pd.department_id <> p.owning_department_id), '{}') AS contributing
         FROM projects p JOIN departments d ON d.id = p.owning_department_id
        WHERE p.status = ANY($1::text[])${dept}`,
      params,
    )
  ).rows as Scoped[];
  if (!f.includeArchived && f.statuses.includes('closed')) {
    const archived = await archivedAmong(pool, rows.filter((r) => r.status === 'closed').map((r) => r.id), today);
    rows = rows.filter((r) => !archived.has(r.id));
  }
  return rows.sort(byName);
}
