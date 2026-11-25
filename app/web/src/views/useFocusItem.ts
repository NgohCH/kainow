import { useEffect } from 'react';

/** Opening an item's link: once the list has loaded, scroll the item into view, focus it and outline it for 3 seconds. `may`, asked at that moment, can refuse. */
export function useFocusItem(focusId: string | undefined, ready: boolean, may?: () => boolean): void {
  useEffect(() => {
    if (!focusId || !ready || (may && !may())) return;
    const el = document.getElementById(`item-${focusId}`);
    if (!el) return;
    el.scrollIntoView({ block: 'center' });
    el.focus({ preventScroll: true });
    el.classList.add('found');
    const t = window.setTimeout(() => el.classList.remove('found'), 3000);
    // Runs whenever the effect re-runs or the page unmounts, so the outline cannot stick.
    return () => {
      window.clearTimeout(t);
      el.classList.remove('found');
    };
  }, [focusId, ready]);
}
