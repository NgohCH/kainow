import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  ACCENT_KEYS,
  ACCENTS,
  DEFAULT_PREFS,
  TAB_STYLES,
  TAB_STYLE_LABELS,
  THEME_TOKENS,
  applyAppearance,
  expansionDefault,
  moveItem,
  moveSection,
  schemeChoices,
  resetPrefs,
  schemeFor,
  setHidden,
  tabStyleOf,
  type FixedAccentKey,
  type Prefs,
} from './prefs.ts';
import { contrastRatio, type SchemeTokens } from './ui/colour.ts';
import { MEANINGS, type Meaning } from './ui/meanings.ts';

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

test('resetting puts back only what the panel shows', () => {
  const mine: Prefs = {
    ...DEFAULT_PREFS,
    theme: 'dark', accent: 'plum', accentChosen: true, tabStyle: 'tinted',
    home: { ...DEFAULT_PREFS.home, order: [...DEFAULT_PREFS.home.order].reverse(), hidden: [DEFAULT_PREFS.home.order[1]], showCompleted: true },
    leadership: { fields: { order: ['name'], hidden: ['stage'] } },
    expanded: { home: true },
  };
  const customise = resetPrefs(mine, ['home', 'leadership']);
  assert.deepEqual(customise.home, { ...DEFAULT_PREFS.home, showCompleted: true });
  assert.deepEqual(customise.leadership, DEFAULT_PREFS.leadership);
  assert.deepEqual([customise.theme, customise.accent, customise.accentChosen, customise.tabStyle, customise.expanded], ['dark', 'plum', true, 'tinted', { home: true }]);
  assert.deepEqual(resetPrefs(mine, ['leadership']).home, mine.home);
  const looks = resetPrefs(mine, ['appearance']);
  assert.deepEqual([looks.theme, looks.accent, looks.accentChosen, looks.tabStyle, looks.home], ['light', 'red', false, 'boxes', mine.home]);
});

test('preferences without a tab style show boxes', () => {
  const { tabStyle: _none, ...older } = DEFAULT_PREFS;
  assert.equal(tabStyleOf(older as Prefs), 'boxes');
  assert.equal(tabStyleOf({ ...DEFAULT_PREFS, tabStyle: 'grey' }), 'grey');
});

test('contrastRatio matches the WCAG reference values', () => {
  assert.equal(contrastRatio('#000000', '#ffffff'), 21);
  assert.equal(contrastRatio('#ffffff', '#ffffff'), 1);
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
  assert.equal(DEFAULT_PREFS.accent, 'red');
  assert.equal(DEFAULT_PREFS.accentChosen, false);
  assert.equal(DEFAULT_PREFS.tabStyle, 'boxes');
  assert.deepEqual(DEFAULT_PREFS.home, { order: ['needsYou', 'myTasks', 'myProjects'], hidden: [], showCompleted: false, includeArchived: false });
  assert.equal(DEFAULT_PREFS.leadership.fields.order[0], 'name');
  assert.equal(DEFAULT_PREFS.leadership.fields.order.length, 17);
  assert.deepEqual(DEFAULT_PREFS.leadership.fields.hidden, []);
  assert.deepEqual(DEFAULT_PREFS.expanded, {});
  assert.deepEqual(DEFAULT_PREFS.timeline, { hiddenKinds: [] });
});

const FIXED = Object.keys(ACCENTS) as FixedAccentKey[];

test('every scheme meets 4.5:1 text and 3:1 controls in both themes', () => {
  assert.deepEqual([...ACCENT_KEYS], ['red', 'teal', 'blue', 'plum', 'slate', 'organisation']);
  assert.deepEqual(FIXED, ['red', 'teal', 'blue', 'plum', 'slate']);
  for (const theme of ['light', 'dark'] as const) {
    const { paper, surface } = THEME_TOKENS[theme];
    for (const key of FIXED) {
      const a = ACCENTS[key][theme];
      const where = `${key} ${theme}`;
      for (const bg of [paper, surface]) {
        assert.ok(contrastRatio(a.accent, bg) >= 4.5, `${where}: accent as text on ${bg}`);
        assert.ok(contrastRatio(a.accentDeep, bg) >= 4.5, `${where}: deep as text on ${bg}`);
      }
      assert.ok(contrastRatio(a.accent, surface) >= 3, `${where}: accent as a control`);
      assert.ok(contrastRatio(a.accentContrast, a.accent) >= 4.5, `${where}: text on the accent`);
      assert.ok(contrastRatio(a.accentDeep, a.accentWash) >= 4.5, `${where}: text on the wash`);
      assert.ok(contrastRatio(a.accent, a.accentWash) >= 3, `${where}: accent control on the wash`);
      assert.ok(contrastRatio(a.menuInk, a.menu) >= 4.5, `${where}: menu text on the menu`);
      assert.ok(contrastRatio(a.menuInk, a.menuActive) >= 4.5, `${where}: menu text on the active item`);
      assert.ok(contrastRatio(a.menuActive, a.menu) >= 1.2, `${where}: the active item shows against the menu`);
    }
  }
});

