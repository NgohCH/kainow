import assert from 'node:assert/strict';
import { test } from 'node:test';
import { badgeText, bellLabel } from './notifications.ts';

test('bellLabel carries the unread count in words', () => {
  assert.equal(bellLabel(0), 'Notifications');
  assert.equal(bellLabel(1), 'Notifications, 1 unread');
  assert.equal(bellLabel(7), 'Notifications, 7 unread');
  assert.equal(bellLabel(99), 'Notifications, 99 unread');
  assert.equal(bellLabel(100), 'Notifications, 99+ unread');
});

test('badgeText is empty for none and caps at 99+', () => {
  assert.equal(badgeText(0), null);
  assert.equal(badgeText(1), '1');
  assert.equal(badgeText(99), '99');
  assert.equal(badgeText(120), '99+');
});
