/** What the review's single-key shortcuts need to know about a key event's target (an Element, or a stand-in in tests). */
export interface KeyTarget {
  tagName: string;
  closest(selector: string): unknown;
}

/** Places whose keys are never the review's: the Ask panel beside or over it, and any dialog. */
const ELSEWHERE = '.ask-panel, dialog, [role="dialog"]';
const FIELD = /^(INPUT|TEXTAREA|SELECT)$/;

const inFormOrElsewhere = (t: KeyTarget): boolean => FIELD.test(t.tagName) || !!t.closest('form') || !!t.closest(ELSEWHERE);

/**
 * Whether a key belongs to the proposal review's shortcuts (j, k, a, r). Not from a field or a form, not from the
 * Ask panel or a dialog, and not from anything outside the review's own root. A key on the page itself (nothing has
 * focus) counts only while no Ask panel is open, since the panel may cover the review.
 */
export function reviewOwnsKey(target: KeyTarget | null, root: { contains(node: unknown): boolean } | null, body: unknown, askPanelOpen: boolean): boolean {
  if (!target || !root) return false;
  if (inFormOrElsewhere(target)) return false;
  if (target === body) return !askPanelOpen;
  return root.contains(target);
}

/** The proposal a or r acts on: the selected one, and none while focus (`focused`, its card) is in a different card. */
export const cardForKey = (focused: string | null, selected: string | null): string | null =>
  focused !== null && focused !== selected ? null : selected;

/** Where j (next) or k (previous) goes from the focused card, else the selected one; null at an end. */
export function stepCard(key: 'j' | 'k', ids: string[], focused: string | null, selected: string | null): string | null {
  const at = ids.indexOf(focused ?? selected ?? '');
  return ids[key === 'j' ? at + 1 : at - 1] ?? null;
}

/** What is selected when a run opens or its address changes: the proposal named, else what was selected, else the first. Nothing when the one named is not in the run. */
export function openingSelection(ids: string[], named: string | undefined, selected: string | null): { selected: string | null; missing: boolean } {
  if (named === undefined) return { selected: selected ?? ids[0] ?? null, missing: false };
  return ids.includes(named) ? { selected: named, missing: false } : { selected: null, missing: true };
}

/** Whether the named proposal may take focus once everything has loaded: not if the reader has moved since, or is in a form, the Ask panel or a dialog. */
export const mayTakeFocus = (active: KeyTarget | null, moved: boolean): boolean => !moved && !(active && inFormOrElsewhere(active));
