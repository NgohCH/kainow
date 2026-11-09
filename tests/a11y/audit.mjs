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
const SETUP_LOG = process.env.KAINOW_SETUP_LOG ?? '/tmp/a11y/setup.log';
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
const log = readFileSync(API_LOG, 'utf8');
const code = [...log.matchAll(new RegExp(EMAIL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ': (\\d{6})', 'g'))].pop()[1];
const v = await fetch(`${base}/auth/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: EMAIL, code }) });
const cookie = v.headers.get('set-cookie').split(';')[0];
const csrf = (await v.json()).csrfToken;
const api = (m, p, b) => fetch(base + p, { method: m, headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: b && JSON.stringify(b) }).then((r) => r.json());

// Onboarding comes first: nothing else opens until the organisation is set up.
const setupToken = [...readFileSync(SETUP_LOG, 'utf8').matchAll(/#\/setup\/([A-Za-z0-9_-]+)/g)].pop()[1];
const assets = join(here, '..', '..', 'app', 'assets', 'branding');
const uploadLogo = (shape) =>
  fetch(`${base}/organisation/logos/${shape}`, { method: 'PUT', headers: { 'content-type': 'image/png', cookie, 'x-csrf-token': csrf }, body: readFileSync(join(assets, `kainow-${shape}.png`)) });
const removeLogo = (shape) => api('POST', `/organisation/logos/${shape}/remove`, {});
const [cookieName, ...cookieValue] = cookie.split('=');
const signedInPage = async (width) => {
  const page = await browser.newPage();
  await page.setViewport({ width, height: 800 });
  await page.setCookie({ name: cookieName, value: cookieValue.join('='), domain: 'localhost', path: '/' });
  return page;
};
const signedOutCheck = async (theme, width, label, hash) => {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width, height: 800 });
  await page.goto(`${base}/${hash}`, { waitUntil: 'networkidle0' });
  await wait(300);
  await check(`${theme}: ${label}`, page);
  await ctx.close();
};
for (const [theme, width] of [['wide', 1200], ['narrow', 375]]) {
  await signedOutCheck(theme, width, 'setup link page (already used), Kainow defaults', `#/setup/${setupToken}`);
  await signedOutCheck(theme, width, 'sign-in before setup, Kainow defaults', '');
  const page = await signedInPage(width);
  await page.goto(`${base}/#/`, { waitUntil: 'networkidle0' });
  await wait(300);
  await check(`${theme}: onboarding, empty`, page);
  await page.close();
}
await api('POST', '/organisation/name', { name: 'Example Organisation' });
await api('POST', '/domains', { domain: 'example.org' });
const department = (await api('POST', '/departments', { name: 'Access Check Department' })).department;
for (const shape of ['wide', 'square']) if ((await uploadLogo(shape)).status !== 200) throw new Error('logo upload failed');
for (const [theme, width] of [['wide', 1200], ['narrow', 375]]) {
  const page = await signedInPage(width);
  await page.goto(`${base}/#/`, { waitUntil: 'networkidle0' });
  await wait(300);
  await check(`${theme}: onboarding, filled with both logos`, page);
  await page.close();
}
if (!(await api('POST', '/organisation/finish', {})).registered) throw new Error('setup did not finish');

// One project the administrator also works in.
const projectId = (await api('POST', '/projects', { name: 'Access check project', purpose: 'Check every screen with axe.', owningDepartmentId: department.id })).project.id;
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const user = (await db.query("select id from users where email=$1", [EMAIL])).rows[0].id;
// The administrator also holds Project Manager and Owner here, with a separate Member, so every project screen has content.
const memberId = randomUUID();
await db.query("insert into users (id, email, display_name, role) values ($1, 'member.a11y@example.org', 'Member', 'member')", [memberId]);
for (const [who, role] of [[user, 'pm'], [user, 'owner'], [memberId, 'member']]) {
  await db.query("insert into memberships (id, project_id, user_id, role, starts_on) values ($1, $2, $3, $4, (now() at time zone 'Asia/Kuala_Lumpur')::date)", [randomUUID(), projectId, who, role]);
}
await db.query("update projects set status = 'active' where id = $1", [projectId]);
const invited = await api('POST', `/projects/${projectId}/invitations`, { email: 'sponsor.a11y@example.org', role: 'sponsor', startsOn: new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10) });
if (!invited.invitation) throw new Error('invitation not created: ' + JSON.stringify(invited));

