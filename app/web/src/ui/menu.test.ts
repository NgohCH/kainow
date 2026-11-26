import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { PersonalProject } from '../dashboard.ts';
import { PROFILE_HREF, PROJECTS_CHANGED, SETTINGS_GROUPS, currentMenuHref, menuProjects, sideMenuGroups, type MenuContext } from './menu.ts';

const member: MenuContext = { isAdmin: false, hasGrant: false, maintainer: false, reviewer: false, reviewCount: 0 };
const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const headings = (ctx: MenuContext) => sideMenuGroups(ctx).map((g) => g.heading);
const texts = (ctx: MenuContext, heading: string) => sideMenuGroups(ctx).find((g) => g.heading === heading)?.items.map((i) => i.text);

test('a plain Member gets Work and My AI use, and no Administration group (Review Focus 1)', () => {
  assert.deepEqual(headings(member), ['Work', 'Organisation']);
  assert.deepEqual(texts(member, 'Work'), ['Home', 'My tasks', 'Reviews', 'Projects']);
  assert.deepEqual(texts(member, 'Organisation'), ['My AI use']);
  assert.deepEqual(sideMenuGroups(member)[0].items.map((i) => i.href), ['#/', '#/my-tasks', '#/reviews', '#/projects']);
});

test('no badge when nothing waits; the Reviews badge carries the count', () => {
  assert.ok(sideMenuGroups(member).every((g) => g.items.every((i) => i.badge === undefined)));
  const reviews = sideMenuGroups({ ...member, reviewCount: 3 })[0].items.find((i) => i.text === 'Reviews');
  assert.equal(reviews?.badge, 3);
});

test('an Administrator gets Analytics, Resource catalogue, Settings and Operations', () => {
  const admin = { ...member, isAdmin: true };
  assert.deepEqual(headings(admin), ['Work', 'Organisation', 'Administration']);
  assert.deepEqual(texts(admin, 'Organisation'), ['Analytics', 'My AI use', 'Resource catalogue']);
  assert.deepEqual(texts(admin, 'Administration'), ['Settings', 'Operations']);
  assert.deepEqual(sideMenuGroups(admin)[2].items.map((i) => i.href), ['#/settings', '#/admin/operations']);
});

test('a security reviewer gets Security review; grant holders and maintainers their own items', () => {
  assert.deepEqual(texts({ ...member, reviewer: true }, 'Administration'), ['Security review']);
  assert.deepEqual(texts({ ...member, hasGrant: true, maintainer: true }, 'Organisation'), ['Leadership', 'My AI use', 'Resource catalogue']);
  assert.deepEqual(headings({ ...member, hasGrant: true, maintainer: true }), ['Work', 'Organisation']);
});

test('currentMenuHref: settings pages mark Settings, project pages mark Projects', () => {
  assert.equal(currentMenuHref('#/deliveries'), '#/settings');
  assert.equal(currentMenuHref('#/stage-templates'), '#/settings');
  assert.equal(currentMenuHref('#/ai/usage'), '#/settings');
  assert.equal(currentMenuHref('#/settings'), '#/settings');
  for (const g of SETTINGS_GROUPS) for (const i of g.items) {
    const expected = i.href === '#/admin/operations' || i.href === '#/security/cases' ? i.href : '#/settings';
    assert.equal(currentMenuHref(i.href), expected, i.href);
  }
  assert.equal(currentMenuHref(`#/projects/${ID}/work`), '#/projects');
  assert.equal(currentMenuHref(`#/projects/${ID}`), '#/projects');
  assert.equal(currentMenuHref(`#/projects/${ID}/threads/${ID}?m=3`), '#/projects');
  assert.equal(currentMenuHref(`#/runs/${ID}`), '#/projects');
  assert.equal(currentMenuHref(`#/notes/${ID}/v/2`), '#/projects');
  assert.equal(currentMenuHref('#/projects'), '#/projects');
});

test('currentMenuHref: the other menu items and pages without one', () => {
  assert.equal(currentMenuHref('#/my-ai-usage'), '#/my-ai-usage');
  assert.equal(currentMenuHref('#/'), '#/');
  assert.equal(currentMenuHref(''), '#/');
  assert.equal(currentMenuHref('#/my-tasks'), '#/my-tasks');
  assert.equal(currentMenuHref('#/reviews'), '#/reviews');
  assert.equal(currentMenuHref('#/admin/analytics/definitions'), '#/admin/analytics');
  assert.equal(currentMenuHref('#/security/grants'), '#/security/cases');
  assert.equal(currentMenuHref(`#/quarantine/cases/${ID}`), '#/security/cases');
  assert.equal(currentMenuHref('#/leadership'), '#/leadership');
  assert.equal(currentMenuHref('#/resource-catalogue'), '#/resource-catalogue');
  assert.equal(currentMenuHref('#/notifications'), '');
  assert.equal(currentMenuHref('#/search?q=budget'), '');
});

