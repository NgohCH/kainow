/** Needs you and tasks grouped by project (11a.1 spec 15, D141). Pure; ProjectGroups draws the boxes. */
import type { NeedsYouItem } from '../dashboard.ts';
import { formatDay } from '../format.ts';
import { type AttentionBucket, type AttentionGroup, groupAttention } from './attention.ts';
import type { TaskRow } from './home.ts';
import type { Meaning } from './meanings.ts';

/** What a box counts: the urgency groups and, for tasks, those that need no attention. */
export type CountGroup = AttentionGroup | 'later' | 'completed';
export interface ProjectCount<G extends CountGroup = CountGroup> { group: G; count: number }
export interface ProjectBox<G extends CountGroup = CountGroup> { projectId: string; projectName: string; counts: ProjectCount<G>[] }
export interface AttentionBox extends ProjectBox<AttentionGroup> { groups: AttentionBucket[] }
export interface TaskBox extends ProjectBox { rows: TaskRow[] }

/** The rows of each project, in the order they came, keyed by id: two projects may share a name. */
function perProject<T extends { projectId: string; projectName: string }>(list: readonly T[]): { projectId: string; projectName: string; list: T[] }[] {
  const boxes = new Map<string, { projectId: string; projectName: string; list: T[] }>();
  for (const x of list) {
    const box = boxes.get(x.projectId);
    if (box) box.list.push(x);
    else boxes.set(x.projectId, { projectId: x.projectId, projectName: x.projectName, list: [x] });
  }
  return [...boxes.values()];
}

const countOf = (p: ProjectBox, group: CountGroup): number => p.counts.find((c) => c.group === group)?.count ?? 0;

/** Most overdue, then most to review, then most due soon, then by name. */
function byUrgency(a: ProjectBox, b: ProjectBox): number {
  const more = (g: CountGroup) => countOf(b, g) - countOf(a, g);
  return more('overdue') || more('review') || more('dueSoon') || a.projectName.localeCompare(b.projectName) || a.projectId.localeCompare(b.projectId);
}

/** Needs you, one box per project. An item that stands for several things (`count`) is one item, as it is one row. */
export function attentionByProject(items: NeedsYouItem[]): AttentionBox[] {
  return perProject(items)
    .map(({ projectId, projectName, list }) => {
      const groups = groupAttention(list);
      return { projectId, projectName, counts: groups.map((g) => ({ group: g.group, count: g.items.length })), groups };
    })
    .sort(byUrgency);
}

const TASK_GROUP: Record<TaskRow['group'], CountGroup> = { overdue: 'overdue', awaitingReview: 'review', dueSoon: 'dueSoon', later: 'later', completed: 'completed' };
const TASK_ORDER: CountGroup[] = ['overdue', 'review', 'dueSoon', 'later', 'completed'];

/** Tasks, one box per project: overdue first, then by due date. Completed ones come last, so they never push open work out of the first rows. */
export function tasksByProject(rows: TaskRow[]): TaskBox[] {
  const rank = (r: TaskRow) => (r.group === 'overdue' ? 0 : r.group === 'completed' ? 2 : 1);
  return perProject(rows)
    .map(({ projectId, projectName, list }) => ({
      projectId,
      projectName,
      counts: TASK_ORDER.map((group) => ({ group, count: list.filter((r) => TASK_GROUP[r.group] === group).length })).filter((c) => c.count > 0),
      rows: [...list].sort((a, b) => rank(a) - rank(b) || a.dueOn.localeCompare(b.dueOn)),
    }))
    .sort(byUrgency);
}

/** A count as a box's header shows it; without a meaning it is plain text. */
export interface HeaderCount { key: string; meaning?: Meaning; word: string }

const ATTENTION_WORDS: Record<AttentionGroup, string> = { overdue: 'overdue', review: 'to review', blocked: 'blocked', dueSoon: 'due soon' };

export function attentionCounts(p: AttentionBox): HeaderCount[] {
  return p.counts.map((c) => ({ key: c.group, meaning: c.group, word: `${c.count} ${ATTENTION_WORDS[c.group]}` }));
}

/** The counts of a project's tasks. Blocked is a state, not a due-date group, so a blocked task is also in one of the others. */
export function taskCounts(p: TaskBox): HeaderCount[] {
  const all: { key: string; meaning?: Meaning; n: number; word: string }[] = [
    { key: 'overdue', meaning: 'overdue', n: countOf(p, 'overdue'), word: 'overdue' },
    { key: 'review', meaning: 'review', n: countOf(p, 'review'), word: 'awaiting deadline review' },
    { key: 'blocked', meaning: 'blocked', n: p.rows.filter((r) => r.status === 'blocked').length, word: 'blocked' },
    { key: 'dueSoon', meaning: 'dueSoon', n: countOf(p, 'dueSoon'), word: 'due soon' },
    { key: 'later', n: countOf(p, 'later'), word: 'later' },
    { key: 'completed', n: countOf(p, 'completed'), word: 'completed' },
  ];
  return all.filter((c) => c.n > 0).map(({ key, meaning, n, word }) => ({ key, meaning, word: `${n} ${word}` }));
}

/** The boxes' names for buttons and tables; projects with one name are numbered. */
export function distinctNames(boxes: readonly { projectName: string }[]): string[] {
  return boxes.map(({ projectName }, i) => {
    const same = boxes.filter((b) => b.projectName === projectName).length;
    const place = boxes.slice(0, i + 1).filter((b) => b.projectName === projectName).length;
    return same === 1 ? projectName : `${projectName} (${place} of ${same} with this name)`;
  });
}

const FIRST_OPEN = 3;
const FIRST_ROWS = 5;

/** Whether the box at this place in the list is open before the person chooses. */
export const startsOpen = (index: number): boolean => index < FIRST_OPEN;

/** The rows a box shows: the first five, or every one. */
export const shownRows = <T>(rows: readonly T[], all: boolean): readonly T[] => (all ? rows : rows.slice(0, FIRST_ROWS));

/** What the date of each kind is: for tasks, risks and resources the server's `since` is the due, review or needed-by day. */
const DATE_WORDS: Partial<Record<NeedsYouItem['kind'], string>> = { overdue: 'Due', blocked: 'Due', due_soon: 'Due', risk_review: 'Review by', resources: 'Needed by' };

/** The date a Needs you item carries, in words; for the other kinds, since when it has waited. */
export function itemDate(i: NeedsYouItem): string {
  return i.since === null ? '' : `${DATE_WORDS[i.kind] ?? 'Since'} ${formatDay(i.since)}`;
}
