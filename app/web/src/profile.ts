/** My profile (D134): what GET /me/profile returns, and the wording and choices the page shows. */

import type { Department } from './api.ts';
import { formatDay } from './format.ts';
import type { ProjectRole } from './projects.ts';

/** A person's department as the server gives it. Information only: it gives no access. */
export interface PersonDepartment { id: string; name: string; retired: boolean }
export interface ProfileRole { projectId: string; projectName: string; role: ProjectRole; since: string; until: string | null; canOpen: boolean }
export interface PastRole { projectId: string; projectName: string; role: ProjectRole; since: string; endedOn: string }
export interface Profile { name: string; email: string; department: PersonDepartment | null; roles: ProfileRole[]; pastRoles: PastRole[] }

const retiredName = (name: string): string => `${name} (retired)`;

export const departmentName = (d: PersonDepartment | null): string => (d === null ? 'None' : d.retired ? retiredName(d.name) : d.name);

/**
 * None, the active departments, and the one held when it is no longer among them. The id of None is ''. Until the active
 * ones are loaded (null) only the one held shows, as it is known.
 */
export function departmentOptions(active: readonly Department[] | null, held: PersonDepartment | null): { id: string; label: string }[] {
  if (active === null) return [{ id: held?.id ?? '', label: departmentName(held) }];
  const options = [{ id: '', label: 'None' }, ...active.map((d) => ({ id: d.id, label: d.name }))];
  return held === null || options.some((o) => o.id === held.id) ? options : [...options, { id: held.id, label: retiredName(held.name) }];
}

/** What to send, or undefined when nothing changed: the server refuses a retired department even when it is the one held. */
export function departmentToSave(held: PersonDepartment | null, chosen: string): string | null | undefined {
  if (chosen === (held?.id ?? '')) return undefined;
  return chosen === '' ? null : chosen;
}

/** Days are 'YYYY-MM-DD' in UTC+8, which also order as text. */
export const sinceText = (since: string, today: string): string => (since > today ? `Starts ${formatDay(since)}` : formatDay(since));
export const untilText = (until: string | null): string => (until === null ? 'No end date' : formatDay(until));
/** A role withdrawn before its start day never began. */
export const endedText = (since: string, endedOn: string): string => (endedOn < since ? `Never started (withdrawn ${formatDay(endedOn)})` : formatDay(endedOn));
