/**
 * Personal display preferences on the web (dashboards spec section 8). The shape and defaults mirror
 * app/src/dashboards/preferences.ts: the web cannot import server code, so the lists are copied here. The server
 * normalises every saved document, so these helpers only have to keep what they build valid.
 */

import { contrastRatio, deriveScheme, type SchemeTokens } from './ui/colour.ts';

export const HOME_SECTIONS = ['needsYou', 'myTasks', 'myProjects'] as const;
export type HomeSection = (typeof HOME_SECTIONS)[number];

export const HOME_SECTION_LABELS: Record<HomeSection, string> = {
  needsYou: 'Needs you',
  myTasks: 'My tasks',
  myProjects: 'My projects',
};

/** The leadership card fields (mirrors app/src/leadership/leadership-fields.ts). Required ones can move but never hide. */
export const LEADERSHIP_FIELDS: readonly { key: string; label: string; required?: true }[] = [
  { key: 'name', label: 'Project name', required: true },
  { key: 'owningDepartment', label: 'Owning department' },
  { key: 'contributingDepartments', label: 'Contributing departments' },
  { key: 'projectManager', label: 'Project Manager' },
  { key: 'status', label: 'Status' },
  { key: 'stage', label: 'Stage' },
  { key: 'taskCompletion', label: 'Task completion' },
  { key: 'onTime', label: 'On-time completion' },
  { key: 'plannedEnd', label: 'Planned end' },
  { key: 'overdue', label: 'Overdue tasks' },
  { key: 'blocked', label: 'Blocked tasks' },
  { key: 'significantRisks', label: 'Significant risks' },
  { key: 'resources', label: 'Resources' },
  { key: 'budget', label: 'Budget' },
  { key: 'nextDates', label: 'Next dates' },
  { key: 'attentionFlags', label: 'Attention flags', required: true },
  { key: 'refresh', label: 'Last refreshed', required: true },
];
export const LEADERSHIP_FIXED_FIELDS: readonly string[] = LEADERSHIP_FIELDS.filter((f) => f.required).map((f) => f.key);

export type TimelineKind = 'stage' | 'status' | 'archive' | 'tasks_due' | 'risk_review' | 'resource_needed_by' | 'planned_end';
export type Theme = 'light' | 'dark';
export const ACCENT_KEYS = ['red', 'teal', 'blue', 'plum', 'slate', 'organisation'] as const;
export type AccentKey = (typeof ACCENT_KEYS)[number];
export type FixedAccentKey = Exclude<AccentKey, 'organisation'>;

export const TAB_STYLES = ['boxes', 'grey', 'tinted'] as const;
export type TabStyle = (typeof TAB_STYLES)[number];
export const TAB_STYLE_LABELS: Record<TabStyle, string> = { boxes: 'Boxes', grey: 'Grey dividers', tinted: 'Tinted dividers' };

export const MENUS = ['light', 'dark'] as const;
export type MenuStyle = (typeof MENUS)[number];
export const DENSITIES = ['comfortable', 'compact'] as const;
export type Density = (typeof DENSITIES)[number];

/** How each list of tasks is laid out (mirrors the server's views). */
export type Views = {
  work: 'board' | 'list';
  workBy: 'status' | 'assignee';
  myTasks: 'board' | 'project' | 'due';
  needsYou: 'board' | 'project';
};
export const DEFAULT_VIEWS: Views = { work: 'board', workBy: 'status', myTasks: 'board', needsYou: 'board' };

export type Prefs = {
  theme: Theme;
  accent: AccentKey;
  /** True once the person has picked a scheme; until then the installation default (organisation colour, else red) applies. */
  accentChosen: boolean;
  /** How a project's tabs look (D135). */
  tabStyle: TabStyle;
  /** The side menu: light by default, dark as a personal option. */
  menu: MenuStyle;
  /** Spacing of lists and boards. */
  density: Density;
  views: Views;
  home: { order: HomeSection[]; hidden: HomeSection[]; showCompleted: boolean; includeArchived: boolean };
  leadership: { fields: { order: string[]; hidden: string[] } };
  expanded: Record<string, boolean>;
  timeline: { hiddenKinds: TimelineKind[] };
};

