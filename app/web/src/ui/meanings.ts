/**
 * The fixed meaning colours (spec 5.1): what a state or an attention flag looks like, whatever scheme the person chose.
 * Each has a symbol and a word (colour is never the only sign), a strong colour (text, edges, filled badges) and a wash
 * (backgrounds), for both themes. styles.css carries the same values as --m-<meaning> and --m-<meaning>-wash
 * (dueSoon is --m-due-soon); meanings.test.ts checks that and the contrast.
 */
import type { ProjectStatus } from '../projects.ts';
import type { Theme } from '../prefs.ts';

export type Meaning =
  | 'draft'
  | 'planned'
  | 'active'
  | 'deferred'
  | 'closed'
  | 'overdue'
  | 'review'
  | 'blocked'
  | 'dueSoon'
  | 'ok'
  | 'attention'
  | 'failing'
  | 'off';

export type MeaningStyle = { symbol: string; word: string; strong: Record<Theme, string>; wash: Record<Theme, string> };

const both = (light: string, dark: string): Record<Theme, string> => ({ light, dark });

const GREY = { strong: both('#5b6670', '#a9b4bd'), wash: both('#e6e9ec', '#2a3238') };
const BLUE = { strong: both('#1d4f9a', '#8fb4f0'), wash: both('#dbe6f6', '#1d3050') };
const GREEN = { strong: both('#18703f', '#6fd09a'), wash: both('#d7efe0', '#17392a') };
const AMBER = { strong: both('#8a5200', '#f0b862'), wash: both('#fbe8c8', '#4a3510') };
const INDIGO = { strong: both('#45476a', '#b4b6e0'), wash: both('#e4e3ef', '#2d2f4d') };
const RED = { strong: both('#a8203a', '#ff8fa3'), wash: both('#f7dde2', '#4a1a24') };
const VIOLET = { strong: both('#6a3a88', '#d9a8ee'), wash: both('#eadcf0', '#3a2447') };

export const MEANINGS: Record<Meaning, MeaningStyle> = {
  draft: { symbol: '○', word: 'Draft', ...GREY },
  planned: { symbol: '◷', word: 'Planned', ...BLUE },
  active: { symbol: '●', word: 'Active', ...GREEN },
  deferred: { symbol: '❚❚', word: 'Deferred', ...AMBER },
  closed: { symbol: '✓', word: 'Closed', ...INDIGO },
  overdue: { symbol: '⚠', word: 'Overdue', ...RED },
  review: { symbol: '◆', word: 'Needs review', ...AMBER },
  blocked: { symbol: '■', word: 'Blocked', ...VIOLET },
  dueSoon: { symbol: '◷', word: 'Due soon', ...BLUE },
  ok: { symbol: '✓', word: 'Set up', ...GREEN },
  // The spec table has no row for these two: attention reuses the amber of "needs review", failing the red of overdue.
  attention: { symbol: '!', word: 'Needs attention', ...AMBER },
  failing: { symbol: '✕', word: 'Failing', ...RED },
  off: { symbol: '–', word: 'Not in use', ...GREY },
};

/** The meaning that shows a project's status. */
export function projectMeaning(status: ProjectStatus): Meaning {
  return status;
}
