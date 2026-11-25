/** Authorising several people's proposals at once (D140): each needs its own assignee and due date. */
import { waitingLine } from './changes.ts';
import { defaultDueOn, likelyAssignee, splitNames } from './records.ts';

/** The assignee choice that asks for an email address instead (as in the authorise form). */
export const INVITE = '__invite__';
/** The server's limit for one go. */
export const MAX_AT_ONCE = 100;

export interface ProposedSubtask { title: string; description: string | null; due: string | null }
export interface ManyProposal {
  id: string;
  kind: string;
  text: string;
  owner: string | null;
  due: string | null;
  reviewStatus: string;
  proposedSubtasks?: ProposedSubtask[] | null;
  dueReading: { state: string; earliest: string | null; latest: string | null };
}
interface PersonLike { userId: string; displayName: string; email: string }

export interface SubtaskTerms { on: boolean; title: string; description: string | null; assignee: string; email: string; dueOn: string }
export interface ItemTerms { assignee: string; email: string; dueOn: string; subtasks: SubtaskTerms[] }

/** People's actions still waiting; one already sent for more approvals is finished on its own request. */
export function manyCandidates<T extends ManyProposal>(proposals: readonly T[], requested: ReadonlySet<string>): T[] {
  return proposals.filter((p) => p.kind === 'action' && p.reviewStatus === 'pending' && !requested.has(p.id));
}

export function startSubtask(s: ProposedSubtask): SubtaskTerms {
  return { on: true, title: s.title, description: s.description, assignee: '', email: '', dueOn: s.due ?? '' };
}

export function startItem(p: ManyProposal, people: PersonLike[]): ItemTerms {
  return {
    assignee: likelyAssignee(splitNames(p.owner)[0] ?? null, people) ?? '',
    email: '',
    dueOn: defaultDueOn(p.dueReading) ?? '',
    subtasks: (p.proposedSubtasks ?? []).map(startSubtask),
  };
}

/** Whether an item holds something typed or ticked. */
export const isTyped = (draft: { on: boolean; terms: ItemTerms }, start: ItemTerms): boolean => draft.on || JSON.stringify(draft.terms) !== JSON.stringify(start);

const hasPerson = (t: { assignee: string; email: string }): boolean => (t.assignee === INVITE ? /^[^@\s]+@[^@\s]+$/.test(t.email.trim()) : t.assignee !== '');

/** What one item still needs, or null. */
export function itemProblem(t: ItemTerms): string | null {
  if (!hasPerson(t)) return 'Choose an assignee.';
  if (t.dueOn === '') return 'Give a due date.';
  const sub = t.subtasks.find((s) => s.on && (!hasPerson(s) || s.dueOn === '' || s.title.trim() === ''));
  return sub ? 'Each subtask needs a title, an assignee and a due date; untick a subtask to leave it out.' : null;
}

const person = (t: { assignee: string; email: string }) => (t.assignee === INVITE ? { inviteEmail: t.email.trim() } : { assigneeId: t.assignee });

export const subtaskBody = (s: SubtaskTerms) => ({ title: s.title, description: s.description, ...person(s), dueOn: s.dueOn });

/** The body's items, each with the terms of a single authorisation. The proposer's description is used as it is. */
export function buildItems(items: Array<[string, ItemTerms]>) {
  return items.map(([proposalId, t]) => ({ proposalId, ...person(t), dueOn: t.dueOn, subtasks: t.subtasks.filter((s) => s.on).map(subtaskBody) }));
}

export type ManyResult =
  | { proposalId: string; ok: true; record: { kind: string; id: string } }
  | { proposalId: string; ok: true; waiting: true; request: { requiredApprovals: number; approvals: unknown[] } }
  | { proposalId: string; ok: false; error: string };

/** How one of them ended: its state, and what there is to say about it. */
export function resultLine(r: ManyResult): { word: string; detail: string } {
  if (!r.ok) return { word: 'Not authorised', detail: r.error };
  return 'waiting' in r ? { word: waitingLine(r.request), detail: 'Another Owner or Sponsor can approve it below.' } : { word: 'Authorised', detail: 'It is now on the Work tab.' };
}