export const DEFAULT_PREFS: Prefs = {
  theme: 'light',
  accent: 'red',
  accentChosen: false,
  tabStyle: 'boxes',
  menu: 'light',
  density: 'comfortable',
  views: { ...DEFAULT_VIEWS },
  home: { order: [...HOME_SECTIONS], hidden: [], showCompleted: false, includeArchived: false },
  leadership: { fields: { order: LEADERSHIP_FIELDS.map((f) => f.key), hidden: [] } },
  expanded: {},
  timeline: { hiddenKinds: [] },
};

/** A fresh copy of the defaults, so a caller can edit it without touching the constant. */
export const defaultPrefs = (): Prefs => structuredClone(DEFAULT_PREFS);

export type PrefsPart = 'appearance' | 'home' | 'leadership';

/** The defaults for the parts a panel shows; everything else, and what is chosen elsewhere, stays as it is. */
export function resetPrefs(prefs: Prefs, parts: readonly PrefsPart[]): Prefs {
  const d = defaultPrefs();
  return {
    ...prefs,
    ...(parts.includes('appearance')
      ? { theme: d.theme, accent: d.accent, accentChosen: d.accentChosen, tabStyle: d.tabStyle, menu: d.menu, density: d.density }
      : {}),
    ...(parts.includes('home') ? { home: { ...prefs.home, order: d.home.order, hidden: d.home.hidden } } : {}),
    ...(parts.includes('leadership') ? { leadership: d.leadership } : {}),
  };
}

/** The reset button's words: for appearance they name everything it puts back. */
export function resetLabel(parts: readonly PrefsPart[]): string {
  return parts.includes('appearance') ? 'Reset colour scheme, light or dark, tab style, side menu and spacing' : 'Reset to defaults';
}

/** Back to the installation default: the organisation colour when it has a usable one, else Red. Nothing else changes. */
export const followOrganisation = (prefs: Prefs): Prefs => ({ ...prefs, accentChosen: false });

/** The tab style shown; a document without one shows the default. */
export const tabStyleOf = (prefs: Partial<Pick<Prefs, 'tabStyle'>>): TabStyle => prefs.tabStyle ?? DEFAULT_PREFS.tabStyle;

/** The menu shown; a document saved before the choice existed shows the light one. */
export const menuOf = (prefs: Partial<Pick<Prefs, 'menu'>>): MenuStyle => (MENUS as readonly string[]).includes(prefs.menu as string) ? prefs.menu! : DEFAULT_PREFS.menu;

/** The spacing shown; a document saved before the choice existed shows comfortable. */
export const densityOf = (prefs: Partial<Pick<Prefs, 'density'>>): Density => (DENSITIES as readonly string[]).includes(prefs.density as string) ? prefs.density! : DEFAULT_PREFS.density;

/** Every view choice, each falling back to its default when a document saved earlier lacks it. */
export function viewsOf(prefs: { views?: Partial<Views> | null }): Views {
  const v = prefs.views ?? {};
  const pick = <K extends keyof Views>(k: K, allowed: readonly Views[K][]): Views[K] => (allowed.includes(v[k] as Views[K]) ? (v[k] as Views[K]) : DEFAULT_VIEWS[k]);
  return {
    work: pick('work', ['board', 'list']),
    workBy: pick('workBy', ['status', 'assignee']),
    myTasks: pick('myTasks', ['board', 'project', 'due']),
    needsYou: pick('needsYou', ['board', 'project']),
  };
}

/**
 * The views shown: the saved choices once preferences have loaded; otherwise this visit's own choices (not saved) over the
 * saved or default ones, so every view stays reachable when preferences failed to load.
 */
export function shownViews(prefs: { views?: Partial<Views> | null }, ready: boolean, local: Partial<Views>): Views {
  return ready ? viewsOf(prefs) : { ...viewsOf(prefs), ...local };
}

/** A personal or leadership list of projects: expanded when the person chose so, else when 5 or fewer are shown. */
export function expansionDefault(shownCount: number, saved: boolean | undefined): boolean {
  return saved ?? shownCount <= 5;
}

/** Open or closed: this session's own choice first (it works even when saved preferences did not load), then the saved one, then the default. */
export function openChoice(local: Record<string, boolean>, saved: Record<string, boolean>, shownCount: number, id: string): boolean {
  return local[id] ?? expansionDefault(shownCount, saved[id]);
}

