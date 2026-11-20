/**
 * Personal display preferences on the web (dashboards spec section 8). The shape and defaults mirror
 * app/src/dashboards/preferences.ts: the web cannot import server code, so the lists are copied here. The server
 * normalises every saved document, so these helpers only have to keep what they build valid.
 */

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
export const ACCENT_KEYS = ['teal', 'blue', 'plum', 'slate'] as const;
export type AccentKey = (typeof ACCENT_KEYS)[number];

export type Prefs = {
  theme: Theme;
  accent: AccentKey;
  home: { order: HomeSection[]; hidden: HomeSection[]; showCompleted: boolean; includeArchived: boolean };
  leadership: { fields: { order: string[]; hidden: string[] } };
  expanded: Record<string, boolean>;
  timeline: { hiddenKinds: TimelineKind[] };
};

export const DEFAULT_PREFS: Prefs = {
  theme: 'light',
  accent: 'teal',
  home: { order: [...HOME_SECTIONS], hidden: [], showCompleted: false, includeArchived: false },
  leadership: { fields: { order: LEADERSHIP_FIELDS.map((f) => f.key), hidden: [] } },
  expanded: {},
  timeline: { hiddenKinds: [] },
};

/** A fresh copy of the defaults, so a caller can edit it without touching the constant. */
export const defaultPrefs = (): Prefs => structuredClone(DEFAULT_PREFS);

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
    paper: '#f4f7f6',
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

/**
 * accent: text and controls on the page and surface; contrast: text on a block of the accent; deep: link and button text;
 * wash: a tint behind deep text.
 */
export type AccentTokens = { accent: string; contrast: string; deep: string; wash: string };

export const ACCENTS: Record<AccentKey, Record<Theme, AccentTokens>> = {
  teal: {
    light: { accent: '#0c6a6e', contrast: '#ffffff', deep: '#08494c', wash: '#d9ecea' },
    dark: { accent: '#4fc1c6', contrast: '#08181a', deep: '#7fd9dc', wash: '#1c3b3d' },
  },
  blue: {
    light: { accent: '#1f55a8', contrast: '#ffffff', deep: '#17407f', wash: '#dbe6f6' },
    dark: { accent: '#7fb0ff', contrast: '#08142a', deep: '#a9c8ff', wash: '#1d3050' },
  },
  plum: {
    light: { accent: '#7a3a8f', contrast: '#ffffff', deep: '#5a2a6a', wash: '#eadcf0' },
    dark: { accent: '#d29be6', contrast: '#1e0d26', deep: '#e3bff0', wash: '#392545' },
  },
  slate: {
    light: { accent: '#4a5a68', contrast: '#ffffff', deep: '#333f4a', wash: '#e0e5ea' },
    dark: { accent: '#a3b4c4', contrast: '#10181e', deep: '#c3cfdb', wash: '#2a343d' },
  },
};

function luminance(hex: string): number {
  let h = hex.replace('#', '');
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  const [r, g, b] = [0, 2, 4].map((i) => {
    const v = parseInt(h.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The WCAG contrast ratio of two colours, from 1 to 21. */
export function contrastRatio(hexA: string, hexB: string): number {
  const a = luminance(hexA);
  const b = luminance(hexB);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** Puts the theme and accent on <html>, where styles.css reads them. */
export function applyAppearance(prefs: Pick<Prefs, 'theme' | 'accent'>, root: HTMLElement = document.documentElement): void {
  root.setAttribute('data-theme', prefs.theme);
  root.setAttribute('data-accent', prefs.accent);
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
