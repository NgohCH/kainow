// Supported-browsers smoke run (10b spec 14.1): the same journey in every browser and size, each step asserting what is on
// screen, that the browser logged no console error and got no 4xx or 5xx reply, and that the page does not scroll sideways, with a
// screenshot. See README.md. It signs in with a code read from
// the API log, so the API must run with LOG_SIGN_IN_CODES=true on a scratch database seeded by `npm run load-test -- --seed`.
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REVIEW_NOTE, REVIEW_NOTE_PROJECT, createReviewRun } from './review-run.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const current = require('playwright');

const base = (process.env.KAINOW_URL ?? 'http://localhost:3312').replace(/\/$/, '');
const EMAIL = process.env.KAINOW_EMAIL ?? 'load-001@example.org';
const API_LOG = process.env.KAINOW_API_LOG ?? join(here, 'api.log');
const WANTED = (process.env.BROWSERS ?? 'chrome,msedge,firefox,webkit,chrome-previous,msedge-previous,firefox-previous').split(',').map((b) => b.trim()).filter(Boolean);
// The seeded load-test organisation: the Administrator is the Project Manager of Load Project 01 and the Owner of Load Project 06.
const WORK_PROJECT = process.env.KAINOW_PROJECT ?? 'Load Project 01';
// Comma list; the first with a decision waiting is used. The Administrator is the Owner of each (the seed's Owners review proposals).
const REVIEW_PROJECTS = (process.env.KAINOW_REVIEW_PROJECTS ?? 'Load Project 06,Load Project 16,Load Project 26,Load Project 36').split(',').map((p) => p.trim());
// Optional: the test installation's database, to insert a finished AI run for the review screen (review-run.mjs).
const DATABASE_URL = process.env.DATABASE_URL;
const STEP_TIMEOUT = 15_000;
const RESEND_GAP_MS = 61_000; // the API sends at most one code a minute per person

const SIZES = {
  desktop: { label: 'desktop 1280×800', viewport: { width: 1280, height: 800 } },
  phone: { label: 'phone 390×844', viewport: { width: 390, height: 844 } },
  tablet: { label: 'tablet 820×1180', viewport: { width: 820, height: 1180 } },
};

/** Every browser the run knows: how to launch it, its label and its sizes (tablet only in Chrome and WebKit). */
const BROWSERS = {
  chrome: { label: 'Chrome (installed)', sizes: ['desktop', 'phone', 'tablet'], launch: () => current.chromium.launch({ channel: 'chrome' }) },
  msedge: { label: 'Edge (installed)', sizes: ['desktop', 'phone'], launch: () => current.chromium.launch({ channel: 'msedge' }) },
  firefox: { label: `Firefox (Playwright ${require('playwright/package.json').version} build)`, sizes: ['desktop', 'phone'], launch: () => current.firefox.launch() },
  webkit: { label: 'WebKit engine, not Safari', sizes: ['desktop', 'phone', 'tablet'], launch: () => current.webkit.launch() },
  'firefox-previous': {
    label: `Firefox (previous Playwright release, ${require('playwright-previous/package.json').version})`,
    sizes: ['desktop', 'phone'],
    launch: () => require('playwright-previous').firefox.launch(),
  },
  'chrome-previous': {
    label: 'Chrome previous major',
    sizes: ['desktop', 'phone'],
    launch: () => {
      if (!process.env.CHROME_PREVIOUS) throw new NotObtainable('no previous Chrome is installed on this PC (set CHROME_PREVIOUS to its chrome.exe; Beta or Dev is not a previous version)');
      return current.chromium.launch({ executablePath: process.env.CHROME_PREVIOUS });
    },
  },
  'msedge-previous': {
    label: 'Edge previous major',
    sizes: ['desktop', 'phone'],
    launch: () => {
      if (!process.env.MSEDGE_PREVIOUS) throw new NotObtainable('no previous Edge is installed on this PC (set MSEDGE_PREVIOUS to its msedge.exe; Beta or Dev is not a previous version)');
      return current.chromium.launch({ executablePath: process.env.MSEDGE_PREVIOUS });
    },
  },
};
class NotObtainable extends Error {}
/** A step that cannot be checked in this setup (recorded as "not checked", not as a failure). */
class NotChecked extends Error {}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const exactly = (s) => new RegExp('^' + escape(s) + '$');
const codes = () => [...readFileSync(API_LOG, 'utf8').matchAll(new RegExp(escape(EMAIL) + ': (\\d{6})', 'g'))].map((m) => m[1]);
let lastCodeRequest = 0;

