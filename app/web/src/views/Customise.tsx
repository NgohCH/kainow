import { useState } from 'react';
import { ApiError } from '../api.ts';
import {
  ACCENT_KEYS,
  ACCENTS,
  HOME_SECTION_LABELS,
  LEADERSHIP_FIELDS,
  LEADERSHIP_FIXED_FIELDS,
  defaultPrefs,
  moveItem,
  moveSection,
  setHidden,
  type AccentKey,
  type HomeSection,
  type Prefs,
  type Theme,
} from '../prefs.ts';

const ACCENT_LABELS: Record<AccentKey, string> = { teal: 'Teal', blue: 'Blue', plum: 'Plum', slate: 'Slate' };
const THEME_LABELS: Record<Theme, string> = { light: 'Light', dark: 'Dark' };

type Row = { key: string; label: string; fixed: boolean };

/** An ordered list with Move up, Move down and a show box on each row. No dragging: every control is a button or a box. */
function OrderList({
  legend,
  rows,
  hidden,
  onMove,
  onHide,
  fixedNote,
}: {
  legend: string;
  rows: Row[];
  hidden: readonly string[];
  onMove: (key: string, dir: 'up' | 'down') => void;
  onHide: (key: string, hide: boolean) => void;
  fixedNote: string;
}) {
  return (
    <fieldset>
      <legend>{legend}</legend>
      <p className="hint">{fixedNote}</p>
      <ol className="plain customise-order">
        {rows.map((r, i) => (
          <li key={r.key} className="inline-form">
            <label className="check">
              <input
                type="checkbox"
                checked={r.fixed || !hidden.includes(r.key)}
                disabled={r.fixed}
                onChange={(e) => onHide(r.key, !e.target.checked)}
              />
              <span>{r.label}</span>
            </label>
            <button type="button" disabled={r.key === 'needsYou' || i === 0 || rows[i - 1].key === 'needsYou'} onClick={() => onMove(r.key, 'up')} aria-label={`Move up: ${r.label}`}>
              Move up
            </button>
            <button type="button" disabled={r.key === 'needsYou' || i === rows.length - 1} onClick={() => onMove(r.key, 'down')} aria-label={`Move down: ${r.label}`}>
              Move down
            </button>
          </li>
        ))}
      </ol>
    </fieldset>
  );
}

/**
 * The Customise panel (spec section 8): theme, accent, Home section order and visibility, and leadership field order and
 * visibility. Every change is saved at once through onChange, which the app sends to PUT /me/preferences.
 */
export function Customise({
  prefs,
  onChange,
  onClose,
  ready = true,
  failed = false,
  show = ['appearance', 'home', 'leadership'],
}: {
  prefs: Prefs;
  onChange: (next: Prefs) => Promise<void>;
  onClose?: () => void;
  /** False until the saved preferences have loaded: saving then would overwrite them with defaults. */
  ready?: boolean;
  /** True when loading the saved preferences failed: only then is the reload alert shown. */
  failed?: boolean;
  show?: ('appearance' | 'home' | 'leadership')[];
}) {
  const [status, setStatus] = useState('');
  const [error, setError] = useState(false);

  async function save(next: Prefs) {
    setStatus('Saving');
    setError(false);
    try {
      await onChange(next);
      setStatus('Saved');
    } catch (e) {
      setError(true);
      setStatus(e instanceof ApiError ? e.message : 'Your changes were not saved. Try again.');
    }
  }

  const homeRows: Row[] = prefs.home.order.map((k) => ({ key: k, label: HOME_SECTION_LABELS[k], fixed: k === 'needsYou' }));
  const leadershipRows: Row[] = prefs.leadership.fields.order.map((k) => ({
    key: k,
    label: LEADERSHIP_FIELDS.find((f) => f.key === k)?.label ?? k,
    fixed: LEADERSHIP_FIXED_FIELDS.includes(k),
  }));

  return (
    <section className="panel customise" aria-labelledby="customise-heading">
      <div className="row">
        <h2 id="customise-heading">Customise</h2>
        {onClose && (
          <button type="button" className="quiet" onClick={onClose}>
            Close
          </button>
        )}
      </div>
      <p className="hint">These choices change only how Kainow looks for you. They are saved as you make them.</p>
      {failed && !ready && <p role="alert" className="error">Your saved preferences have not loaded, so they cannot be changed now. Reload the page to try again.</p>}
      <fieldset className="plain-fieldset" disabled={!ready}>
      <div className="stack">
        {show.includes('appearance') && (
          <>
            <fieldset>
              <legend>Theme</legend>
              {(['light', 'dark'] as const).map((t) => (
                <label key={t} className="choice">
                  <input type="radio" name="customise-theme" checked={prefs.theme === t} onChange={() => save({ ...prefs, theme: t })} />
                  {THEME_LABELS[t]}
                </label>
              ))}
            </fieldset>
            <fieldset>
              <legend>Accent colour</legend>
              {ACCENT_KEYS.map((a) => (
                <label key={a} className="choice">
                  <input type="radio" name="customise-accent" checked={prefs.accent === a} onChange={() => save({ ...prefs, accent: a })} />
                  <span className="swatch" aria-hidden="true" style={{ background: ACCENTS[a][prefs.theme].accent }} />
                  {ACCENT_LABELS[a]}
                </label>
              ))}
            </fieldset>
          </>
        )}
        {show.includes('home') && (
          <OrderList
            legend="Home sections"
            rows={homeRows}
            hidden={prefs.home.hidden}
            fixedNote="Needs you is always first and always shown."
            onMove={(k, dir) => save({ ...prefs, home: { ...prefs.home, order: moveSection(prefs.home.order, k, dir) as HomeSection[] } })}
            onHide={(k, hide) => save({ ...prefs, home: { ...prefs.home, hidden: setHidden(prefs.home.hidden, k as HomeSection, hide, ['needsYou']) } })}
          />
        )}
        {show.includes('leadership') && (
          <OrderList
            legend="Leadership card fields"
            rows={leadershipRows}
            hidden={prefs.leadership.fields.hidden}
            fixedNote="Project name, Attention flags and Last refreshed can be moved but not hidden."
            onMove={(k, dir) => save({ ...prefs, leadership: { fields: { ...prefs.leadership.fields, order: moveItem(prefs.leadership.fields.order, k, dir) } } })}
            onHide={(k, hide) =>
              save({ ...prefs, leadership: { fields: { ...prefs.leadership.fields, hidden: setHidden(prefs.leadership.fields.hidden, k, hide, LEADERSHIP_FIXED_FIELDS) } } })
            }
          />
        )}
        <div className="actions">
          <button type="button" onClick={() => save(defaultPrefs())}>
            Reset to defaults
          </button>
          <span role={error ? 'alert' : 'status'} className={error ? 'error' : 'meta'}>
            {status}
          </span>
        </div>
      </div>
      </fieldset>
    </section>
  );
}
