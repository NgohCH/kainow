import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DEFAULT_PREFS, normalisePrefs } from './preferences';

const ID = '0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b';
const FREE = 'Dummy free text value';

describe('normalisePrefs', () => {
  test('non-objects give the defaults', () => {
    for (const v of [null, undefined, 'x', 5, [], true]) assert.deepEqual(normalisePrefs(v), DEFAULT_PREFS);
  });

  test('unknown sections dropped; needsYou cannot be hidden or moved', () => {
    const p = normalisePrefs({ home: { order: ['myProjects', 'gone', 'myTasks', 'needsYou', 'myTasks'], hidden: ['needsYou', 'myTasks', 'gone'] } });
    assert.deepEqual(p.home.order, ['needsYou', 'myProjects', 'myTasks']);
    assert.deepEqual(p.home.hidden, ['myTasks']);
  });

  test('a missing section is appended so none is lost', () => {
    assert.deepEqual(normalisePrefs({ home: { order: ['myTasks'] } }).home.order, ['needsYou', 'myTasks', 'myProjects']);
  });

  test('colour scheme: red by default, old documents keep their accent, unknown values fall back', () => {
    const d = normalisePrefs({});
    assert.equal(d.accent, 'red');
    assert.equal(d.accentChosen, false);
    const old = normalisePrefs({ accent: 'teal' });
    assert.equal(old.accent, 'teal');
    assert.equal(old.accentChosen, false);
    const org = normalisePrefs({ accent: 'organisation', accentChosen: true });
    assert.equal(org.accent, 'organisation');
    assert.equal(org.accentChosen, true);
    assert.equal(normalisePrefs({ accent: 'green' }).accent, 'red');
    assert.equal(normalisePrefs({ accentChosen: 'yes' }).accentChosen, false);
  });

  test('bad theme falls back to light', () => {
    const p = normalisePrefs({ theme: 'neon', accent: 'green' });
    assert.equal(p.theme, 'light');
    const q = normalisePrefs({ theme: 'dark', accent: 'plum' });
    assert.equal(q.theme, 'dark');
    assert.equal(q.accent, 'plum');
  });

  test('home flags must be booleans', () => {
    const p = normalisePrefs({ home: { showCompleted: 'yes', includeArchived: true } });
    assert.equal(p.home.showCompleted, DEFAULT_PREFS.home.showCompleted);
    assert.equal(p.home.includeArchived, true);
  });

  test('leadership fields: unknown dropped, name and refresh stay visible', () => {
    const p = normalisePrefs({ leadership: { fields: { order: ['status', 'bogus', 'name', 'status'], hidden: ['name', 'refresh', 'status', 'bogus'] } } });
    assert.ok(!p.leadership.fields.order.includes('bogus'));
    assert.equal(new Set(p.leadership.fields.order).size, p.leadership.fields.order.length);
    assert.deepEqual(p.leadership.fields.hidden, ['status']);
    assert.ok(p.leadership.fields.order.includes('name') && p.leadership.fields.order.includes('refresh'));
  });

  test('attentionFlags cannot be hidden but can be moved', () => {
    const p = normalisePrefs({ leadership: { fields: { order: ['attentionFlags', 'name'], hidden: ['attentionFlags', 'status'] } } });
    assert.deepEqual(p.leadership.fields.hidden, ['status']);
    assert.equal(p.leadership.fields.order[0], 'attentionFlags');
  });

  test('free text in keys or values is dropped', () => {
    const p = normalisePrefs({
      theme: FREE,
      home: { order: [FREE], hidden: [FREE] },
      leadership: { fields: { order: [FREE], hidden: [FREE] } },
      expanded: { [FREE]: true, [ID]: true, [`${ID}x`]: true, '0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6c': FREE },
      timeline: { hiddenKinds: [FREE, 'tasks_due', 'tasks_due'] },
      extra: FREE,
    });
    assert.ok(!JSON.stringify(p).includes('free text'));
    assert.deepEqual(p.expanded, { [ID]: true });
    assert.deepEqual(p.timeline.hiddenKinds, ['tasks_due']);
    assert.ok(!('extra' in p));
  });

  test('expanded is capped at 1,000 entries', () => {
    const expanded: Record<string, boolean> = {};
    for (let i = 0; i < 1500; i++) expanded[`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`] = i % 2 === 0;
    assert.equal(Object.keys(normalisePrefs({ expanded }).expanded).length, 1000);
  });

  test('tab style: boxes by default, three known values, anything else becomes boxes', () => {
    assert.equal(normalisePrefs({}).tabStyle, 'boxes');
    for (const v of ['boxes', 'grey', 'tinted']) assert.equal(normalisePrefs({ tabStyle: v }).tabStyle, v);
    for (const v of ['Grey', FREE, 3, null, { a: 1 }]) assert.equal(normalisePrefs({ tabStyle: v }).tabStyle, 'boxes');
  });

  test('menu and spacing: light and comfortable by default, known values kept, others dropped', () => {
    const d = normalisePrefs({});
    assert.deepEqual([d.menu, d.density], ['light', 'comfortable']);
    for (const v of ['light', 'dark']) assert.equal(normalisePrefs({ menu: v }).menu, v);
    for (const v of ['comfortable', 'compact']) assert.equal(normalisePrefs({ density: v }).density, v);
    for (const v of ['Dark', FREE, 3, null]) {
      assert.equal(normalisePrefs({ menu: v }).menu, 'light');
      assert.equal(normalisePrefs({ density: v }).density, 'comfortable');
    }
  });

  test('views: board, status, board, board by default; each known value kept, unknown ones dropped, missing keys filled', () => {
    assert.deepEqual(normalisePrefs({}).views, { work: 'board', workBy: 'status', myTasks: 'board', needsYou: 'board' });
    const all = normalisePrefs({ views: { work: 'list', workBy: 'assignee', myTasks: 'due', needsYou: 'project' } }).views;
    assert.deepEqual(all, { work: 'list', workBy: 'assignee', myTasks: 'due', needsYou: 'project' });
    assert.deepEqual(normalisePrefs({ views: { myTasks: 'project' } }).views, { work: 'board', workBy: 'status', myTasks: 'project', needsYou: 'board' }, 'missing keys filled');
    // A value known to another list is not known to this one.
    assert.deepEqual(normalisePrefs({ views: { work: 'due', workBy: 'list', myTasks: 'status', needsYou: 'due', extra: FREE } }).views, DEFAULT_PREFS.views);
    for (const v of [FREE, 3, null, [], 'board']) assert.deepEqual(normalisePrefs({ views: v }).views, DEFAULT_PREFS.views);
  });

  test('normalising is idempotent', () => {
    const once = normalisePrefs({ theme: 'dark', expanded: { [ID]: false }, timeline: { hiddenKinds: ['stage'] } });
    assert.deepEqual(normalisePrefs(once), once);
  });
});
