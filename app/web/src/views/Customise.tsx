import { useState, type Ref } from 'react';
import { ApiError } from '../api.ts';
import {
  ACCENTS,
  DENSITIES,
  HOME_SECTION_LABELS,
  MENUS,
  LEADERSHIP_FIELDS,
  LEADERSHIP_FIXED_FIELDS,
  TAB_STYLES,
  TAB_STYLE_LABELS,
  densityOf,
  followOrganisation,
  menuOf,
  resetLabel,
  resetPrefs,
  moveItem,
  moveSection,
  schemeChoices,
  schemeFor,
  setHidden,
  tabStyleOf,
  type Density,
  type HomeSection,
  type MenuStyle,
  type Prefs,
  type PrefsPart,
  type Theme,
} from '../prefs.ts';
import { TabPreview } from '../ui/TabPreview.tsx';

const THEME_LABELS: Record<Theme, string> = { light: 'Light', dark: 'Dark' };
const MENU_LABELS: Record<MenuStyle, string> = { light: 'Light', dark: 'Dark, in the scheme colour' };
const DENSITY_LABELS: Record<Density, string> = { comfortable: 'Comfortable', compact: 'Compact' };

/** Saves a change and keeps a short status line: "Saving", "Saved", or the reason it failed. */
export function useSaveStatus(onChange: (next: Prefs) => Promise<void>) {
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
  return { save, status, error };
}

/**
 * Colour scheme, Light or dark, tab style, side menu and spacing (spec section 8, D135, 11a.2 spec 7). "Follow the
 * organisation" is the installation default (the organisation colour, else Red) and is marked until the person picks a
 * fixed scheme; picking one records that the person chose it, and "Follow the organisation" goes back.
 */
export function AppearanceChoice({ prefs, orgColour, save, name }: { prefs: Prefs; orgColour: string | null; save: (next: Prefs) => void; name: string }) {
  const shown = schemeFor(prefs, orgColour).key;
  // A scheme saved as "organisation" before this choice existed follows the organisation too: it falls back to Red the same way.
  const following = !prefs.accentChosen || prefs.accent === 'organisation';
  const followed = schemeFor(followOrganisation(prefs), orgColour);
  return (
    <>
      <fieldset>
        <legend>Colour scheme</legend>
        <label className="choice">
          <input type="radio" name={`${name}-scheme`} checked={following} onChange={() => save(followOrganisation(prefs))} />
          <span className="swatch" aria-hidden="true" style={{ background: followed.key === 'organisation' ? followed.tokens.accent : ACCENTS.red[prefs.theme].accent }} />
          <span>
            Follow the organisation
            <span className="hint">{followed.key === 'organisation' ? "The organisation's colour." : 'Red, as the organisation has no colour of its own.'}</span>
          </span>
        </label>
        {schemeChoices(prefs.theme, orgColour).filter((c) => c.key !== 'organisation').map((c) => (
          <label key={c.key} className="choice">
            <input type="radio" name={`${name}-scheme`} checked={!following && shown === c.key} onChange={() => save({ ...prefs, accent: c.key, accentChosen: true })} />
            <span className="swatch" aria-hidden="true" style={{ background: c.swatch }} />
            {c.label}
          </label>
        ))}
      </fieldset>
      <fieldset>
        <legend>Light or dark</legend>
        {(['light', 'dark'] as const).map((t) => (
          <label key={t} className="choice">
            <input type="radio" name={`${name}-theme`} checked={prefs.theme === t} onChange={() => save({ ...prefs, theme: t })} />
            {THEME_LABELS[t]}
          </label>
        ))}
      </fieldset>
      <fieldset className="tab-style-choice">
        <legend>Tab style</legend>
        {TAB_STYLES.map((s) => (
          <label key={s} className="choice">
            <input type="radio" name={`${name}-tabs`} checked={tabStyleOf(prefs) === s} onChange={() => save({ ...prefs, tabStyle: s })} />
            <span className="tab-style-name">{TAB_STYLE_LABELS[s]}</span>
            <TabPreview style={s} />
          </label>
        ))}
      </fieldset>
      <fieldset>
        <legend>Side menu</legend>
        {MENUS.map((m) => (
          <label key={m} className="choice">
            <input type="radio" name={`${name}-menu`} checked={menuOf(prefs) === m} onChange={() => save({ ...prefs, menu: m })} />
            {MENU_LABELS[m]}
          </label>
        ))}
      </fieldset>
      <fieldset>
        <legend>Spacing</legend>
        {DENSITIES.map((d) => (
          <label key={d} className="choice">
            <input type="radio" name={`${name}-density`} checked={densityOf(prefs) === d} onChange={() => save({ ...prefs, density: d })} />
            {DENSITY_LABELS[d]}
          </label>
        ))}
        <p className="hint">Compact puts more rows of lists, tables and boards on the screen.</p>
      </fieldset>
    </>
  );
}

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
 * The Customise panel (spec section 8): appearance, Home section order and visibility, and leadership field order and
 * visibility. Every change is saved at once through onChange, which the app sends to PUT /me/preferences.
 */
export function Customise({
  prefs,
  onChange,
  onClose,
  ready = true,
  failed = false,
  show = ['appearance', 'home', 'leadership'],
  orgColour = null,
  headingRef,
}: {
  prefs: Prefs;
  onChange: (next: Prefs) => Promise<void>;
  onClose?: () => void;
  /** False until the saved preferences have loaded: saving then would overwrite them with defaults. */
  ready?: boolean;
  /** True when loading the saved preferences failed: only then is the reload alert shown. */
  failed?: boolean;
  show?: PrefsPart[];
  /** The organisation colour, when set: offers the Organisation scheme. */
  orgColour?: string | null;
  /** The heading, so whoever opened the panel can move focus to it. */
  headingRef?: Ref<HTMLHeadingElement>;
}) {
  const { save, status, error } = useSaveStatus(onChange);

  const homeRows: Row[] = prefs.home.order.map((k) => ({ key: k, label: HOME_SECTION_LABELS[k], fixed: k === 'needsYou' }));
  const leadershipRows: Row[] = prefs.leadership.fields.order.map((k) => ({
    key: k,
    label: LEADERSHIP_FIELDS.find((f) => f.key === k)?.label ?? k,
    fixed: LEADERSHIP_FIXED_FIELDS.includes(k),
  }));

  return (
    <section className="panel customise" aria-labelledby="customise-heading">
      <div className="row">
        <h2 id="customise-heading" ref={headingRef} tabIndex={-1}>Customise</h2>
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
        {show.includes('appearance') && <AppearanceChoice prefs={prefs} orgColour={orgColour} save={save} name="customise" />}
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
          <button type="button" onClick={() => save(resetPrefs(prefs, show))}>
            {resetLabel(show)}
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
