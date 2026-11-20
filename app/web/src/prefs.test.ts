import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  ACCENT_KEYS,
  ACCENTS,
  DEFAULT_PREFS,
  THEME_TOKENS,
  contrastRatio,
  expansionDefault,
  moveItem,
  moveSection,
  setHidden,
} from './prefs.ts';

const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

/** The declarations of the rule whose selector is exactly `selector`. */
function rule(selector: string): Record<string, string> {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(?:^|\\n)${esc}\\s*\\{([^}]*)\\}`).exec(css);
  assert.ok(m, `styles.css has a rule for ${selector}`);
  const out: Record<string, string> = {};
  for (const d of m[1].split(';')) {
    const i = d.indexOf(':');
    if (i > 0) out[d.slice(0, i).trim()] = d.slice(i + 1).trim();
  }
  return out;
}

test('contrastRatio matches the WCAG reference values', () => {
  assert.equal(contrastRatio('#000000', '#ffffff'), 21);
  assert.equal(contrastRatio('#fff', '#fff'), 1);
  assert.ok(Math.abs(contrastRatio('#777777', '#ffffff') - 4.48) < 0.01);
});

test('expansion: 6 shown collapses, 5 expands, saved wins', () => {
  assert.equal(expansionDefault(6, undefined), false);
  assert.equal(expansionDefault(5, undefined), true);
  assert.equal(expansionDefault(0, undefined), true);
  assert.equal(expansionDefault(6, true), true);
  assert.equal(expansionDefault(2, false), false);
});

test('moveSection keeps needsYou first', () => {
  const order = ['needsYou', 'myTasks', 'myProjects'];
  assert.deepEqual(moveSection(order, 'needsYou', 'down'), order);
  assert.deepEqual(moveSection(order, 'myTasks', 'up'), order, 'cannot go above needsYou');
  assert.deepEqual(moveSection(order, 'myTasks', 'down'), ['needsYou', 'myProjects', 'myTasks']);
  assert.deepEqual(moveSection(order, 'myProjects', 'up'), ['needsYou', 'myProjects', 'myTasks']);
  assert.deepEqual(moveSection(order, 'myProjects', 'down'), order, 'last stays last');
  assert.equal(moveSection(order, 'myTasks', 'down')[0], 'needsYou');
});

test('moveItem swaps neighbours and ignores unknown keys', () => {
  assert.deepEqual(moveItem(['a', 'b', 'c'], 'b', 'up'), ['b', 'a', 'c']);
  assert.deepEqual(moveItem(['a', 'b', 'c'], 'a', 'up'), ['a', 'b', 'c']);
  assert.deepEqual(moveItem(['a', 'b', 'c'], 'x', 'down'), ['a', 'b', 'c']);
});

test('setHidden hides and shows, but never a fixed key', () => {
  assert.deepEqual(setHidden([], 'b', true, ['a']), ['b']);
  assert.deepEqual(setHidden(['b'], 'b', false, ['a']), []);
  assert.deepEqual(setHidden([], 'a', true, ['a']), []);
  assert.deepEqual(setHidden(['b'], 'b', true, []), ['b']);
});

test('DEFAULT_PREFS has the server shape and values', () => {
  assert.equal(DEFAULT_PREFS.theme, 'light');
  assert.equal(DEFAULT_PREFS.accent, 'teal');
  assert.deepEqual(DEFAULT_PREFS.home, { order: ['needsYou', 'myTasks', 'myProjects'], hidden: [], showCompleted: false, includeArchived: false });
  assert.equal(DEFAULT_PREFS.leadership.fields.order[0], 'name');
  assert.equal(DEFAULT_PREFS.leadership.fields.order.length, 17);
  assert.deepEqual(DEFAULT_PREFS.leadership.fields.hidden, []);
  assert.deepEqual(DEFAULT_PREFS.expanded, {});
  assert.deepEqual(DEFAULT_PREFS.timeline, { hiddenKinds: [] });
});

test('every accent meets 4.5:1 text and 3:1 controls in both themes', () => {
  assert.deepEqual([...ACCENT_KEYS], ['teal', 'blue', 'plum', 'slate']);
  for (const theme of ['light', 'dark'] as const) {
    const { paper, surface } = THEME_TOKENS[theme];
    for (const key of ACCENT_KEYS) {
      const a = ACCENTS[key][theme];
      const where = `${key} ${theme}`;
      for (const bg of [paper, surface]) {
        assert.ok(contrastRatio(a.accent, bg) >= 4.5, `${where}: accent as text on ${bg}`);
        assert.ok(contrastRatio(a.deep, bg) >= 4.5, `${where}: deep as text on ${bg}`);
      }
      assert.ok(contrastRatio(a.accent, surface) >= 3, `${where}: accent as a control`);
      assert.ok(contrastRatio(a.contrast, a.accent) >= 4.5, `${where}: text on the accent`);
      assert.ok(contrastRatio(a.deep, a.wash) >= 4.5, `${where}: text on the wash`);
      assert.ok(contrastRatio(a.accent, a.wash) >= 3, `${where}: accent control on the wash`);
    }
  }
});

test('the fixed surfaces keep readable text and visible marks in both themes', () => {
  for (const theme of ['light', 'dark'] as const) {
    const t = THEME_TOKENS[theme];
    for (const bg of [t.paper, t.surface, t.markerWash, t.marker, t.accentWashStrong, t.mutedWash]) {
      assert.ok(contrastRatio(t.ink, bg) >= 4.5, `${theme}: ink on ${bg}`);
    }
    for (const bg of [t.paper, t.surface]) {
      assert.ok(contrastRatio(t.muted, bg) >= 4.5, `${theme}: muted on ${bg}`);
      assert.ok(contrastRatio(t.rust, bg) >= 4.5, `${theme}: rust on ${bg}`);
      assert.ok(contrastRatio(t.controlBorder, bg) >= 3, `${theme}: control border on ${bg}`);
    }
    assert.ok(contrastRatio(t.rustInk, t.rustWash) >= 4.5, `${theme}: warning text`);
    assert.ok(contrastRatio(t.rustContrast, t.rust) >= 4.5, `${theme}: text on rust`);
    assert.ok(contrastRatio(t.muted, t.mutedWash) >= 4.5, `${theme}: muted on its wash`);
  }
});

test('styles.css agrees with the token values in prefs.ts', () => {
  const baseKeys: Record<string, string> = {
    paper: '--paper', surface: '--surface', ink: '--ink', muted: '--muted', rust: '--rust', rustWash: '--rust-wash', rustInk: '--rust-ink',
    rustContrast: '--rust-contrast', controlBorder: '--control-border', marker: '--marker', markerWash: '--marker-wash',
    accentWashStrong: '--accent-wash-strong', mutedWash: '--muted-wash', markerInk: '--marker-ink',
  };
  const same = (a: string | undefined, b: string) => assert.equal(a?.toLowerCase(), b.toLowerCase());
  for (const theme of ['light', 'dark'] as const) {
    const block = rule(theme === 'light' ? ':root' : '[data-theme="dark"]');
    for (const [k, prop] of Object.entries(baseKeys)) same(block[prop], THEME_TOKENS[theme][k as keyof (typeof THEME_TOKENS)['light']]);
    for (const key of ACCENT_KEYS) {
      const a = ACCENTS[key][theme];
      const r = rule(theme === 'light' ? `[data-accent="${key}"]` : `[data-theme="dark"][data-accent="${key}"]`);
      same(r['--accent'], a.accent);
      same(r['--accent-contrast'], a.contrast);
      same(r['--accent-deep'], a.deep);
      same(r['--accent-wash'], a.wash);
    }
  }
  // The default (teal, light) is in :root too, so the page is right before preferences load.
  const root = rule(':root');
  same(root['--accent'], ACCENTS.teal.light.accent);
  same(root['--accent-contrast'], ACCENTS.teal.light.contrast);
});

test('no colour is hard-coded outside the token blocks, and the AI-proposed rules stay dashed', () => {
  const outside = css.replace(/(?:^|\n)(?::root|\[data-theme="dark"\](?:\[data-accent="\w+"\])?|\[data-accent="\w+"\])\s*\{[^}]*\}/g, '');
  const hard = outside.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(/g);
  assert.equal(hard, null, `hard-coded colours left: ${hard}`);
  assert.match(css, /\.ai-proposed \{[^}]*border: 1px dashed var\(--ink\)/);
  assert.match(css, /\.ai-answer \{[^}]*border: 1px dashed var\(--ink\)/);
  assert.match(css, /\.ai-label\.approved \{[^}]*border-style: solid/);
});

test('saver: saves run in order, the last response wins, and a rollback never undoes a later success', async () => {
  const { createPrefsSaver } = await import('./prefs.ts');
  const shown: string[] = [];
  const calls: string[] = [];
  const gates: Record<string, () => void> = {};
  const fail = new Set<string>();
  const put = (p: typeof DEFAULT_PREFS) =>
    new Promise<typeof DEFAULT_PREFS>((resolve, reject) => {
      calls.push(p.accent);
      gates[p.accent] = () => (fail.has(p.accent) ? reject(new Error('no')) : resolve(p));
    });
  const saver = createPrefsSaver(put, (p) => shown.push(p.accent));
  saver.loaded(DEFAULT_PREFS);
  fail.add('blue');
  const a = saver.save({ ...DEFAULT_PREFS, accent: 'blue' });
  const b = saver.save({ ...DEFAULT_PREFS, accent: 'plum' });
  const aSettled = a.catch(() => 'failed');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls, ['blue'], 'the second save waits for the first');
  gates.blue();
  assert.equal(await aSettled, 'failed');
  await new Promise((r) => setImmediate(r));
  gates.plum();
  await b;
  assert.deepEqual(calls, ['blue', 'plum']);
  assert.equal(shown.at(-1), 'plum', 'the failed first save did not roll back over the later one');

  // A failure of the latest save puts back the last saved copy.
  fail.add('slate');
  const c = saver.save({ ...DEFAULT_PREFS, accent: 'slate' });
  const cSettled = c.catch(() => 'failed');
  await new Promise((r) => setImmediate(r));
  gates.slate();
  assert.equal(await cSettled, 'failed');
  assert.equal(shown.at(-1), 'plum');
});

test('openChoice: a session choice beats the saved one, which beats the default', async () => {
  const { openChoice } = await import('./prefs.ts');
  assert.equal(openChoice({}, {}, 6, 'a'), false);
  assert.equal(openChoice({ a: true }, {}, 6, 'a'), true);
  assert.equal(openChoice({}, { a: true }, 6, 'a'), true);
  assert.equal(openChoice({ a: false }, { a: true }, 3, 'a'), false);
  assert.equal(openChoice({}, {}, 5, 'a'), true);
});
