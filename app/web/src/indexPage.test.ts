import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// Browsers ask for /favicon.ico when the page names no icon; the API has none, so every first load logged a 404 error.
test('the page names its tab icon (Kainow square logo) before the organisation branding loads', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const icon = /<link\s+rel="icon"[^>]*href="([^"]+)"/.exec(html);
  assert.ok(icon, 'index.html has no <link rel="icon">');
  // The same address the API gives as the default tab logo (organisation branding, places.tab).
  assert.equal(icon[1], '/organisation/logo/square?v=default');
});