async function newCode(page, seenBefore) {
  for (let i = 0; i < 20; i++) {
    const all = codes();
    if (all.length > seenBefore) return all[all.length - 1];
    await wait(250);
  }
  return null;
}

/** The journey: each step does something a person does and then checks what should be on screen. */
const STEPS = [
  ['Sign-in page', async (page) => {
    await page.goto(`${base}/`);
    await page.getByText('Sign in to Kainow').waitFor();
    await page.getByLabel('Work email').waitFor();
  }],
  ['Sign in with a code', async (page) => {
    const pause = lastCodeRequest + RESEND_GAP_MS - Date.now();
    if (pause > 0) await wait(pause);
    let before = codes().length;
    await page.getByLabel('Work email').fill(EMAIL);
    await page.getByRole('button', { name: 'Email me a sign-in code' }).click();
    lastCodeRequest = Date.now();
    await page.getByText('a 6-digit code is on its way').waitFor();
    let code = await newCode(page, before);
    if (!code) {
      // A code asked for in the last minute (outside this run) silences a new one: wait the gap and ask again.
      await page.getByRole('button', { name: 'Use a different email' }).click();
      await wait(RESEND_GAP_MS);
      before = codes().length;
      await page.getByLabel('Work email').fill(EMAIL);
      await page.getByRole('button', { name: 'Email me a sign-in code' }).click();
      lastCodeRequest = Date.now();
      code = await newCode(page, before);
      if (!code) throw new Error(`no sign-in code for ${EMAIL} appeared in ${API_LOG}`);
    }
    await page.getByLabel('Sign-in code').fill(code);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    // Home: its heading is a greeting ("Good morning, Load"), and the side menu marks Home as the current page.
    await page.getByRole('heading', { name: /^Good (morning|afternoon|evening)/, level: 1 }).waitFor();
  }],
  ['Projects', async (page) => {
    await menuLink(page, 'Projects');
    await page.getByRole('heading', { name: 'Projects', level: 1 }).waitFor();
    await page.getByRole('link', { name: new RegExp('^' + escape(WORK_PROJECT)) }).first().waitFor();
  }],
  ['Open a project', async (page) => {
    await page.getByRole('link', { name: new RegExp('^' + escape(WORK_PROJECT)) }).first().click();
    await page.getByRole('heading', { name: WORK_PROJECT, level: 1 }).waitFor();
    await page.getByRole('heading', { name: 'About', level: 2 }).waitFor();
  }],
  ['Work tab', async (page) => {
    await projectTab(page, 'Work');
    await page.getByRole('heading', { name: 'Tasks', level: 2 }).waitFor();
  }],
  ['Save a task progress change from the Work list', async (page) => {
    // A task the signed-in person may act on: block an In progress one with a reason, or (when none is left) unblock a
    // Blocked one with how it was resolved. Either is a saved progress change. Tasks are rows of the Tasks table.
    const rows = page.getByRole('table', { name: /^Tasks/ }).locator('tbody tr');
    await rows.first().waitFor();
    const withButton = (label) => rows.filter({ has: page.getByRole('button', { name: label, exact: true }) });
    const [action, prompt, note, after] = (await withButton('Block').count()) > 0
      ? ['Block', 'Why is it blocked?', 'Waiting for the browser smoke run', 'Blocked']
      : ['Unblock', 'How was it resolved?', 'Resolved during the browser smoke run', 'In Progress'];
    const id = await withButton(action).first().getAttribute('id');
    const task = page.locator(`tr[id="${id}"]`);
    await task.scrollIntoViewIfNeeded();
    await task.getByRole('button', { name: action, exact: true }).click();
    await task.getByLabel(prompt).fill(note);
    await task.getByRole('form', { name: `${action} task` }).getByRole('button', { name: action, exact: true }).click();
    await page.getByRole('status').filter({ hasText: `${action}: done.` }).waitFor();
    await task.getByText(after, { exact: true }).first().waitFor();
  }],
  ['Follow a task link to its page', async (page) => {
    // The first task of the Work list: its title opens the task page, inside the project with the Work tab open (D133).
    const link = page.getByRole('table', { name: /^Tasks/ }).locator('tbody a[href*="/tasks/"]').first();
    const title = (await link.textContent()).trim();
    await link.click();
    await page.getByRole('heading', { name: title, level: 2, exact: true }).waitFor();
    await page.getByRole('heading', { name: 'Description', level: 3 }).waitFor();
    await page.getByText(/^(Not started: nobody|In progress: the work|Blocked: the work|Completed: the work|Cancelled: the work)/).waitFor();
    await page.getByRole('link', { name: 'Back to Work' }).click();
    await page.getByRole('heading', { name: 'Tasks', level: 2 }).waitFor();
  }],
  ['Post a discussion comment', async (page, run) => {
    await projectTab(page, 'Discussion');
    await page.getByRole('heading', { name: 'Discussion', level: 2 }).waitFor();
    await page.locator('main a[href*="/threads/"]').first().click();
    const text = `Smoke run comment, ${run.browser} at ${run.size}, ${new Date().toISOString()}`;
    await page.getByLabel('Write a message').fill(text);
    await page.getByRole('button', { name: 'Post', exact: true }).click();
    await page.getByRole('region', { name: 'Messages' }).getByText(text).waitFor();
  }],
  ['Open a note', async (page) => {
    // A thread is its own page (outside the project's tabs), so go back to the project first.
    await openProject(page, WORK_PROJECT);
    await projectTab(page, 'Notes');
    const note = page.locator('main a[href^="#/notes/"]').first();
    const name = (await note.locator('strong').first().textContent()).trim();
    await note.click();
    await page.getByRole('heading', { name, level: 1 }).waitFor();
  }],
  ['Review screen with a proposal', async (page, run) => {
    // The AI review screen (#/runs/:id, inside the project) needs a finished run; with DATABASE_URL the run inserts one
    // (review-run.mjs) on "Meeting notes 6.1" in Load Project 06, where the Administrator is the Owner.
    if (!DATABASE_URL) throw new NotChecked('DATABASE_URL not set, so no AI run to review');
    const { runId, decisions } = await createReviewRun(DATABASE_URL, 1);
    run.decision = decisions[0];
    await openProject(page, REVIEW_NOTE_PROJECT);
    await projectTab(page, 'Notes');
    await page.locator('main a[href^="#/notes/"]').filter({ has: page.locator('strong', { hasText: exactly(REVIEW_NOTE) }) }).first().click();
    await page.getByRole('heading', { name: REVIEW_NOTE, level: 1 }).waitFor();
    await page.locator(`a[href="#/runs/${runId}"]`).click();
    await page.getByRole('heading', { name: 'Review proposals' }).waitFor();
    const card = reviewCard(page, run.decision);
    await card.getByRole('button', { name: 'Authorise', exact: true }).waitFor();
    // Below 900 px the notes open in their own view from each proposal ("Show in the notes"), with a way back.
    const showNotes = card.getByRole('button', { name: /^Show in the notes/ });
    if (await showNotes.isVisible()) {
      await showNotes.click();
      await page.getByRole('region', { name: 'Source text' }).waitFor();
      await page.getByRole('button', { name: /^Back to proposal/ }).click();
      await card.getByRole('button', { name: 'Authorise', exact: true }).waitFor();
    } else {
      await page.getByRole('region', { name: 'Source text' }).waitFor();
    }
  }],
  ['Approve a proposal', async (page, run) => {
    if (!run.decision) throw new NotChecked('the review screen step was not checked');
    const card = reviewCard(page, run.decision);
    await card.scrollIntoViewIfNeeded();
    await card.getByRole('button', { name: 'Authorise', exact: true }).click();
    await page.getByRole('form', { name: 'Authorise this proposal' }).getByRole('button', { name: 'Authorise', exact: true }).click();
    // The link opens the record it became: a decision's row in Work (D136).
    await card.getByRole('link', { name: /^Authorised: open the decision/ }).click();
    await page.locator('tr[id^="item-"]').filter({ hasText: run.decision }).first().waitFor();
  }],
  ["Authorise a person's proposal", async (page) => {
    // People's proposals (the project's Proposals tab › Proposals from people). Each journey authorises one decision; when
    // a project has none left waiting, the next project in the list is used.
    let item = null;
    for (const project of REVIEW_PROJECTS) {
      await openProject(page, project);
      await projectTab(page, 'Proposals');
      await page.getByRole('heading', { name: 'Proposals from people', level: 2 }).waitFor();
      await page.locator('section[aria-labelledby="human-proposals-heading"] li.work-item').first().waitFor();
      if ((await pendingDecision(page).count()) > 0) {
        item = pendingDecision(page);
        break;
      }
    }
    if (!item) throw new Error(`no decision proposal is waiting in ${REVIEW_PROJECTS.join(', ')}`);
    const text = (await item.locator('strong').first().textContent()).trim();
    await item.scrollIntoViewIfNeeded();
    await item.getByRole('button', { name: 'Authorise', exact: true }).click();
    await page.getByRole('form', { name: 'Authorise this proposal' }).getByRole('button', { name: 'Authorise', exact: true }).click();
    await page.getByText('Authorised: it is now on the Work tab.').waitFor();
    await page.locator('li.work-item').filter({ has: page.locator('strong', { hasText: exactly(text) }) }).getByRole('link', { name: /^authorised: open the decision/ }).waitFor();
  }],
  ['Personal dashboard', async (page) => {
    await menuLink(page, 'Home');
    await page.getByRole('heading', { name: 'Needs you', level: 2 }).waitFor();
    await page.getByRole('heading', { name: 'My tasks', level: 2 }).waitFor();
  }],
  ['My profile', async (page) => {
    await page.locator('#person-menu-button').click();
    await page.getByRole('link', { name: 'My profile' }).click();
    await page.getByRole('heading', { name: 'My profile', level: 1 }).waitFor();
    await page.getByRole('table', { name: 'Projects and roles' }).getByRole('link', { name: WORK_PROJECT, exact: true }).first().waitFor();
    await page.getByRole('table', { name: 'Past roles' }).or(page.getByText('No past roles.')).first().waitFor();
  }],
  ['Each tab style', async (page) => {
    // Chosen on My profile, then looked at on a project: the open tab is marked, and every tab is inside the page (D135).
    for (const [label, style] of [['Grey dividers', 'grey'], ['Tinted dividers', 'tinted'], ['Boxes', 'boxes']]) {
      await page.locator('#person-menu-button').click();
      await page.getByRole('link', { name: 'My profile' }).click();
      const saved = page.waitForResponse((r) => r.url().endsWith('/me/preferences') && r.request().method() === 'PUT');
      const choice = page.getByRole('group', { name: 'Tab style' }).getByRole('radio', { name: new RegExp('^' + label) });
      // Boxes, the default, may already be the choice of the person (then nothing is saved).
      if (await choice.isChecked()) saved.catch(() => undefined);
      else {
        await choice.check();
        await saved;
      }
      await openProject(page, WORK_PROJECT);
      await page.locator(`html[data-tabs="${style}"] nav.binder-tabs a[aria-current="page"]`).filter({ hasText: 'Overview' }).waitFor();
      await notSideways(page);
      await projectTab(page, 'Work');
      await page.locator('nav.binder-tabs a[aria-current="page"]').filter({ hasText: 'Work' }).waitFor();
      await page.getByRole('heading', { name: 'Tasks', level: 2 }).waitFor();
    }
  }],
  ['Project dashboard', async (page) => {
    await menuLink(page, 'Projects');
    await page.getByRole('heading', { name: 'Projects', level: 1 }).waitFor();
    await page.getByRole('link', { name: new RegExp('^' + escape(WORK_PROJECT)) }).first().click();
    await page.getByRole('heading', { name: 'Figures', level: 2 }).waitFor();
    await page.locator('section[aria-labelledby="figures-heading"] a').first().waitFor();
  }],
  ['Analytics as Administrator', async (page) => {
    await menuLink(page, 'Analytics');
    await page.getByRole('heading', { name: 'Analytics', level: 1 }).waitFor();
    await page.getByRole('heading', { name: 'Saved views', level: 2 }).waitFor();
  }],
  ['Operations page', async (page) => {
    await menuLink(page, 'Operations');
    await page.getByRole('heading', { name: 'Operations', level: 1 }).waitFor();
    await page.getByRole('heading', { name: 'Backups', level: 3, exact: true }).waitFor();
  }],
  ['Sign out', async (page) => {
    // Sign out is in the person menu (the button with the person's name).
    await page.locator('#person-menu-button').click();
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await page.getByText('Sign in to Kainow').waitFor();
    await page.getByLabel('Work email').waitFor();
  }],
];

