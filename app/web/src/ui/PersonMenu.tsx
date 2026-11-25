import { useEffect, useRef, useState, type ReactNode } from 'react';
import { PROFILE_HREF } from './menu.ts';

export const PERSON_BUTTON_ID = 'person-menu-button';

/**
 * The person menu (spec 6.2): a disclosure button with the person's name, opening My profile, Customise,
 * Sign out and Sign out everywhere. Escape closes it and returns focus to the button; so does a click outside it, without
 * moving focus. It closes when the page changes.
 */
export function PersonMenu({
  name,
  hash,
  onCustomise,
  onSignOut,
  onSignOutEverywhere,
  extra,
}: {
  name: string;
  hash: string;
  onCustomise: () => void;
  onSignOut: () => void;
  onSignOutEverywhere: () => void;
  /** Shown first in the menu (the AI spend meter on narrow screens, where the top bar has no room for it). */
  extra?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => setOpen(false), [hash]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      document.getElementById(PERSON_BUTTON_ID)?.focus();
    };
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open]);

  const initial = name.trim().charAt(0).toUpperCase() || '?';
  return (
    <div className="person-menu" ref={wrap}>
      <button type="button" id={PERSON_BUTTON_ID} className="person-button" aria-expanded={open} aria-controls="person-menu-panel" onClick={() => setOpen((o) => !o)}>
        <span className="person-initial" aria-hidden="true">{initial}</span>
        <span className="person-name">{name}</span>
      </button>
      {open && (
        <div id="person-menu-panel" className="person-panel">
          {extra}
          <ul>
            <li>
              {/* The link goes away with the menu, so focus moves to the page it opens. */}
              <a
                className="person-action"
                href={PROFILE_HREF}
                aria-current={hash === PROFILE_HREF ? 'page' : undefined}
                onClick={() => {
                  setOpen(false);
                  document.getElementById('main')?.focus();
                }}
              >
                My profile
              </a>
            </li>
            <li>
              <button
                type="button"
                className="person-action"
                onClick={() => {
                  setOpen(false);
                  onCustomise();
                }}
              >
                Customise
              </button>
            </li>
            <li className="person-signout">
              <button type="button" className="person-action" onClick={onSignOut}>Sign out</button>
              <button type="button" className="person-action" onClick={onSignOutEverywhere}>Sign out everywhere</button>
            </li>
          </ul>
        </div>
      )}
    </div>
  );
}
