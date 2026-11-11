import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_NAME, chooseLogo, defaultLogo } from './branding';
import { readImage } from './image';

const none = { wide: false, square: false };
const wideOnly = { wide: true, square: false };
const squareOnly = { wide: false, square: true };
const both = { wide: true, square: true };

test('the header prefers the square logo, then the wide one, then the square default', () => {
  assert.deepEqual(chooseLogo('header', both), { shape: 'square', isDefault: false, box: { width: 32, height: 32 } });
  assert.deepEqual(chooseLogo('header', wideOnly), { shape: 'wide', isDefault: false, box: { width: 96, height: 32 } });
  assert.deepEqual(chooseLogo('header', squareOnly), { shape: 'square', isDefault: false, box: { width: 32, height: 32 } });
  assert.deepEqual(chooseLogo('header', none), { shape: 'square', isDefault: true, box: { width: 32, height: 32 } });
});

test('the tab icon uses the square logo or the square default', () => {
  assert.deepEqual(chooseLogo('tab', both), { shape: 'square', isDefault: false, box: { width: 32, height: 32 } });
  assert.deepEqual(chooseLogo('tab', wideOnly), { shape: 'square', isDefault: true, box: { width: 32, height: 32 } });
  assert.deepEqual(chooseLogo('tab', none), { shape: 'square', isDefault: true, box: { width: 32, height: 32 } });
});

test('sign-in, emails and reports prefer the wide logo', () => {
  assert.deepEqual(chooseLogo('signIn', both), { shape: 'wide', isDefault: false, box: { width: 160, height: 56 } });
  assert.deepEqual(chooseLogo('signIn', squareOnly), { shape: 'square', isDefault: false, box: { width: 72, height: 72 } });
  assert.deepEqual(chooseLogo('signIn', none), { shape: 'wide', isDefault: true, box: { width: 160, height: 56 } });
  for (const place of ['email', 'report'] as const) {
    assert.deepEqual(chooseLogo(place, wideOnly), { shape: 'wide', isDefault: false, box: { width: 120, height: 40 } });
    assert.deepEqual(chooseLogo(place, squareOnly), { shape: 'square', isDefault: false, box: { width: 48, height: 48 } });
    assert.deepEqual(chooseLogo(place, none), { shape: 'wide', isDefault: true, box: { width: 120, height: 40 } });
  }
});

test('Kainow ships a default name and a default logo of each shape', () => {
  assert.equal(DEFAULT_NAME, 'Kainow');
  assert.deepEqual(readImage(defaultLogo('square').content), { mime: 'image/png', width: 128, height: 128 });
  assert.deepEqual(readImage(defaultLogo('wide').content), { mime: 'image/png', width: 240, height: 80 });
});
