import { useEffect, useRef } from 'react';
import { openerSelector, returnTarget } from '../focusReturn.ts';

/**
 * Focus after an inline form closes (WCAG 2.2: focus is never lost to the page body). Pass the key of the form that is
 * open, or null; mark each opener button with `data-opener={key}`. When the form closes, saved or cancelled, focus goes
 * back to its opener, found by key so it still works when the form replaced the row and the button was re-created.
 * Call `leaving(headingId)` just before a save that removes the opener; focus then goes to that heading (tabIndex -1).
 */
export function useReturnFocus(openKey: string | null): { leaving: (headingId: string) => void } {
  const was = useRef<string | null>(null);
  const heading = useRef<string | null>(null);
  useEffect(() => {
    const target = returnTarget(was.current, openKey, heading.current);
    if (openKey === null) heading.current = null;
    if (target !== null) {
      const el = target.startsWith('#') ? document.getElementById(target.slice(1)) : document.querySelector<HTMLElement>(openerSelector(target));
      el?.focus();
    }
    was.current = openKey;
  }, [openKey]);
  return { leaving: (id) => { heading.current = id; } };
}
