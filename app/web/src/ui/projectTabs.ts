/**
 * The project's binder tabs (11a spec 6.3): their order, who sees each (today's rules, unchanged), and the count badges.
 * The tab's key is also its address: `#/projects/<id>/<key>`, the Overview at `#/projects/<id>`.
 */
import { mayReviewAnswers, mayReviewSummaries } from '../assist.ts';
import type { ProjectStatus } from '../projects.ts';
import type { Meaning } from './meanings.ts';

export interface ProjectTabsContext {
  roles: string[];
  isAdmin: boolean;
  /** Members read the content; so does an Audit or Oversight grant holder. Others see the summary tabs only. */
  contentAllowed: boolean;
  inspectDeleted: boolean;
  status: ProjectStatus;
  /** The project may be prepared for closure by this person (the closure view's mayPrepare). */
  closingNeeded: boolean;
  /** Tasks wait for a new authorised due date and this person handles them. */
  deadlineReview: boolean;
  /** How many tasks wait for that new date (the Deadline review badge). */
  deadlineTasks?: number;
  mayViewAi: boolean;
  /** Proposals waiting for review that this person may read. */
  waiting: number;
  /** Overdue tasks. */
  overdue: number;
}

export interface ProjectTab { key: string; text: string; badge?: { count: number; meaning: Meaning } }

const badge = (count: number, meaning: Meaning) => (count > 0 ? { badge: { count, meaning } } : {});

export function projectTabs(ctx: ProjectTabsContext): ProjectTab[] {
  const c = ctx.contentAllowed;
  const tabs: Array<ProjectTab | false> = [
    { key: 'overview', text: 'Overview' },
    c && { key: 'discussion', text: 'Discussion' },
    c && { key: 'notes', text: 'Notes' },
    c && { key: 'proposals', text: 'Proposals', ...badge(ctx.waiting, 'review') },
    c && { key: 'work', text: 'Work', ...badge(ctx.overdue, 'overdue') },
    c && { key: 'timeline', text: 'Timeline' },
    { key: 'resources', text: 'Resources' },
    c && { key: 'outputs', text: 'Outputs' },
    { key: 'people', text: 'People' },
    { key: 'settings', text: 'Settings' },
    ctx.mayViewAi && { key: 'ai', text: 'AI' },
    c && { key: 'drafts', text: 'Drafts' },
    c && (mayReviewAnswers(ctx.roles) || mayReviewSummaries(ctx.roles)) && { key: 'review', text: 'Assist review' },
    c && { key: 'feedback', text: 'Feedback' },
    ctx.inspectDeleted && { key: 'deleted', text: 'Deleted items' },
    ctx.closingNeeded && { key: 'closing', text: 'Closing' },
    ctx.deadlineReview && { key: 'deadline-review', text: 'Deadline review', ...badge(ctx.deadlineTasks ?? 0, 'review') },
  ];
  return tabs.filter((t): t is ProjectTab => t !== false);
}

/**
 * The tab marked current for an address segment: none is the Overview, the resources report belongs to Resources,
 * the old `notes` address is the Notes tab, and a run's review page (`run`, from `#/runs/<id>`) sits under Proposals.
 * `notes/<id>` named a person's proposal while notes and proposals shared one tab (search results and Needs you still
 * link there): with an item it is the Proposals tab.
 */
export function tabForHash(tab: string | undefined, itemId?: string): string {
  if (!tab) return 'overview';
  if (tab === 'notes' && itemId) return 'proposals';
  if (tab === 'resources/report') return 'resources';
  if (tab === 'run') return 'proposals';
  return tab;
}