test('My profile is at #/me, opened from the person menu: no side menu entry is highlighted or added (D134)', () => {
  assert.equal(PROFILE_HREF, '#/me');
  assert.equal(currentMenuHref(PROFILE_HREF), '');
  const everything = sideMenuGroups({ isAdmin: true, hasGrant: true, maintainer: true, reviewer: true, reviewCount: 1 });
  assert.ok(everything.every((g) => g.items.every((i) => i.href !== PROFILE_HREF)));
  const read = (f: string) => readFileSync(new URL(f, import.meta.url), 'utf8');
  assert.match(read('../App.tsx'), /hash === PROFILE_HREF\) page = <MyProfile /);
  assert.match(read('./PersonMenu.tsx'), /href=\{PROFILE_HREF\}/);
});

// ---- The person's current projects in the menu (11a.2 spec 7) ----

const proj = (n: number, name: string, status: string | null = 'active', extra: Partial<PersonalProject> = {}): PersonalProject => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  name,
  onHold: false,
  ...(status ? { header: { status, stage: null, completion: { state: 'not_measurable' }, flags: { overdue: 0, blocked: 0, missingRole: false, noIndependentEscalation: false, deadlineReview: false } } } : {}),
  ...extra,
}) as PersonalProject;

test('menuProjects: the first ten current projects by name, then more', () => {
  const names = ['Lima', 'alpha', 'Kilo', 'Bravo', 'Juliet', 'Charlie', 'India', 'Delta', 'Hotel', 'Echo', 'Golf', 'Foxtrot'];
  const { items, more } = menuProjects(names.map((n, i) => proj(i, n)));
  assert.deepEqual(items.map((i) => i.text), ['alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel', 'India', 'Juliet']);
  assert.equal(more, true);
  assert.equal(items[0].href, `#/projects/${proj(1, 'alpha').id}`);
  assert.equal(menuProjects(names.slice(0, 10).map((n, i) => proj(i, n))).more, false);
  assert.deepEqual(menuProjects([]), { items: [], more: false });
});

test('menuProjects: Deferred, Closed and archived projects are left out; on hold is listed without a link', () => {
  const { items, more } = menuProjects([
    proj(1, 'Active one'),
    proj(2, 'Deferred one', 'deferred'),
    proj(3, 'Closed one', 'closed'),
    proj(4, 'Archived one', 'active', { archived: true }),
    proj(5, 'Held one', null, { onHold: true }),
    proj(6, 'Draft one', 'draft'),
  ]);
  assert.deepEqual(items.map((i) => i.text), ['Active one', 'Draft one', 'Held one']);
  assert.equal(more, false);
  const held = items.find((i) => i.text === 'Held one');
  assert.equal(held?.href, undefined, 'no link to figures the person may not see');
  assert.equal(held?.note, 'membership on hold');
});

test('the current project carries the menu mark, and Projects does not', () => {
  const list = menuProjects([proj(1, 'Alpha'), proj(2, 'Bravo')]);
  const groups = sideMenuGroups({ ...member, projects: list });
  assert.deepEqual(groups.map((g) => g.heading), ['Work', 'Your projects', 'Organisation']);
  const hrefs = list.items.flatMap((i) => (i.href ? [i.href] : []));
  const marked = (hash: string) => {
    const current = currentMenuHref(hash, hrefs);
    return groups.flatMap((g) => g.items).filter((i) => i.href === current && !i.unmarked).map((i) => i.text);
  };
  assert.deepEqual(marked(`#/projects/${proj(2, 'Bravo').id}/work`), ['Bravo']);
  assert.deepEqual(marked(`#/projects/${proj(1, 'Alpha').id}`), ['Alpha']);
  assert.deepEqual(marked(`#/projects/${ID}`), ['Projects'], 'a project not in the menu marks Projects');
  assert.deepEqual(marked('#/projects'), ['Projects']);
  assert.deepEqual(marked('#/projects/history'), ['Projects']);
});

test('more than ten: an All projects link that is never marked; no projects: no group', () => {
  const many = menuProjects(Array.from({ length: 11 }, (_, i) => proj(i, `Project ${String(i).padStart(2, '0')}`)));
  const group = sideMenuGroups({ ...member, projects: many }).find((g) => g.heading === 'Your projects');
  assert.equal(group?.items.length, 11);
  assert.deepEqual(group?.items.at(-1), { href: '#/projects', text: 'All projects', unmarked: true });
  assert.deepEqual(headings({ ...member, projects: { items: [], more: false } }), ['Work', 'Organisation']);
});

test('the menu list refreshes when a project is created, duplicated or changes state', () => {
  const read = (f: string) => readFileSync(new URL(f, import.meta.url), 'utf8');
  assert.equal(PROJECTS_CHANGED, 'projects-changed');
  assert.match(read('./AppShell.tsx'), /addEventListener\(PROJECTS_CHANGED/);
  for (const f of ['../views/Projects.tsx', '../views/DuplicateProject.tsx', '../views/ProjectPage.tsx']) assert.match(read(f), /projectsChanged\(\)/, f);
});