const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const disabled = await fetch(base + `/users/${memberId}/disable`, { method: 'POST', headers: { cookie, 'x-csrf-token': csrf } });
const enabled = await fetch(base + `/users/${memberId}/enable`, { method: 'POST', headers: { cookie, 'x-csrf-token': csrf } });
if (disabled.status !== 204 || enabled.status !== 204) throw new Error('could not hold the member');
const grant = await api('POST', `/projects/${projectId}/grants`, { userId: memberId, kind: 'audit', purpose: 'Access check', scope: 'Everything', startsOn: today });
if (!grant.grant) throw new Error('grant not recorded: ' + JSON.stringify(grant));
const handover = await api('POST', `/projects/${projectId}/handover`, { email: 'next.a11y@example.org', outgoingRole: 'member' });
if (!handover.invitation) throw new Error('handover not issued: ' + JSON.stringify(handover));
const closedId = (await api('POST', '/projects', { name: 'Closed access check', purpose: 'A Closed project for the archive panel.', owningDepartmentId: department.id })).project.id;

const text = 'We agreed to ship on Friday.\nWe agreed to ship on Friday.\nSam will send the budget to Priya by 12 December.\nRisk: the venue may not be free.';
const created = await api('POST', `/projects/${projectId}/notes`, { title: 'Access check note', text });
const sourceId = created.source?.id ?? created.id;
const versionId = created.version.id;
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
await db.query("insert into memberships (id, project_id, user_id, role, starts_on) values ($1, $2, $3, 'owner', (now() at time zone 'Asia/Kuala_Lumpur')::date)", [randomUUID(), closedId, user]);
await db.query("update projects set status = 'closed', closure_outcome = 'delivered' where id = $1", [closedId]);
const recordsId = (await api('POST', '/projects', { name: 'Records access check', purpose: 'Tasks, questions, decisions and risks.', owningDepartmentId: department.id })).project.id;
// The creator is already its Project Manager; add the Owner role and a Member.
for (const [who, role] of [[user, 'owner'], [memberId, 'member']]) {
  await db.query("insert into memberships (id, project_id, user_id, role, starts_on) values ($1, $2, $3, $4, (now() at time zone 'Asia/Kuala_Lumpur')::date)", [randomUUID(), recordsId, who, role]);
}
await db.query("update projects set status = 'active' where id = $1", [recordsId]);
const origin = async (kind, inProject = recordsId) => {
  const id = randomUUID();
  await db.query("insert into human_proposals (id, project_id, kind, text, proposed_by, proposed_at, review_status, reviewed_by, reviewed_at) values ($1, $2, $3, 'x', $4, now(), 'approved', $4, now())", [id, inProject, kind, user]);
  return id;
};
const parentTask = randomUUID();
await db.query("insert into tasks (id, project_id, depth, title, assignee_id, owner_as_written, due_on, origin_proposal_id, authorised_by, authorised_at) values ($1, $2, 0, 'Export the catalogue records', $3, 'Ann and Ben', (now() at time zone 'Asia/Kuala_Lumpur')::date - 1, $4, $3, now())", [parentTask, recordsId, user, await origin('action')]);
await db.query("insert into tasks (id, project_id, parent_id, depth, title, assignee_id, due_on, authorised_by, authorised_at) values ($1, $2, $3, 1, 'Export the finance records', $4, (now() at time zone 'Asia/Kuala_Lumpur')::date + 5, $4, now())", [randomUUID(), recordsId, parentTask, memberId]);
const questionId = randomUUID();
await db.query("insert into questions (id, project_id, text, requester_id, status, origin_proposal_id, authorised_by, authorised_at) values ($1, $2, 'Keep the old barcode?', $3, 'answered', $4, $3, now())", [questionId, recordsId, user, await origin('question')]);
await db.query("insert into question_answers (id, question_id, answer, author_id, at) values ($1, $2, 'Until March', $3, now())", [randomUUID(), questionId, user]);
await db.query("insert into decisions (id, project_id, statement, rationale, origin_proposal_id, authorised_by, authorised_at) values ($1, $2, 'Move to the new system', 'Cheaper', $3, $4, now())", [randomUUID(), recordsId, await origin('decision'), user]);
await db.query("insert into risks (id, project_id, description, severity, responsible_id, review_on, status, origin_proposal_id, authorised_by, authorised_at) values ($1, $2, 'The vendor may be late', 'high', $3, (now() at time zone 'Asia/Kuala_Lumpur')::date + 20, 'mitigating', $4, $3, now())", [randomUUID(), recordsId, user, await origin('risk')]);

