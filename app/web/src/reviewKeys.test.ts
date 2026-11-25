import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cardForKey, mayTakeFocus, openingSelection, reviewOwnsKey, stepCard, type KeyTarget } from './reviewKeys.ts';

/** A stand-in element: its tag and the selectors it sits inside. */
const el = (tagName: string, inside: string[] = []): KeyTarget => ({
  tagName,
  closest: (selector: string) => (selector.split(',').some((s) => inside.includes(s.trim())) ? {} : null),
});
const body = el('BODY');
const card = el('ARTICLE');
const outside = el('BUTTON');
const root = { contains: (n: unknown) => n === card };

test('keys from inside the review are its shortcuts', () => {
  assert.equal(reviewOwnsKey(card, root, body, false), true);
});

test('keys from the Ask panel or a dialog are not, even if the panel sits inside the page', () => {
  const askButton = el('BUTTON', ['.ask-panel']);
  const inRoot = { contains: () => true };
  assert.equal(reviewOwnsKey(askButton, inRoot, body, true), false);
  assert.equal(reviewOwnsKey(el('BUTTON', ['[role="dialog"]']), inRoot, body, false), false);
  assert.equal(reviewOwnsKey(el('A', ['dialog']), inRoot, body, false), false);
});

test('keys from elsewhere on the page (header, tabs) are not', () => {
  assert.equal(reviewOwnsKey(outside, root, body, false), false);
});

test('typing in a field is never a shortcut', () => {
  const field = el('TEXTAREA');
  assert.equal(reviewOwnsKey(field, { contains: () => true }, body, false), false);
});

test('a key with nothing focused counts only while no Ask panel is open', () => {
  assert.equal(reviewOwnsKey(body, root, body, false), true);
  assert.equal(reviewOwnsKey(body, root, body, true), false);
});

test('no target or no review root: not a shortcut', () => {
  assert.equal(reviewOwnsKey(null, root, body, false), false);
  assert.equal(reviewOwnsKey(card, null, body, false), false);
});

test('keys from inside a form are not, whatever has focus in it', () => {
  assert.equal(reviewOwnsKey(el('BUTTON', ['form']), { contains: () => true }, body, false), false);
});

test('a key acts on the selected card, and never while focus is in another one', () => {
  assert.equal(cardForKey('a', 'a'), 'a');
  assert.equal(cardForKey(null, 'a'), 'a');
  assert.equal(cardForKey('b', 'a'), null);
  assert.equal(cardForKey(null, null), null);
});

test('j and k move one card from the focused one, or from the selected one, and stop at the ends', () => {
  const ids = ['a', 'b', 'c'];
  assert.equal(stepCard('j', ids, null, 'a'), 'b');
  assert.equal(stepCard('k', ids, null, 'b'), 'a');
  assert.equal(stepCard('j', ids, 'b', 'a'), 'c');
  assert.equal(stepCard('j', ids, null, 'c'), null);
  assert.equal(stepCard('k', ids, null, 'a'), null);
  assert.equal(stepCard('j', ids, null, null), 'a');
  assert.equal(stepCard('k', ids, null, null), null);
});

test('opening a run selects the named proposal, the first when none is named, and nothing when the named one is not there', () => {
  assert.deepEqual(openingSelection(['a', 'b'], 'b', null), { selected: 'b', missing: false });
  assert.deepEqual(openingSelection(['a', 'b'], 'b', 'a'), { selected: 'b', missing: false });
  assert.deepEqual(openingSelection(['a', 'b'], undefined, null), { selected: 'a', missing: false });
  assert.deepEqual(openingSelection(['a', 'b'], undefined, 'b'), { selected: 'b', missing: false });
  assert.deepEqual(openingSelection(['a', 'b'], 'x', 'a'), { selected: null, missing: true });
  assert.deepEqual(openingSelection([], undefined, null), { selected: null, missing: false });
});

test('the named proposal takes focus unless the reader has moved, or is in a form, the Ask panel or a dialog', () => {
  assert.equal(mayTakeFocus(body, false), true);
  assert.equal(mayTakeFocus(null, false), true);
  assert.equal(mayTakeFocus(card, false), true);
  assert.equal(mayTakeFocus(body, true), false);
  assert.equal(mayTakeFocus(el('INPUT'), false), false);
  assert.equal(mayTakeFocus(el('BUTTON', ['form']), false), false);
  assert.equal(mayTakeFocus(el('BUTTON', ['.ask-panel']), false), false);
});
