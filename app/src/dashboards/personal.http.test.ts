import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { uuidv7 } from '../common/uuid7';
import { PG_POOL } from '../db/database.module';
import { POSSIBLE_COPY_TEXT, UNDER_REVIEW_TEXT } from '../quarantine/labels';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedProject, seedUser } from '../testing/projects';

// The test clock starts at 2026-11-09T02:00Z: today is 2026-11-09 (UTC+8).
const PEOPLE = ['pm', 'owner', 'sponsor', 'sponsor2', 'mem', 'loner'] as const;
type Person = (typeof PEOPLE)[number];

type NeedsYou = { kind: string; projectId: string; projectName: string; label: string; since: string | null; link: string; count?: number };
type TaskRow = {
  id: string; title: string; projectId: string; projectName: string; dueOn: string; status: string; overdueDays?: number;
  completedOn: string | null; blockedReason: string | null; parent: { id: string; title: string } | null; subtasks: { done: number; total: number };
};

describe('personal dashboard endpoint', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let projectId: string;
  const ids: Record<string, string> = {};
  const people = {} as Record<Person, Client>;

  beforeEach(async () => {
    t = await startTestApp();
    const adminId = await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    await t.pool.query(`INSERT INTO eligible_domains (id, domain, added_by, added_at) VALUES ($1, 'example.com', $2, now())`, [uuidv7(), adminId]);
    for (const p of PEOPLE) ids[p] = await seedUser(t.pool, `${p}@example.com`);
    projectId = await seedProject(t.pool, {
      status: 'active',
      name: 'Harbour works',
      members: [
        { userId: ids.pm, role: 'pm' },
        { userId: ids.owner, role: 'owner' },
        { userId: ids.sponsor, role: 'sponsor' },
        { userId: ids.sponsor2, role: 'sponsor' },
        { userId: ids.mem, role: 'member' },
      ],
    });
    for (const p of PEOPLE) people[p] = await t.signIn(`${p}@example.com`);
  });
  afterEach(async () => {
    await t?.close();
  });

  const me = async (person: Person, query = '') => {
    const r = await people[person].request('GET', `/dashboard/me${query}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body as {
      needsYou: NeedsYou[];
      myTasks: { overdue: TaskRow[]; dueSoon: TaskRow[]; later: TaskRow[]; awaitingReview: TaskRow[]; completed?: TaskRow[] };
      projects: Array<{ id: string; name: string; onHold: boolean; header?: Record<string, unknown>; expanded?: Record<string, unknown> }>;
      computedAt: string;
    };
  };

  async function resourceLine(project: string, o: { item?: string; kind?: string; description?: string; status?: string; neededBy?: string | null; startsOn?: string | null; endsOn?: string | null; by: string }): Promise<string> {
    const id = uuidv7();
    await t.pool.query(
      `INSERT INTO resource_lines (id, project_id, item_id, one_off_kind, description, status, needed_by, starts_on, ends_on, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now(), now())`,
      [id, project, o.item ?? null, o.item ? null : (o.kind ?? 'other'), o.item ? '' : (o.description ?? 'Dummy hire'), o.status ?? 'needed', o.neededBy ?? null, o.startsOn ?? null, o.endsOn ?? null, o.by],
    );
    return id;
  }
  async function resourceItem(reference: string, name: string, by: string): Promise<string> {
    const id = uuidv7();
    await t.pool.query(`INSERT INTO resource_items (id, kind, reference, name, created_by, created_at, status) VALUES ($1, 'equipment', $2, $3, $4, now(), 'active')`, [id, reference, name, by]);
    return id;
  }
  const kinds = (body: { needsYou: NeedsYou[] }, kind: string) => body.needsYou.filter((n) => n.kind === kind);

  async function task(opts: { title?: string; assignee?: string; dueOn?: string; status?: string; project?: string; review?: boolean; completedAt?: string; parent?: string } = {}): Promise<string> {
    const id = uuidv7();
    const status = opts.status ?? 'not_started';
    await t.pool.query(
      `INSERT INTO tasks (id, project_id, parent_id, depth, title, assignee_id, due_on, status, completed_at, deadline_review_required, authorised_by, authorised_at)
       VALUES ($1, $2, $10, $11, $3, $4, $5, $6, $7, $8, $9, now())`,
      [id, opts.project ?? projectId, opts.title ?? 'Task', opts.assignee ?? ids.mem, opts.dueOn ?? '2026-11-30', status,
        status === 'completed' ? (opts.completedAt ?? '2026-11-05T02:00:00Z') : null, opts.review ?? false, ids.pm, opts.parent ?? null, opts.parent ? 1 : 0],
    );
    return id;
  }
  async function question(text: string, requester: string, status: string): Promise<string> {
    const proposal = uuidv7();
    await t.pool.query(
      `INSERT INTO human_proposals (id, project_id, kind, text, proposed_by, proposed_at, review_status, reviewed_by, reviewed_at)
       VALUES ($1, $2, 'question', 'Proposed', $3, now(), 'approved', $3, now())`,
      [proposal, projectId, ids.pm],
    );
    const id = uuidv7();
    await t.pool.query(
      `INSERT INTO questions (id, project_id, text, requester_id, status, origin_proposal_id, authorised_by, authorised_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, '2026-11-02T02:00:00Z')`,
      [id, projectId, text, requester, status, proposal, ids.owner],
    );
    return id;
  }

  test('an approval of a change to a task opens the task page', async () => {
    const id = await task({ title: 'Order pipes', dueOn: '2026-11-30' });
    await t.pool.query(`UPDATE approval_policy SET required = 3`);
    const r = await people.pm.request('POST', `/projects/${projectId}/changes`, { kind: 'amend_task', targetKind: 'task', targetId: id, terms: { title: 'Order the pipes', reason: 'Wording' }, reason: 'Wording' });
    assert.ok([201, 202].includes(r.status), JSON.stringify(r.body));
    assert.equal(kinds(await me('owner'), 'approval')[0]?.link, `#/projects/${projectId}/tasks/${id}`);
  });

  test('approval appears for an eligible Owner, not after they approve, not for a Member', async () => {
    const text = 'Ann will export the records by 20 November 2026.';
    const versionId = (await people.pm.request('POST', `/projects/${projectId}/notes`, { title: 'N', text })).body.version.id;
    const runId = uuidv7();
    await t.pool.query(
      `INSERT INTO extraction_runs (id, source_version_id, requested_by, status, item_count, unlocated_count, created_at, finished_at) VALUES ($1, $2, $3, 'succeeded', 1, 0, now(), now())`,
      [runId, versionId, ids.pm],
    );
    const itemId = uuidv7();
    await t.pool.query(
      `INSERT INTO extraction_items (id, run_id, source_version_id, position, kind, text, owner, due, quote, quote_start, quote_end, quote_matches, created_at)
       VALUES ($1, $2, $3, 0, 'action', 'Export the records.', 'Ann', 'by 20 November 2026', $4, 0, $5, 1, now())`,
      [itemId, runId, versionId, text, text.length],
    );
    await t.pool.query(`UPDATE approval_policy SET required = 3`);
    const submitted = await people.sponsor.request('POST', `/extractions/${runId}/items/${itemId}/authorise`, { sourceVersionId: versionId, assigneeId: ids.mem, dueOn: '2026-11-20' });
    assert.equal(submitted.status, 202, JSON.stringify(submitted.body));
    const requestId = submitted.body.request.id as string;

    const owner = kinds(await me('owner'), 'approval');
    assert.equal(owner.length, 1);
    assert.deepEqual(owner[0], {
      kind: 'approval',
      projectId,
      projectName: 'Harbour works',
      label: 'Authorise a proposal',
      since: new Date(submitted.body.request.submittedAt).toISOString(),
      link: `#/runs/${runId}`,
    });
    assert.deepEqual(kinds(await me('mem'), 'approval'), [], 'a Member may not approve');
    assert.deepEqual(kinds(await me('sponsor'), 'approval'), [], 'the submitter already approved');

    const approved = await people.owner.request('POST', `/changes/${requestId}/approve`, { version: 1 });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.request.status, 'pending');
    assert.deepEqual(kinds(await me('owner'), 'approval'), [], 'gone once they approved');
    assert.equal(kinds(await me('sponsor2'), 'approval').length, 1, 'still waiting for the third approver');
  });

  test('answered question appears to its requester only', async () => {
    const answered = await question('When is the site visit?', ids.mem, 'answered');
    await question('Still open?', ids.mem, 'open');
    await question('Someone else asked', ids.pm, 'answered');
    const mem = kinds(await me('mem'), 'question');
    assert.deepEqual(mem.map((q) => [q.label, q.link, q.projectName]), [['When is the site visit?', `#/projects/${projectId}/work/${answered}`, 'Harbour works']]);
    assert.deepEqual(kinds(await me('owner'), 'question'), []);
    assert.deepEqual(kinds(await me('pm'), 'question').map((q) => q.label), ['Someone else asked']);
  });

  test('on-hold membership shows name only and no tasks', async () => {
    await task({ title: 'Held work' });
    await question('Answered while held', ids.mem, 'answered');
    await t.pool.query(`UPDATE memberships SET held_at = now(), held_by = $2, hold_reason = 'Checking' WHERE project_id = $1 AND user_id = $3`, [projectId, ids.pm, ids.mem]);
    const body = await me('mem');
    assert.deepEqual(body.projects, [{ id: projectId, name: 'Harbour works', onHold: true }]);
    assert.deepEqual(body.needsYou, []);
    assert.deepEqual([body.myTasks.overdue, body.myTasks.dueSoon, body.myTasks.later, body.myTasks.awaitingReview], [[], [], [], []]);
  });

  test('Scheduled membership: project tasks not listed', async () => {
    const later = await seedProject(t.pool, {
      status: 'active',
      name: 'Later project',
      members: [
        { userId: ids.pm, role: 'pm' },
        { userId: ids.owner, role: 'owner' },
        { userId: ids.mem, role: 'member', startsOn: '2026-11-20' },
      ],
    });
    await task({ title: 'Future work', project: later });
    await task({ title: 'Current work' });
    const body = await me('mem');
    const all = [...body.myTasks.overdue, ...body.myTasks.dueSoon, ...body.myTasks.later, ...body.myTasks.awaitingReview];
    assert.deepEqual(all.map((x) => x.title), ['Current work']);
    assert.deepEqual(body.projects.map((p) => p.name), ['Harbour works']);
  });

  test('tasks grouped overdue / due in 7 days / later / awaiting review', async () => {
    const overdue = await task({ title: 'Overdue', dueOn: '2026-11-05', status: 'in_progress' });
    await task({ title: 'Due today', dueOn: '2026-11-09' });
    // Monday 9 November: seven working days on is Wednesday 18 November (nine calendar days).
    await task({ title: 'Due in seven', dueOn: '2026-11-18' });
    await task({ title: 'Due in eight', dueOn: '2026-11-19' });
    await task({ title: 'Marked', dueOn: '2026-11-03', review: true });
    await task({ title: 'Done', dueOn: '2026-11-04', status: 'completed', completedAt: '2026-11-04T02:00:00Z' });
    await task({ title: 'Done long ago', dueOn: '2026-09-01', status: 'completed', completedAt: '2026-09-01T02:00:00Z' });
    await task({ title: 'Cancelled', dueOn: '2026-11-04', status: 'cancelled' });
    await task({ title: 'Not mine', assignee: ids.pm, dueOn: '2026-11-04' });
    const gone = await task({ title: 'Deleted', dueOn: '2026-11-04' });
    await t.pool.query(`UPDATE tasks SET deleted_at = now(), deleted_by = $2, delete_reason = 'Entered in error' WHERE id = $1`, [gone, ids.pm]);

    const body = await me('mem');
    const titles = (rows: TaskRow[]) => rows.map((r) => r.title);
    assert.deepEqual(titles(body.myTasks.overdue), ['Overdue']);
    assert.deepEqual(body.myTasks.overdue[0], {
      id: overdue, title: 'Overdue', projectId, projectName: 'Harbour works', dueOn: '2026-11-05', status: 'in_progress', overdueDays: 4,
      completedOn: null, blockedReason: null, parent: null, subtasks: { done: 0, total: 0 },
    });
    assert.deepEqual(titles(body.myTasks.dueSoon), ['Due today', 'Due in seven']);
    assert.deepEqual(titles(body.myTasks.later), ['Due in eight']);
    assert.deepEqual(titles(body.myTasks.awaitingReview), ['Marked']);
    assert.equal(body.myTasks.completed, undefined, 'completed only on request');
    assert.equal(body.computedAt, t.clock.now().toISOString());

    const withDone = await me('mem', '?showCompleted=1');
    assert.deepEqual(titles(withDone.myTasks.completed as TaskRow[]), ['Done'], 'the last 30 days only');

    const [p] = body.projects;
    assert.equal(p.onHold, false);
    assert.equal(p.name, 'Harbour works');
    const header = p.header as { status: string; completion: { state: string }; flags: { overdue: number; blocked: number; deadlineReview: boolean } };
    assert.equal(header.status, 'active');
    assert.deepEqual([header.flags.overdue, header.flags.blocked, header.flags.deadlineReview], [2, 0, true]);
    const expanded = p.expanded as { roles: string[]; owningDepartment: string; link: string };
    assert.deepEqual(expanded.roles, ['member']);
    assert.equal(expanded.link, `#/projects/${projectId}`);
  });

  test('possible copies show a count, never text', async () => {
    const reported = await task({ title: 'Secret reported text', assignee: ids.pm });
    const copyA = await task({ title: 'Secret copy one', assignee: ids.pm });
    const copyB = await task({ title: 'Secret copy two', assignee: ids.pm });
    const caseId = uuidv7();
    await t.pool.query(
      `INSERT INTO quarantine_cases (id, project_id, item_kind, item_id, reason, marked_length, state, waiting_for_key, reported_at)
       VALUES ($1, $2, 'task', $3, 'test', 8, 'held', true, '2026-11-08T02:00:00Z')`,
      [caseId, projectId, reported],
    );
    await t.pool.query(`UPDATE tasks SET held_case_id = $2 WHERE id = $1`, [reported, caseId]);
    for (const id of [copyA, copyB]) {
      await t.pool.query(`INSERT INTO quarantine_possible_copies (case_id, item_kind, item_id, found_at, masked) VALUES ($1, 'task', $2, '2026-11-08T03:00:00Z', true)`, [caseId, id]);
    }
    const body = await me('pm');
    assert.deepEqual(kinds(body, 'copies'), [
      {
        kind: 'copies', projectId, projectName: 'Harbour works', label: '2 possible credential copies to check', count: 2,
        since: '2026-11-08T03:00:00.000Z', link: `#/quarantine/cases/${caseId}/copies`,
      },
    ]);
    const tasks = [...body.myTasks.overdue, ...body.myTasks.dueSoon, ...body.myTasks.later];
    assert.deepEqual(tasks.map((x) => x.title), [POSSIBLE_COPY_TEXT, POSSIBLE_COPY_TEXT], 'copies carry the label; the uncleaned held task is absent');
    assert.ok(!JSON.stringify(body).includes('Secret'), 'no marked text anywhere');
    assert.deepEqual(kinds(await me('owner'), 'copies'), [], 'PM or Deputy only');
    assert.deepEqual(kinds(await me('mem'), 'copies'), []);
  });

  test('submitted minutes need a reviewer who may publish', async () => {
    const created = await people.pm.request('POST', `/projects/${projectId}/notes`, { title: 'Site visit notes', text: 'We walked the site.' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const sourceId = created.body.source.id as string;
    await t.pool.query(`UPDATE sources SET publication = 'submitted', submitted_by = $2 WHERE id = $1`, [sourceId, ids.mem]);
    const minutes = kinds(await me('owner'), 'minutes');
    assert.deepEqual(minutes.map((n) => [n.label, n.link, n.projectId]), [['Site visit notes', `#/notes/${sourceId}`, projectId]]);
    assert.equal(kinds(await me('pm'), 'minutes').length, 1);
    assert.deepEqual(kinds(await me('mem'), 'minutes'), [], 'a Member may not publish');
  });

  test('an open deadline review needs the PM or a Deputy', async () => {
    await task({ title: 'Paused work', dueOn: '2026-11-20' });
    await t.pool.query(`SELECT mark_deadline_review($1, $2)`, [projectId, ids.pm]);
    const pm = kinds(await me('pm'), 'deadline_review');
    assert.deepEqual(pm.map((n) => [n.label, n.link]), [['Deadline review to prepare: 1 task', `#/projects/${projectId}/deadline-review`]]);
    assert.deepEqual(kinds(await me('owner'), 'deadline_review'), []);
  });

  test('resources past needed-by date need the PM or a Deputy, as one item per project', async () => {
    await resourceLine(projectId, { neededBy: '2026-11-08', by: ids.pm });
    await resourceLine(projectId, { neededBy: '2026-10-01', by: ids.pm });
    await resourceLine(projectId, { neededBy: '2026-11-09', by: ids.pm });
    await resourceLine(projectId, { neededBy: '2026-10-01', status: 'arranged', by: ids.pm });
    await resourceLine(projectId, { neededBy: '2026-10-01', status: 'cancelled', by: ids.pm });
    const pm = kinds(await me('pm'), 'resources');
    assert.deepEqual(pm.map((n) => [n.label, n.link, n.projectId]), [['Resources past needed-by date: 2', `#/projects/${projectId}/resources`, projectId]]);
    assert.deepEqual(kinds(await me('mem'), 'resources'), []);
    assert.deepEqual(kinds(await me('owner'), 'resources'), []);
  });

  test('archived projects are left out unless asked for', async () => {
    const closed = await seedProject(t.pool, { status: 'closed', name: 'Old works', members: [{ userId: ids.pm, role: 'pm' }, { userId: ids.owner, role: 'owner' }] });
    await t.pool.query(
      `INSERT INTO project_transitions (id, project_id, from_status, to_status, actor_id, reason, at) VALUES ($1, $2, 'active', 'closed', $3, 'Done', '2026-11-02T02:00:00Z')`,
      [uuidv7(), closed, ids.pm],
    );
    await t.pool.query(`INSERT INTO project_archive_events (id, project_id, kind, actor_id, reason, at) VALUES ($1, $2, 'archived', $3, 'Tidy', '2026-11-03T02:00:00Z')`, [uuidv7(), closed, ids.pm]);
    assert.deepEqual((await me('pm')).projects.map((p) => p.name), ['Harbour works']);
    assert.deepEqual((await me('pm', '?includeArchived=1')).projects.map((p) => p.name), ['Harbour works', 'Old works']);
  });

  async function risk(o: { description: string; responsible: string | null; reviewOn: string | null; status?: string }): Promise<string> {
    const proposal = uuidv7();
    await t.pool.query(
      `INSERT INTO human_proposals (id, project_id, kind, text, proposed_by, proposed_at, review_status, reviewed_by, reviewed_at)
       VALUES ($1, $2, 'risk', 'Proposed', $3, now(), 'approved', $3, now())`,
      [proposal, projectId, ids.pm],
    );
    const id = uuidv7();
    await t.pool.query(
      `INSERT INTO risks (id, project_id, description, severity, responsible_id, review_on, status, origin_proposal_id, authorised_by, authorised_at)
       VALUES ($1, $2, $3, 'medium', $4, $5, $6, $7, $8, now())`,
      [id, projectId, o.description, o.responsible, o.reviewOn, o.status ?? 'open', proposal, ids.pm],
    );
    return id;
  }
  async function holdRecord(table: 'tasks' | 'risks', kind: 'task' | 'risk', id: string, state: 'held' | 'cleaned'): Promise<void> {
    const caseId = uuidv7();
    await t.pool.query(
      `INSERT INTO quarantine_cases (id, project_id, item_kind, item_id, reason, marked_length, state, waiting_for_key, reported_at, cleaned_at)
       VALUES ($1, $2, $3, $4, 'Reported', 8, $5, $6, now(), CASE WHEN $5 = 'cleaned' THEN now() END)`,
      [caseId, projectId, kind, id, state, state === 'held'],
    );
    await t.pool.query(`UPDATE ${table} SET held_case_id = $2 WHERE id = $1`, [id, caseId]);
  }
  /** 00:00 UTC+8 on the date, as an ISO instant. */
  const midnight = (day: string) => new Date(`${day}T00:00:00+08:00`).toISOString();

  test('overdue, blocked and due-soon tasks need their assignee; a Blocked task also needs the PM', async () => {
    const overdue = await task({ title: 'Overdue', dueOn: '2026-11-05', status: 'in_progress' });
    const blocked = await task({ title: 'Blocked', dueOn: '2026-11-30', status: 'blocked' });
    const today = await task({ title: 'Due today', dueOn: '2026-11-09' });
    // Monday 9 November: seven working days on is Wednesday 18 November.
    await task({ title: 'Due in seven working days', dueOn: '2026-11-18' });
    await task({ title: 'Due in eight working days', dueOn: '2026-11-19' });
    await task({ title: 'Marked', dueOn: '2026-11-03', review: true });
    await task({ title: 'Done', dueOn: '2026-11-04', status: 'completed', completedAt: '2026-11-04T02:00:00Z' });
    await task({ title: 'Cancelled', dueOn: '2026-11-04', status: 'cancelled' });
    await task({ title: 'Owner blocked', assignee: ids.owner, dueOn: '2026-11-30', status: 'blocked' });
    const gone = await task({ title: 'Deleted', dueOn: '2026-11-04', status: 'blocked' });
    await t.pool.query(`UPDATE tasks SET deleted_at = now(), deleted_by = $2, delete_reason = 'Entered in error' WHERE id = $1`, [gone, ids.pm]);

    const mem = await me('mem');
    assert.deepEqual(kinds(mem, 'overdue'), [
      { kind: 'overdue', projectId, projectName: 'Harbour works', label: 'Overdue', since: midnight('2026-11-05'), link: `#/projects/${projectId}/tasks/${overdue}` },
    ]);
    assert.deepEqual(kinds(mem, 'blocked'), [
      { kind: 'blocked', projectId, projectName: 'Harbour works', label: 'Blocked', since: midnight('2026-11-30'), link: `#/projects/${projectId}/tasks/${blocked}` },
    ]);
    const soon = kinds(mem, 'due_soon');
    assert.deepEqual(soon.map((n) => n.label), ['Due today', 'Due in seven working days']);
    assert.deepEqual(soon[0], { kind: 'due_soon', projectId, projectName: 'Harbour works', label: 'Due today', since: midnight('2026-11-09'), link: `#/projects/${projectId}/tasks/${today}` });

    // The PM sees every Blocked task of the project; the Owner and a Sponsor only their own.
    const pm = await me('pm');
    assert.deepEqual(kinds(pm, 'blocked').map((n) => n.label), ['Blocked', 'Owner blocked']);
    assert.deepEqual([kinds(pm, 'overdue'), kinds(pm, 'due_soon')], [[], []], "not the PM's own tasks");
    assert.deepEqual(kinds(await me('owner'), 'blocked').map((n) => n.label), ['Owner blocked']);
    assert.deepEqual(kinds(await me('sponsor'), 'blocked'), []);
    await t.pool.query(`INSERT INTO memberships (id, project_id, user_id, role, starts_on) VALUES ($1, $2, $3, 'deputy_pm', '2026-11-01')`, [uuidv7(), projectId, ids.sponsor2]);
    assert.deepEqual(kinds(await me('sponsor2'), 'blocked').map((n) => n.label), ['Blocked', 'Owner blocked'], 'a Deputy PM too');
  });

  test('due soon follows the project calendar', async () => {
    await task({ title: 'Due Monday next', dueOn: '2026-11-16' });
    await task({ title: 'Due Tuesday next', dueOn: '2026-11-17' });
    assert.deepEqual(kinds(await me('mem'), 'due_soon').map((n) => n.label), ['Due Monday next', 'Due Tuesday next'], 'working days');
    const myDueSoon = async () => ((await me('mem')).myTasks.dueSoon as Array<{ title: string }>).map((r) => r.title);
    assert.deepEqual(await myDueSoon(), ['Due Monday next', 'Due Tuesday next'], 'My tasks agrees with Needs you');
    await t.pool.query(`INSERT INTO holidays (id, project_id, on_date, name, added_by, added_at) VALUES ($1, $2, '2026-11-12', 'Dummy holiday', $3, now())`, [uuidv7(), projectId, ids.pm]);
    await task({ title: 'Due Thursday next', dueOn: '2026-11-19' });
    assert.deepEqual(kinds(await me('mem'), 'due_soon').map((n) => n.label), ['Due Monday next', 'Due Tuesday next', 'Due Thursday next'], 'a holiday moves the end on a day');
    assert.deepEqual(await myDueSoon(), ['Due Monday next', 'Due Tuesday next', 'Due Thursday next']);
    await t.pool.query(`INSERT INTO project_notification_settings (project_id, day_counting) VALUES ($1, 'calendar')`, [projectId]);
    assert.deepEqual(kinds(await me('mem'), 'due_soon').map((n) => n.label), ['Due Monday next'], 'calendar days');
  });

  test('risk reviews due within 7 days need the risk owner', async () => {
    const soon = await risk({ description: 'Crane may fail', responsible: ids.mem, reviewOn: '2026-11-12' });
    await risk({ description: 'Missed review', responsible: ids.mem, reviewOn: '2026-11-02', status: 'mitigating' });
    await risk({ description: 'Review later', responsible: ids.mem, reviewOn: '2026-11-19' });
    await risk({ description: 'Resolved', responsible: ids.mem, reviewOn: '2026-11-12', status: 'resolved' });
    await risk({ description: 'No review date', responsible: ids.mem, reviewOn: null, status: 'accepted' });
    await risk({ description: "Someone else's", responsible: ids.owner, reviewOn: '2026-11-12' });
    const mem = kinds(await me('mem'), 'risk_review');
    assert.deepEqual(mem.map((n) => n.label), ['Missed review', 'Crane may fail']);
    assert.deepEqual(mem[1], {
      kind: 'risk_review', projectId, projectName: 'Harbour works', label: 'Crane may fail', since: midnight('2026-11-12'), link: `#/projects/${projectId}/work/${soon}`,
    });
    assert.deepEqual(kinds(await me('pm'), 'risk_review'), [], 'the PM does not own them');
    assert.deepEqual(kinds(await me('owner'), 'risk_review').map((n) => n.label), ["Someone else's"]);
  });

  test('a cleaned held task or risk shows its held label; an uncleaned one is absent', async () => {
    const cleanedTask = await task({ title: 'Secret overdue text', dueOn: '2026-11-05' });
    const heldTask = await task({ title: 'Secret blocked text', status: 'blocked' });
    const cleanedRisk = await risk({ description: 'Secret risk text', responsible: ids.mem, reviewOn: '2026-11-12' });
    await holdRecord('tasks', 'task', cleanedTask, 'cleaned');
    await holdRecord('tasks', 'task', heldTask, 'held');
    await holdRecord('risks', 'risk', cleanedRisk, 'cleaned');
    const body = await me('mem');
    assert.deepEqual(kinds(body, 'overdue').map((n) => n.label), [UNDER_REVIEW_TEXT]);
    assert.deepEqual(kinds(body, 'blocked'), []);
    assert.deepEqual(kinds(body, 'risk_review').map((n) => n.label), [UNDER_REVIEW_TEXT]);
    assert.ok(!JSON.stringify(body).includes('Secret'), 'no held text anywhere');
  });

  const block = (id: string, note: string, at: string) =>
    t.pool.query(
      `INSERT INTO task_events (id, task_id, kind, from_status, to_status, note, actor_id, at) VALUES ($1, $2, 'blocked', 'in_progress', 'blocked', $3, $4, $5)`,
      [uuidv7(), id, note, ids.mem, at],
    );
  const deleteTask = (id: string) => t.pool.query(`UPDATE tasks SET deleted_at = now(), deleted_by = $2, delete_reason = 'Entered in error' WHERE id = $1`, [id, ids.pm]);
  const mineByTitle = async () => {
    const b = await me('mem', '?showCompleted=1');
    return Object.fromEntries([...b.myTasks.overdue, ...b.myTasks.dueSoon, ...b.myTasks.later, ...(b.myTasks.completed ?? [])].map((r) => [r.title, r]));
  };

  test('My tasks gives the day finished, the latest block, the parent and the live subtask count', async () => {
    const stuck = await task({ title: 'Stuck', status: 'blocked' });
    await block(stuck, 'First reason', '2026-11-03T02:00:00Z');
    await block(stuck, 'Second reason', '2026-11-04T02:00:00Z');
    await task({ title: 'Free' });
    await task({ title: 'Done late', status: 'completed', completedAt: '2026-11-05T23:30:00Z' });
    const top = await task({ title: 'Top task', assignee: ids.pm });
    await task({ title: 'Child', parent: top });
    const withSubs = await task({ title: 'Has subtasks' });
    for (const [title, status] of [['A', 'completed'], ['B', 'in_progress'], ['C', 'cancelled']] as const) await task({ title, parent: withSubs, status, assignee: ids.pm });
    await deleteTask(await task({ title: 'D', parent: withSubs, assignee: ids.pm }));
    await holdRecord('tasks', 'task', await task({ title: 'E', parent: withSubs, assignee: ids.pm }), 'held');
    await holdRecord('tasks', 'task', await task({ title: 'F', parent: withSubs, assignee: ids.pm }), 'cleaned');
    const rows = await mineByTitle();
    assert.equal(rows.Stuck.blockedReason, 'Second reason');
    assert.equal(rows.Free.blockedReason, null);
    assert.equal(rows['Done late'].completedOn, '2026-11-06', 'the UTC+8 day');
    assert.equal(rows.Free.completedOn, null);
    assert.deepEqual(rows.Child.parent, { id: top, title: 'Top task' });
    assert.equal(rows.Free.parent, null);
    assert.deepEqual(rows['Has subtasks'].subtasks, { done: 1, total: 2 }, 'A and B: not cancelled, Deleted or held');
    assert.deepEqual(rows.Free.subtasks, { done: 0, total: 0 });
  });

  test('the number of queries does not grow with the tasks', async () => {
    const count = async () => {
      let n = 0;
      const pool = t.app.get(PG_POOL);
      const original = pool.query;
      pool.query = function (...args: unknown[]) {
        n += 1;
        return original.apply(pool, args);
      };
      try {
        await me('mem');
      } finally {
        pool.query = original;
      }
      return n;
    };
    let made = 0;
    const make = async (n: number) => {
      for (let i = made; i < made + n; i += 1) {
        const parent = await task({ title: `Parent ${i}`, status: i % 2 === 0 ? 'blocked' : 'in_progress', dueOn: `2026-11-${10 + (i % 15)}` });
        if (i % 2 === 0) await block(parent, 'Waiting', '2026-11-04T02:00:00Z');
        await task({ title: `Child ${i}`, parent });
      }
      made += n;
    };
    await make(1);
    await me('mem');
    const one = await count();
    await make(19);
    assert.equal(Object.keys(await mineByTitle()).length, 40);
    assert.equal(await count(), one);
  });

  test('a held or Deleted parent is not named; a held task gives no reason', async () => {
    const parents = {
      deleted: await task({ title: 'Secret deleted parent', assignee: ids.pm }),
      held: await task({ title: 'Secret held parent', assignee: ids.pm }),
      cleaned: await task({ title: 'Secret cleaned parent', assignee: ids.pm }),
    };
    for (const [name, id] of Object.entries(parents)) await task({ title: `Child of ${name}`, parent: id });
    await deleteTask(parents.deleted);
    await holdRecord('tasks', 'task', parents.held, 'held');
    await holdRecord('tasks', 'task', parents.cleaned, 'cleaned');
    const stuck = await task({ title: 'Secret stuck text', status: 'blocked' });
    await block(stuck, 'Secret reason text', '2026-11-04T02:00:00Z');
    await holdRecord('tasks', 'task', stuck, 'cleaned');
    const rows = await mineByTitle();
    for (const name of Object.keys(parents)) assert.equal(rows[`Child of ${name}`].parent, null, name);
    assert.equal(rows[UNDER_REVIEW_TEXT].blockedReason, null);
    assert.ok(!JSON.stringify(await me('mem')).includes('Secret'), 'no held or Deleted text anywhere');
  });

  test('an On Hold member gets none of the task and risk kinds for that project', async () => {
    await task({ title: 'Overdue', dueOn: '2026-11-05' });
    await task({ title: 'Blocked', status: 'blocked' });
    await task({ title: 'Due soon', dueOn: '2026-11-10' });
    await risk({ description: 'Crane may fail', responsible: ids.mem, reviewOn: '2026-11-12' });
    assert.equal((await me('mem')).needsYou.length, 4);
    await t.pool.query(`UPDATE memberships SET held_at = now(), held_by = $2, hold_reason = 'Checking' WHERE project_id = $1 AND user_id = $3`, [projectId, ids.owner, ids.mem]);
    assert.deepEqual((await me('mem')).needsYou, []);
    assert.equal(kinds(await me('pm'), 'blocked').length, 1, 'the PM still sees the Blocked task');
    await t.pool.query(`UPDATE memberships SET held_at = now(), held_by = $2, hold_reason = 'Checking' WHERE project_id = $1 AND user_id = $3`, [projectId, ids.owner, ids.pm]);
    assert.deepEqual(kinds(await me('pm'), 'blocked'), [], 'nor for a held PM');
  });

  test('Nothing needs you right now when empty', async () => {
    const body = await me('loner');
    assert.deepEqual(body.needsYou, []);
    assert.deepEqual(body.projects, []);
    assert.deepEqual(body.myTasks, { overdue: [], dueSoon: [], later: [], awaitingReview: [] });
    assert.deepEqual((await me('mem')).needsYou, []);
    assert.equal((await t.anonymous('GET', '/dashboard/me')).status, 401);
  });
});
