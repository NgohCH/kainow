// The 11a.1 walk (D133 to D141) of audit.mjs: it does on real projects what a person would do, on screen and with real
// replies, checks what the screens then say, and audits each state at both widths. See README.md.
import { randomUUID } from 'node:crypto';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const addDays = (n) => new Date(Date.now() + 8 * 3600e3 + n * 86400e3).toISOString().slice(0, 10);
const TODAY = "(now() at time zone 'Asia/Kuala_Lumpur')::date";
/** Looks like a credential to Kainow (an API key), and is not one. */
const FAKE_KEY = 'sk-' + 'example'.repeat(4);

/**
 * `wide` and `narrow`: two signed-in pages of the administrator. `check(name, page)` audits a page. `signInAs(email)` gives
 * another person's page. `expectRefusal(page, status, path)` allows one refusal the walk asks for; the audit fails when it
 * does not come.
 */
export async function walkthrough({ base, db, api, must, check, wide, narrow, signInAs, expectRefusal, user, memberId, department }) {
  // --- Helpers ---------------------------------------------------------------------------------------------------------
  const say = (ok, what) => {
    if (!ok) throw new Error(`walkthrough: ${what}`);
  };
  const open = async (page, hash) => {
    await page.goto(`${base}/${hash}`, { waitUntil: 'networkidle0' });
    await page.reload({ waitUntil: 'networkidle0' });
    await wait(300);
  };
  /** Until nothing says it is loading, and what came has been drawn. */
  const settle = async (page) => {
    await wait(400);
    await page.waitForFunction(() => !document.querySelector('main .loading, .loading'), { timeout: 8000 });
    await wait(400);
  };
  const text = (page, scope = 'main') => page.$eval(scope, (e) => e.innerText.replace(/\s+/g, ' '));
  const hashOf = (page) => page.evaluate(() => location.hash);
  const focused = (page) => page.evaluate(() => document.activeElement?.id ?? '');
  /** What one box or table says, by its heading or caption; '' when it is not there. */
  const partText = (page, name) =>
    page.evaluate((n) => {
      const at = [...document.querySelectorAll('main h1, main h2, main h3, main caption')].find((e) => e.textContent.trim() === n);
      return at ? at.closest('table, section, .box').innerText.replace(/\s+/g, ' ') : '';
    }, name);
  const sees = async (page, wanted, scope) => {
    const until = Date.now() + 8000;
    let now = '';
    do {
      now = await text(page, scope);
      if (now.includes(wanted)) return;
      await wait(150);
    } while (Date.now() < until);
    throw new Error(`walkthrough: "${wanted}" is not on ${await hashOf(page)}:\n${now.slice(0, 1500)}`);
  };
  /** Presses the button or link with exactly this text (hidden words aside), or one matching a pattern, inside `scope`. */
  const press = async (page, label, scope = 'main') => {
    const until = Date.now() + 8000;
    do {
      for (const b of await page.$$(`${scope} button, ${scope} a`)) {
        const words = await b.evaluate((e) => {
          const t = [...e.childNodes].filter((n) => !n.classList?.contains('visually-hidden')).map((n) => n.textContent).join('').trim();
          return e.getClientRects().length > 0 && !e.disabled ? t : null;
        });
        if (words !== null && (label instanceof RegExp ? label.test(words) : words === label)) {
          await b.evaluate((e) => e.scrollIntoView({ block: 'center' }));
          await b.click();
          await wait(350);
          return words;
        }
      }
      await wait(150);
    } while (Date.now() < until);
    throw new Error(`walkthrough: nothing to press called "${label}" in ${scope} on ${await hashOf(page)}:\n${(await text(page)).slice(0, 1500)}`);
  };
  /** Sets the field whose label starts with `label`, as typing or choosing does (the page hears input and change). */
  const fill = async (page, label, value, scope = 'main') => {
    const done = await page.evaluate(
      (start, v, within) => {
        for (const l of document.querySelectorAll(`${within} label`)) {
          if (!l.textContent.trim().startsWith(start)) continue;
          const el = l.querySelector('input, textarea, select') ?? document.getElementById(l.htmlFor);
          if (!el || el.disabled) continue;
          if (el.type === 'checkbox' || el.type === 'radio') {
            if (el.checked !== v) el.click();
            return true;
          }
          const proto = el.tagName === 'SELECT' ? HTMLSelectElement : el.tagName === 'TEXTAREA' ? HTMLTextAreaElement : HTMLInputElement;
          const set = el.tagName === 'SELECT' ? [...el.options].find((o) => o.value === v || o.textContent.trim().startsWith(v))?.value : v;
          if (set === undefined) return false;
          Object.getOwnPropertyDescriptor(proto.prototype, 'value').set.call(el, set);
          el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
          return true;
        }
        return false;
      },
      label,
      value,
      scope,
    );
    say(done, `no field "${label}" in ${scope} on ${await hashOf(page)}`);
    await wait(150);
  };
  /** Audits one address at both widths; `prepare` first puts each page in the state to audit. */
  const both = async (label, hash, prepare) => {
    for (const [name, page] of [['narrow', narrow], ['wide', wide]]) {
      await open(page, hash);
      if (prepare) await prepare(page);
      await check(`${name}: ${label}`, page);
    }
  };
  /** Follows a link by a click (not by its address); returns where it went. */
  const follow = async (page, selector) => {
    await page.waitForSelector(selector, { timeout: 8000 }).catch(async () => {
      throw new Error(`walkthrough: no link ${selector} on ${await hashOf(page)}:\n${(await text(page)).slice(0, 2500)}`);
    });
    const href = await page.$eval(selector, (e) => {
      e.scrollIntoView({ block: 'center' });
      return e.getAttribute('href');
    });
    await page.click(selector);
    await page.waitForFunction((h) => location.hash === h, { timeout: 8000 }, href);
    await settle(page);
    return href;
  };
  const member = (projectId, who, role, from = 0, until = null) =>
    db.query(`insert into memberships (id, project_id, user_id, role, starts_on, expires_on) values ($1, $2, $3, $4, ${TODAY} - $5::int, $6)`, [randomUUID(), projectId, who, role, from, until]);

  // --- The project the walk works in: created, staffed and started ---------------------------------------------------------
  const project = async (name) => {
    const id = must(name, await api('POST', '/projects', { name, purpose: `Check the changes from the demo walkthrough: ${name}.`, owningDepartmentId: department.id, plannedEnd: addDays(90) })).project.id;
    await member(id, user, 'owner', 30);
    await member(id, memberId, 'member', 30);
    for (const to of ['planned', 'active']) must(to, await api('POST', `/projects/${id}/transition`, { to }));
    return id;
  };
  const walkId = await project('Alpha rollout 2026');
  const authorised = async (title, due, extra = {}) => {
    const p = must('propose', await api('POST', `/projects/${walkId}/proposals`, { kind: 'action', text: title, description: `How to do it for Alpha: ${title}.` })).proposal;
    const r = must('authorise', await api('POST', `/proposals/${p.id}/authorise`, { assigneeId: user, dueOn: due, subtasks: [], ...extra }));
    return { proposalId: p.id, taskId: r.record.id };
  };
  const kiosks = await authorised('Install the Alpha kiosks', addDays(2), { subtasks: [{ title: 'Test the kiosk in the lobby', assigneeId: user, dueOn: addDays(2) }] });
  const labels = await authorised('Print the Alpha labels', addDays(5));
  const guide = await authorised('Translate the Alpha guide', addDays(6));
  await authorised('Return the old kiosks', addDays(-2));
  for (let i = 1; i <= 5; i++) await authorised(`Check room ${i}`, addDays(20 + i));
  const risk = must('risk', await api('POST', `/projects/${walkId}/proposals`, { kind: 'risk', text: 'The Alpha supplier may be late' })).proposal;
  must('risk record', await api('POST', `/proposals/${risk.id}/authorise`, { severity: 'high', responsibleId: user }));

  // --- D133: the task page in every status, moved on by the person it is assigned to ----------------------------------------
  const taskHash = (id) => `#/projects/${walkId}/tasks/${id}`;
  await both('task page, not started (a subtask, its own proposal)', taskHash(kiosks.taskId));
  for (const words of ['Not started: nobody has begun the work yet.', 'How to do it for Alpha: Install the Alpha kiosks.', 'Test the kiosk in the lobby', 'Due soon']) await sees(wide, words);
  await press(wide, 'Start');
  await sees(wide, 'Start: done.');
  await both('task page, in progress', taskHash(kiosks.taskId));
  await sees(wide, 'In progress: the work is under way.');
  await both('task page, block form open', taskHash(kiosks.taskId), (page) => press(page, 'Block'));
  await fill(wide, 'Why is it blocked?', 'The floor is not ready');
  await press(wide, 'Block', '.task-page form');
  await sees(wide, 'Block: done.');
  await both('task page, blocked (reason, who and when)', taskHash(kiosks.taskId));
  await sees(wide, 'Blocked: the work cannot continue. The due date has not moved.');
  await sees(wide, 'Reason: The floor is not ready. Blocked by');
  await press(wide, 'Unblock');
  await fill(wide, 'How was it resolved?', 'The floor is ready');
  await press(wide, 'Unblock', '.task-page form');
  await sees(wide, 'Unblock: done.');
  await sees(wide, 'In progress: the work is under way.');
  say(!(await text(wide)).includes('the work cannot continue'), 'an unblocked task still reads as blocked');
  await open(wide, taskHash(labels.taskId));
  await press(wide, 'Start');
  await sees(wide, 'Start: done.');
  await press(wide, 'Complete');
  await fill(wide, 'Completion note', 'Printed and checked');
  await press(wide, 'Complete', '.task-page form');
  await sees(wide, 'Complete: done.');
  await both('task page, completed', taskHash(labels.taskId));
  await sees(wide, 'Completed: the work is finished.');
  must('cancel', await api('POST', `/projects/${walkId}/changes`, { kind: 'cancel_task', targetKind: 'task', targetId: guide.taskId, terms: { reason: 'English only', subtasks: {} }, approve: true }));
  await both('task page, cancelled', taskHash(guide.taskId));
  await sees(wide, 'Cancelled: the work will not be done.');
  await both('task page, Propose a change open', taskHash(kiosks.taskId), (page) => press(page, 'Propose a change'));
  // The old address still opens the Work tab at the task's row.
  await open(wide, `#/projects/${walkId}/work/${kiosks.taskId}`);
  say((await focused(wide)) === `item-${kiosks.taskId}`, `#/projects/…/work/<task> does not open at its row (focus on "${await focused(wide)}")`);

  // --- D136: a person's own proposal and its record, both ways ---------------------------------------------------------------
  await open(wide, taskHash(kiosks.taskId));
  await follow(wide, `main a[href="#/projects/${walkId}/proposals/${kiosks.proposalId}"]`);
  say((await focused(wide)) === `item-${kiosks.proposalId}`, 'the task does not open its proposal');
  await follow(wide, `[id="item-${kiosks.proposalId}"] a[href="${taskHash(kiosks.taskId)}"]`);
  await sees(wide, 'In progress: the work is under way.');

  // A finished AI run on a note, and one on a discussion; each proposal is authorised on the review screen.
  const me = (await db.query('select display_name from users where id = $1', [user])).rows[0].display_name;
  const addRun = async (versionId, body, items) => {
    const runId = randomUUID();
    await db.query("insert into extraction_runs (id, source_version_id, requested_by, status, model_id, attempts, item_count, unlocated_count, created_at, finished_at) values ($1, $2, $3, 'succeeded', 'gpt-6.1-sol', 1, $4, 0, now(), now())", [runId, versionId, user, items.length]);
    const ids = [];
    for (const [i, [kind, words, quote]] of items.entries()) {
      ids.push(randomUUID());
      const at = body.indexOf(quote);
      await db.query('insert into extraction_items (id, run_id, source_version_id, position, kind, text, owner, due, quote, quote_start, quote_end, quote_matches, created_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 1, now())', [ids[i], runId, versionId, i, kind, words, kind === 'action' ? 'Priya' : null, kind === 'action' ? `by ${addDays(4)}` : null, quote, at, at + quote.length]);
    }
    return { runId, ids, hash: (n) => `#/runs/${runId}/${ids[n]}` };
  };
  /** Authorises a proposal on the review screen and follows its link to the record; returns the record's address. */
  const authorise = async (run, n, fields = []) => {
    await open(wide, run.hash(n));
    const card = `[id="item-${run.ids[n]}"]`;
    await press(wide, 'Authorise', card);
    for (const [label, value] of fields) await fill(wide, label, value, 'form[aria-label="Authorise this proposal"]');
    await press(wide, 'Authorise', 'form[aria-label="Authorise this proposal"]');
    return follow(wide, `${card} a.badge-approved`);
  };
  const idIn = (hash) => hash.split('/').pop();

  const noteText = 'The team met.\nPriya will order the Alpha cables by Friday.\nThe go-live date was agreed.';
  const note = must('note', await api('POST', `/projects/${walkId}/notes`, { title: 'Alpha kick-off', text: noteText }));
  const sourceId = note.source?.id ?? note.id;
  const noteRun = await addRun(note.version.id, noteText, [['action', 'Order the Alpha cables', 'Priya will order the Alpha cables by Friday.'], ['decision', 'Agree the go-live date', 'The go-live date was agreed.']]);
  // The task: its page quotes the note, opens its proposal, and the proposal opens the very passage.
  const cables = await authorise(noteRun, 0, [['Accountable person', me], ['Due date', addDays(4)]]);
  say(cables === taskHash(idIn(cables)), `an authorised action links to ${cables}, not to its task page`);
  await both('task page, from a note (its quote and source)', cables);
  await sees(wide, 'Priya will order the Alpha cables by Friday.');
  await follow(wide, `main a[href="${noteRun.hash(0)}"]`);
  const passage = await follow(wide, `[id="item-${noteRun.ids[0]}"] a[href^="#/notes/"]`);
  say(/^#\/notes\/[0-9a-f-]{36}\/v\/1\?at=\d+-\d+$/.test(passage), `the review does not link to the passage: ${passage}`);
  say((await wide.$eval('main mark[id^="item-place-"]', (e) => e.textContent)) === 'Priya will order the Alpha cables by Friday.', 'the note does not mark the passage');
  say((await focused(wide)).startsWith('item-place-'), 'the passage does not have the focus');
  await both("note opened at a proposal's passage", passage);
  await both('review opened at one proposal, linked to its task', noteRun.hash(0));
  await both('proposals tab, with sources, records and people’s proposals', `#/projects/${walkId}/proposals`);
  await follow(wide, `main a[href="#/notes/${sourceId}/v/1"]`);
  await sees(wide, 'The go-live date was agreed.');
  // A decision: its row in Work, and back.
  const decision = await authorise(noteRun, 1);
  say(decision === `#/projects/${walkId}/work/${idIn(decision)}`, `an authorised decision links to ${decision}, not to its row in Work`);
  say((await focused(wide)) === `item-${idIn(decision)}`, "the decision's row does not have the focus");
  await follow(wide, `[id="item-${idIn(decision)}"] a[href="${noteRun.hash(1)}"]`);

  // The discussion's transcript, its places and its run are written as the analysis writes them.
  const thread = must('thread', await api('POST', `/projects/${walkId}/threads`, { kind: 'discussion', title: 'Alpha cabling' }));
  const threadId = thread.thread?.id ?? thread.id;
  const said = 'We will use the blue cables in every room.';
  must('message', await api('POST', `/threads/${threadId}/messages`, { body: said }));
  const message = (await db.query('select m.message_no, m.author_id, v.id as version_id from discussion_messages m join message_versions v on v.message_id = m.id where m.thread_id = $1 order by m.message_no limit 1', [threadId])).rows[0];
  const [talkSource, talkVersion, header] = [randomUUID(), randomUUID(), '[1] Access Check\n'];
  const transcript = header + said;
  await db.query("insert into sources (id, title, created_by, created_at, project_id, kind, audience_id, thread_id) select $1, 'Discussion: Alpha cabling', $2, now(), $3, 'discussion', audience_id, id from discussion_threads where id = $4", [talkSource, user, walkId, threadId]);
  await db.query("insert into source_versions (id, source_id, version_no, origin, text_content, text_sha256, char_count, created_by, created_at) values ($1, $2, 1, 'discussion', $3, 'h', $4, $5, now())", [talkVersion, talkSource, transcript, transcript.length, user]);
  await db.query('insert into transcript_spans (source_version_id, message_no, message_version_id, author_id, header_start, body_start, body_end) values ($1, $2, $3, $4, 0, $5, $6)', [talkVersion, message.message_no, message.version_id, message.author_id, header.length, transcript.length]);
  const talkRun = await addRun(talkVersion, transcript, [['decision', 'Use the blue cables', said], ['action', 'Order the blue cables', said]]);
  const blue = await authorise(talkRun, 0);
  await follow(wide, `[id="item-${idIn(blue)}"] a[href="${talkRun.hash(0)}"]`);
  const toMessage = await follow(wide, `[id="item-${talkRun.ids[0]}"] a[href*="/threads/${threadId}"]`);
  say(toMessage.endsWith(`?m=${message.message_no}`), `the review does not link to the message: ${toMessage}`);
  await sees(wide, said);
  const order = await authorise(talkRun, 1, [['Accountable person', me], ['Due date', addDays(30)]]);
  await both('task page, from a discussion (its message)', order);
  await follow(wide, `main a[href="${toMessage}"]`);
  await open(wide, order);
  await follow(wide, `main a[href="${talkRun.hash(1)}"]`);
  await both('review of a discussion (message links)', talkRun.hash(0));
  await open(wide, `#/projects/${walkId}/proposals`);
  await follow(wide, `main td a[href*="/threads/${threadId}"], main table a[href*="/threads/${threadId}"]`);

  // --- The first resource catalogue item, its new category in the same form --------------------------------------------------
  const firstItem = async (page) => {
    await press(page, '+ Add item');
    await fill(page, 'Reference', 'P-01', '.item-form');
    await fill(page, 'Name', 'Portable projector', '.item-form');
    await fill(page, 'Category', 'New category', '.item-form');
    await fill(page, 'New category name', 'Presentation equipment', '.item-form');
  };
  await both('resource catalogue, empty', '#/resource-catalogue');
  await both("resource catalogue, the first item's form with a new category", '#/resource-catalogue', firstItem);
  await press(wide, 'Add item', '.item-form');
  await sees(wide, 'Category Presentation equipment added. Item added.');
  await both('resource catalogue, with its first item and category', '#/resource-catalogue');
  say((await partText(wide, 'Items')).includes('Portable projector'), 'the first item is not in the catalogue');
  say((await partText(wide, 'Categories')).includes('Presentation equipment'), 'the new category is not in the catalogue');
  const item = must('catalogue', await api('GET', '/resources/catalogue')).items[0];
  must('line', await api('POST', `/projects/${walkId}/resources/lines`, { itemId: item.id }));

  // --- D137: a stage renamed ---------------------------------------------------------------------------------------------------
  const renameForm = 'form[aria-label="Rename Planning"]';
  const startRename = async (page, name) => {
    await page.click('main button[data-opener="stages"]');
    await wait(400);
    await fill(page, 'Reason for the change', 'The sponsor calls it drafting');
    await page.$eval('main button[aria-label="Rename Planning"]', (e) => e.click());
    await wait(200);
    await fill(page, 'New name', name, renameForm);
  };
  await both('stage rename form, a name already used refused', `#/projects/${walkId}/settings`, async (page) => {
    await startRename(page, 'Execution');
    await press(page, 'Save name', renameForm);
    say(await page.$(`${renameForm} [role="alert"]`), 'a stage name already used is not refused');
  });
  await open(wide, `#/projects/${walkId}/settings`);
  await startRename(wide, 'Drafting');
  await press(wide, 'Save name', renameForm);
  await sees(wide, 'Planning renamed to Drafting.');
  await sees(wide, 'Renamed Planning to Drafting.');
  await open(wide, `#/projects/${walkId}`);
  await sees(wide, 'Drafting');

  // --- D138: a real project deferred, resumed, deferred, closed, reopened and closed while Active --------------------------------
  const lifeId = await project('Lifecycle walk');
  await db.query("update project_stage_periods set started_at = now() - interval '40 days' where project_id = $1", [lifeId]);
  const overview = `#/projects/${lifeId}`;
  /** Presses a lifecycle button on the Overview, gives the reason and sends it. */
  const change = async (label, reason) => {
    await open(wide, overview);
    await press(wide, label);
    await fill(wide, 'Reason', reason, `form[aria-label="${label}"]`);
    await press(wide, label, `form[aria-label="${label}"]`);
    await sees(wide, `${label}: done.`);
  };
  const close = async (outcome, reason) => {
    const form = 'form[aria-label="Close the project"]';
    await open(wide, `#/projects/${lifeId}/closing`);
    await fill(wide, outcome, true, form);
    await fill(wide, 'Reason', reason, form);
    await press(wide, 'Close', form);
    await wide.waitForFunction((h) => location.hash === h, { timeout: 8000 }, overview);
    await settle(wide);
  };
  /**
   * What the Overview (header, stage flow, History), the Timeline's bars and Projects say. `stopped`: what stopped the last
   * stage, null while it runs. `stops`: how many stages each kind of stop ended. `table`: its place in Projects and what that row says.
   */
  const looks = async (state, { stopped, deferred, closed, table, says }) => {
    const words = stopped && `Stopped when ${stopped}`;
    await both(`overview, ${state}`, overview);
    for (const part of ['.project-facts', '.stage-flow']) {
      const seen = await text(wide, `main ${part}`);
      say(words ? seen.includes(words) : !seen.includes('Stopped when'), `${state}: ${part} says "${seen}"`);
    }
    const past = await partText(wide, 'History');
    const times = (all, what) => all.split(what).length - 1;
    say(times(past, '(stopped when deferred)') === deferred && times(past, '(stopped when closed)') === closed, `${state}: the Overview's History is wrong: ${past}`);
    say(times(past, '(current)') === (stopped ? 0 : 1), `${state}: the Overview's History names the wrong current stage: ${past}`);
    await both(`timeline, ${state}`, `#/projects/${lifeId}/timeline`);
    const bars = await partText(wide, 'Bars');
    say(times(bars, 'Stopped when deferred') === deferred && times(bars, 'Stopped when closed') === closed, `${state}: the bars are wrong: ${bars}`);
    say(bars.includes('● Current') === !stopped, `${state}: the bars' current stage is wrong: ${bars}`);
    await both(`projects and their History, ${state}`, '#/projects');
    for (const caption of ['Current projects', 'Deferred', 'Closed']) {
      const seen = await partText(wide, caption);
      say(seen.includes('Lifecycle walk') === (caption === table), `${state}: ${caption} says "${seen}"`);
      if (caption === table && says) say(seen.includes(says) && (caption === 'Current projects' || seen.includes(String(new Date().getUTCFullYear()))), `${state}: ${caption} does not say "${says}" and the day: ${seen}`);
    }
  };
  await looks('active', { stopped: null, deferred: 0, closed: 0, table: 'Current projects' });
  await change('Defer', 'Funding paused until March');
  await looks('deferred', { stopped: 'deferred', deferred: 1, closed: 0, table: 'Deferred', says: 'Funding paused until March' });
  await both('home, with a link to History', '#/');
  await sees(wide, 'in History');
  say(!(await text(wide)).includes('Lifecycle walk'), 'Home lists a Deferred project');
  await follow(wide, 'main a[href="#/projects/history"]');
  say((await wide.evaluate(() => document.activeElement?.getAttribute('aria-label'))) === 'History', "Home's link does not go to History");
  await change('Resume', 'Funding is back');
  await looks('resumed', { stopped: null, deferred: 1, closed: 0, table: 'Current projects' });
  await change('Defer', 'The site is closed');
  await looks('deferred a second time', { stopped: 'deferred', deferred: 2, closed: 0, table: 'Deferred', says: 'The site is closed' });
  await close('Partially Delivered', 'Enough was delivered');
  await looks('closed after a deferral', { stopped: 'deferred', deferred: 2, closed: 0, table: 'Closed', says: 'Partially Delivered' });
  await change('Reopen', 'More was asked for');
  await looks('reopened', { stopped: null, deferred: 2, closed: 0, table: 'Current projects' });
  await close('Abandoned', 'The customer withdrew');
  await looks('closed while active', { stopped: 'closed', deferred: 2, closed: 1, table: 'Closed', says: 'Abandoned' });
  await both('project tab bar and Stages of a closed project', `#/projects/${lifeId}/settings`);

  // --- D141: Home and My tasks by project ---------------------------------------------------------------------------------------
  await both('home, Needs you by project and My tasks by project', '#/', (page) => fill(page, 'View', 'project'));
  say((await wide.$$('main .project-group')).length > 1, 'Home is not grouped by project');
  await both('my tasks as a board', '#/my-tasks', (page) => fill(page, 'View', 'board'));
  await both('my tasks by project, every row of a box shown', '#/my-tasks', async (page) => { await fill(page, 'View', 'project'); await press(page, /^Show all \d+$/); });
  await both('my tasks by project, a box closed', '#/my-tasks', async (page) => { await fill(page, 'View', 'project'); await page.click('main .project-group-toggle'); });
  await both('my tasks by due date', '#/my-tasks', (page) => fill(page, 'View', 'due'));
  say(!(await wide.$('main .project-group')) && (await wide.$('main table')), 'My tasks by due date is still grouped');

  // --- D134: My profile, with a past role and a retired department -------------------------------------------------------------
  await member(lifeId, user, 'sponsor', 60, addDays(-10));
  const old = must('department', await api('POST', '/departments', { name: 'Old department' })).department;
  await open(wide, '#/');
  await wide.click('#person-menu-button');
  await wait(200);
  await press(wide, 'My profile', '#person-menu-panel');
  say((await hashOf(wide)) === '#/me', 'My profile in the person menu does not open #/me');
  await both('my profile, department form open', '#/me', (page) => page.click('main button[data-opener="department"]'));
  await fill(wide, 'Your department', 'Old department');
  await press(wide, 'Save department');
  await wait(500);
  must('retire', await api('POST', `/departments/${old.id}/retire`, { reason: 'Merged' }));
  await both('my profile, with a past role and a retired department', '#/me');
  await sees(wide, 'Old department (retired)');
  say((await partText(wide, 'Past roles')).includes('Lifecycle walk'), 'the past role is not listed');

  // --- D140: Duplicate, refused and created --------------------------------------------------------------------------------------
  const duplicate = `#/projects/${walkId}/duplicate`;
  await both('duplicate project, nothing changed yet', duplicate);
  say(await wide.evaluate(() => [...document.querySelectorAll('main button')].find((b) => b.textContent === 'Create project').disabled), 'Create is on before anything was changed');
  /** The page warns before it is left with input: the walk leaves on purpose. */
  const leave = async (page) => {
    page.once('dialog', (d) => void d.accept());
    await page.goto('about:blank');
  };
  const rename = async (page, name, terms) => {
    await fill(page, 'Name', name);
    await fill(page, 'No planned end', true);
    await fill(page, 'Old terms to look for', terms);
    await wait(700);
  };
  const confirmAll = (page) =>
    page.evaluate(async () => {
      for (let i = 0; i < 100; i++) {
        const box = [...document.querySelectorAll('main .carried.open label.check input')].find((e) => /Still correct/.test(e.parentElement.textContent) && !e.checked);
        if (!box) return;
        box.click();
        await new Promise((r) => setTimeout(r, 60));
      }
    });
  for (const [name, page] of [['narrow', narrow], ['wide', wide]]) {
    await open(page, duplicate);
    await rename(page, 'Beta rollout 2027', 'Alpha\n2026');
    say((await page.$$('main .carried mark')).length > 3, 'the old terms are not marked');
    await check(`${name}: duplicate project, old terms marked`, page);
    await confirmAll(page);
    await fill(page, 'Purpose', `Roll out Beta with ${FAKE_KEY}`);
    await wait(700);
    await check(`${name}: duplicate project, every old term confirmed`, page);
    expectRefusal(page, 400, /\/duplicate$/);
    await press(page, 'Create project');
    await sees(page, 'The project was not created');
    await check(`${name}: duplicate project, refused (a text looks like a credential)`, page);
    if (page === narrow) await leave(page);
  }
  await fill(wide, 'Purpose', 'Roll out Beta');
  await wait(500);
  await press(wide, 'Create project');
  await wide.waitForFunction(() => /^#\/projects\/[0-9a-f-]{36}$/.test(location.hash), { timeout: 10_000 });
  await settle(wide);
  await sees(wide, 'Beta rollout 2027');
  await sees(wide, 'Copied from Alpha rollout 2026');
  const copyId = idIn(await hashOf(wide));
  await both("a copied project's overview (its origin)", `#/projects/${copyId}`);
  await sees(wide, 'Start the project to authorise proposals');
  await both("a copied project's proposals while it is a Draft (why none can be authorised)", `#/projects/${copyId}/proposals`);
  await sees(wide, 'Start the project to authorise proposals');
  await both("a copied project's resources", `#/projects/${copyId}/resources`);
  // A Sponsor of the copy who may not open the original sees neither its name nor a link.
  const sponsorId = randomUUID();
  await db.query("insert into users (id, email, display_name, role) values ($1, 'copy.a11y@example.org', 'Copy Sponsor', 'member')", [sponsorId]);
  await member(copyId, sponsorId, 'sponsor');
  await member(copyId, user, 'owner');
  await member(copyId, memberId, 'member');
  // Authorising starts once the copy is under way, as in any project.
  for (const to of ['planned', 'active']) must(to, await api('POST', `/projects/${copyId}/transition`, { to }));
  const sponsor = await signInAs('copy.a11y@example.org');
  await open(sponsor.page, `#/projects/${copyId}/proposals`);
  await sees(sponsor.page, 'Copied from another project');
  say(!(await sponsor.page.content()).includes('Alpha rollout 2026') && !(await sponsor.page.content()).includes(walkId), "the original's name or address reaches someone who may not open it");
  await check('wide: a copy’s proposals, to someone who may not open the original', sponsor.page);
  await sponsor.close();

  // Authorise several: what is missing is named, then every chosen action is authorised.
  const several = 'main section[aria-labelledby="several-heading"]';
  await both('authorise several, all chosen, with what is missing named', `#/projects/${copyId}/proposals`, async (page) => {
    await press(page, 'Authorise several');
    await press(page, 'Select all', several);
    await press(page, /^Authorise \d+ actions?$/, several);
    await sees(page, 'an assignee or a due date', several);
  });
  await wide.evaluate(
    (scope, userId, due) => {
      const set = (el, v, kind) => {
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, v);
        el.dispatchEvent(new Event(kind, { bubbles: true }));
      };
      for (const s of document.querySelectorAll(`${scope} select`)) set(s, userId, 'change');
      for (const d of document.querySelectorAll(`${scope} input[type="date"]`)) set(d, due, 'input');
    },
    several,
    user,
    addDays(20),
  );
  await wait(400);
  const pressed = await press(wide, /^Authorise \d+ actions?$/, several);
  const n = pressed.match(/\d+/)[0];
  await sees(wide, `${n} of ${n} accepted.`, several);
  await check('wide: authorise several, accepted', wide);
  await follow(wide, `${several} a[href*="/tasks/"]`);
  await sees(wide, 'Not started: nobody has begun the work yet.');

  // --- D140: Duplicate refused while a case is open, and the copied line on the case ----------------------------------------------
  await open(wide, duplicate);
  await rename(wide, 'Gamma rollout 2028', '');
  await confirmAll(wide);
  await wait(500);
  must('report', await api('POST', `/projects/${walkId}/secret-reports`, { kind: 'task', id: labels.taskId, marked: ['labels'], reason: 'It may hold a door code' }));
  expectRefusal(wide, 409, /\/duplicate$/);
  await press(wide, 'Create project');
  await sees(wide, 'under review');
  await check('wide: duplicate project, refused while a case is open (Load again)', wide);
  for (let n = 0; n < 2; n++) {
    await press(wide, 'Load again');
    await wide.waitForFunction(() => document.activeElement?.textContent?.startsWith('Loaded again.'), { timeout: 10_000 });
    await wide.evaluate(() => document.activeElement.blur());
  }
  await leave(wide);
  await both('duplicate project, opened while a case is open', duplicate);
  await sees(wide, 'This project cannot be copied now');
  await both('organisation, a quarantine case of a copied project', '#/organisation');
  await sees(wide, 'This project was copied to Beta rollout 2027. Check these projects too.');
  await both('security review, a quarantine case of a copied project', '#/security/cases');
  await sees(wide, 'This project was copied to');

  // --- D135: the three tab styles, Light and Dark, on a project whose tabs carry a count ---------------------------------------------
  await api('POST', `/projects/${walkId}/proposals`, { kind: 'question', text: 'Who keeps the spare cables?' });
  for (const tabStyle of ['grey', 'tinted', 'boxes']) {
    for (const theme of ['light', 'dark']) {
      must('preferences', await api('PUT', '/me/preferences', { theme, accent: 'red', accentChosen: true, tabStyle }));
      await both(`tab style ${tabStyle}, ${theme}`, `#/projects/${walkId}/work`);
      say((await wide.$eval('html', (e) => e.getAttribute('data-tabs'))) === tabStyle, `the tabs are not in the ${tabStyle} style`);
    }
  }
  for (const [label, hash] of [
    ['task page', taskHash(kiosks.taskId)],
    ['my profile', '#/me'],
    ['projects with History', '#/projects'],
    ['home by project', '#/'],
    ['timeline of a closed project', `#/projects/${lifeId}/timeline`],
    ['duplicate project', `#/projects/${copyId}/duplicate`],
    ['proposals', `#/projects/${copyId}/proposals`],
  ]) {
    await both(`${label}, Dark`, hash);
  }
  // Choosing a style on My profile changes the tabs at once, and it is kept.
  await open(wide, '#/me');
  await fill(wide, 'Grey dividers', true);
  await wait(600);
  say((await wide.$eval('html', (e) => e.getAttribute('data-tabs'))) === 'grey', 'choosing Grey dividers on My profile does not change the tabs');
  await wide.reload({ waitUntil: 'networkidle0' });
  say((await wide.$eval('html', (e) => e.getAttribute('data-tabs'))) === 'grey', 'the chosen tab style is not kept');
  must('preferences', await api('PUT', '/me/preferences', { theme: 'light', accent: 'red', accentChosen: false, tabStyle: 'boxes' }));
}
