import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ACCENTS, THEME_TOKENS } from '../prefs.ts';
import { contrastRatio } from './colour.ts';
import { MEANINGS, projectMeaning, type Meaning } from './meanings.ts';

const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
const names = Object.keys(MEANINGS) as Meaning[];
const kebab = (m: string) => m.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());

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

test('every meaning has a symbol and a word', () => {
  assert.equal(names.length, 13);
  for (const m of names) {
    assert.ok(MEANINGS[m].symbol.length > 0, `${m}: symbol`);
    assert.ok(MEANINGS[m].word.length > 0, `${m}: word`);
  }
  assert.deepEqual(
    names.map((m) => MEANINGS[m].word),
    ['Draft', 'Planned', 'Active', 'Deferred', 'Closed', 'Overdue', 'Needs review', 'Blocked', 'Due soon', 'Set up', 'Needs attention', 'Failing', 'Not in use'],
  );
});

test('every meaning reads on its wash and on the surface, in both themes', () => {
  for (const theme of ['light', 'dark'] as const) {
    const { surface, paper } = THEME_TOKENS[theme];
    for (const m of names) {
      const { strong, wash } = MEANINGS[m];
      assert.ok(contrastRatio(strong[theme], wash[theme]) >= 4.5, `${m} ${theme}: strong on wash`);
      assert.ok(contrastRatio(strong[theme], surface) >= 4.5, `${m} ${theme}: strong on surface`);
      assert.ok(contrastRatio(strong[theme], paper) >= 4.5, `${m} ${theme}: strong on paper`);
    }
  }
});

test('the Red menu never looks like an Overdue box (light theme; in dark both are dark, so the symbol, word and edge tell them apart)', () => {
  assert.ok(contrastRatio(ACCENTS.red.light.menu, MEANINGS.overdue.wash.light) >= 3);
});

test('a project status shows its own meaning', () => {
  for (const s of ['draft', 'planned', 'active', 'deferred', 'closed'] as const) assert.equal(projectMeaning(s), s);
});

test('styles.css agrees with MEANINGS', () => {
  for (const theme of ['light', 'dark'] as const) {
    const block = rule(theme === 'light' ? ':root' : '[data-theme="dark"]');
    for (const m of names) {
      assert.equal(block[`--m-${kebab(m)}`]?.toLowerCase(), MEANINGS[m].strong[theme], `${m} ${theme} strong`);
      assert.equal(block[`--m-${kebab(m)}-wash`]?.toLowerCase(), MEANINGS[m].wash[theme], `${m} ${theme} wash`);
    }
  }
});
