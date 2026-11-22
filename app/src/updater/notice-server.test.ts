import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { describe, test } from 'node:test';
import { NOTICE_TEXT, startNoticeServer } from './notice-server';

describe('the notice page after a failed update', () => {
  test('the notice page is 503 with the fixed text for / and /anything', async () => {
    assert.equal(
      NOTICE_TEXT,
      'Kainow is unavailable after a failed update. Nothing you saved before the update started has been lost. Please contact your Administrator.',
    );
    const server = startNoticeServer(0);
    try {
      await once(server, 'listening');
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      for (const [path, method] of [['/', 'GET'], ['/anything', 'GET'], ['/api/projects?x=1', 'POST'], ['/health', 'GET']]) {
        const res = await fetch(`${base}${path}`, { method });
        assert.equal(res.status, 503, path);
        assert.match(res.headers.get('content-type') ?? '', /^text\/html; charset=utf-8/);
        assert.equal(res.headers.get('cache-control'), 'no-store');
        const html = await res.text();
        assert.ok(html.includes(NOTICE_TEXT), path);
        assert.match(html, /<html lang="en">/);
        assert.match(html, /<main>[\s\S]*<h1>[\s\S]*<\/h1>[\s\S]*<\/main>/);
        assert.match(html, /<style>/);
        assert.ok(!/<script|<link|src=|https?:\/\//i.test(html), 'inline CSS only: nothing loaded from anywhere');
      }
    } finally {
      server.close();
      await once(server, 'close');
    }
  });
});
