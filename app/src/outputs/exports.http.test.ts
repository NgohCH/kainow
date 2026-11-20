import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { uuidv7 } from '../common/uuid7';
import { ProjectAccess } from '../projects/access.service';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedProject, seedUser } from '../testing/projects';
import { COVERAGE, EXPORTS_OFF, EXPORT_COLUMNS, EXPORT_KINDS, MAX_CELL, NOT_AN_EXPORT_ROLE, buildExport, mayExport } from './exports';

const reason = 'Agreed at the board';
const SECRET = `sk-${'a1B2c3D4e5'.repeat(3)}`;
const UNDER_REVIEW = 'Credential removed — under review';

/** One CSV line into cells (RFC 4180 quoting). */
function parseLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** The `#` lines as a map, the header, and the rows. Cells here have no line breaks, so lines are records. */
function parseCsv(text: string) {
  assert.ok(text.endsWith('\r\n'), `ends with CRLF: ${JSON.stringify(text.slice(-80))}`);
  const lines = text.slice(0, -2).split('\r\n');
  const meta: Record<string, string> = {};
  let i = 0;
  for (; lines[i].startsWith('# '); i++) {
    const at = lines[i].indexOf(': ');
    meta[lines[i].slice(2, at)] = lines[i].slice(at + 2);
  }
  return { meta, header: parseLine(lines[i]), rows: lines.slice(i + 1).map(parseLine) };
}