// Sub-project 2b: an approval count of 2, requests waiting and applied, review flags, closing and the deadline review.
const must = (label, r) => {
  if (r.statusCode) throw new Error(`${label}: ${JSON.stringify(r)}`);
  return r;
};
if (!must('policy', await api('POST', '/approval-policy', { required: 2, projectsMayOverride: true, reason: 'Access check', pending: 'keep' }))) throw new Error('no policy');
const second = 'sponsor2.a11y@example.org';
const secondId = randomUUID();
await db.query("insert into users (id, email, display_name, role) values ($1, $2, 'Second Sponsor', 'member')", [secondId, second]);
const addDays = (n) => new Date(Date.now() + 8 * 3600e3 + n * 86400e3).toISOString().slice(0, 10);
const addMember = (projectId, who, role) => db.query("insert into memberships (id, project_id, user_id, role, starts_on) values ($1, $2, $3, $4, (now() at time zone 'Asia/Kuala_Lumpur')::date)", [randomUUID(), projectId, who, role]);
await addMember(recordsId, secondId, 'sponsor');
const mkTask = async (projectId, title, due, status = 'not_started') => {
  const id = randomUUID();
  await db.query("insert into tasks (id, project_id, depth, title, assignee_id, due_on, status, authorised_by, authorised_at) values ($1, $2, 0, $3, $4, $5, $6, $4, now())", [id, projectId, title, user, due, status]);
  return id;
};
const mkQuestion = async (projectId, text) => {
  const id = randomUUID();
  await db.query("insert into questions (id, project_id, text, requester_id, status, origin_proposal_id, authorised_by, authorised_at) values ($1, $2, $3, $4, 'open', $5, $4, now())", [id, projectId, text, user, await origin('question', projectId)]);
  return id;
};
const mkRisk = async (projectId, description) => {
  const id = randomUUID();
  await db.query("insert into risks (id, project_id, description, severity, responsible_id, review_on, status, origin_proposal_id, authorised_by, authorised_at) values ($1, $2, $3, 'medium', $4, $5, 'open', $6, $4, now())", [id, projectId, description, user, addDays(30), await origin('risk', projectId)]);
  return id;
};
const mkDecision = async (projectId, statement) => {
  const id = randomUUID();
  await db.query("insert into decisions (id, project_id, statement, rationale, origin_proposal_id, authorised_by, authorised_at) values ($1, $2, $3, 'Cheaper', $4, $5, now())", [id, projectId, statement, await origin('decision', projectId), user]);
  return id;
};
// Work tab: tasks and decisions with requests waiting (0 of 2 and 1 of 2), and one replacement applied with review flags raised.
const amendTask = await mkTask(recordsId, 'Order the scanners', addDays(10));
const cancelTask = await mkTask(recordsId, 'Book the training room', addDays(12));
const flaggedTask = await mkTask(recordsId, 'Migrate the catalogue', addDays(15));
const flaggedQuestion = await mkQuestion(recordsId, 'Which supplier hosts the archive?');
const flaggedRisk = await mkRisk(recordsId, 'The archive host may raise its price');
const waitingDecision = await mkDecision(recordsId, 'Use the red labels');
const replacedDecision = await mkDecision(recordsId, 'Use supplier Alpha');
// Closing: one project not ready, one ready (with the Project Manager allowed to close), and a Deferred one for the deadline review.
const projectWith = async (name) => {
  const id = must(name, await api('POST', '/projects', { name, purpose: 'Check the closing screens.', owningDepartmentId: department.id })).project.id;
  await addMember(id, user, 'owner');
  await db.query("update projects set status = 'active' where id = $1", [id]);
  return id;
};
const closeA = await projectWith('Closing not ready');
await mkTask(closeA, 'Finish the handbook', addDays(20), 'in_progress');
await mkQuestion(closeA, 'Who owns the handbook?');
await mkRisk(closeA, 'The printer may be unavailable');
const closeB = await projectWith('Closing ready');
const keptTask = await mkTask(closeB, 'Print the posters', addDays(20));
const leftQuestion = await mkQuestion(closeB, 'Is the hall free in May?');
const acceptedRisk = await mkRisk(closeB, 'Rain on the day');
const reviewProject = await projectWith('Deadline review check');
await mkTask(reviewProject, 'Paint the hall', addDays(5), 'in_progress');
await mkTask(reviewProject, 'Hang the banners', addDays(6));
const reviewedTask = await mkTask(reviewProject, 'Collect the keys', addDays(7));
await db.end();

