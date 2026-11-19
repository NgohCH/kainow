import { TIMELINE_KINDS, type TimelineLine } from './timeline';

/**
 * Personal display preferences (spec section 8). The stored jsonb is classified NO_USER_TEXT, so every string that
 * survives normalisation comes from a fixed list below or is a UUID: nothing a person typed is ever kept.
 */

export const HOME_SECTIONS = ['needsYou', 'myTasks', 'myProjects'] as const;
export type HomeSection = (typeof HOME_SECTIONS)[number];

const THEMES = ['light', 'dark'] as const;
const ACCENTS = ['teal', 'blue', 'plum', 'slate'] as const;

/** The leadership card field keys (spec 6.3), in default order. Sub-project 8 adds resource and budget keys. */
export const LEADERSHIP_FIELD_KEYS = [
  'name',
  'owningDepartment',
  'contributingDepartments',
  'projectManager',
  'status',
  'stage',
  'taskCompletion',
  'onTime',
  'plannedEnd',
  'overdue',
  'blocked',
  'significantRisks',
  'nextDates',
  'attentionFlags',
  'refresh',
] as const;
/** Fields that can never be hidden. */
export const LEADERSHIP_FIXED_FIELDS: readonly string[] = ['name', 'refresh'];

export const MAX_EXPANDED = 1000;

export type Prefs = {
  theme: (typeof THEMES)[number];
  accent: (typeof ACCENTS)[number];
  home: { order: HomeSection[]; hidden: HomeSection[]; showCompleted: boolean; includeArchived: boolean };
  leadership: { fields: { order: string[]; hidden: string[] } };
  expanded: Record<string, boolean>;
  timeline: { hiddenKinds: TimelineLine['kind'][] };
};

export const DEFAULT_PREFS: Prefs = {
  theme: 'light',
  accent: 'teal',
  home: { order: [...HOME_SECTIONS], hidden: [], showCompleted: false, includeArchived: false },
  leadership: { fields: { order: [...LEADERSHIP_FIELD_KEYS], hidden: [] } },
  expanded: {},
  timeline: { hiddenKinds: [] },
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => (typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback);
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);

/** The known, distinct members of a list, in the order given. */
function known<T extends string>(v: unknown, allowed: readonly T[]): T[] {
  if (!Array.isArray(v)) return [];
  const out: T[] = [];
  for (const x of v) if (typeof x === 'string' && (allowed as readonly string[]).includes(x) && !out.includes(x as T)) out.push(x as T);
  return out;
}

/** Validates a saved or submitted document into a complete one: unknown keys and values are dropped, never kept. */
export function normalisePrefs(input: unknown): Prefs {
  const src = isObject(input) ? input : {};
  const home = isObject(src.home) ? src.home : {};
  const fields = isObject(src.leadership) && isObject(src.leadership.fields) ? src.leadership.fields : {};
  const timeline = isObject(src.timeline) ? src.timeline : {};

  const sections = known(home.order, HOME_SECTIONS).filter((s) => s !== 'needsYou');
  for (const s of HOME_SECTIONS) if (s !== 'needsYou' && !sections.includes(s)) sections.push(s);

  const fieldOrder: string[] = known(fields.order, LEADERSHIP_FIELD_KEYS);
  for (const k of LEADERSHIP_FIELD_KEYS) if (!fieldOrder.includes(k)) fieldOrder.push(k);

  const expanded: Record<string, boolean> = {};
  if (isObject(src.expanded)) {
    let n = 0;
    for (const [k, v] of Object.entries(src.expanded)) {
      if (n >= MAX_EXPANDED) break;
      if (UUID.test(k) && typeof v === 'boolean') {
        expanded[k] = v;
        n++;
      }
    }
  }

  return {
    theme: oneOf(src.theme, THEMES, DEFAULT_PREFS.theme),
    accent: oneOf(src.accent, ACCENTS, DEFAULT_PREFS.accent),
    home: {
      order: ['needsYou', ...sections],
      hidden: known(home.hidden, HOME_SECTIONS).filter((s) => s !== 'needsYou'),
      showCompleted: bool(home.showCompleted, DEFAULT_PREFS.home.showCompleted),
      includeArchived: bool(home.includeArchived, DEFAULT_PREFS.home.includeArchived),
    },
    leadership: { fields: { order: fieldOrder, hidden: known(fields.hidden, LEADERSHIP_FIELD_KEYS).filter((k) => !LEADERSHIP_FIXED_FIELDS.includes(k)) } },
    expanded,
    timeline: { hiddenKinds: known(timeline.hiddenKinds, TIMELINE_KINDS) },
  };
}