test('the Red scheme: accent #b0182e, menu #4a0912 or darker', () => {
  assert.equal(ACCENTS.red.light.accent, '#b0182e');
  assert.ok(contrastRatio(ACCENTS.red.light.menu, '#000000') >= contrastRatio('#4a0912', '#000000'));
});

test('schemeFor: red until chosen, the organisation colour when set, a chosen scheme wins', () => {
  assert.equal(schemeFor({ ...DEFAULT_PREFS }, null).key, 'red');
  assert.equal(schemeFor({ ...DEFAULT_PREFS }, '#1f55a8').key, 'organisation');
  assert.equal(schemeFor({ ...DEFAULT_PREFS, accent: 'teal', accentChosen: true }, '#1f55a8').key, 'teal');
  assert.equal(schemeFor({ ...DEFAULT_PREFS }, '#ffd84a').key, 'red', 'an unusable organisation colour is not used');
  assert.equal(schemeFor({ ...DEFAULT_PREFS, accent: 'organisation', accentChosen: true }, '#1f55a8').key, 'organisation');
  assert.equal(schemeFor({ ...DEFAULT_PREFS, accent: 'teal', accentChosen: true }, null).tokens, ACCENTS.teal.light);
});

test('schemeFor falls back to red', () => {
  const chosen = { ...DEFAULT_PREFS, accent: 'organisation' as const, accentChosen: true };
  assert.equal(schemeFor(chosen, null).key, 'red');
  assert.equal(schemeFor(chosen, '#ffd84a').key, 'red');
  assert.equal(schemeFor(chosen, null).tokens, ACCENTS.red.light);
});

test('the organisation scheme is readable in both themes', () => {
  for (const theme of ['light', 'dark'] as const) {
    const { paper, surface } = THEME_TOKENS[theme];
    for (const colour of ['#1f55a8', '#b0182e', '#0c6a6e', '#2a1a6a']) {
      const { key, tokens: a } = schemeFor({ ...DEFAULT_PREFS, theme }, colour);
      const where = `${colour} ${theme}`;
      assert.equal(key, 'organisation', where);
      for (const bg of [paper, surface]) {
        assert.ok(contrastRatio(a.accent, bg) >= 4.5, `${where}: accent on ${bg}`);
        assert.ok(contrastRatio(a.accentDeep, bg) >= 4.5, `${where}: deep on ${bg}`);
      }
      assert.ok(contrastRatio(a.accentContrast, a.accent) >= 4.5, `${where}: text on the accent`);
      assert.ok(contrastRatio(a.accentDeep, a.accentWash) >= 4.5, `${where}: text on the wash`);
      assert.ok(contrastRatio(a.menuInk, a.menu) >= 4.5, `${where}: menu text`);
      assert.ok(contrastRatio(a.menuInk, a.menuActive) >= 4.5, `${where}: menu text on the active item`);
    }
  }
});

