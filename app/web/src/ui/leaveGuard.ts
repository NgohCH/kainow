/**
 * Asks before unsaved input is lost: on moving to another address in Kainow (a link, Back, an address typed or set by the
 * page) and on closing or reloading the tab. A form arms it while it holds unsaved input (`useLeaveGuard`).
 */
export interface LeaveEnv {
  confirm: (message: string) => boolean;
  hash: () => string;
  /** Puts the address back without the app noticing. */
  restore: (hash: string) => void;
}

interface HashEventLike { stopImmediatePropagation(): void }
interface ClickLike { defaultPrevented: boolean; button: number; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean; preventDefault(): void }
interface UnloadLike { preventDefault(): void }

export function createLeaveGuard(env: LeaveEnv) {
  const armed = new Map<symbol, string>();
  let at = '';
  /** True when nothing is unsaved or the person chose to leave (they are then not asked again). */
  const mayLeave = (): boolean => {
    const message = [...armed.values()][0];
    if (message === undefined) return true;
    if (!env.confirm(message)) return false;
    armed.clear();
    return true;
  };
  return {
    /** Guards the page until the returned function is called. */
    arm(message: string): () => void {
      if (armed.size === 0) at = env.hash();
      const key = Symbol('unsaved');
      armed.set(key, message);
      return () => void armed.delete(key);
    },
    mayLeave,
    /** Nothing is unsaved any more (it was just saved and the page is about to move on). */
    release: () => armed.clear(),
    /** A link is stopped before it moves, so the history stays as it was. */
    onClick(e: ClickLike, link: { href: string; target: string } | null): void {
      if (!link || e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
      if (!link.href.startsWith('#') || link.href === at || (link.target !== '' && link.target !== '_self')) return;
      if (!mayLeave()) e.preventDefault();
    },
    /** Every other way of moving: it has happened, so staying puts the address back before the app hears of it. */
    onHashChange(e: HashEventLike): void {
      if (armed.size === 0 || env.hash() === at) return;
      if (mayLeave()) return;
      e.stopImmediatePropagation();
      env.restore(at);
    },
    onUnload(e: UnloadLike): void {
      if (armed.size > 0) e.preventDefault();
    },
  };
}

export const leaveGuard = createLeaveGuard({
  confirm: (message) => window.confirm(message),
  hash: () => window.location.hash,
  restore: (hash) => window.history.pushState(null, '', hash),
});

/** Called once, before the app starts listening to the address itself (main.tsx). */
export function installLeaveGuard(): void {
  window.addEventListener('hashchange', leaveGuard.onHashChange);
  window.addEventListener('beforeunload', leaveGuard.onUnload);
  // On the document, so that a link the page handles itself (preventDefault) has already said so.
  document.addEventListener('click', (e) => {
    const a = e.target instanceof Element ? e.target.closest('a[href]') : null;
    leaveGuard.onClick(e, a ? { href: a.getAttribute('href') ?? '', target: a.getAttribute('target') ?? '' } : null);
  });
}