/** The page never scrolls sideways (wide drawings and tables scroll inside their own box). */
async function notSideways(page) {
  const w = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: document.documentElement.clientWidth }));
  if (w.scroll > w.inner) throw new Error(`the page scrolls sideways: ${w.scroll} px wide in ${w.inner} px`);
}

/** A side-menu link. Below 900 px the side menu is closed behind the top bar's Menu button, so that is opened first. */
async function menuLink(page, name) {
  const toggle = page.locator('#menu-toggle');
  if (await toggle.isVisible()) {
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  }
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: new RegExp('^' + escape(name)) }).click();
}

/** A project's binder tab (the project's section navigation). */
async function projectTab(page, name) {
  await page.locator('nav.binder-tabs').getByRole('link', { name: new RegExp('^' + escape(name) + '(\\s*\\d|$)') }).click();
}

/** From any page: Projects in the side menu, then the project. Each click waits for the page it opens. */
async function openProject(page, project) {
  await menuLink(page, 'Projects');
  await page.getByRole('heading', { name: 'Projects', level: 1 }).waitFor();
  await page.getByRole('link', { name: new RegExp('^' + escape(project)) }).first().click();
  await page.getByRole('heading', { name: project, level: 1 }).waitFor();
}

/** The proposal card on the review screen with this text. */
const reviewCard = (page, text) =>
  page.getByRole('region', { name: 'Proposals' }).locator('article').filter({ has: page.locator('.proposal-text', { hasText: exactly(text) }) });

