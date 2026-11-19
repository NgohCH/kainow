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

  test('bad theme falls back to light; bad accent to teal', () => {
    const p = normalisePrefs({ theme: 'neon', accent: 'red' });
    assert.equal(p.theme, 'light');
    assert.equal(p.accent, 'teal');
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

  test('normalising is idempotent', () => {
    const once = normalisePrefs({ theme: 'dark', expanded: { [ID]: false }, timeline: { hiddenKinds: ['stage'] } });
    assert.deepEqual(normalisePrefs(once), once);
  });
});
