import assert from 'node:assert/strict';
import { test } from 'node:test';
import { logoUploadError } from './branding.ts';

test('a logo upload is checked early for its type and size; the server stays the judge', () => {
  assert.equal(logoUploadError({ type: 'image/svg+xml', size: 1000 }), 'Use a PNG or JPEG file.');
  assert.equal(logoUploadError({ type: 'image/gif', size: 1000 }), 'Use a PNG or JPEG file.');
  assert.equal(logoUploadError({ type: 'image/png', size: 524289 }), 'A logo can be at most 512 KB.');
  assert.equal(logoUploadError({ type: 'image/png', size: 524288 }), null);
  assert.equal(logoUploadError({ type: 'image/jpeg', size: 2000 }), null);
});