const amended = must('amend', await api('POST', `/projects/${recordsId}/changes`, { kind: 'amend_task', targetKind: 'task', targetId: amendTask, terms: { dueOn: addDays(20), reason: 'Waiting on a supplier' }, approve: true }));
must('cancel', await api('POST', `/projects/${recordsId}/changes`, { kind: 'cancel_task', targetKind: 'task', targetId: cancelTask, terms: { reason: 'The room is no longer needed', subtasks: {} } }));
must('replace waiting', await api('POST', `/projects/${recordsId}/changes`, { kind: 'supersede_decision', targetKind: 'decision', targetId: waitingDecision, terms: { statement: 'Use the blue labels', rationale: 'They scan better', reason: 'A test found the red ones unreadable', affected: [] } }));
const replacement = must('replace', await api('POST', `/projects/${recordsId}/changes`, {
  kind: 'supersede_decision', targetKind: 'decision', targetId: replacedDecision,
  terms: { statement: 'Use supplier Beta', rationale: 'Alpha withdrew', reason: 'Alpha withdrew their offer', affected: [{ kind: 'task', id: flaggedTask }, { kind: 'question', id: flaggedQuestion }, { kind: 'risk', id: flaggedRisk }] },
  approve: true,
}));
{
  await new Promise((r) => setTimeout(r, 300));
  const before = readFileSync(API_LOG, 'utf8').length;
  await fetch(`${base}/auth/request-code`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: second }) });
  await new Promise((r) => setTimeout(r, 500));
  const code2 = [...readFileSync(API_LOG, 'utf8').slice(before).matchAll(new RegExp(second.replace(/\./g, '\\.') + ': (\\d{6})', 'g'))].pop()[1];
  const v2 = await fetch(`${base}/auth/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: second, code: code2 }) });
  const cookie2 = v2.headers.get('set-cookie').split(';')[0];
  const csrf2 = (await v2.json()).csrfToken;
  const done = await fetch(`${base}/changes/${replacement.request.id}/approve`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: cookie2, 'x-csrf-token': csrf2 }, body: JSON.stringify({ version: replacement.request.version ?? 1 }) }).then((r) => r.json());
  must('second approval', done);
  if (done.request?.status !== 'authorised') throw new Error('replacement not applied: ' + JSON.stringify(done));
}
// Closing not ready: nothing chosen. Closing ready: every item has a disposition, and the Project Manager may close.
const dispose = (projectId, recordKind, recordId, disposition, reason, extra = {}) => api('POST', `/projects/${projectId}/closure/dispositions`, { recordKind, recordId, disposition, reason, ...extra }).then((r) => must("disposition", r));
await dispose(closeB, 'task', keptTask, 'keep', 'Operations will finish it');
await dispose(closeB, 'question', leftQuestion, 'unresolved', 'Nobody can answer it yet', { affectsDelivery: false });
await dispose(closeB, 'risk', acceptedRisk, 'final_accept', 'The exposure is acceptable');
must('delegation', await api('POST', `/projects/${closeB}/closure/delegation`, { reason: 'The Project Manager knows the work' }));
// Deadline review: defer, then send one new date for authorisation so a request is waiting beside the form.
must('defer', await api('POST', `/projects/${reviewProject}/transition`, { to: 'deferred', reason: 'Funding paused' }));
must('deadline review', await api('POST', `/projects/${reviewProject}/deadline-review`, { tasks: [{ taskId: reviewedTask, dueOn: addDays(30) }] }));
const waiting =await api('POST', `/projects/${recordsId}/proposals`, { kind: 'action', text: 'Book the launch room', owner: 'Ann and Ben', due: 'by 30 November 2026' });
if (!waiting.proposal) throw new Error('proposal not recorded: ' + JSON.stringify(waiting));
// The invitation link is written to the API log (LOG_SIGN_IN_CODES); read it after the invitation was sent.
await new Promise((r) => setTimeout(r, 300));
const inviteToken = [...readFileSync(API_LOG, 'utf8').matchAll(/sponsor\.a11y@example\.org: .*#\/invitations\/([A-Za-z0-9_-]+)/g)].pop()[1];
const handoverToken = [...readFileSync(API_LOG, 'utf8').matchAll(/next\.a11y@example\.org: .*#\/invitations\/([A-Za-z0-9_-]+)/g)].pop()[1];

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
  await page.goto(`${base}/#/invitations/${inviteToken}`, { waitUntil: 'networkidle0' });
  await wait(300);
  await check(`${theme}: invitation, signed out`, page);
  await page.goto(`${base}/#/invitations/${handoverToken}`, { waitUntil: 'networkidle0' });
  await wait(300);
  await check(`${theme}: handover invitation, signed out`, page);
  await ctx.close();
  // Signed in
  page = await open(browser.defaultBrowserContext());
  const [n, ...val] = cookie.split('=');
  await page.setCookie({ name: n, value: val.join('='), domain: 'localhost', path: '/' });
  const screens = [
    ['work tab (tasks, questions, decisions, risks)', `#/projects/${recordsId}/work`],
    ['notes tab with proposals from people', `#/projects/${recordsId}/notes`],
    ['closed project overview (archive panel)', `#/projects/${closedId}`],
    ['my projects', '#/'],
    ['project overview', `#/projects/${projectId}`],
    ['project people', `#/projects/${projectId}/people`],
    ['project notes', `#/projects/${projectId}/notes`],
    ['note', `#/notes/${sourceId}`],
    ['review', `#/runs/${runId}`],
    ['administrators', '#/people'],
    ['departments', '#/departments'],
    ['domains', '#/domains'],
    ['organisation (name and logos)', '#/organisation'],
    ['spending', '#/spending'],
    ['approvals settings (organisation count, override, history)', '#/approvals'],
    ['closing, not ready', `#/projects/${closeA}/closing`],
    ['closing, ready (the Project Manager allowed to close)', `#/projects/${closeB}/closing`],
    ['deadline review (waiting request and new due dates)', `#/projects/${reviewProject}/deadline-review`],
    ['deferred project overview (deadline review link)', `#/projects/${reviewProject}`],
    ['overview with closing, delegation and project approvals', `#/projects/${closeB}`],
  ];
  for (const [label, hash] of screens) {
    await page.goto(`${base}/${hash}`, { waitUntil: 'networkidle0' });
    await page.reload({ waitUntil: 'networkidle0' });
    await wait(300);
    await check(`${theme}: ${label}`, page);
  }
  await page.goto(`${base}/#/runs/${runId}`, { waitUntil: 'networkidle0' });
  await page.reload({ waitUntil: 'networkidle0' });
  const edit = await page.$('article button.link-button');
  if (edit) { await edit.click(); await wait(200); await check(`${theme}: review, editor open`, page); }
  // Forms that open in place: a new project, and a lifecycle change.
  await page.goto(`${base}/#/`, { waitUntil: 'networkidle0' });
  await page.reload({ waitUntil: 'networkidle0' });
  await page.click('main button.primary');
  await wait(300);
  await check(`${theme}: new project form open`, page);
  await page.goto(`${base}/#/projects/${projectId}`, { waitUntil: 'networkidle0' });
  await page.reload({ waitUntil: 'networkidle0' });
  for (const b of await page.$$('main button')) {
    if ((await b.evaluate((e) => e.textContent)) === 'Defer') { await b.click(); break; }
  }
  await wait(300);
  await check(`${theme}: defer form open`, page);
  // Forms on the People tab: handover, grant request; and the department move on the Overview.
  for (const [label, hash, button] of [
    ['handover form open', `#/projects/${projectId}/people`, 'Hand over the project'],
    ['grant request form open', `#/projects/${projectId}/people`, 'Record a request'],
    ['finding form open', `#/projects/${projectId}/people`, 'Record finding'],
    ['department move form open', `#/projects/${projectId}`, 'Move to another department'],
    ['propose form open', `#/projects/${recordsId}/notes`, 'Propose something'],
    ['authorise form open (split into subtasks)', `#/projects/${recordsId}/notes`, 'Authorise'],
    ['task complete form open', `#/projects/${recordsId}/work`, 'Complete'],
    ['risk accept form open', `#/projects/${recordsId}/work`, 'Accept exposure'],
    ['task history open', `#/projects/${recordsId}/work`, 'History'],
    ['amend task form open', `#/projects/${recordsId}/work`, 'Propose a change'],
    ['cancel task form open', `#/projects/${recordsId}/work`, 'Propose cancellation'],
    ['decision replacement form open', `#/projects/${recordsId}/work`, 'Propose a replacement'],
    ['review flag clear form open', `#/projects/${recordsId}/work`, 'Clear'],
    ['request reject form open', `#/projects/${recordsId}/work`, 'Reject'],
    ['closing disposition form open', `#/projects/${closeA}/closing`, 'Choose a disposition'],
    ['deadline review, finished-during-the-pause form open', `#/projects/${reviewProject}/deadline-review`, 'This work was finished during the pause'],
  ]) {
    await page.goto(`${base}/${hash}`, { waitUntil: 'networkidle0' });
    await page.reload({ waitUntil: 'networkidle0' });
    let clicked = false;
    for (const b of await page.$$('main button')) {
      if ((await b.evaluate((e) => e.textContent)) === button) { await b.click(); clicked = true; break; }
    }
    if (!clicked) throw new Error(`no "${button}" button for ${label}`);
    await wait(400);
    await check(`${theme}: ${label}`, page);
  }
  await page.close();
}
// The organisation's branding after setup, then with only one logo of each shape.
for (const [theme, width] of [['wide', 1200], ['narrow', 375]]) {
  await signedOutCheck(theme, width, 'sign-in after setup, both logos', '');
}
await removeLogo('square');
for (const [theme, width] of [['wide', 1200], ['narrow', 375]]) {
  const page = await signedInPage(width);
  await page.goto(`${base}/#/`, { waitUntil: 'networkidle0' });
  await wait(300);
  await check(`${theme}: header with the wide logo only`, page);
  await page.close();
}
await uploadLogo('square');
await removeLogo('wide');
for (const [theme, width] of [['wide', 1200], ['narrow', 375]]) {
  await signedOutCheck(theme, width, 'sign-in with the square logo only', '');
}
await uploadLogo('wide');
await browser.close();
let total = 0;
for (const r of results) {
  total += r.violations.length;
  console.log(`\n## ${r.name}: ${r.violations.length} violation(s)`);
  for (const x of r.violations) { console.log(`- [${x.impact}] ${x.id}: ${x.help}`); for (const n of x.nodes.slice(0, 4)) console.log(`    ${n}`); }
}
console.log(`\nTOTAL violations: ${total}`);
