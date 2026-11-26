/** The side menu (spec 6.1, D128): which groups and items a person sees, and which item a page belongs to. */

import type { PersonalProject } from '../dashboard.ts';
import { homeProjects } from './home.ts';
import { SETTINGS_CATALOGUE } from './settings.ts';

/** My profile (D134): opened from the person menu, so it belongs to no side menu item. */
export const PROFILE_HREF = '#/me';

export type MenuHeading = 'Work' | 'Your projects' | 'Organisation' | 'Administration';
export interface MenuItem {
  /** None for a project where the person's membership is on hold: it is named, as on Home, without a link. */
  href?: string;
  text: string;
  badge?: number;
  /** Said after the name, as on Home. */
  note?: string;
  /** Never marked as the current page (All projects: the Projects item is marked instead). */
  unmarked?: true;
}
export interface MenuGroup { heading: MenuHeading; items: MenuItem[] }
export interface MenuContext {
  isAdmin: boolean;
  hasGrant: boolean;
  maintainer: boolean;
  reviewer: boolean;
  reviewCount: number;
  /** The person's current projects (menuProjects); left out, or none, and the group is not shown. */
  projects?: { items: MenuItem[]; more: boolean };
}

/** Sent on window after a project is created, duplicated or changes, so the menu reads its list of projects again. */
export const PROJECTS_CHANGED = 'projects-changed';
export const projectsChanged = (): void => {
  globalThis.dispatchEvent?.(new Event(PROJECTS_CHANGED));
};

/** How many projects the menu lists before "All projects". */
export const MENU_PROJECTS = 10;

/** The menu's projects: current ones only (as Home's), the first ten by name, and whether there are more. */
export function menuProjects(projects: readonly PersonalProject[]): { items: MenuItem[]; more: boolean } {
  const current = homeProjects(projects.filter((p) => !p.archived)).current;
  const sorted = [...current].sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
  return {
    items: sorted.slice(0, MENU_PROJECTS).map((p) => (p.onHold || !p.header ? { text: p.name, note: 'membership on hold' } : { href: `#/projects/${p.id}`, text: p.name })),
    more: sorted.length > MENU_PROJECTS,
  };
}

/** The menu groups in order; an item shows only to whom it applies, and a group with no item is dropped. */
export function sideMenuGroups(ctx: MenuContext): MenuGroup[] {
  const pick = (items: (MenuItem | false)[]) => items.filter((i): i is MenuItem => i !== false);
  const groups: MenuGroup[] = [
    {
      heading: 'Work',
      items: [
        { href: '#/', text: 'Home' },
        { href: '#/my-tasks', text: 'My tasks' },
        ctx.reviewCount > 0 ? { href: '#/reviews', text: 'Reviews', badge: ctx.reviewCount } : { href: '#/reviews', text: 'Reviews' },
        { href: '#/projects', text: 'Projects' },
      ],
    },
    {
      heading: 'Your projects',
      items: ctx.projects && ctx.projects.items.length > 0
        ? [...ctx.projects.items, ...(ctx.projects.more ? [{ href: '#/projects', text: 'All projects', unmarked: true as const }] : [])]
        : [],
    },
    {
      heading: 'Organisation',
      items: pick([
        ctx.hasGrant && { href: '#/leadership', text: 'Leadership' },
        ctx.isAdmin && { href: '#/admin/analytics', text: 'Analytics' },
        { href: '#/my-ai-usage', text: 'My AI use' },
        (ctx.isAdmin || ctx.maintainer) && { href: '#/resource-catalogue', text: 'Resource catalogue' },
      ]),
    },
    {
      heading: 'Administration',
      items: pick([
        ctx.isAdmin && { href: '#/settings', text: 'Settings' },
        ctx.isAdmin && { href: '#/admin/operations', text: 'Operations' },
        ctx.reviewer && { href: '#/security/cases', text: 'Security review' },
      ]),
    },
  ];
  return groups.filter((g) => g.items.length > 0);
}

/** The organisation-wide settings by group (spec 7.8), made from the one catalogue. */
export const SETTINGS_GROUPS: { heading: string; items: { href: string; text: string; reviewerOnly?: true }[] }[] = (
  ['Organisation and people', 'Work rules', 'Connections', 'Running Kainow'] as const
).map((heading) => ({
  heading,
  items: SETTINGS_CATALOGUE.filter((s) => s.group === heading).map((s) => ({ href: s.href, text: s.title, ...(s.reviewerOnly ? { reviewerOnly: true as const } : {}) })),
}));

/** Settings pages whose own menu item is Settings (Operations and Security review have their own items). */
const SETTINGS_PAGES = new Set([
  'settings', 'organisation', 'people', 'departments', 'domains', 'leadership-grants', 'approvals', 'notifications-settings',
  'access-settings', 'resources-admin', 'report-types', 'stage-templates', 'ai', 'ai/usage', 'deliveries', 'storage', 'go-live',
  'escalated-feedback',
]);

const OWN_ITEMS = new Set(['my-tasks', 'reviews', 'projects', 'leadership', 'my-ai-usage', 'resource-catalogue', 'admin/operations', 'admin/analytics']);

/**
 * The menu item a page belongs to (its href), or '' when it belongs to none (notifications, search, My profile). A page of
 * a project listed in the menu (projectHrefs) belongs to that project's item; any other project page to Projects.
 */
export function currentMenuHref(hash: string, projectHrefs: readonly string[] = []): string {
  const path = (hash.startsWith('#') ? hash.slice(1) : hash).split('?')[0].replace(/^\/+|\/+$/g, '');
  if (path === '') return '#/';
  if (SETTINGS_PAGES.has(path)) return '#/settings';
  if (OWN_ITEMS.has(path)) return `#/${path}`;
  const first = path.split('/')[0];
  const own = first === 'projects' ? `#/projects/${path.split('/')[1] ?? ''}` : '';
  if (own && projectHrefs.includes(own)) return own;
  if (first === 'projects' || first === 'runs' || first === 'notes' || first === 'summaries') return '#/projects';
  if (path.startsWith('admin/analytics/')) return '#/admin/analytics';
  if (first === 'security' || first === 'quarantine') return '#/security/cases';
  return '';
}
