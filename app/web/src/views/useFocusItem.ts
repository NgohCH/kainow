import { useEffect, useRef } from 'react';

/** Opening an item's link: once the list has loaded, scroll the item into view, focus it and outline it for 3 seconds. */
export function useFocusItem(focusId: string | undefined, ready: boolean): void {
  const done = useRef<string | null>(null);
  useEffect(() => {
    if (!focusId || !ready || done.current === focusId) return;
    const el = document.getElementById(`item-${focusId}`);
    if (!el) return;
    done.current = focusId;
    el.scrollIntoView({ block: 'center' });
    el.focus({ preventScroll: true });
    el.classList.add('found');
    const t = window.setTimeout(() => el.classList.remove('found'), 3000);
    return () => window.clearTimeout(t);
  }, [focusId, ready]);
}
