import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Prefs } from '../prefs.ts';
import { AppearanceChoice, useSaveStatus } from '../views/Customise.tsx';

export const PERSON_BUTTON_ID = 'person-menu-button';

/**
 * The person menu (spec 6.2): a disclosure button with the person's name, opening Customise, Colour scheme, Light or dark,
 * Sign out and Sign out everywhere. Escape closes it and returns focus to the button; so does a click outside it, without
 * moving focus. It closes when the page changes.
 */
export function PersonMenu({
  name,
  hash,
  prefs,
  orgColour,
  ready,
  failed,
  onPrefs,
  onCustomise,
  onSignOut,
  onSignOutEverywhere,
  extra,
}: {
  name: string;
  hash: string;
  prefs: Prefs;
  orgColour: string | null;
  ready: boolean;
  failed: boolean;
  onPrefs: (next: Prefs) => Promise<void>;
  onCustomise: () => void;
  onSignOut: () => void;
  onSignOutEverywhere: () => void;
  /** Shown first in the menu (the AI spend meter on narrow screens, where the top bar has no room for it). */
  extra?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const { save, status, error } = useSaveStatus(onPrefs);

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
            <li>
              {failed && !ready && <p role="alert" className="error">Your saved preferences have not loaded, so they cannot be changed now. Reload the page to try again.</p>}
              <fieldset className="plain-fieldset person-appearance" disabled={!ready}>
                <AppearanceChoice prefs={prefs} orgColour={orgColour} save={save} name="person-menu" />
              </fieldset>
              <span role={error ? 'alert' : 'status'} className={error ? 'error' : 'meta'}>{status}</span>
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
