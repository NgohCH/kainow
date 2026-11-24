/** The side menu (spec 6.1, D128): which groups and items a person sees, and which item a page belongs to. */

export type MenuHeading = 'Work' | 'Organisation' | 'Administration';
export interface MenuItem { href: string; text: string; badge?: number }
export interface MenuGroup { heading: MenuHeading; items: MenuItem[] }
export interface MenuContext { isAdmin: boolean; hasGrant: boolean; maintainer: boolean; reviewer: boolean; reviewCount: number }

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

/** The organisation-wide settings by group (spec 7.8), with the addresses they keep. */
export const SETTINGS_GROUPS: { heading: string; items: { href: string; text: string; reviewerOnly?: true }[] }[] = [
  {
    heading: 'Organisation and people',
    items: [
      { href: '#/organisation', text: 'Organisation' },
      { href: '#/people', text: 'Administrators' },
      { href: '#/departments', text: 'Departments' },
      { href: '#/domains', text: 'Email domains' },
      { href: '#/leadership-grants', text: 'Leadership access' },
    ],
  },
  {
    heading: 'Work rules',
    items: [
      { href: '#/approvals', text: 'Approvals' },
      { href: '#/notifications-settings', text: 'Reminders and email' },
      { href: '#/access-settings', text: 'Access and records' },
      { href: '#/resources-admin', text: 'Resources and finance' },
      { href: '#/report-types', text: 'Report types' },
    ],
  },
  {
    heading: 'Connections',
    items: [
      { href: '#/ai', text: 'AI' },
      { href: '#/deliveries', text: 'Email delivery' },
      { href: '#/storage', text: 'Storage' },
    ],
  },
  {
    heading: 'Running Kainow',
    items: [
      { href: '#/admin/operations', text: 'Operations' },
      { href: '#/go-live', text: 'Go-live checklist' },
      { href: '#/escalated-feedback', text: 'Escalated feedback' },
      { href: '#/security/cases', text: 'Security review', reviewerOnly: true },
    ],
  },
];

/** Settings pages whose own menu item is Settings (Operations and Security review have their own items). */
const SETTINGS_PAGES = new Set([
  'settings', 'organisation', 'people', 'departments', 'domains', 'leadership-grants', 'approvals', 'notifications-settings',
  'access-settings', 'resources-admin', 'report-types', 'stage-templates', 'ai', 'ai/usage', 'deliveries', 'storage', 'go-live',
  'escalated-feedback',
]);

const OWN_ITEMS = new Set(['my-tasks', 'reviews', 'projects', 'leadership', 'my-ai-usage', 'resource-catalogue', 'admin/operations', 'admin/analytics']);

/** The menu item a page belongs to (its href), or '' when it belongs to none (notifications, search). */
export function currentMenuHref(hash: string): string {
  const path = (hash.startsWith('#') ? hash.slice(1) : hash).split('?')[0].replace(/^\/+|\/+$/g, '');
  if (path === '') return '#/';
  if (SETTINGS_PAGES.has(path)) return '#/settings';
  if (OWN_ITEMS.has(path)) return `#/${path}`;
  const first = path.split('/')[0];
  if (first === 'projects' || first === 'runs' || first === 'notes' || first === 'summaries') return '#/projects';
  if (path.startsWith('admin/analytics/')) return '#/admin/analytics';
  if (first === 'security' || first === 'quarantine') return '#/security/cases';
  return '';
}
