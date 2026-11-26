import { useEffect } from 'react';

/**
 * Opening an item's link: once the list has loaded, scroll the item into view, focus it and outline it for 3 seconds.
 * `may`, asked at that moment, can refuse. An item not drawn or shown yet (a board column still unfolding) is waited for a few frames.
 */
export function useFocusItem(focusId: string | undefined, ready: boolean, may?: () => boolean): void {
  useEffect(() => {
    if (!focusId || !ready || (may && !may())) return;
    let frame = 0;
    let tries = 0;
    let found: HTMLElement | null = null;
    let timer = 0;
    const attempt = () => {
      const el = document.getElementById(`item-${focusId}`);
      if ((!el || el.getClientRects().length === 0) && tries++ < 10) {
        frame = requestAnimationFrame(attempt);
        return;
      }
      if (!el) return;
      el.scrollIntoView({ block: 'center' });
      el.focus({ preventScroll: true });
      el.classList.add('found');
      found = el;
      timer = window.setTimeout(() => el.classList.remove('found'), 3000);
    };
    attempt();
    // Runs whenever the effect re-runs or the page unmounts, so the outline cannot stick.
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
      found?.classList.remove('found');
    };
  }, [focusId, ready]);
}
