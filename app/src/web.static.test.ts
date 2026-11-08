import 'reflect-metadata';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createApp } from './bootstrap';
import { loadConfig } from './config';
import { SKIP_NO_DB, testDatabaseUrl } from './testing/db';
import { testEnv } from './testing/fakes';

test('the web app is served without sign-in, with strict headers, and the API still needs sign-in', { skip: SKIP_NO_DB }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kainow-web-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Kainow</title>');
  const app = await createApp(loadConfig(testEnv(testDatabaseUrl() as string)), { logger: false, webDir: dir, extractionQueue: { enqueue: async () => undefined } });
  await app.listen(0);
  try {
    const base = await app.getUrl();
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Kainow/);
    const csp = page.headers.get('content-security-policy') ?? '';
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
    assert.equal((await fetch(`${base}/projects`)).status, 401);
    assert.equal((await fetch(`${base}/ai/spend`)).status, 401);
  } finally {
    await app.close();
  }
});