/** The first decision proposal still waiting, with its Authorise button. */
const pendingDecision = (page) =>
  page.locator('li.work-item').filter({ hasText: 'Proposed: change the' }).filter({ has: page.getByRole('button', { name: 'Authorise', exact: true }) }).first();

/**
 * The one error a browser logs by design: signed out, the page asks GET /auth/me and the API answers 401 (the session
 * check; tests rely on that answer). Chrome, Edge and Firefox log any 4xx as "Failed to load resource". Nothing else is excused.
 */
const expectedWhileSignedOut = (m) => /\b401\b/.test(m.text()) && new URL(m.location()?.url || 'about:blank').pathname === '/auth/me';

async function runJourney(browser, key, sizeKey, shotDir) {
  const context = await browser.newContext({ viewport: SIZES[sizeKey].viewport });
  context.setDefaultTimeout(STEP_TIMEOUT);
  const page = await context.newPage();
  let errors = [];
  page.on('console', (m) => {
    if (m.type() !== 'error' || expectedWhileSignedOut(m)) return;
    errors.push(`console: ${m.text()}${m.location()?.url ? ` (${m.location().url})` : ''}`);
  });
  // Any 4xx or 5xx reply, whatever the browser logs (WebKit does not log every one): signed out, only the session check's 401.
  page.on('response', (r) => {
    const path = new URL(r.url()).pathname;
    if (r.status() >= 400 && !(r.status() === 401 && path === '/auth/me')) errors.push(`reply: ${r.status()} ${r.request().method()} ${path}`);
  });
  page.on('pageerror', (e) => errors.push(`page error: ${e.message}`));
  const steps = [];
  const state = { browser: key, size: sizeKey };
  let failed = false;
  let signedIn = false;
  for (const [i, [name, step]] of STEPS.entries()) {
    const n = String(i + 1).padStart(2, '0');
    if (failed && (name !== 'Sign out' || !signedIn)) {
      steps.push({ n, name, result: 'skipped', detail: 'an earlier step failed' });
      continue;
    }
    errors = [];
    let detail = '';
    try {
      await step(page, state);
      await wait(400); // let late requests (and their console errors) land
      await notSideways(page);
    } catch (e) {
      if (e instanceof NotChecked) {
        steps.push({ n, name, result: 'not checked', detail: e.message });
        console.log(`  --   ${n} ${name} — not checked: ${e.message}`);
        continue;
      }
      // The first line, plus what Playwright was waiting for (which link or heading), when it says.
      const lines = e.message.split('\n');
      detail = [lines[0], lines.find((l) => /waiting for/.test(l))?.trim()].filter(Boolean).join(' — ');
    }
    // The step's errors are read before the screenshot: in WebKit, Playwright's screenshot inserts a style of its own,
    // which the page's Content Security Policy refuses and WebKit logs. That message is Playwright's, not Kainow's.
    const problems = [detail, ...errors].filter(Boolean);
    const shot = join(shotDir, `${n}-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.png`);
    await page.screenshot({ path: shot, fullPage: false }).catch(() => undefined);
    const ok = problems.length === 0;
    if (name === 'Sign in with a code' && !detail) signedIn = true;
    if (!ok) failed = true;
    steps.push({ n, name, result: ok ? 'passed' : 'failed', detail: problems.join('; '), shot });
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${n} ${name}${ok ? '' : ' — ' + problems.join('; ')}`);
  }
  await context.close();
  return steps;
}

// The date on the PC (Kainow's times are UTC+8; a run late at night UTC is still that day here).
const now = new Date();
const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
const resultsDir = join(here, 'results');
const shotsRoot = join(resultsDir, date);
rmSync(shotsRoot, { recursive: true, force: true });
const runs = [];
for (const key of WANTED) {
  const def = BROWSERS[key];
  if (!def) {
    runs.push({ key, label: key, version: '—', size: '—', status: 'not checked', detail: 'unknown browser name' });
    continue;
  }
  let browser;
  try {
    browser = await def.launch();
  } catch (e) {
    const reason = e instanceof NotObtainable ? e.message : `could not be started: ${e.message.split('\n')[0]}`;
    console.log(`${def.label}: not checked — ${reason}`);
    runs.push({ key, label: def.label, version: '—', size: '—', status: 'not checked', detail: reason });
    continue;
  }
  const version = browser.version();
  for (const sizeKey of def.sizes) {
    console.log(`${def.label} ${version}, ${SIZES[sizeKey].label}`);
    const shotDir = join(shotsRoot, `${key}-${sizeKey}`);
    mkdirSync(shotDir, { recursive: true });
    const steps = await runJourney(browser, key, sizeKey, shotDir);
    const failedSteps = steps.filter((s) => s.result === 'failed' || s.result === 'skipped');
    const unchecked = steps.filter((s) => s.result === 'not checked').length;
    const status = failedSteps.length ? 'failed' : unchecked ? `passed, ${unchecked} step${unchecked > 1 ? 's' : ''} not checked` : 'passed';
    runs.push({ key, label: def.label, version, size: SIZES[sizeKey].label, status, steps, shotDir });
  }
  await browser.close();
}

const rel = (p) => p.slice(resultsDir.length + 1).replace(/\\/g, '/');
const lines = [
  `# Browser smoke run, ${date}`,
  '',
  `Against ${base} as ${EMAIL} (the seeded load-test organisation, "Example Organisation"). Journey: ${STEPS.length} steps (10b spec 14.1); each asserts visible content, no console error, no 4xx or 5xx reply and no sideways scroll, and takes a screenshot (in \`results/${date}/\`, not committed).`,
  '',
  '| Browser | Exact version | Size | Result | Steps passed |',
  '|---|---|---|---|---|',
  ...runs.map((r) => `| ${r.label} | ${r.version} | ${r.size} | ${r.status}${r.status === 'not checked' ? ': ' + r.detail : ''} | ${r.steps ? `${r.steps.filter((s) => s.result === 'passed').length}/${r.steps.length}` : '—'} |`),
  '',
  '## Steps',
  '',
  ...runs.filter((r) => r.steps).flatMap((r) => [
    `### ${r.label} ${r.version}, ${r.size}`,
    '',
    '| # | Step | Result | Detail |',
    '|---|---|---|---|',
    ...r.steps.map((s) => `| ${s.n} | ${s.name} | ${s.result} | ${(s.detail || (s.shot ? `\`${rel(s.shot)}\`` : '')).replace(/\|/g, '\\|')} |`),
    '',
  ]),
];
const failedRuns = runs.filter((r) => r.status === 'failed');
lines.push('## Failures', '', failedRuns.length ? failedRuns.map((r) => `- ${r.label} ${r.version}, ${r.size}: ${r.steps.filter((s) => s.result === 'failed').map((s) => `${s.n} ${s.name}: ${s.detail}`).join('; ')}`).join('\n') : 'None.', '');
mkdirSync(resultsDir, { recursive: true });
writeFileSync(join(resultsDir, `${date}.md`), lines.join('\n'));
console.log(`\nWrote results/${date}.md: ${runs.filter((r) => r.status.startsWith('passed')).length} passed, ${failedRuns.length} failed, ${runs.filter((r) => r.status === 'not checked').length} not checked.`);
process.exit(failedRuns.length ? 1 : 0);