describe('project exports (D106)', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  const ids: Record<string, string> = {};
  const c: Record<string, Client> = {};
  let project: string;
  const url = (kind: string, extra = '') => `/projects/${project}/export?kind=${kind}${extra}`;
  const on = () => t.pool.query(`UPDATE access_settings SET project_exports_allowed = true`);
  const roles = (r: string[]) => t.pool.query(`INSERT INTO project_output_settings (project_id, export_roles, updated_by, updated_at) VALUES ($1, $2, $3, now())
                                               ON CONFLICT (project_id) DO UPDATE SET export_roles = EXCLUDED.export_roles`, [project, r, ids.pm]);
  const csv = async (client: Client, kind: string, extra = '') => {
    const r = await client.raw('GET', url(kind, extra));
    assert.equal(r.status, 200, r.text);
    return parseCsv(r.text);
  };
  const proposal = async (kind: string, text: string) => {
    const id = uuidv7();
    await t.pool.query(
      `INSERT INTO human_proposals (id, project_id, kind, text, proposed_by, proposed_at, review_status, reviewed_by, reviewed_at) VALUES ($1, $2, $3, $4, $5, now(), 'approved', $5, now())`,
      [id, project, kind, text, ids.pm],
    );
    return id;
  };
  const task = async (o: { title: string; status?: string; parent?: string; due?: string; assignee?: string; completedAt?: string; review?: boolean }) => {
    const id = uuidv7();
    await t.pool.query(
      `INSERT INTO tasks (id, project_id, parent_id, depth, title, assignee_id, due_on, status, authorised_by, authorised_at, completed_at, deadline_review_required)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, '2026-11-02T03:00:00Z', $10, $11)`,
      [id, project, o.parent ?? null, o.parent ? 1 : 0, o.title, o.assignee ?? ids.ann, o.due ?? '2026-11-20', o.status ?? 'not_started', ids.pm, o.completedAt ?? null, o.review ?? false],
    );
    return id;
  };
  const decision = async (statement: string, o: { status?: string; replaces?: string; rationale?: string } = {}) => {
    const id = uuidv7();
    await t.pool.query(
      `INSERT INTO decisions (id, project_id, statement, rationale, status, origin_proposal_id, replaces_id, authorised_by, authorised_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '2026-11-03T03:00:00Z')`,
      [id, project, statement, o.rationale ?? null, o.status ?? 'active', await proposal('decision', `Origin of ${statement}`), o.replaces ?? null, ids.pm],
    );
    return id;
  };
  const question = async (text: string, status = 'open') => {
    const id = uuidv7();
    await t.pool.query(
      `INSERT INTO questions (id, project_id, text, status, requester_id, origin_proposal_id, authorised_by, authorised_at) VALUES ($1, $2, $3, $4, $5, $6, $7, '2026-11-04T03:00:00Z')`,
      [id, project, text, status, ids.ann, await proposal('question', `Origin of ${text}`), ids.pm],
    );
    return id;
  };
  const risk = async (description: string, o: { status?: string; severity?: string; reviewOn?: string | null } = {}) => {
    const id = uuidv7();
    await t.pool.query(
      `INSERT INTO risks (id, project_id, description, severity, status, responsible_id, review_on, origin_proposal_id, authorised_by, authorised_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, '2026-11-05T03:00:00Z')`,
      [id, project, description, o.severity ?? 'medium', o.status ?? 'open', ids.ann, o.reviewOn ?? null, await proposal('risk', `Origin of ${description}`), ids.pm],
    );
    return id;
  };
  const event = (kind: string, id: string, ev: string, note: string | null, at: string) =>
    t.pool.query(`INSERT INTO record_events (id, record_kind, record_id, kind, note, actor_id, at) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [uuidv7(), kind, id, ev, note, ids.pm, at]);
  /** Puts the record in a case: held (uncleaned) or cleaned. */
  const holdIn = async (table: string, kind: string, id: string, state: 'held' | 'cleaned') => {
    const caseId = uuidv7();
    await t.pool.query(
      `INSERT INTO quarantine_cases (id, project_id, item_kind, item_id, marked_length, reported_at, state, cleaned_at) VALUES ($1, $2, $3, $4, 10, now(), $5, CASE WHEN $5 = 'cleaned' THEN now() END)`,
      [caseId, project, kind, id, state],
    );
    await t.pool.query(`UPDATE ${table} SET held_case_id = $2 WHERE id = $1`, [id, caseId]);
  };
  const deleteRecord = (table: string, id: string) =>
    t.pool.query(`UPDATE ${table} SET deleted_at = now(), deleted_by = $2, delete_reason = 'Duplicate' WHERE id = $1`, [id, ids.pm]);
  const submitMd = async (client: Client, title: string) => {
    const b = 'exportboundary';
    const body = Buffer.concat([
      Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="title"\r\n\r\n${title}\r\n--${b}\r\nContent-Disposition: form-data; name="file"; filename="r.md"\r\nContent-Type: text/markdown\r\n\r\n# ${title}\n\nBody\n\r\n--${b}--\r\n`),
    ]);
    const r = await client.upload('POST', `/projects/${project}/outputs`, body, `multipart/form-data; boundary=${b}`);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.id as string;
  };
  const typeId = async (name: string) => (await t.pool.query(`SELECT id FROM report_types WHERE name = $1`, [name])).rows[0].id as string;
  const audit = async () => (await t.pool.query(`SELECT detail, actor_user_id, subject_id FROM audit_events WHERE action = 'project.exported' ORDER BY occurred_at, id`)).rows;

  beforeEach(async () => {
    t = await startTestApp();
    ids.admin = await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    for (const p of ['pm', 'deputy', 'owner', 'sponsor', 'ann', 'auditor', 'overseer', 'outsider']) ids[p] = await seedUser(t.pool, `${p}@example.org`);
    project = await seedProject(t.pool, {
      name: 'Pump Station',
      status: 'active',
      members: [
        { userId: ids.pm, role: 'pm' },
        { userId: ids.deputy, role: 'deputy_pm' },
        { userId: ids.owner, role: 'owner' },
        { userId: ids.sponsor, role: 'sponsor' },
        { userId: ids.ann, role: 'member' },
      ],
    });
    for (const [who, kind] of [['auditor', 'audit'], ['overseer', 'oversight']] as const) {
      await t.pool.query(
        `INSERT INTO access_grants (id, project_id, user_id, kind, purpose, scope, starts_on, expires_on, requested_by, requested_at, decision, decided_by, decided_at)
         VALUES ($1, $2, $3, $4, 'Annual review', 'Everything', '2026-11-01', '2026-11-30', $5, now(), 'approved', $6, now())`,
        [uuidv7(), project, ids[who], kind, ids.pm, ids.admin],
      );
    }
    for (const p of ['admin', 'pm', 'deputy', 'owner', 'sponsor', 'ann', 'auditor', 'overseer', 'outsider']) c[p] = await t.signIn(`${p}@example.org`);
  });
  afterEach(async () => t?.close());

  test('exports refused while project exports are off', async () => {
    for (const kind of EXPORT_KINDS) {
      const r = await c.pm.request('GET', url(kind));
      assert.equal(r.status, 403, kind);
      assert.equal(r.body.message, EXPORTS_OFF);
    }
    assert.equal((await c.pm.request('POST', `/projects/${project}/export/save`, { kind: 'tasks' })).status, 403);
    assert.equal((await t.pool.query(`SELECT count(*)::int AS n FROM outputs`)).rows[0].n, 0);
    assert.deepEqual(await audit(), []);
  });

  test('with exports on, default roles PM, Deputy, Owner and Sponsor may export; Member may not until chosen', async () => {
    await on();
    for (const who of ['pm', 'deputy', 'owner', 'sponsor']) assert.equal((await c[who].raw('GET', url('tasks'))).status, 200, who);
    const refused = await c.ann.request('GET', url('tasks'));
    assert.equal(refused.status, 403);
    assert.equal(refused.body.message, NOT_AN_EXPORT_ROLE);
    assert.equal((await c.outsider.request('GET', url('tasks'))).status, 404, 'a non-participant sees nothing of the project');
    assert.equal((await c.admin.request('GET', url('tasks'))).status, 403, 'the Administrator is not a content reader');
    assert.equal((await c.pm.request('PUT', `/projects/${project}/output-settings`, { reason, exportRoles: ['pm', 'member'] })).status, 200);
    assert.equal((await c.ann.raw('GET', url('tasks'))).status, 200);
    assert.equal((await c.deputy.request('GET', url('tasks'))).status, 403, 'the roles are exactly the ones chosen');
  });

  test('Audit and Oversight via their grant kind when chosen', async () => {
    await on();
    assert.equal((await c.auditor.request('GET', url('tasks'))).status, 403);
    assert.equal((await c.overseer.request('GET', url('tasks'))).status, 403);
    await roles(['pm', 'audit']);
    assert.equal((await c.auditor.raw('GET', url('tasks'))).status, 200);
    assert.equal((await c.overseer.request('GET', url('tasks'))).status, 403);
    await roles(['pm', 'oversight']);
    assert.equal((await c.auditor.request('GET', url('tasks'))).status, 403);
    assert.equal((await c.overseer.raw('GET', url('tasks'))).status, 200);
    // Read-only access: a grant holder never saves an export as an output.
    assert.equal((await c.overseer.request('POST', `/projects/${project}/export/save`, { kind: 'tasks' })).status, 403);
    // An expired grant is no access, whatever the roles say.
    await t.pool.query(`UPDATE access_grants SET expires_on = '2026-11-05'`);
    assert.equal((await c.overseer.request('GET', url('tasks'))).status, 404);
  });

  test('mayExport is the one rule: switch, content reader and a chosen role', async () => {
    const ctx = await new ProjectAccess(t.pool, t.clock.now).context({ id: ids.pm, email: 'pm@example.org', displayName: 'pm', role: 'member' }, project);
    assert.equal(mayExport(ctx, { allowed: false, roles: ['pm'] }), false);
    assert.equal(mayExport(ctx, { allowed: true, roles: ['deputy'] }), false);
    assert.equal(mayExport(ctx, { allowed: true, roles: ['pm'] }), true);
    const deputy = await new ProjectAccess(t.pool, t.clock.now).context({ id: ids.deputy, email: 'd@example.org', displayName: 'd', role: 'member' }, project);
    assert.equal(mayExport(deputy, { allowed: true, roles: ['deputy'] }), true, 'Deputy is stored as "deputy", not "deputy_pm"');
    assert.equal(mayExport(deputy, { allowed: true, roles: ['deputy_pm'] }), false);
    const admin = await new ProjectAccess(t.pool, t.clock.now).context({ id: ids.admin, email: 'a@example.org', displayName: 'a', role: 'enterprise_administrator' }, project);
    assert.equal(mayExport(admin, { allowed: true, roles: ['pm', 'member', 'audit'] }), false);
  });

  test('allowed while Deferred, Closed and archived', async () => {
    await on();
    await task({ title: 'Replace the valve' });
    for (const status of ['deferred', 'closed']) {
      await t.pool.query(`UPDATE projects SET status = $2, closure_outcome = CASE WHEN $2 = 'closed' THEN 'abandoned' ELSE NULL END WHERE id = $1`, [project, status]);
      const r = await csv(c.pm, 'tasks');
      assert.equal(r.rows.length, 1, status);
    }
    await t.pool.query(`INSERT INTO project_archive_events (id, project_id, kind, actor_id, reason, at) VALUES ($1, $2, 'archived', $3, 'Old', now())`, [uuidv7(), project, ids.admin]);
    assert.equal((await csv(c.owner, 'tasks')).rows.length, 1);
    assert.equal((await t.pool.query(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'project.exported'`)).rows[0].n, 3);
  });

  test('columns per kind exactly as specified, with the values of each record', async () => {
    await on();
    const parent = await task({ title: 'Install pump', due: '2026-11-05', status: 'completed', completedAt: '2026-11-06T02:00:00Z' });
    const sub = await task({ title: 'Order parts', parent, due: '2026-11-30', status: 'in_progress' });
    const late = await task({ title: 'Test pump', due: '2026-11-07' });
    const review = await task({ title: 'Reviewed late', due: '2026-11-07', review: true });
    const old = await decision('Use the north entrance', { rationale: 'Shorter route', status: 'superseded' });
    const newer = await decision('Use the east entrance', { replaces: old });
    const q = await question('Who signs the permit?', 'resolved');
    await t.pool.query(`INSERT INTO question_answers (id, question_id, answer, author_id, at) VALUES ($1, $2, 'The owner', $3, now()), ($4, $2, 'Confirmed', $3, now())`, [uuidv7(), q, ids.pm, uuidv7()]);
    await event('question', q, 'resolved', null, '2026-11-08T04:00:00Z');
    const accepted = await risk('Supplier may be late', { status: 'accepted', severity: 'high', reviewOn: '2026-12-01' });
    await event('risk', accepted, 'accepted', 'Cost of delay is small', '2026-11-08T05:00:00Z');
    await risk('Open one');

    const tasks = await csv(c.pm, 'tasks');
    assert.deepEqual(tasks.header, [...EXPORT_COLUMNS.tasks]);
    assert.deepEqual(tasks.header, ['id', 'parent id', 'title', 'assignee', 'assignee department', 'status', 'due date', 'next review', 'overdue (yes/no)', 'completed on', 'created on', 'authorised on']);
    const byTitle = Object.fromEntries(tasks.rows.map((r) => [r[2], r]));
    assert.deepEqual(byTitle['Install pump'], [parent, '', 'Install pump', 'ann', '', 'Completed', '2026-11-05', '', 'no', '2026-11-06', '2026-11-02', '2026-11-02']);
    assert.equal(byTitle['Order parts'][1], parent, 'a subtask carries its parent id');
    assert.equal(byTitle['Order parts'][5], 'In progress');
    assert.equal(byTitle['Test pump'][8], 'yes', 'overdue is read against today (UTC+8, 2026-11-09)');
    assert.equal(byTitle['Order parts'][8], 'no');
    assert.equal(byTitle['Reviewed late'][8], 'no', 'a task waiting for a deadline review is not overdue');
    assert.deepEqual([sub, late, review].every((id) => tasks.rows.some((r) => r[0] === id)), true);

    const decisions = await csv(c.pm, 'decisions');
    assert.deepEqual(decisions.header, ['id', 'statement', 'rationale', 'status', 'authorised on', 'replaced by']);
    assert.deepEqual(decisions.rows, [
      [old, 'Use the north entrance', 'Shorter route', 'Superseded', '2026-11-03', newer],
      [newer, 'Use the east entrance', '', 'Active', '2026-11-03', ''],
    ]);

    const questions = await csv(c.pm, 'questions');
    assert.deepEqual(questions.header, ['id', 'question', 'requester', 'status', 'answers (count)', 'resolved on']);
    assert.deepEqual(questions.rows, [[q, 'Who signs the permit?', 'ann', 'Resolved', '2', '2026-11-08']]);

    const risks = await csv(c.pm, 'risks');
    assert.deepEqual(risks.header, ['id', 'description', 'severity', 'status', 'responsible person', 'review date', 'accepted reason']);
    assert.deepEqual(risks.rows[0], [accepted, 'Supplier may be late', 'High', 'Accepted', 'ann', '2026-12-01', 'Cost of delay is small']);
    assert.deepEqual(risks.rows[1].slice(1, 7), ['Open one', 'Medium', 'Open', 'ann', '', '']);

    // Filters narrow the rows and are written on the Filters line.
    const filtered = await csv(c.pm, 'tasks', `&status=in_progress,completed&overdue=yes`);
    assert.deepEqual(filtered.rows, []);
    assert.match(filtered.meta.Filters, /status: In progress, Completed; overdue only/);
    const onlyLate = await csv(c.pm, 'tasks', `&overdue=yes`);
    assert.deepEqual(onlyLate.rows.map((r) => r[2]), ['Test pump']);
    assert.deepEqual((await csv(c.pm, 'risks', '&severity=high')).rows.map((r) => r[1]), ['Supplier may be late']);
    assert.equal((await c.pm.request('GET', url('tasks', '&status=nonsense'))).status, 400);
    assert.equal((await c.pm.request('GET', url('nothing'))).status, 400);
    assert.equal((await c.pm.request('GET', url('tasks', '&assigneeId=nope'))).status, 400);
  });

  test('the output register lists what this person may read, never deleted, held or withdrawn outputs', async () => {
    await on();
    const reg = async (title: string, who: Client = c.pm) => {
      const id = await submitMd(who, title);
      const done = await c.pm.request('POST', `/projects/${project}/outputs/${id}/register`, { reportTypeId: await typeId('Status reports'), categoryIds: [await typeId('Other')], issueDate: '2026-11-08' });
      assert.equal(done.status, 200, JSON.stringify(done.body));
      return id;
    };
    const kept = await reg('Kept report');
    const gone = await reg('Deleted report');
    const withdrawn = await reg('Withdrawn report');
    const held = await reg('Held report');
    const submittedByAnn = await submitMd(c.ann, 'Ann draft');
    assert.equal((await c.pm.request('POST', `/projects/${project}/outputs/${gone}/delete`, { reason })).status, 200);
    assert.equal((await c.pm.request('POST', `/projects/${project}/outputs/${withdrawn}/withdraw`, { reason })).status, 200);
    await holdIn('outputs', 'output', held, 'held');

    const out = await csv(c.pm, 'outputs');
    assert.deepEqual(out.header, ['id', 'title', 'report type', 'categories', 'issue date', 'author', 'latest version', 'latest status', 'filing state', 'last check']);
    assert.deepEqual(out.rows.map((r) => r[0]).sort(), [kept, submittedByAnn].sort());
    const row = out.rows.find((r) => r[0] === kept) as string[];
    assert.deepEqual(row.slice(1), ['Kept report', 'Status reports', 'Other', '2026-11-08', 'pm', '1', 'Draft', 'Not filed', '']);
    // Deleted outputs are excluded at the query itself, not only by what the reader may see.
    const viewer = await new ProjectAccess(t.pool, t.clock.now).context({ id: ids.pm, email: 'pm@example.org', displayName: 'pm', role: 'member' }, project);
    const built = await buildExport(t.pool, project, 'outputs', {}, viewer, t.clock.now());
    assert.ok(!built.csv.toString('utf8').includes(gone) && !built.csv.toString('utf8').includes(withdrawn) && !built.csv.toString('utf8').includes(held));
    await roles(['pm', 'member']);
    // Ann reads the registered ones and her own submission, as in the register.
    const annOut = await csv(c.ann, 'outputs');
    assert.deepEqual(annOut.rows.map((r) => r[0]).sort(), [kept, submittedByAnn].sort());
    // A restricted output is exported only for people in its audience.
    const narrowed = await c.pm.request('PUT', `/projects/${project}/outputs/${kept}/audience`, { mode: 'restricted', userIds: [ids.pm], reason });
    assert.equal(narrowed.status, 200, JSON.stringify(narrowed.body));
    assert.deepEqual((await csv(c.ann, 'outputs')).rows.map((r) => r[0]), [submittedByAnn]);
    assert.equal((await csv(c.pm, 'outputs')).rows.length, 2);
    assert.deepEqual((await csv(c.pm, 'outputs', `&status=submitted`)).rows.map((r) => r[0]), [submittedByAnn]);
  });

  test('Deleted records and uncleaned held records are absent; cleaned held show Credential removed — under review', async () => {
    await on();
    await task({ title: 'Live task' });
    const delT = await task({ title: 'Deleted task' });
    const heldT = await task({ title: `Held ${SECRET}` });
    const cleanedT = await task({ title: 'Cleaned original' });
    await deleteRecord('tasks', delT);
    await holdIn('tasks', 'task', heldT, 'held');
    await holdIn('tasks', 'task', cleanedT, 'cleaned');
    const d = [await decision('Live decision'), await decision('Deleted decision'), await decision('Held decision'), await decision('Cleaned decision', { rationale: 'Cleaned rationale' })];
    await deleteRecord('decisions', d[1]);
    await holdIn('decisions', 'decision', d[2], 'held');
    await holdIn('decisions', 'decision', d[3], 'cleaned');
    const q = [await question('Live question'), await question('Deleted question'), await question('Held question'), await question('Cleaned question')];
    await deleteRecord('questions', q[1]);
    await holdIn('questions', 'question', q[2], 'held');
    await holdIn('questions', 'question', q[3], 'cleaned');
    const r = [await risk('Live risk'), await risk('Deleted risk'), await risk('Held risk'), await risk('Cleaned risk', { status: 'accepted' })];
    await event('risk', r[3], 'accepted', 'Cleaned note', '2026-11-08T05:00:00Z');
    await deleteRecord('risks', r[1]);
    await holdIn('risks', 'risk', r[2], 'held');
    await holdIn('risks', 'risk', r[3], 'cleaned');

    const titles = async (kind: string, col: number) => (await csv(c.pm, kind)).rows.map((x) => x[col]).sort();
    assert.deepEqual(await titles('tasks', 2), [UNDER_REVIEW, 'Live task']);
    assert.deepEqual(await titles('decisions', 1), [UNDER_REVIEW, 'Live decision']);
    assert.deepEqual(await titles('questions', 1), [UNDER_REVIEW, 'Live question']);
    assert.deepEqual(await titles('risks', 1), [UNDER_REVIEW, 'Live risk']);
    const cleanedDecision = (await csv(c.pm, 'decisions')).rows.find((x) => x[0] === d[3]) as string[];
    assert.equal(cleanedDecision[2], UNDER_REVIEW, 'every text cell of a record under review says so');
    const cleanedRisk = (await csv(c.pm, 'risks')).rows.find((x) => x[0] === r[3]) as string[];
    assert.equal(cleanedRisk[6], UNDER_REVIEW);
    for (const kind of ['tasks', 'decisions', 'questions', 'risks']) {
      const text = (await c.pm.raw('GET', url(kind))).text;
      assert.ok(!/Deleted|Held|Cleaned (original|rationale|note)|sk-/.test(text.replace(/^#.*$/gm, '')), kind);
    }
  });

  test('no source text, message text, quotes or AI questions appear', async () => {
    await on();
    const marks = ['SOURCE-TEXT-MARK', 'SOURCE-TITLE-MARK', 'MESSAGE-TEXT-MARK', 'AI-QUESTION-MARK', 'REJECTED-PROPOSAL-MARK', 'MITIGATION-MARK', 'ANSWER-TEXT-MARK'];
    const src = uuidv7();
    await t.pool.query(`INSERT INTO sources (id, title, created_by, created_at, project_id) VALUES ($1, $2, $3, now(), $4)`, [src, 'SOURCE-TITLE-MARK', ids.pm, project]);
    await t.pool.query(
      `INSERT INTO source_versions (id, source_id, version_no, origin, text_content, text_sha256, char_count, created_by, created_at) VALUES ($1, $2, 1, 'paste', $3, 'x', 16, $4, now())`,
      [uuidv7(), src, 'SOURCE-TEXT-MARK', ids.pm],
    );
    const audience = uuidv7();
    await t.pool.query(`INSERT INTO audiences (id, project_id, mode, created_at) VALUES ($1, $2, 'project', now())`, [audience, project]);
    const thread = uuidv7();
    await t.pool.query(`INSERT INTO discussion_threads (id, project_id, kind, title, audience_id, created_by, created_at) VALUES ($1, $2, 'discussion', 'Thread', $3, $4, now())`, [thread, project, audience, ids.pm]);
    const msg = uuidv7();
    await t.pool.query(`INSERT INTO discussion_messages (id, thread_id, message_no, author_id, created_at) VALUES ($1, $2, 1, $3, now())`, [msg, thread, ids.pm]);
    await t.pool.query(`INSERT INTO message_versions (id, message_id, version_no, body, body_sha256, created_at) VALUES ($1, $2, 1, 'MESSAGE-TEXT-MARK', 'x', now())`, [uuidv7(), msg]);
    const req = uuidv7();
    await t.pool.query(`INSERT INTO ai_requests (id, project_id, kind, requested_by, status, scope, created_at) VALUES ($1, $2, 'question', $3, 'succeeded', 'personal', now())`, [req, project, ids.pm]);
    await t.pool.query(`INSERT INTO ai_answers (request_id, project_id, question) VALUES ($1, $2, 'AI-QUESTION-MARK')`, [req, project]);
    await proposal('action', 'REJECTED-PROPOSAL-MARK');
    // Records whose origin text and extras carry marks of their own that are not exported.
    await t.pool.query(`UPDATE human_proposals SET text = text || ' MESSAGE-TEXT-MARK'`);
    const rk = await risk('Plain risk');
    await t.pool.query(`UPDATE risks SET mitigation = 'MITIGATION-MARK' WHERE id = $1`, [rk]);
    const qu = await question('Plain question', 'answered');
    await t.pool.query(`INSERT INTO question_answers (id, question_id, answer, author_id, at) VALUES ($1, $2, 'ANSWER-TEXT-MARK', $3, now())`, [uuidv7(), qu, ids.pm]);
    await decision('Plain decision');
    await task({ title: 'Plain task' });
    for (const kind of EXPORT_KINDS) {
      const text = (await c.pm.raw('GET', url(kind))).text;
      for (const m of marks) assert.ok(!text.includes(m), `${kind} must not hold ${m}`);
    }
    assert.equal((await csv(c.pm, 'tasks')).rows.length, 1);
  });

  test('formula guard, BOM, CRLF, # lines and the 2,000-character cut', async () => {
    await on();
    await task({ title: '=HYPERLINK("http://x")' });
    await task({ title: 'Ahmad, "Siti" Nurul' });
    await task({ title: `${'é'.repeat(2_100)}` });
    await decision('+1 and @someone', { rationale: '-flagged' });
    const viewer = await new ProjectAccess(t.pool, t.clock.now).context({ id: ids.pm, email: 'pm@example.org', displayName: 'pm', role: 'member' }, project);
    const built = await buildExport(t.pool, project, 'tasks', {}, viewer, t.clock.now());
    assert.deepEqual([...built.csv.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 byte order mark');
    const text = built.csv.toString('utf8').slice(1);
    assert.ok(!text.replace(/\r\n/g, '').includes('\n') && !text.replace(/\r\n/g, '').includes('\r'), 'every line break is CRLF');
    const parsed = parseCsv(text);
    assert.deepEqual(Object.keys(parsed.meta), ['Export', 'Project', 'Filters', 'Computed at', 'Coverage']);
    assert.deepEqual(parsed.meta, {
      Export: 'Tasks',
      Project: 'Pump Station',
      Filters: 'None (every record of this kind)',
      'Computed at': parsed.meta['Computed at'],
      Coverage: COVERAGE,
    });
    assert.match(parsed.meta['Computed at'], /^2026-11-09 10:\d\d \(UTC\+8\)$/);
    assert.equal(COVERAGE, 'All authorised records in the project except deleted ones and any under credential review');
    const titles = parsed.rows.map((r) => r[2]);
    assert.ok(titles.includes(`'=HYPERLINK("http://x")`), 'a cell starting with = gets a quote in front');
    assert.ok(titles.includes('Ahmad, "Siti" Nurul'), 'quoting survives');
    assert.ok(text.includes('"Ahmad, ""Siti"" Nurul"'));
    const long = titles.find((x) => x.startsWith('é')) as string;
    assert.equal(Array.from(long).length, MAX_CELL);
    const d = parseCsv((await buildExport(t.pool, project, 'decisions', {}, viewer, t.clock.now())).csv.toString('utf8').slice(1));
    assert.deepEqual(d.rows[0].slice(1, 3), [`'+1 and @someone`, `'-flagged`]);
    // Over HTTP: a download with the file name and no caching.
    const r = await c.pm.raw('GET', url('tasks'));
    assert.match(r.headers.get('content-type') ?? '', /^text\/csv/);
    assert.equal(r.headers.get('content-disposition'), 'attachment; filename="kainow-tasks-export-2026-11-09.csv"');
    assert.equal(r.headers.get('cache-control'), 'private, no-store');
  });

  test('each export writes project.exported with kind, filters and row count and no data', async () => {
    await on();
    await task({ title: 'Secret-looking unique title UNIQUE-TITLE-MARK', status: 'blocked' });
    await task({ title: 'Other' });
    await csv(c.pm, 'tasks', '&status=blocked');
    await csv(c.owner, 'risks');
    const rows = await audit();
    assert.equal(rows.length, 2);
    const of = (kind: string) => rows.find((r) => r.detail.kind === kind);
    assert.deepEqual(of('tasks')?.detail, { projectId: project, kind: 'tasks', filters: { status: ['blocked'] }, rows: 1 });
    assert.deepEqual(of('risks')?.detail, { projectId: project, kind: 'risks', filters: {}, rows: 0 });
    assert.equal(of('tasks')?.actor_user_id, ids.pm);
    assert.equal(of('risks')?.actor_user_id, ids.owner);
    assert.equal(of('tasks')?.subject_id, project);
    assert.ok(!JSON.stringify(rows).includes('UNIQUE-TITLE-MARK'));
    // A refused export writes nothing.
    await c.ann.request('GET', url('tasks'));
    assert.equal((await audit()).length, 2);
  });

  test('save as output creates a submitted CSV output with type Exports and a Project-wide audience', async () => {
    await on();
    await task({ title: 'Install pump' });
    const save = await c.pm.request('POST', `/projects/${project}/export/save`, { kind: 'tasks', filters: { status: ['not_started'] } });
    assert.equal(save.status, 201, JSON.stringify(save.body));
    const out = save.body;
    assert.equal(out.status, 'submitted');
    assert.equal(out.title, 'Tasks export 2026-11-09');
    assert.deepEqual(out.reportType.name, 'Exports');
    assert.deepEqual(out.audience, { mode: 'project', people: [] });
    assert.equal(out.versions.length, 1);
    assert.equal(out.versions[0].origin, 'export');
    assert.equal(out.versions[0].format, 'csv');
    assert.equal(out.versions[0].status, 'draft');
    const stored = (await t.pool.query(`SELECT b.bytes, v.sha256, v.size_bytes FROM output_version_bytes b JOIN output_versions v ON v.id = b.output_version_id WHERE v.output_id = $1`, [out.id])).rows[0];
    assert.deepEqual([...stored.bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    const parsed = parseCsv(stored.bytes.toString('utf8').slice(1));
    assert.equal(parsed.rows.length, 1);
    assert.equal(parsed.rows[0][2], 'Install pump');
    assert.equal(Number(stored.size_bytes), stored.bytes.length);
    assert.equal((await t.pool.query(`SELECT audience_id FROM outputs WHERE id = $1`, [out.id])).rows[0].audience_id, null, 'no restricted audience');
    const rows = await audit();
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].detail, { projectId: project, kind: 'tasks', filters: { status: ['not_started'] }, rows: 1, outputId: out.id });

    // A Member may submit outputs but may export only when chosen; Sponsor may.
    assert.equal((await c.ann.request('POST', `/projects/${project}/export/save`, { kind: 'tasks' })).status, 403);
    assert.equal((await c.sponsor.request('POST', `/projects/${project}/export/save`, { kind: 'risks', title: 'Risk list', filters: {} })).status, 201);
    assert.equal((await c.sponsor.request('POST', `/projects/${project}/export/save`, { kind: 'tasks', title: 'x'.repeat(201) })).status, 400);
    assert.equal((await c.pm.request('POST', `/projects/${project}/export/save`, { kind: 'nope' })).status, 400);

    // A new version of a chosen registered output.
    const reg = await c.pm.request('POST', `/projects/${project}/outputs/${out.id}/register`, { reportTypeId: await typeId('Exports') });
    assert.equal(reg.status, 200, JSON.stringify(reg.body));
    await task({ title: 'Second task' });
    const again = await c.pm.request('POST', `/projects/${project}/export/save`, { kind: 'tasks', outputId: out.id });
    assert.equal(again.status, 201, JSON.stringify(again.body));
    assert.deepEqual(again.body.versions.map((v: { no: number; origin: string }) => [v.no, v.origin]), [[1, 'export'], [2, 'export']]);
    assert.equal(again.body.title, 'Tasks export 2026-11-09');
    assert.equal((await audit()).length, 3 + 0, 'one record per saved export (tasks, risks, tasks again)');
    // No export, no save: switch off again.
    await t.pool.query(`UPDATE access_settings SET project_exports_allowed = false`);
    assert.equal((await c.pm.request('POST', `/projects/${project}/export/save`, { kind: 'tasks' })).status, 403);
    assert.equal((await t.pool.query(`SELECT count(*)::int AS n FROM outputs`)).rows[0].n, 2);
  });

  test('a project that does not allow CSV outputs cannot save an export', async () => {
    await on();
    await c.pm.request('PUT', `/projects/${project}/output-settings`, { reason, outputFormats: ['md'] });
    const r = await c.pm.request('POST', `/projects/${project}/export/save`, { kind: 'tasks' });
    assert.equal(r.status, 400);
    assert.equal((await t.pool.query(`SELECT count(*)::int AS n FROM outputs`)).rows[0].n, 0);
    assert.deepEqual(await audit(), []);
    assert.equal((await c.pm.raw('GET', url('tasks'))).status, 200, 'the download itself does not depend on output formats');
  });

  test('the Access and records setting changes with a reason through access settings history', async () => {
    const put = (b: Record<string, unknown>) => c.admin.request('PUT', '/admin/access-settings', b);
    assert.equal((await c.admin.request('GET', '/admin/access-settings')).body.settings.projectExportsAllowed, false);
    assert.equal((await put({ projectExportsAllowed: true })).status, 400, 'a reason is required');
    assert.equal((await put({ projectExportsAllowed: 'yes', reason })).status, 400);
    assert.equal((await put({ projectExportsAllowed: true, reason })).status, 200);
    const got = (await c.admin.request('GET', '/admin/access-settings')).body;
    assert.equal(got.settings.projectExportsAllowed, true);
    assert.equal(got.defaults.projectExportsAllowed, false);
    assert.equal(got.changes.length, 1);
    assert.equal(got.changes[0].reason, reason);
    assert.equal(got.changes[0].previous.projectExportsAllowed, false);
    assert.equal(got.changes[0].next.projectExportsAllowed, true);
    const log = (await t.pool.query(`SELECT detail FROM audit_events WHERE action = 'access_settings.changed'`)).rows;
    assert.deepEqual(log[0].detail, { fields: ['projectExportsAllowed'] });
    assert.equal((await c.pm.raw('GET', url('tasks'))).status, 200, 'the switch takes effect at once');
    assert.equal((await put({ archiveAfterMonths: 6, reason })).status, 200);
    assert.equal((await c.admin.request('GET', '/admin/access-settings')).body.settings.projectExportsAllowed, true, 'other changes keep it');
    assert.equal((await c.pm.request('PUT', '/admin/access-settings', { projectExportsAllowed: false, reason })).status, 403);
  });

  test('a saved register export holds only outputs every reader may read; a download is the personal view', async () => {
    await on();
    const base = `/projects/${project}/outputs`;
    const register = async (id: string) => assert.equal((await c.pm.request('POST', `${base}/${id}/register`, { reportTypeId: await typeId('Status reports') })).status, 200);
    const open = await submitMd(c.pm, 'Open report');
    await register(open);
    const restricted = await submitMd(c.pm, 'Restricted report');
    await register(restricted);
    assert.equal((await c.pm.request('PUT', `${base}/${restricted}/audience`, { mode: 'restricted', userIds: [ids.pm], reason })).status, 200);
    const annOnly = await submitMd(c.ann, 'Ann submission');
    const mine = (await csv(c.pm, 'outputs')).rows.map((r) => r[0]).sort();
    assert.deepEqual(mine, [open, restricted, annOnly].sort(), 'the PM download is a personal view');
    const save = await c.pm.request('POST', `/projects/${project}/export/save`, { kind: 'outputs' });
    assert.equal(save.status, 201, JSON.stringify(save.body));
    const bytes = (await t.pool.query(`SELECT b.bytes FROM output_version_bytes b JOIN output_versions v ON v.id = b.output_version_id WHERE v.output_id = $1`, [save.body.id])).rows[0].bytes as Buffer;
    const saved = parseCsv(bytes.toString('utf8').slice(1));
    assert.deepEqual(saved.rows.map((r) => r[0]), [open]);
    assert.match(saved.meta.Coverage, /Restricted and unregistered outputs are omitted/);
    assert.deepEqual((await t.pool.query(`SELECT detail FROM audit_events WHERE action = 'project.exported'`)).rows.at(-1).detail.rows, 1);
  });

  test('save body checks: participant first, report type and title with an output', async () => {
    await on();
    const url2 = `/projects/${project}/export/save`;
    assert.equal((await c.outsider.request('POST', url2, { kind: 'nope' })).status, 404);
    assert.equal((await c.pm.request('POST', url2, { kind: 'tasks', reportTypeId: 'nope' })).status, 400);
    assert.equal((await c.pm.request('POST', url2, { kind: 'tasks', outputId: uuidv7(), title: 'Other title' })).status, 400);
    assert.equal((await t.pool.query(`SELECT count(*)::int AS n FROM outputs`)).rows[0].n, 0);
    const stranger = uuidv7();
    const r = await csv(c.pm, 'tasks', `&assigneeId=${ids.outsider}`);
    assert.equal(r.meta.Filters, `assignee: ${ids.outsider}`, 'a name outside the project is not looked up');
    assert.ok(stranger);
  });
});