/** Moves one key a place up or down. An unknown key, or one already at the end, leaves the list as it was. */
export function moveItem<T extends string>(list: readonly T[], key: T, dir: 'up' | 'down'): T[] {
  const i = list.indexOf(key);
  const j = dir === 'up' ? i - 1 : i + 1;
  const out = [...list];
  if (i < 0 || j < 0 || j >= out.length) return out;
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

/** Moves a Home section. "Needs you" never moves and nothing moves above it. */
export function moveSection(order: readonly string[], key: string, dir: 'up' | 'down'): string[] {
  if (key === 'needsYou') return [...order];
  const out = moveItem(order, key, dir);
  return out[0] === 'needsYou' || !order.includes('needsYou') ? out : [...order];
}

/** Adds or removes a key from a hidden list. A fixed key (one that can never be hidden) is never added. */
export function setHidden<T extends string>(hidden: readonly T[], key: T, hide: boolean, fixed: readonly string[]): T[] {
  const rest = hidden.filter((k) => k !== key);
  return hide && !fixed.includes(key) ? [...rest, key] : rest;
}

/** The colours that every accent is checked against, and the fixed surfaces. styles.css must carry exactly these. */
export type ThemeTokens = {
  paper: string;
  /** Behind board columns: a step away from the page. */
  well: string;
  surface: string;
  ink: string;
  muted: string;
  mutedWash: string;
  controlBorder: string;
  marker: string;
  markerWash: string;
  markerInk: string;
  accentWashStrong: string;
  rust: string;
  rustWash: string;
  rustInk: string;
  rustContrast: string;
};

export const THEME_TOKENS: Record<Theme, ThemeTokens> = {
  light: {
    paper: '#ffffff',
    well: '#f3f5f5',
    surface: '#ffffff',
    ink: '#13262b',
    muted: '#52666b',
    mutedWash: '#e4eae9',
    controlBorder: '#748886',
    marker: '#ffd84a',
    markerWash: '#fff3bf',
    markerInk: '#8a7410',
    accentWashStrong: '#a9d8d4',
    rust: '#a8203a',
    rustWash: '#f7dde2',
    rustInk: '#6e1020',
    rustContrast: '#ffffff',
  },
  dark: {
    paper: '#0f1a1d',
    well: '#132226',
    surface: '#172529',
    ink: '#e6eeee',
    muted: '#9fb3b6',
    mutedWash: '#243438',
    controlBorder: '#6f8a8d',
    marker: '#6b5a00',
    markerWash: '#4a3f0a',
    markerInk: '#d9bd3a',
    accentWashStrong: '#2a5457',
    rust: '#ff8fa3',
    rustWash: '#4a1a24',
    rustInk: '#ffd0d8',
    rustContrast: '#2a0710',
  },
};

const scheme = (menu: string, menuInk: string, menuActive: string, accent: string, accentContrast: string, accentDeep: string, accentWash: string): SchemeTokens => ({
  menu, menuInk, menuActive, accent, accentContrast, accentDeep, accentWash,
});

/**
 * The fixed schemes. menu, menuInk, menuActive: the side menu, its text and its active item. accent: text and controls on
 * the page and surface. accentContrast: text on a block of the accent. accentDeep: link and button text. accentWash: a
 * tint behind deep text. The organisation scheme is derived from its colour (schemeFor), so it is not listed here.
 */
export const ACCENTS: Record<FixedAccentKey, Record<Theme, SchemeTokens>> = {
  red: {
    light: scheme('#4a0912', '#ffffff', '#b0182e', '#b0182e', '#ffffff', '#8a1224', '#f9e0e4'),
    dark: scheme('#3a0b14', '#f6eaec', '#7a1626', '#ff8a9a', '#2a0710', '#ffb3bf', '#43151f'),
  },
  teal: {
    light: scheme('#0a3d40', '#ffffff', '#0c6a6e', '#0c6a6e', '#ffffff', '#08494c', '#d9ecea'),
    dark: scheme('#0b2f31', '#f2f6f6', '#14585c', '#4fc1c6', '#08181a', '#7fd9dc', '#1c3b3d'),
  },
  blue: {
    light: scheme('#132f5e', '#ffffff', '#1f55a8', '#1f55a8', '#ffffff', '#17407f', '#dbe6f6'),
    dark: scheme('#10233f', '#f2f6fb', '#1d4a8c', '#7fb0ff', '#08142a', '#a9c8ff', '#1d3050'),
  },
  plum: {
    light: scheme('#3f1d4d', '#ffffff', '#7a3a8f', '#7a3a8f', '#ffffff', '#5a2a6a', '#eadcf0'),
    dark: scheme('#2a1535', '#f6f0f9', '#5a2a6e', '#d29be6', '#1e0d26', '#e3bff0', '#392545'),
  },
  slate: {
    light: scheme('#26313b', '#ffffff', '#4a5a68', '#4a5a68', '#ffffff', '#333f4a', '#e0e5ea'),
    dark: scheme('#1c252d', '#f1f4f7', '#3a4a58', '#a3b4c4', '#10181e', '#c3cfdb', '#2a343d'),
  },
};

/**
 * The light side menu of each scheme (the default; the dark menu is the scheme's own menu colour): the page colour with a
 * trace of the accent. Its text is ink and muted; its current item is the accent wash with deep text and an accent edge.
 * In the Dark theme it is a quiet dark, as the page is.
 */
export const LIGHT_MENUS: Record<FixedAccentKey, Record<Theme, string>> = {
  red: { light: '#fcf6f7', dark: '#1b2023' },
  teal: { light: '#f5f9f9', dark: '#122225' },
  blue: { light: '#f6f8fc', dark: '#152228' },
  plum: { light: '#faf7fb', dark: '#192027' },
  slate: { light: '#f8f8f9', dark: '#162225' },
};

/** How much accent the light menu takes, by theme (the fixed values above were made the same way). */
const LIGHT_MENU_TINT: Record<Theme, { base: string; share: number }> = { light: { base: '#ffffff', share: 0.04 }, dark: { base: '#0f1a1d', share: 0.05 } };

function mixHex(a: string, b: string, t: number): string {
  const n = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [x, y] = [n(a), n(b)];
  return '#' + x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join('');
}

/** The organisation scheme in the dark theme: the menu stays as derived; the accent is lightened until it reads on the dark page. */
export function darkOrganisation(light: SchemeTokens): SchemeTokens {
  const { surface, paper } = THEME_TOKENS.dark;
  let accent = light.accent;
  for (let t = 0.05; t <= 1 && (contrastRatio(accent, surface) < 4.5 || contrastRatio(accent, paper) < 4.5); t += 0.05) {
    accent = mixHex(light.accent, '#ffffff', t);
  }
  const accentContrast = contrastRatio('#0b0b0b', accent) >= contrastRatio('#ffffff', accent) ? '#0b0b0b' : '#ffffff';
  return {
    menu: light.menu,
    menuInk: '#ffffff',
    menuActive: light.menuActive,
    accent,
    accentContrast,
    accentDeep: mixHex(accent, '#ffffff', 0.3),
    accentWash: mixHex(surface, light.accent, 0.25),
  };
}

/**
 * The scheme to show. Until the person has chosen one, the installation default applies: the organisation colour when it
 * works, else Red. A saved choice of the organisation scheme falls back to Red when the colour is gone or cannot be used.
 */
export function schemeFor(prefs: Pick<Prefs, 'theme' | 'accent' | 'accentChosen'>, orgColour: string | null): { key: AccentKey; tokens: SchemeTokens } {
  const derived = orgColour ? deriveScheme(orgColour) : null;
  const org = derived && derived.ok ? derived.scheme : null;
  const key: AccentKey = !prefs.accentChosen ? (org ? 'organisation' : 'red') : prefs.accent === 'organisation' && !org ? 'red' : prefs.accent;
  if (key === 'organisation' && org) return { key, tokens: prefs.theme === 'dark' ? darkOrganisation(org) : org };
  const fixedKey: FixedAccentKey = key === 'organisation' ? 'red' : key;
  return { key: fixedKey, tokens: ACCENTS[fixedKey][prefs.theme] };
}

/** The light menu shown: a fixed scheme's value, or the organisation scheme's made from its accent. */
export function lightMenuFor(prefs: Pick<Prefs, 'theme' | 'accent' | 'accentChosen'>, orgColour: string | null): string {
  const { key, tokens } = schemeFor(prefs, orgColour);
  if (key !== 'organisation') return LIGHT_MENUS[key][prefs.theme];
  const { base, share } = LIGHT_MENU_TINT[prefs.theme];
  return mixHex(base, tokens.accent, share);
}

export const ACCENT_LABELS: Record<AccentKey, string> = { red: 'Red', teal: 'Teal', blue: 'Blue', plum: 'Plum', slate: 'Slate', organisation: 'Organisation' };

/** The colour schemes a person may pick, each with the accent it shows in this theme. Organisation only when its colour is usable. */
export function schemeChoices(theme: Theme, orgColour: string | null): { key: AccentKey; label: string; swatch: string }[] {
  const fixed = ACCENT_KEYS.filter((k): k is FixedAccentKey => k !== 'organisation').map((k) => ({ key: k as AccentKey, label: ACCENT_LABELS[k], swatch: ACCENTS[k][theme].accent }));
  const org = schemeFor({ theme, accent: 'organisation', accentChosen: true }, orgColour);
  return org.key === 'organisation' ? [...fixed, { key: 'organisation', label: ACCENT_LABELS.organisation, swatch: org.tokens.accent }] : fixed;
}

const SCHEME_VARS: Record<keyof SchemeTokens, string> = {
  menu: '--menu',
  menuInk: '--menu-ink',
  menuActive: '--menu-active',
  accent: '--accent',
  accentContrast: '--accent-contrast',
  accentDeep: '--accent-deep',
  accentWash: '--accent-wash',
};

/**
 * Puts the theme, scheme, tab style, side menu and spacing on <html>. The fixed schemes come from the token blocks in styles.css; the organisation
 * scheme has no block, so its values are set directly (and removed again when another scheme is shown).
 */
export function applyAppearance(
  prefs: Pick<Prefs, 'theme' | 'accent' | 'accentChosen' | 'tabStyle'> & Partial<Pick<Prefs, 'menu' | 'density'>>,
  orgColour: string | null,
  root: HTMLElement = document.documentElement,
): void {
  const { key, tokens } = schemeFor(prefs, orgColour);
  root.setAttribute('data-theme', prefs.theme);
  root.setAttribute('data-accent', key);
  root.setAttribute('data-tabs', tabStyleOf(prefs));
  root.setAttribute('data-menu', menuOf(prefs));
  root.setAttribute('data-density', densityOf(prefs));
  const org = key === 'organisation';
  for (const [field, prop] of Object.entries(SCHEME_VARS)) {
    if (org) root.style.setProperty(prop, tokens[field as keyof SchemeTokens]);
    else root.style.removeProperty(prop);
  }
  if (org) root.style.setProperty('--menu-light', lightMenuFor(prefs, orgColour));
  else root.style.removeProperty('--menu-light');
}

/**
 * Saves preference documents one at a time, in the order they were made. Each change shows at once; a failed save puts
 * back the last saved copy only when no later change has been made, so a rollback can never undo a later success.
 */
export function createPrefsSaver(put: (next: Prefs) => Promise<Prefs>, onChange: (p: Prefs) => void) {
  let confirmed: Prefs = DEFAULT_PREFS;
  let seq = 0;
  let tail: Promise<unknown> = Promise.resolve();
  return {
    /** The copy the server gave at load. */
    loaded(p: Prefs): void {
      confirmed = p;
      seq++;
      onChange(p);
    },
    save(next: Prefs): Promise<void> {
      const mine = ++seq;
      onChange(next);
      const run = tail.then(async () => {
        try {
          const saved = await put(next);
          confirmed = saved;
          if (mine === seq) onChange(saved);
        } catch (e) {
          if (mine === seq) onChange(confirmed);
          throw e;
        }
      });
      tail = run.catch(() => undefined);
      return run;
    },
  };
}

/** The hint under "Follow the organisation": the colour it shows, and why it is Red when it is (C117). */
export function followHint(prefs: Pick<Prefs, 'theme'>, orgColour: string | null): string {
  if (schemeFor({ theme: prefs.theme, accent: 'red', accentChosen: false }, orgColour).key === 'organisation') return "The organisation's colour.";
  return orgColour ? "Red, as the organisation's colour cannot be used here." : 'Red, as the organisation has no colour of its own.';
}
