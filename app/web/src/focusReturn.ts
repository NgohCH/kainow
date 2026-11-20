/** CSS selector for the button that opened the form with this key (it carries data-opener). */
export const openerSelector = (key: string): string => `[data-opener="${key.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`;

/**
 * Where focus goes after a render: nothing unless a form just closed (open key to none); then the opener's key, or
 * `#id` of the section heading when the opener is gone (a line cancelled, an item retired).
 */
export function returnTarget(was: string | null, now: string | null, headingId: string | null): string | null {
  if (was === null || now !== null) return null;
  return headingId ? `#${headingId}` : was;
}
