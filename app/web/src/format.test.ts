import assert from 'node:assert/strict';
import { test } from 'node:test';
import { noticesStartLine } from './format.ts';

test('the notices start line shows the stored time in UTC+8', () => {
  assert.equal(noticesStartLine('2026-11-10T01:30:00Z'), 'Notices start from Tue 10 Nov 2026, 09:30 (UTC+8)');
  assert.equal(noticesStartLine('2026-11-09T17:05:00Z'), 'Notices start from Tue 10 Nov 2026, 01:05 (UTC+8)');
});
