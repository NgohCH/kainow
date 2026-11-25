import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Branding, logoUploadError, memberOf, previewPlaces } from './branding.ts';

test('what the server refuses until setup is finished is asked for only then: preferences load after Finish setup', () => {
  const user = { id: 'u' };
  const branding = { registered: false, name: 'Kainow', colour: null, places: {} } as unknown as Branding;
  assert.equal(memberOf(user, false, null), null, 'not before the organisation has been read');
  assert.equal(memberOf(user, true, branding), null, 'not while it is being set up');
  assert.equal(memberOf(user, true, { ...branding, registered: true }), user, 'Finish setup reads the organisation again, and now they are');
  assert.equal(memberOf(user, true, null), user, 'the organisation could not be read: the server decides');
  assert.equal(memberOf(null, true, { ...branding, registered: true }), null);
  assert.equal(memberOf(undefined, true, { ...branding, registered: true }), null);
});

test('a logo upload is checked early for its type and size; the server stays the judge', () => {
  assert.equal(logoUploadError({ type: 'image/svg+xml', size: 1000 }), 'Use a PNG or JPEG file.');
  assert.equal(logoUploadError({ type: 'image/gif', size: 1000 }), 'Use a PNG or JPEG file.');
  assert.equal(logoUploadError({ type: 'image/png', size: 524289 }), 'A logo can be at most 512 KB.');
  assert.equal(logoUploadError({ type: 'image/png', size: 524288 }), null);
  assert.equal(logoUploadError({ type: 'image/jpeg', size: 2000 }), null);
});

test('each logo is previewed in the boxes of the places it appears in', () => {
  assert.deepEqual(previewPlaces('wide'), [
    { label: 'Sign-in page', width: 160, height: 56 },
    { label: 'Emails and reports', width: 120, height: 40 },
    { label: 'Page header, when there is no square logo', width: 96, height: 32 },
  ]);
  assert.deepEqual(previewPlaces('square'), [
    { label: 'Page header and browser tab', width: 32, height: 32 },
    { label: 'Sign-in page, when there is no wide logo', width: 72, height: 72 },
    { label: 'Emails and reports, when there is no wide logo', width: 48, height: 48 },
  ]);
});
