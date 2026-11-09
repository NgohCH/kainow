import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { jpegHeader, pngHeader } from '../testing/images';
import { seedUser } from '../testing/projects';

/** The wide and square logos, and the branding everyone (signed in or not) sees. */
describe('logos and branding', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let admin: Client;

  beforeEach(async () => {
    t = await startTestApp(undefined, { organisation: false });
    await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    admin = await t.signIn('admin@example.org');
  });
  afterEach(async () => {
    await t?.close();
  });

  const finishSetup = async () => {
    await admin.request('POST', '/organisation/name', { name: 'Example Organisation' });
    await admin.request('POST', '/domains', { domain: 'example.org' });
    await admin.request('POST', '/departments', { name: 'Operations' });
    assert.equal((await admin.request('POST', '/organisation/finish', {})).status, 200);
  };
  const branding = async () => (await t.anonymous('GET', '/organisation/branding')).body;
  const image = (shape: string, etag?: string) => fetch(`${t.base}/organisation/logo/${shape}`, { headers: etag ? { 'If-None-Match': etag } : {} });

  test('uploads are checked by their contents, size and shape', async () => {
    const put = (shape: string, body: Buffer, type = 'image/png') => admin.upload('PUT', `/organisation/logos/${shape}`, body, type);
    assert.equal((await put('square', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).body.message, 'Use a PNG or JPEG file.');
    assert.equal((await put('square', pngHeader(64, 64, 524289))).body.message, 'A logo can be at most 512 KB.');
    assert.equal((await put('square', pngHeader(100, 90))).body.message, 'A square logo must be square and at least 64 × 64 pixels.');
    assert.equal((await put('wide', pngHeader(79, 40))).body.message, 'A wide logo must be 2 to 6 times as wide as it is high and at least 40 pixels high.');
    assert.equal((await put('round', pngHeader(64, 64))).status, 404);
    const ok = await put('wide', jpegHeader(120, 40), 'image/jpeg');
    assert.equal(ok.status, 200);
    assert.deepEqual([ok.body.logo.width, ok.body.logo.height, ok.body.logo.byteSize], [120, 40, 64]);
    const audit = (await t.pool.query(`SELECT detail FROM audit_events WHERE action = 'organisation.logo_set'`)).rows;
    assert.deepEqual(audit.map((r) => r.detail), [{ shape: 'wide', byteSize: 64, width: 120, height: 40 }], 'the audit names the logo, never its bytes');
  });

  test('a member cannot change the logos', async () => {
    await seedUser(t.pool, 'member@example.org');
    const member = await t.signIn('member@example.org');
    assert.equal((await member.upload('PUT', '/organisation/logos/square', pngHeader(64, 64), 'image/png')).status, 403);
  });

  test('before Finish setup everyone sees Kainow and its default logos, even with logos uploaded', async () => {
    await admin.upload('PUT', '/organisation/logos/square', pngHeader(64, 64), 'image/png');
    await admin.request('POST', '/organisation/name', { name: 'Example Organisation' });
    const b = await branding();
    assert.deepEqual([b.registered, b.name], [false, 'Kainow']);
    assert.ok(Object.values(b.places).every((p: any) => p.isDefault));
    // The administrator can still preview what was uploaded.
    const preview = await fetch(`${t.base}/organisation/logos/square/preview`, { headers: { Cookie: '' } });
    assert.equal(preview.status, 401, 'the preview is for administrators only');
    assert.equal((await image('square')).headers.get('etag'), '"default"', 'the public image is still the default');
  });

  test('after Finish setup the organisation name and its logos replace the defaults; a missing shape keeps its default', async () => {
    await admin.upload('PUT', '/organisation/logos/wide', pngHeader(120, 40), 'image/png');
    await finishSetup();
    const b = await branding();
    assert.deepEqual([b.registered, b.name], [true, 'Example Organisation']);
    assert.deepEqual(b.places.header, { url: b.places.header.url, width: 96, height: 32, isDefault: false });
    assert.match(b.places.header.url, /^\/organisation\/logo\/wide\?v=/);
    assert.equal(b.places.tab.isDefault, true, 'the tab icon needs a square logo');
    assert.equal(b.places.signIn.isDefault, false);
    const wide = await image('wide');
    assert.deepEqual([wide.status, wide.headers.get('content-type'), (await wide.arrayBuffer()).byteLength], [200, 'image/png', 64]);
  });

  test('removing a logo brings its default back', async () => {
    await admin.upload('PUT', '/organisation/logos/square', pngHeader(64, 64), 'image/png');
    await finishSetup();
    assert.equal((await branding()).places.header.isDefault, false);
    assert.equal((await admin.request('POST', '/organisation/logos/square/remove', {})).status, 200);
    assert.equal((await branding()).places.header.isDefault, true);
    assert.equal((await t.pool.query(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'organisation.logo_removed'`)).rows[0].n, 1);
  });

  test('the image route serves what the branding names, with a matching type and version', async () => {
    await admin.upload('PUT', '/organisation/logos/square', pngHeader(64, 64), 'image/png');
    await finishSetup();
    const first = await image('square');
    const etag = first.headers.get('etag') as string;
    assert.equal((await image('square', etag)).status, 304);
    t.clock.advanceSeconds(60);
    await admin.upload('PUT', '/organisation/logos/square', jpegHeader(80, 80), 'image/jpeg');
    const second = await image('square', etag);
    assert.deepEqual([second.status, second.headers.get('content-type')], [200, 'image/jpeg']);
    assert.notEqual(second.headers.get('etag'), etag);
    assert.ok((await branding()).places.header.url.endsWith(`v=${JSON.parse(second.headers.get('etag') as string)}`));
  });
});
