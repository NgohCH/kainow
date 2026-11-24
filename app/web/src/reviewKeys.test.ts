import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reviewOwnsKey, type KeyTarget } from './reviewKeys.ts';

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
