/** What the review's single-key shortcuts need to know about a key event's target (an Element, or a stand-in in tests). */
export interface KeyTarget {
  tagName: string;
  closest(selector: string): unknown;
}

/** Places whose keys are never the review's: the Ask panel beside or over it, and any dialog. */
const ELSEWHERE = '.ask-panel, dialog, [role="dialog"]';

/**
 * Whether a key belongs to the proposal review's shortcuts (j, k, a, r). Not when typing in a field, not from the
 * Ask panel or a dialog, and not from anything outside the review's own root. A key on the page itself (nothing has
 * focus) counts only while no Ask panel is open, since the panel may cover the review.
 */
export function reviewOwnsKey(target: KeyTarget | null, root: { contains(node: unknown): boolean } | null, body: unknown, askPanelOpen: boolean): boolean {
  if (!target || !root) return false;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return false;
  if (target.closest(ELSEWHERE)) return false;
  if (target === body) return !askPanelOpen;
  return root.contains(target);
}
