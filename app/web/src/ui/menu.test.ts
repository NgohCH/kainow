import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { NeedsYouItem } from '../dashboard.ts';
import { SETTINGS_GROUPS, currentMenuHref, reviewCount, sideMenuGroups, type MenuContext } from './menu.ts';

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

test('reviewCount counts the Review and decisions group only', () => {
  const item = (kind: NeedsYouItem['kind']): NeedsYouItem => ({ kind, projectId: 'p', projectName: 'P', label: kind, since: null, link: '#/x' });
  assert.equal(reviewCount([]), 0);
  assert.equal(reviewCount(['approval', 'minutes', 'overdue', 'question', 'blocked', 'deadline_review', 'due_soon'].map((k) => item(k as NeedsYouItem['kind']))), 4);
});