test('applyAppearance sets the theme and scheme, and only sets variables for the organisation scheme', () => {
  const props = new Map<string, string>();
  const attrs = new Map<string, string>();
  const root = {
    setAttribute: (k: string, v: string) => attrs.set(k, v),
    style: { setProperty: (k: string, v: string) => props.set(k, v), removeProperty: (k: string) => props.delete(k) },
  } as unknown as HTMLElement;
  applyAppearance({ ...DEFAULT_PREFS }, '#1f55a8', root);
  assert.equal(attrs.get('data-tabs'), 'boxes');
  assert.equal(attrs.get('data-accent'), 'organisation');
  assert.equal(props.get('--menu-ink'), '#ffffff');
  assert.equal(props.get('--accent'), '#1f55a8');
  applyAppearance({ ...DEFAULT_PREFS, theme: 'dark', accent: 'plum', accentChosen: true, tabStyle: 'tinted' }, '#1f55a8', root);
  assert.equal(attrs.get('data-tabs'), 'tinted');
  assert.equal(attrs.get('data-theme'), 'dark');
  assert.equal(attrs.get('data-accent'), 'plum');
  assert.equal(props.size, 0, 'the organisation values were removed');
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
    for (const key of FIXED) {
      const a = ACCENTS[key][theme];
      const r = rule(theme === 'light' ? `[data-accent="${key}"]` : `[data-theme="dark"][data-accent="${key}"]`);
      same(r['--menu'], a.menu);
      same(r['--menu-ink'], a.menuInk);
      same(r['--menu-active'], a.menuActive);
      same(r['--accent'], a.accent);
      same(r['--accent-contrast'], a.accentContrast);
      same(r['--accent-deep'], a.accentDeep);
      same(r['--accent-wash'], a.accentWash);
    }
  }
  // The default (red, light) is in :root too, so the page is right before preferences load.
  const root = rule(':root');
  same(root['--accent'], ACCENTS.red.light.accent);
  same(root['--accent-contrast'], ACCENTS.red.light.accentContrast);
  same(root['--menu'], ACCENTS.red.light.menu);
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

test('schemeChoices: the five fixed schemes, and Organisation only when its colour is usable', () => {
  assert.deepEqual(schemeChoices('light', null).map((c) => c.label), ['Red', 'Teal', 'Blue', 'Plum', 'Slate']);
  assert.deepEqual(schemeChoices('light', '#ffd84a').map((c) => c.key), ['red', 'teal', 'blue', 'plum', 'slate'], 'an unusable colour is not offered');
  const withOrg = schemeChoices('dark', '#1f55a8');
  assert.deepEqual(withOrg.map((c) => c.label), ['Red', 'Teal', 'Blue', 'Plum', 'Slate', 'Organisation']);
  assert.equal(withOrg[0].swatch, ACCENTS.red.dark.accent);
  assert.equal(withOrg[5].swatch, schemeFor({ theme: 'dark', accent: 'organisation', accentChosen: true }, '#1f55a8').tokens.accent);
});

test('the scheme shown as chosen is the one applied while the person has not chosen', () => {
  // A stored document from before accentChosen holds accent "teal" that the person never picked: Red (or Organisation) shows.
  const unchosen = { ...DEFAULT_PREFS, accent: 'teal' as const, accentChosen: false };
  assert.equal(schemeFor(unchosen, null).key, 'red');
  assert.equal(schemeFor(unchosen, '#1f55a8').key, 'organisation');
});

// ---- Tab styles (D135) ----

const tabRule = (style: string, rest: string) => rule(`:is([data-tabs="${style}"] .binder-tabs, .tabs-${style}) ${rest}`);

/** Every scheme in both themes, with the organisation scheme of some colours. */
function schemes(): { where: string; theme: 'light' | 'dark'; colour: (cssValue: string) => string }[] {
  const out = [];
  for (const theme of ['light', 'dark'] as const) {
    const t = THEME_TOKENS[theme];
    const all: [string, SchemeTokens][] = FIXED.map((k) => [k, ACCENTS[k][theme]]);
    for (const c of ['#1f55a8', '#b0182e', '#0c6a6e', '#2a1a6a']) all.push([`organisation ${c}`, schemeFor({ ...DEFAULT_PREFS, theme }, c).tokens]);
    for (const [name, a] of all) {
      const vars: Record<string, string> = {
        '--paper': t.paper, '--surface': t.surface, '--ink': t.ink, '--muted': t.muted, '--muted-wash': t.mutedWash, '--control-border': t.controlBorder,
        '--accent': a.accent, '--accent-contrast': a.accentContrast, '--accent-deep': a.accentDeep, '--accent-wash': a.accentWash,
      };
      out.push({
        where: `${name} ${theme}`,
        theme,
        colour: (value: string) => {
          const v = /var\((--[\w-]+)\)/.exec(value)?.[1];
          assert.ok(v && vars[v], `a known colour token in "${value}"`);
          return vars[v];
        },
      });
    }
  }
  return out;
}

test('tab styles: three, boxes first, each with a plain name', () => {
  assert.deepEqual([...TAB_STYLES], ['boxes', 'grey', 'tinted']);
  assert.deepEqual(TAB_STYLES.map((s) => TAB_STYLE_LABELS[s]), ['Boxes', 'Grey dividers', 'Tinted dividers']);
});

test('tab styles: text 4.5:1 and edges 3:1 in every scheme, Light and Dark', () => {
  for (const style of TAB_STYLES) {
    const closed = tabRule(style, '.tab');
    const open = { ...closed, ...tabRule(style, '.tab.open') };
    for (const { where, colour } of schemes()) {
      const at = `${style}, ${where}`;
      const page = colour('var(--paper)');
      for (const [state, d] of [['closed', closed], ['open', open]] as const) {
        assert.ok(contrastRatio(colour(d.color), colour(d.background)) >= 4.5, `${at}: ${state} text`);
        assert.ok(contrastRatio(colour(d['border-color']), page) >= 3, `${at}: ${state} edge against the page`);
      }
      assert.ok(contrastRatio(colour(closed['border-color']), colour(closed.background)) >= 3, `${at}: closed edge against its tab`);
      if (open['border-top-color']) assert.ok(contrastRatio(colour(open['border-top-color']), page) >= 3, `${at}: open top edge`);
      if (style !== 'boxes') assert.ok(contrastRatio(colour(tabRule(style, '.tab-slot::after')['border-bottom']), page) >= 3, `${at}: the line below`);
    }
  }
});

test('tab styles: the count badge reads, and stands out from an open and a closed tab, in every scheme', () => {
  assert.equal(rule('.tab-badge').border, '1px solid currentColor', 'the badge has its own edge');
  for (const style of TAB_STYLES) {
    const closed = tabRule(style, '.tab');
    const open = { ...closed, ...tabRule(style, '.tab.open') };
    for (const { where, theme, colour } of schemes()) {
      for (const m of Object.keys(MEANINGS) as Meaning[]) {
        const strong = MEANINGS[m].strong[theme];
        const wash = MEANINGS[m].wash[theme];
        assert.ok(contrastRatio(strong, wash) >= 4.5, `${m} ${theme}: badge number`);
        for (const d of [closed, open]) {
          const tab = colour(d.background);
          assert.ok(Math.max(contrastRatio(strong, tab), contrastRatio(wash, tab)) >= 3, `${style}, ${where}, ${m}: badge against its tab`);
        }
      }
    }
  }
});

test('tab styles: the open tab differs by weight and by size or edge, not colour alone', () => {
  for (const style of TAB_STYLES) {
    assert.equal(tabRule(style, '.tab.open')['font-weight'], '700', `${style}: weight`);
    assert.notEqual(rule('.tab')['font-weight'], '700', `${style}: a closed tab is not bold`);
    assert.equal(tabRule(style, '.tab')['border-width'], style === 'boxes' ? '2px' : '2px 2px 0', `${style}: strong edge`);
  }
  assert.notEqual(tabRule('boxes', '.tab.open').padding, tabRule('boxes', '.tab').padding, 'boxes: larger');
  assert.notEqual(tabRule('grey', '.tab.open').padding, tabRule('grey', '.tab').padding, 'grey: taller');
  assert.equal(tabRule('tinted', '.tab.open')['border-top-width'], '6px', 'tinted: a thick top edge');
  assert.equal(tabRule('boxes', '.tab')['border-radius'], '8px');
  assert.match(css, /@media \(forced-colors: active\) \{[^@]*\.tab\.open/, 'forced colours mark the open tab');
});

test('menu, spacing and view choices have the server defaults and read an older document', async () => {
  const { menuOf, densityOf, viewsOf } = await import('./prefs.ts');
  assert.equal(DEFAULT_PREFS.menu, 'light');
  assert.equal(DEFAULT_PREFS.density, 'comfortable');
  assert.deepEqual(DEFAULT_PREFS.views, { work: 'board', workBy: 'status', myTasks: 'board', needsYou: 'board' });
  assert.equal(menuOf({}), 'light');
  assert.equal(menuOf({ menu: 'dark' }), 'dark');
  assert.equal(densityOf({}), 'comfortable');
  assert.equal(densityOf({ density: 'compact' }), 'compact');
  assert.deepEqual(viewsOf({}), DEFAULT_PREFS.views);
  assert.deepEqual(viewsOf({ views: { work: 'list' } }), { ...DEFAULT_PREFS.views, work: 'list' });
  assert.deepEqual(viewsOf({ views: { myTasks: 'nonsense' as never, needsYou: 'project' } }), { ...DEFAULT_PREFS.views, needsYou: 'project' });
});
