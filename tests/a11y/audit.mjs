// Automated accessibility pass (axe-core in headless Chrome) over every screen. See README.md.
// It signs in with a code read from the API log, so the API must run with LOG_SIGN_IN_CODES=true on a scratch database.
import puppeteer from 'puppeteer-core';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const pg = createRequire(join(here, '..', '..', 'app', 'package.json'))('pg');
import { randomUUID } from 'node:crypto';

const base = process.env.KAINOW_URL ?? 'http://localhost:3066';
const EMAIL = process.env.KAINOW_EMAIL ?? 'a11y@example.org';
const API_LOG = process.env.KAINOW_API_LOG ?? '/tmp/a11y/api.log';
const CHROME = process.env.CHROME ?? '/usr/bin/google-chrome';
const log = readFileSync(API_LOG, 'utf8');
const code = [...log.matchAll(new RegExp(EMAIL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ': (\\d{6})', 'g'))].pop()[1];
const v = await fetch(`${base}/auth/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: EMAIL, code }) });
const cookie = v.headers.get('set-cookie').split(';')[0];
const csrf = (await v.json()).csrfToken;
const api = (m, p, b) => fetch(base + p, { method: m, headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: b && JSON.stringify(b) }).then((r) => r.json());

const text = 'We agreed to ship on Friday.\nWe agreed to ship on Friday.\nSam will send the budget to Priya by 12 December.\nRisk: the venue may not be free.';
const created = await api('POST', '/notes', { title: 'Access check note', text });
const sourceId = created.source?.id ?? created.id;
const note = await api('GET', `/notes/${sourceId}`);
const versionId = (note.versions?.[0] ?? note.version ?? created.version).id;

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const user = (await db.query("select id from users where email=$1", [EMAIL])).rows[0].id;
const runId = randomUUID();
await db.query("insert into extraction_runs (id, source_version_id, requested_by, status, model_id, attempts, item_count, unlocated_count, created_at, finished_at) values ($1,$2,$3,'succeeded','gpt-6.1-sol',1,4,1,now(),now())", [runId, versionId, user]);
const items = [
  ['decision', 'Ship on Friday', null, 'Friday', 'We agreed to ship on Friday.', 0, 28, 2],
  ['action', 'Send the budget to Priya', 'Sam', '12 December', 'Sam will send the budget to Priya by 12 December.', 58, 108, 1],
  ['risk', 'The venue may not be free', null, null, 'Risk: the venue may not be free.', 109, 140, 1],
  ['question', 'Who books the room?', null, null, 'This sentence is not in the notes.', null, null, 0],
];
for (const [i, it] of items.entries()) {
  await db.query('insert into extraction_items (id, run_id, source_version_id, position, kind, text, owner, due, quote, quote_start, quote_end, quote_matches, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())', [randomUUID(), runId, versionId, i, it[0], it[1], it[2], it[3], it[4], it[5], it[6], it[7]]);
}
await db.end();

const axe = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
const results = [];
async function check(name, page) {
  const seen = await page.evaluate(() => ({ h: [...document.querySelectorAll('h1,h2')].map((e) => e.textContent.trim()).slice(0, 3), buttons: document.querySelectorAll('button').length, inputs: document.querySelectorAll('input,textarea,select').length, len: document.body.innerText.length }));
  console.log('RENDERED', name, JSON.stringify(seen));
  await page.evaluate(axe);
  const r = await page.evaluate(() => axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] } }));
  results.push({ name, violations: r.violations.map((x) => ({ id: x.id, impact: x.impact, help: x.help, nodes: x.nodes.map((n) => n.target.join(' ') + ' :: ' + (n.failureSummary || '').split('\n').slice(1, 3).join(' ')) })) });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
for (const [theme, width] of [['wide', 1200], ['narrow', 375]]) {
  const open = async (ctx) => {
    const page = await ctx.newPage();
    await page.setViewport({ width, height: 800 });
    return page;
  };
  // Signed out, in a private context so the cookie above is not shared
  const ctx = await browser.createBrowserContext();
  let page = await open(ctx);
  await page.goto(base + '/', { waitUntil: 'networkidle0' });
  await check(`${theme}: sign-in`, page);
  await page.type('input[type=email]', EMAIL);
  await page.click('form button');
  await wait(500);
  await check(`${theme}: sign-in, code step`, page);
  await page.type('input[inputmode="numeric"], input[autocomplete="one-time-code"], form input', '000000').catch(() => {});
  await page.click('form button').catch(() => {});
  await wait(600);
  await check(`${theme}: sign-in, wrong code error shown`, page);
  await ctx.close();
  // Signed in
  page = await open(browser.defaultBrowserContext());
  const [n, ...val] = cookie.split('=');
  await page.setCookie({ name: n, value: val.join('='), domain: 'localhost', path: '/' });
  for (const [label, hash] of [['notes', '#/'], ['note', `#/notes/${sourceId}`], ['review', `#/runs/${runId}`], ['people', '#/people'], ['spending', '#/spending']]) {
    await page.goto(`${base}/${hash}`, { waitUntil: 'networkidle0' });
    await page.reload({ waitUntil: 'networkidle0' });
    await wait(300);
    await check(`${theme}: ${label}`, page);
  }
  await page.goto(`${base}/#/runs/${runId}`, { waitUntil: 'networkidle0' });
  await page.reload({ waitUntil: 'networkidle0' });
  const edit = await page.$('button.link-button');
  if (edit) { await edit.click(); await wait(200); await check(`${theme}: review, editor open`, page); }
  await page.close();
}
await browser.close();
let total = 0;
for (const r of results) {
  total += r.violations.length;
  console.log(`\n## ${r.name}: ${r.violations.length} violation(s)`);
  for (const x of r.violations) { console.log(`- [${x.impact}] ${x.id}: ${x.help}`); for (const n of x.nodes.slice(0, 4)) console.log(`    ${n}`); }
}
console.log(`\nTOTAL violations: ${total}`);
