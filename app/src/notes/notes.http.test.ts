import 'reflect-metadata';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { createApp } from '../bootstrap';
import { loadConfig } from '../config';
import { runMigrations } from '../db/migrate';
import { SKIP_NO_DB, resetPublicSchema, testDatabaseUrl } from '../testing/db';
import { CaptureSender, FakeClock, testEnv } from '../testing/fakes';
import { makeDocx, makePdf, makeZip } from '../testing/files';
import { UsersService } from '../users/users.service';
import { MAX_TEXT_CHARS, MAX_UPLOAD_BYTES } from './text';

const EMAIL = 'admin@example.org';

describe('notes intake over HTTP', { skip: SKIP_NO_DB }, () => {
  let app: INestApplication;
  let pool: Pool;
  let base: string;
  let cookie: string;
  let csrf: string;

  beforeEach(async () => {
    const sender = new CaptureSender();
    const clock = new FakeClock(Date.UTC(2026, 10, 9, 2, 0, 0));
    const config = loadConfig(testEnv(testDatabaseUrl() as string));
    pool = new Pool({ connectionString: config.databaseUrl });
    await resetPublicSchema(pool);
    await runMigrations(pool, config.migrationsDir);
    await new UsersService(pool, clock.now).create({ email: EMAIL, displayName: 'Admin' });
    app = await createApp(config, { codeSender: sender, clock: clock.now, logger: false });
    await app.listen(0);
    base = await app.getUrl();
    await fetch(`${base}/auth/request-code`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: EMAIL }) });
    const verify = await fetch(`${base}/auth/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, code: sender.lastCode(EMAIL) }),
    });
    cookie = (verify.headers.getSetCookie()[0] ?? '').split(';')[0];
    csrf = ((await verify.json()) as { csrfToken: string }).csrfToken;
  });
  afterEach(async () => {
    await app?.close();
    await pool?.end();
  });

  async function json(method: string, path: string, body?: unknown, signedIn = true): Promise<{ status: number; body: any }> {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(signedIn ? { Cookie: cookie, 'X-CSRF-Token': csrf } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  }

  async function upload(path: string, filename: string, bytes: Buffer, title?: string): Promise<{ status: number; body: any }> {
    const form = new FormData();
    if (title !== undefined) form.set('title', title);
    form.set('file', new Blob([new Uint8Array(bytes)]), filename);
    const res = await fetch(`${base}${path}`, { method: 'POST', headers: { Cookie: cookie, 'X-CSRF-Token': csrf }, body: form });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  }

  test('every notes route needs a signed-in person', async () => {
    const id = '0197c3a0-0000-7000-8000-000000000000';
    assert.equal((await json('POST', '/notes', { title: 't', text: 'x' }, false)).status, 401);
    assert.equal((await json('GET', '/notes', undefined, false)).status, 401);
    assert.equal((await json('GET', `/notes/${id}`, undefined, false)).status, 401);
    assert.equal((await json('POST', `/notes/${id}/versions`, { text: 'x' }, false)).status, 401);
    assert.equal((await json('GET', `/notes/${id}/versions/1`, undefined, false)).status, 401);
    assert.equal((await json('GET', `/notes/${id}/versions/1/original`, undefined, false)).status, 401);
    const form = new FormData();
    form.set('file', new Blob(['hello']), 'a.txt');
    assert.equal((await fetch(`${base}/notes/upload`, { method: 'POST', body: form })).status, 401);
  });

  test('pasted notes are stored as normalised version 1 and can be read back', async () => {
    const created = await json('POST', '/notes', { title: '  Weekly sync ', text: 'Ali: ship Friday\r\nSam: café' });
    assert.equal(created.status, 201);
    assert.equal(created.body.source.title, 'Weekly sync');
    assert.equal(created.body.version.versionNo, 1);
    assert.equal(created.body.version.origin, 'paste');
    assert.equal(created.body.version.charCount, 'Ali: ship Friday\nSam: café'.length);
    assert.equal(created.body.version.text, undefined, 'the summary does not echo the text');

    const sourceId = created.body.source.id;
    const v = await json('GET', `/notes/${sourceId}/versions/1`);
    assert.equal(v.body.version.text, 'Ali: ship Friday\nSam: café');
    const one = await json('GET', `/notes/${sourceId}`);
    assert.equal(one.body.versions.length, 1);
    const list = await json('GET', '/notes');
    assert.deepEqual(list.body.sources.map((s: any) => [s.title, s.latestVersion, s.versionCount]), [['Weekly sync', 1, 1]]);
  });

  test('a changed text is a new version, an identical one is refused, and old versions stay as they were', async () => {
    const { body } = await json('POST', '/notes', { title: 'T', text: 'first' });
    const id = body.source.id;
    const v2 = await json('POST', `/notes/${id}/versions`, { text: 'second' });
    assert.equal(v2.status, 201);
    assert.equal(v2.body.version.versionNo, 2);
    assert.equal((await json('POST', `/notes/${id}/versions`, { text: 'second\r\n'.trimEnd() })).status, 409);
    assert.equal((await json('GET', `/notes/${id}/versions/1`)).body.version.text, 'first');
    assert.equal((await json('GET', `/notes/${id}/versions/2`)).body.version.text, 'second');
    assert.equal((await json('GET', `/notes/${id}/versions/3`)).status, 404);
  });

  test('two people adding a version at the same moment get different numbers', async () => {
    const { body } = await json('POST', '/notes', { title: 'T', text: 'base' });
    const id = body.source.id;
    const results = await Promise.all(['a', 'b', 'c', 'd'].map((t) => json('POST', `/notes/${id}/versions`, { text: t })));
    assert.ok(results.every((r) => r.status === 201));
    assert.deepEqual(results.map((r) => r.body.version.versionNo).sort(), [2, 3, 4, 5]);
  });

  test('uploads of text, Markdown, Word and PDF files all work, and the original is kept byte for byte', async () => {
    const files: Array<[string, Buffer, RegExp]> = [
      ['sync.txt', Buffer.from('Plain notes\r\nline two'), /^Plain notes\nline two$/],
      ['sync.md', Buffer.from('# Sync\n- a'), /^# Sync\n- a$/],
      ['sync.docx', makeDocx(['We agreed to ship on Friday.']), /We agreed to ship on Friday\./],
      ['sync.pdf', makePdf(['Ali will email Sam.']), /Ali will email Sam\./],
    ];
    for (const [name, bytes, re] of files) {
      const created = await upload('/notes/upload', name, bytes);
      assert.equal(created.status, 201, `${name}: ${JSON.stringify(created.body)}`);
      assert.equal(created.body.source.title, name.replace(/\.[^.]+$/, ''));
      const { id } = created.body.source;
      const text = (await json('GET', `/notes/${id}/versions/1`)).body.version.text;
      assert.match(text, re);

      const res = await fetch(`${base}/notes/${id}/versions/1/original`, { headers: { Cookie: cookie, 'X-CSRF-Token': csrf } });
      assert.equal(res.status, 200);
      assert.deepEqual(Buffer.from(await res.arrayBuffer()), bytes);
      assert.match(res.headers.get('content-disposition') ?? '', /^attachment; filename="sync\./);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    }
  });

  test('an upload can be a new version of existing notes, and a title can be given', async () => {
    const first = await upload('/notes/upload', 'a.txt', Buffer.from('one'), 'Board meeting');
    assert.equal(first.body.source.title, 'Board meeting');
    const id = first.body.source.id;
    const second = await upload(`/notes/${id}/versions/upload`, 'b.docx', makeDocx(['two']));
    assert.equal(second.status, 201);
    assert.equal(second.body.version.versionNo, 2);
    assert.equal(second.body.version.filename, 'b.docx');
  });

  test('a pasted version has no original to download', async () => {
    const { body } = await json('POST', '/notes', { title: 'T', text: 'x' });
    assert.equal((await fetch(`${base}/notes/${body.source.id}/versions/1/original`, { headers: { Cookie: cookie, 'X-CSRF-Token': csrf } })).status, 404);
  });

  test('bad uploads are refused with a reason and store nothing', async () => {
    const cases: Array<[string, Buffer, number, RegExp]> = [
      ['virus.exe', Buffer.from('MZ'), 400, /Only \.txt/],
      ['fake.pdf', Buffer.from('not a pdf'), 400, /not a PDF/],
      ['fake.docx', Buffer.from('not a zip'), 400, /not a Word document/],
      ['latin1.txt', Buffer.from([0x63, 0xe9]), 400, /UTF-8/],
      ['scan.pdf', makePdf([]), 400, /No selectable text/],
      ['empty.txt', Buffer.alloc(0), 400, /empty/],
      ['bomb.docx', makeZip([{ name: 'word/document.xml', data: Buffer.alloc(60 * 1024 * 1024, 0x20) }]), 400, /too large|too much/],
    ];
    for (const [name, bytes, status, re] of cases) {
      const r = await upload('/notes/upload', name, bytes);
      assert.equal(r.status, status, `${name}: ${JSON.stringify(r.body)}`);
      assert.match(JSON.stringify(r.body), re, name);
    }
    const tooBig = await upload('/notes/upload', 'big.txt', Buffer.alloc(MAX_UPLOAD_BYTES + 1, 0x61));
    assert.equal(tooBig.status, 413);
    assert.deepEqual((await json('GET', '/notes')).body.sources, []);
  });

  test('a request needs exactly one of pasted text or a file', async () => {
    const form = new FormData();
    form.set('title', 'No file');
    const res = await fetch(`${base}/notes/upload`, { method: 'POST', headers: { Cookie: cookie, 'X-CSRF-Token': csrf }, body: form });
    assert.equal(res.status, 400);
    assert.equal((await json('POST', '/notes', { title: 'T' })).status, 400);
    assert.equal((await json('POST', '/notes', { title: 'T', text: 5 })).status, 400);
  });

  test('titles are required and limited', async () => {
    for (const title of [undefined, '', '   ', 'x'.repeat(201), 5]) {
      assert.equal((await json('POST', '/notes', { title, text: 'x' })).status, 400, JSON.stringify(title));
    }
  });

  test('long pasted notes work up to the limit, and not beyond it', async () => {
    const atLimit = await json('POST', '/notes', { title: 'Long', text: 'a'.repeat(MAX_TEXT_CHARS) });
    assert.equal(atLimit.status, 201);
    assert.equal(atLimit.body.version.charCount, MAX_TEXT_CHARS);
    const over = await json('POST', '/notes', { title: 'Longer', text: 'a'.repeat(MAX_TEXT_CHARS + 1) });
    assert.equal(over.status, 400);
    const huge = await json('POST', '/notes', { title: 'Huge', text: 'a'.repeat(5 * 1024 * 1024) });
    assert.equal(huge.status, 413);
  });

  test('ids and version numbers that make no sense are a plain 404', async () => {
    assert.equal((await json('GET', '/notes/not-an-id')).status, 404);
    assert.equal((await json('GET', '/notes/0197c3a0-0000-7000-8000-000000000000')).status, 404);
    const { body } = await json('POST', '/notes', { title: 'T', text: 'x' });
    for (const n of ['0', '-1', 'abc', '1.5', '99999999999']) {
      assert.equal((await json('GET', `/notes/${body.source.id}/versions/${n}`)).status, 404, n);
    }
    assert.equal((await json('POST', '/notes/0197c3a0-0000-7000-8000-000000000000/versions', { text: 'x' })).status, 404);
  });

  test('the audit trail records what was imported but never the note text', async () => {
    const secret = 'The merger price is 4.2 million';
    const { body } = await json('POST', '/notes', { title: 'Confidential', text: secret });
    await json('POST', `/notes/${body.source.id}/versions`, { text: secret + ' (revised)' });
    await upload('/notes/upload', 'x.docx', makeDocx([secret + ' upload']));
    const { rows } = await pool.query("SELECT action, detail FROM audit_events WHERE action LIKE 'note.%' ORDER BY occurred_at, id");
    assert.deepEqual(rows.map((r) => r.action).sort(), ['note.created', 'note.created', 'note.version_added']);
    assert.ok(!JSON.stringify(rows).includes('merger'));
    const created = rows.find((r) => r.action === 'note.created' && r.detail.origin === 'paste');
    assert.equal(created.detail.charCount, secret.length);
    assert.match(created.detail.textSha256, /^[0-9a-f]{64}$/);
  });

  test('a stored version cannot be changed or deleted, even by direct database access', async () => {
    const { body } = await json('POST', '/notes', { title: 'T', text: 'original' });
    await assert.rejects(pool.query("UPDATE source_versions SET text_content = 'edited'"), /immutable/);
    await assert.rejects(pool.query('DELETE FROM source_versions'), /immutable/);
    await assert.rejects(pool.query('TRUNCATE source_versions'), /immutable|cannot truncate/);
    await assert.rejects(pool.query('DELETE FROM sources'), /never deleted/);
    assert.equal((await json('GET', `/notes/${body.source.id}/versions/1`)).body.version.text, 'original');
  });
});
