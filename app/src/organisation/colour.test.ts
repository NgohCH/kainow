import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { COLOUR_TOO_LIGHT, contrastRatio, deriveScheme } from './colour';

describe('organisation colour', () => {
  test('contrastRatio follows WCAG', () => {
    assert.ok(Math.abs(contrastRatio('#ffffff', '#000000') - 21) < 0.01);
    assert.ok(Math.abs(contrastRatio('#000000', '#ffffff') - 21) < 0.01);
    assert.ok(Math.abs(contrastRatio('#777777', '#777777') - 1) < 0.01);
  });

  test('deriveScheme makes a scheme from a dark enough colour', () => {
    const r = deriveScheme('#b0182e');
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.scheme.accent, '#b0182e');
    assert.equal(r.scheme.menuActive, '#b0182e');
    assert.equal(r.scheme.menuInk, '#ffffff');
    assert.equal(r.scheme.accentContrast, '#ffffff');
    assert.ok(contrastRatio('#ffffff', r.scheme.menu) >= 4.5);
    assert.ok(contrastRatio('#ffffff', r.scheme.accentDeep) > contrastRatio('#ffffff', r.scheme.accent));
    assert.ok(contrastRatio('#ffffff', r.scheme.accentWash) < 1.3, 'the wash is nearly white');
  });

  test('a very dark colour still shows which menu item is current', () => {
    for (const hex of ['#1a0f40', '#000000', '#111111', '#0a1f44']) {
      const r = deriveScheme(hex);
      assert.equal(r.ok, true, hex);
      if (!r.ok) return;
      assert.equal(r.scheme.accent, hex);
      assert.ok(contrastRatio(r.scheme.menu, r.scheme.menuActive) >= 1.5, `${hex}: ${r.scheme.menu} and ${r.scheme.menuActive}`);
      assert.ok(contrastRatio('#ffffff', r.scheme.menuActive) >= 4.5, hex);
    }
  });

  test('deriveScheme rejects low contrast', () => {
    assert.deepEqual(deriveScheme('#ffd84a'), { ok: false, reason: COLOUR_TOO_LIGHT });
    assert.equal(COLOUR_TOO_LIGHT, 'This colour is too light for white text on buttons. Choose a darker shade.');
  });

  test('deriveScheme is case-insensitive and refuses what is not a colour', () => {
    const r = deriveScheme('#0C6A6E');
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.scheme.accent, '#0c6a6e');
    assert.equal(deriveScheme('red').ok, false);
  });
});
