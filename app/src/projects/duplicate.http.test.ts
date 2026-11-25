import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { uuidv7 } from '../common/uuid7';
import { newKeyBytes } from '../quarantine/protected-key';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type Reply, type TestApp, startTestApp } from '../testing/http';
import { seedDepartment, seedProject, seedUser } from '../testing/projects';

const ORIGINAL = 'Harbour survey 2026';
/** Tables of a project that duplicating it never writes to. */
const NEVER_COPIED: string[] = [
  'access_grants', 'ai_answers', 'ai_assist_events', 'ai_connection_events', 'ai_connection_keys', 'ai_connections', 'ai_feedback',
  'ai_request_material', 'ai_requests', 'ai_spend_entries', 'analysis_runs', 'analysis_settings_changes', 'approvals', 'audience_events',
  'audience_members', 'audiences', 'budget_versions', 'change_request_versions', 'change_requests', 'closure_delegations', 'closure_dispositions',
  'decisions', 'digest_runs', 'discussion_events', 'discussion_messages', 'discussion_threads', 'email_attempts', 'email_outbox',
  'email_preferences', 'expenditure_adjustments', 'expenditures', 'extraction_item_edits', 'extraction_items', 'extraction_runs', 'feedback_events',
  'grant_events', 'invitations', 'leadership_grant_projects', 'meeting_attendees', 'membership_findings', 'message_versions', 'minutes_drafts',
  'notification_triggers', 'notifications', 'output_categories', 'output_contributors', 'output_events', 'output_version_bytes', 'output_versions',
  'outputs', 'passages', 'project_ai_limit_events', 'project_ai_limits', 'project_analysis_settings', 'project_archive_events',
  'project_department_changes', 'project_department_transfers', 'project_finance_changes', 'project_finance_settings', 'project_finance_state',
  'project_stage_changes', 'project_transitions', 'quarantine_cases', 'quarantine_events', 'quarantine_grant_cases', 'quarantine_items',
  'quarantine_originals', 'quarantine_possible_copies', 'question_answers', 'questions', 'record_deletion_delegations', 'report_draft_versions',
  'report_drafts', 'review_flags', 'risks', 'source_events', 'source_version_meeting_dates', 'source_versions', 'sources', 'stored_file_moves',
  'stored_file_withholds', 'stored_files', 'summaries', 'summary_marks', 'summary_versions', 'task_events', 'tasks', 'transcript_spans',
];
const OPEN = 'Something in the original is under review for a suspected credential. Create the copy when the review has ended.';
const PASSWORD = 'password: hunter2hunter2';

describe('duplicating a project (D140)', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  const ids: Record<string, string> = {};
  const c: Record<string, Client> = {};
  let project: string;
  let dept: string;
  let contributing: string;
  let task: string;
  let sub: string;
  let deep: string;
  let cancelled: string;
  let risk: string;
  let item: string;
  let line: string;
  let oneOff: string;

  const addTask = async (title: string, over: Record<string, unknown> = {}) => {
    const id = uuidv7();
    await t.pool.query(
      `INSERT INTO tasks (id, project_id, parent_id, depth, title, description, assignee_id, due_on, status, authorised_by, authorised_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, '2026-11-20', $8, $7, now())`,
      [id, over.project ?? project, over.parent ?? null, over.depth ?? 0, title, over.description ?? null, ids.pm, over.status ?? 'completed'],
    );
    await t.pool.query(`INSERT INTO task_events (id, task_id, kind, to_status, actor_id, at) VALUES ($1, $2, 'authorised', 'not_started', $3, now())`, [uuidv7(), id, ids.pm]);
    return id;
  };
  const addRisk = async (text: string, projectId = project) => {
    const id = uuidv7();
    const proposal = uuidv7();
    await t.pool.query(
      `INSERT INTO human_proposals (id, project_id, kind, text, proposed_by, proposed_at, review_status, reviewed_by, reviewed_at) VALUES ($1, $2, 'risk', $3, $4, now(), 'approved', $4, now())`,
      [proposal, projectId, text, ids.pm],
    );
    await t.pool.query(
      `INSERT INTO risks (id, project_id, description, severity, mitigation, origin_proposal_id, authorised_by, authorised_at) VALUES ($1, $2, $3, 'high', 'Old mitigation', $4, $5, now())`,
      [id, projectId, text, proposal, ids.pm],
    );
    return id;
  };
  const addItem = async (reference: string) => {
    const id = uuidv7();
    await t.pool.query(`INSERT INTO resource_items (id, kind, reference, name, created_by, created_at) VALUES ($1, 'equipment', $2, 'Dummy pump', $3, now())`, [id, reference, ids.pm]);
    return id;
  };
  const addLine = async (values: { item?: string; oneOff?: string; status?: string }) => {
    const id = uuidv7();
    await t.pool.query(
      `INSERT INTO resource_lines (id, project_id, item_id, one_off_kind, description, quantity, unit, starts_on, ends_on, needed_by, notes, status, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 2, 'items', '2026-11-01', '2026-11-30', '2026-11-05', 'Ask the old supplier', $6, $7, now(), now())`,
      [id, project, values.item ?? null, values.oneOff ? 'other' : null, values.oneOff ?? '', values.status ?? 'finished', ids.pm],
    );
    return id;
  };

  beforeEach(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kainow-dup-'));
    writeFileSync(join(dir, 'key'), newKeyBytes().bytes);
    t = await startTestApp(undefined, { protectedKeyFile: join(dir, 'key') });
    await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator').then((id) => (ids.admin = id));
    for (const p of ['pm', 'dep', 'own', 'own2', 'mem', 'late', 'new']) ids[p] = await seedUser(t.pool, `${p}@example.org`);
    dept = await seedDepartment(t.pool, 'Registry');
    contributing = await seedDepartment(t.pool, 'Stores');
    project = await seedProject(t.pool, {
      name: ORIGINAL,
      status: 'closed',
      departmentId: dept,
      members: [
        { userId: ids.pm, role: 'pm' },
        { userId: ids.dep, role: 'deputy_pm' },
        { userId: ids.own, role: 'owner' },
        { userId: ids.mem, role: 'member' },
        { userId: ids.late, role: 'pm', expiresOn: '2026-11-05' },
      ],
    });
    await t.pool.query(`UPDATE projects SET purpose = 'Survey the harbour for Dummy Customer', planned_end = '2026-12-31', required_approvals = 2 WHERE id = $1`, [project]);
    await t.pool.query(`INSERT INTO project_departments (project_id, department_id) VALUES ($1, $2)`, [project, contributing]);
    await t.pool.query(`INSERT INTO project_transitions (id, project_id, from_status, to_status, actor_id, closure_outcome, at) VALUES ($1, $2, 'active', 'closed', $3, 'abandoned', '2024-01-01')`, [uuidv7(), project, ids.pm]);
    await t.pool.query(`UPDATE project_stages SET status = 'retired', retired_by = $2, retired_at = now() WHERE project_id = $1 AND position = 4`, [project, ids.pm]);
    await t.pool.query(`INSERT INTO holidays (id, project_id, on_date, name, added_by, added_at) VALUES ($1, $2, '2027-01-04', 'Dummy Customer day', $3, now())`, [uuidv7(), project, ids.pm]);
    await t.pool.query(`INSERT INTO holidays (id, project_id, on_date, name, added_by, added_at, removed_by, removed_at) VALUES ($1, $2, '2027-01-05', 'Removed day', $3, now(), $3, now())`, [uuidv7(), project, ids.pm]);
    await t.pool.query(
      `INSERT INTO project_notification_settings (project_id, day_counting, lead_days, digest_enabled, digest_frequency, digest_weekday, digest_time, updated_by) VALUES ($1, 'calendar', '{5,2}', true, 'weekly', 1, '09:00', $2)`,
      [project, ids.pm],
    );
    await t.pool.query(`INSERT INTO project_output_settings (project_id, input_formats, output_formats, export_roles, updated_by, updated_at) VALUES ($1, '{txt}', '{pdf,csv}', '{pm,owner}', $2, now())`, [project, ids.pm]);
    task = await addTask('Order samples for 2026', { description: 'From Dummy Customer' });
    sub = await addTask('Pack the samples', { parent: task, depth: 1, description: 'Two boxes' });
    deep = await addTask('Label the boxes', { parent: sub, depth: 2 });
    cancelled = await addTask('Cancelled work', { status: 'cancelled' });
    await addTask('Under cancelled', { parent: cancelled, depth: 1 });
    risk = await addRisk('Dummy Customer may delay');
    item = await addItem('PUMP-1');
    line = await addLine({ item });
    oneOff = await addLine({ oneOff: 'Hired boat' });
    await t.pool.query(`INSERT INTO eligible_domains (id, domain, added_by, added_at) SELECT $1, 'example.org', $2, now() WHERE NOT EXISTS (SELECT 1 FROM eligible_domains WHERE domain = 'example.org' AND removed_at IS NULL)`, [uuidv7(), ids.admin]);
    // The Administrator lets projects set everything, so the original's own settings may be carried; tests turn it off.
    await t.pool.query(`UPDATE notification_settings SET projects_may_change_calendar = true, projects_may_change_timings = true, projects_may_change_digest = true`);
    await t.pool.query(`UPDATE storage_settings SET projects_may_change_formats = true, projects_may_set_export_roles = true`);
    await t.pool.query(`UPDATE approval_policy SET projects_may_override = true`);
    for (const p of ['admin', 'pm', 'dep', 'own', 'mem', 'late', 'new']) c[p] = await t.signIn(`${p}@example.org`);
  });
  afterEach(async () => {
    await t?.close();
  });

  const getOffer = async (who = c.pm) => {
    const r = await who.request('GET', `/projects/${project}/duplicate`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body;
  };
  const strip = (x: any) => ({ id: x.id, title: x.title, description: x.description });
  /** Everything kept as it was offered, with the required decisions made. */
  const body = async (over: Record<string, unknown> = {}) => {
    const o = await getOffer();
    return {
      name: 'Harbour survey 2027', plannedEnd: '2027-12-31', purpose: 'Survey the second harbour',
      owningDepartmentId: o.original.owningDepartment.id,
      contributingDepartmentIds: o.original.contributingDepartments.map((d: any) => d.id),
      asOf: o.asOf, stages: o.stages, holidays: o.holidays,
      tasks: o.tasks.map((x: any) => ({ ...strip(x), subtasks: x.subtasks.map(strip) })),
      risks: o.risks.map((x: any) => ({ id: x.id, text: x.text })),
      resources: o.resources.map((x: any) => ({ id: x.id, ...(x.oneOffKind ? { description: x.description } : {}) })),
      oldTerms: [], confirmedKeys: [],
      ...over,
    };
  };
  const duplicate = async (over: Record<string, unknown> = {}, who = c.pm): Promise<Reply> => who.request('POST', `/projects/${project}/duplicate`, await body(over));
  const made = async (over: Record<string, unknown> = {}) => {
    const r = await duplicate(over);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.project;
  };
  const tables = async (): Promise<string[]> =>
    (await t.pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1`)).rows.map((r) => r.table_name);
  const counts = async (): Promise<Record<string, number>> => {
    const out: Record<string, number> = {};
    for (const name of await tables()) out[name] = Number((await t.pool.query(`SELECT count(*) AS n FROM "${name}"`)).rows[0].n);
    return out;
  };
  const refused = async (over: Record<string, unknown>, message: string | RegExp, status = 400) => {
    const b = await body();
    const before = await counts();
    const r = await c.pm.request('POST', `/projects/${project}/duplicate`, { ...b, ...over });
    assert.equal(r.status, status, JSON.stringify(r.body));
    if (typeof message === 'string') assert.equal(r.body.message, message);
    else assert.match(r.body.message, message);
    assert.deepEqual(await counts(), before, 'a refusal leaves nothing behind');
    return r.body;
  };

  test('everything offered, and nothing that is not the Project Manager’s to copy', async () => {
    const o = await getOffer();
    assert.deepEqual([o.original.name, o.original.plannedEnd, o.original.owningDepartment], [ORIGINAL, '2026-12-31', { id: dept, name: 'Registry', retired: false }]);
    assert.equal(o.stages.length, (await t.pool.query(`SELECT 1 FROM project_stages WHERE project_id = $1 AND status = 'active'`, [project])).rowCount);
    assert.deepEqual(o.holidays.map((h: any) => [h.date, h.name]), [['2027-01-04', 'Dummy Customer day']]);
    assert.deepEqual(o.tasks.map((x: any) => [x.id, x.subtasks.map((s: any) => [s.id, s.parentId])]), [[task, [[sub, task], [deep, sub]]]]);
    assert.deepEqual(o.risks.map((r: any) => [r.id, r.text]), [[risk, 'Dummy Customer may delay']]);
    assert.deepEqual(o.resources.map((l: any) => l.id).sort(), [line, oneOff].sort());
    assert.equal(o.settings.requiredApprovals, 2);
    assert.deepEqual(Object.keys(o.settings.outputs).sort(), ['exportRoles', 'inputFormats', 'outputFormats'], 'no destination');
    const text = JSON.stringify(o);
    for (const never of ['Old mitigation', 'old supplier', 'assignee', '2026-11-20', '2026-11-30', 'pm@example.org']) assert.ok(!text.includes(never), never);
    const keys = [o.original.purposeKey, ...o.stages.flatMap((s: any) => [s.key, ...s.substages.map((x: any) => x.key)]), ...o.holidays.map((h: any) => h.key), ...o.tasks.flatMap((x: any) => [x, ...x.subtasks]).flatMap((x: any) => [x.titleKey, x.descriptionKey]), ...o.risks.map((r: any) => r.key)];
    assert.equal(new Set(keys).size, keys.length, 'one key per text');
  });

  test('copies each kind to one Draft project whose only member is the person', async () => {
    const b = await body();
    b.tasks[0].due = '2027-02-01';
    b.tasks[0].subtasks[0].due = '2027-01-15';
    const r = await c.pm.request('POST', `/projects/${project}/duplicate`, b);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const p = r.body.project;
    assert.deepEqual([p.name, p.status, p.plannedEnd, p.purpose, p.owningDepartment.id], ['Harbour survey 2027', 'draft', '2027-12-31', 'Survey the second harbour', dept]);
    assert.deepEqual(p.contributingDepartments.map((d: any) => d.id), [contributing]);
    assert.deepEqual(p.memberships.map((m: any) => [m.userId, m.role, m.state]), [[ids.pm, 'pm', 'active']]);
    assert.deepEqual(p.copiedFrom, { id: project, name: ORIGINAL });
    assert.deepEqual(p.stages.map((s: any) => [s.name, s.substages, s.status]), b.stages.map((s: any) => [s.name, s.substages.map((x: any) => x.name), 'active']));
    assert.deepEqual([p.stage.stage, p.stagePeriods.length, p.stageChanges], [b.stages[0].name, 1, []]);

    const proposals = (await c.pm.request('GET', `/projects/${p.id}/proposals`)).body.proposals;
    assert.deepEqual(proposals.map((x: any) => [x.kind, x.text, x.description, x.owner, x.due, x.reviewStatus, x.record]), [
      ['action', 'Order samples for 2026', 'From Dummy Customer', null, '2027-02-01', 'pending', null],
      ['risk', 'Dummy Customer may delay', null, null, null, 'pending', null],
    ]);
    assert.deepEqual(proposals[0].dueReading.latest, '2027-02-01');
    assert.deepEqual(proposals[0].proposedSubtasks, [
      { title: 'Pack the samples', description: 'Two boxes', due: '2027-01-15' },
      { title: 'Label the boxes', description: null, due: null },
    ]);
    assert.deepEqual([proposals[0].copiedFrom, proposals[1].copiedFrom, proposals[1].proposedSubtasks], [{ id: project, name: ORIGINAL }, { id: project, name: ORIGINAL }, null]);

    const lines = (await c.pm.request('GET', `/projects/${p.id}/resources`)).body.lines;
    assert.deepEqual(
      lines.map((l: any) => [l.item?.id ?? null, l.oneOffKind, l.description, l.quantity, l.unit, l.startsOn, l.endsOn, l.neededBy, l.notes, l.status]).sort(),
      [[item, null, '', '2.00', 'items', null, null, null, '', 'needed'], [null, 'other', 'Hired boat', '2.00', 'items', null, null, null, '', 'needed']].sort(),
    );
    const settings = (await c.pm.request('GET', `/projects/${p.id}/notification-settings`)).body;
    assert.deepEqual([settings.own.dayCounting, settings.own.leadDays, settings.own.digestEnabled, settings.own.digestTime], ['calendar', [5, 2], true, '09:00']);
    assert.deepEqual([...new Set(settings.history.map((h: any) => h.reason))], ['Copied from another project when this one was created']);
    assert.ok(settings.history.some((h: any) => h.field === 'holiday' && h.newValue === '2027-01-04 Dummy Customer day'));
    const own = (await t.pool.query(`SELECT destination_id, input_formats, output_formats, export_roles FROM project_output_settings WHERE project_id = $1`, [p.id])).rows[0];
    assert.deepEqual(own, { destination_id: null, input_formats: ['txt'], output_formats: ['pdf', 'csv'], export_roles: ['pm', 'owner'] });
    assert.equal((await t.pool.query(`SELECT required_approvals AS n FROM projects WHERE id = $1`, [p.id])).rows[0].n, 2);
    const audit = (await t.pool.query(`SELECT subject_id, detail FROM audit_events WHERE action = 'project.duplicated'`)).rows;
    assert.deepEqual(audit, [{ subject_id: project, detail: { newProjectId: p.id, stages: b.stages.length, holidays: 1, tasks: 3, risks: 1, resources: 2 } }]);
  });

  /**
   * What a duplication writes, table by table; every other table stays as it was. A table that belongs to a project
   * must be named in one of the two lists, so a new one cannot be missed.
   */
  const COPIED = [
    'approval_policy_changes', 'holidays', 'human_proposals', 'membership_events', 'memberships', 'notification_settings_changes', 'project_departments',
    'project_notification_settings', 'project_output_settings', 'project_output_settings_changes', 'project_stage_periods', 'project_stages', 'projects',
    'resource_line_events', 'resource_lines',
  ];

  /**
   * A row of the original in each table with a project_id, as plain as its rules allow (without its foreign keys), so
   * that copying it would show in the counts. Tables whose rules refuse such a row are left out; those seeded are returned.
   */
  const seedTables = async (names: string[]): Promise<string[]> => {
    const done: string[] = [];
    const db = await t.pool.connect();
    try {
      await db.query(`SET session_replication_role = replica`);
      for (const name of names) {
        const cols = (
          await db.query<{ column: string; type: string }>(
            `SELECT column_name AS column, data_type AS type FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = $1 AND ((is_nullable = 'NO' AND column_default IS NULL AND is_generated = 'NEVER') OR column_name = 'project_id')`,
            [name],
          )
        ).rows;
        if (!cols.some((x) => x.column === 'project_id')) continue;
        const checks = (await db.query(`SELECT string_agg(pg_get_constraintdef(oid), ' ') AS def FROM pg_constraint WHERE contype = 'c' AND conrelid = $1::regclass`, [name])).rows[0].def ?? '';
        const value = (x: { column: string; type: string }): unknown => {
          if (x.column === 'project_id') return project;
          if (x.type === 'uuid') return uuidv7();
          if (x.type === 'text') return new RegExp(`\\b${x.column} = ANY \\(ARRAY\\['([^']+)'`).exec(checks)?.[1] ?? 'Old';
          if (x.type === 'boolean') return false;
          if (x.type.startsWith('timestamp') || x.type === 'date') return '2026-11-01';
          if (x.type === 'jsonb' || x.type === 'ARRAY') return '{}';
          return x.type === 'bytea' ? Buffer.from('x') : 1;
        };
        try {
          await db.query(`INSERT INTO "${name}" (${cols.map((x) => `"${x.column}"`).join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, cols.map(value));
          done.push(name);
        } catch {
          // Its rules want more than plain values.
        }
      }
    } finally {
      await db.query(`SET session_replication_role = DEFAULT`);
      db.release();
    }
    return done;
  };

  test('never copies anything else', async () => {
    // A row of the kinds people would miss most, so that a copy of them would show in the counts.
    await t.pool.query(`UPDATE projects SET status = 'active', closure_outcome = NULL WHERE id = $1`, [project]);
    for (const [path, b] of [
      ['notes', { title: 'Old note', text: 'Old note text' }],
      ['threads', { kind: 'discussion', title: 'Old thread', body: 'Old message' }],
      ['proposals', { kind: 'decision', text: 'Old decision' }],
    ] as const) {
      const r = await c.pm.request('POST', `/projects/${project}/${path}`, b);
      assert.ok(r.status < 300, `${path}: ${JSON.stringify(r.body)}`);
    }
    await t.pool.query(
      `INSERT INTO access_grants (id, project_id, user_id, kind, purpose, scope, starts_on, expires_on, requested_by, requested_at) VALUES ($1, $2, $3, 'audit', 'p', 's', '2026-11-01', '2026-11-30', $4, now())`,
      [uuidv7(), project, ids.new, ids.own],
    );
    // Not the quarantine tables: an open case refuses the duplication.
    const seeded = await seedTables(NEVER_COPIED.filter((x) => !x.startsWith('quarantine_')));
    assert.ok(seeded.length >= 35, `only ${seeded.length} of the tables hold a row of the original: ${seeded.join(', ')}`);
    // Text of kinds that are never copied, looked for afterwards in everything the new project holds.
    const CANARY = 'canary-of-the-original';
    const put = (sql: string, ...more: unknown[]) => t.pool.query(sql, [project, CANARY, ...more]);
    await put(`UPDATE tasks SET owner_as_written = $2 WHERE project_id = $1`);
    await put(`UPDATE tasks SET title = $2, description = $2 WHERE project_id = $1 AND status = 'cancelled'`);
    await t.pool.query(`INSERT INTO task_events (id, task_id, kind, note, actor_id, at) VALUES ($1, $2, 'blocked', $3, $4, now())`, [uuidv7(), task, CANARY, ids.pm]);
    await put(`UPDATE risks SET mitigation = $2 WHERE project_id = $1`);
    await put(`UPDATE resource_lines SET notes = $2 WHERE project_id = $1`);
    await put(`INSERT INTO project_stage_changes (id, project_id, kind, actor_id, at, reason, previous, next) VALUES ($3, $1, 'reordered', $4, now(), $2, $5, $5)`, uuidv7(), ids.pm, JSON.stringify([{ name: CANARY }]));
    await put(`UPDATE project_stage_periods SET reason = $2 WHERE project_id = $1`);
    await put(`UPDATE project_stages SET name = $2 WHERE project_id = $1 AND status = 'retired'`);
    await put(`UPDATE memberships SET hold_reason = $2 WHERE project_id = $1`);
    await put(`UPDATE holidays SET name = $2 WHERE project_id = $1 AND removed_at IS NOT NULL`);
    await put(`UPDATE human_proposals SET text = $2 WHERE project_id = $1 AND kind = 'decision'`);
    await put(`INSERT INTO questions (id, project_id, text, requester_id, origin_proposal_id, authorised_by, authorised_at) SELECT $3, $1, $2, $4, id, $4, now() FROM human_proposals WHERE project_id = $1 AND kind = 'decision' LIMIT 1`, uuidv7(), ids.pm);
    await put(`INSERT INTO approval_policy_changes (id, project_id, field, new_value, reason, actor_id, at) VALUES ($3, $1, 'required', '2', $2, $4, now())`, uuidv7(), ids.pm);
    await put(`INSERT INTO notification_settings_changes (id, scope, project_id, field, new_value, reason, actor_id, at) VALUES ($3, 'project', $1, 'holiday', $2, $2, $4, now())`, uuidv7(), ids.pm);
    await put(`INSERT INTO project_output_settings_changes (id, project_id, actor_id, at, reason, previous, next) VALUES ($3, $1, $4, now(), $2, '{}', '{}')`, uuidv7(), ids.pm);
    const canaries = async () => {
      const out: Record<string, number> = {};
      for (const name of await tables()) {
        const n = Number((await t.pool.query(`SELECT count(*) AS n FROM "${name}" x WHERE strpos(x::text, $1) > 0`, [CANARY])).rows[0].n);
        if (n > 0) out[name] = n;
      }
      return out;
    };
    const held = await canaries();
    for (const name of ['tasks', 'task_events', 'risks', 'resource_lines', 'project_stage_changes', 'project_stage_periods', 'memberships', 'holidays', 'human_proposals', 'project_stages', 'questions', 'approval_policy_changes', 'notification_settings_changes', 'project_output_settings_changes']) {
      assert.ok(held[name] > 0, `${name} holds the canary`);
    }
    const b = await body();
    const originalBefore = (await t.pool.query(`SELECT * FROM projects WHERE id = $1`, [project])).rows[0];
    const before = await counts();
    const r = await c.pm.request('POST', `/projects/${project}/duplicate`, b);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual(await canaries(), held, 'no never-copied text reached any row of the new project');
    const after = await counts();
    const delta = Object.fromEntries(Object.keys(after).filter((k) => after[k] !== before[k]).map((k) => [k, after[k] - before[k]]));
    const audits = delta.audit_events;
    delete delta.audit_events;
    assert.deepEqual(delta, {
      approval_policy_changes: 1, holidays: 1, human_proposals: 2, membership_events: 1, memberships: 1, notification_settings_changes: 7,
      project_departments: 1, project_notification_settings: 1, project_output_settings: 1, project_output_settings_changes: 1,
      project_stage_periods: 1, project_stages: b.stages.length, projects: 1, resource_line_events: 2, resource_lines: 2,
    });
    assert.ok(audits > 0);
    assert.deepEqual((await t.pool.query(`SELECT * FROM projects WHERE id = $1`, [project])).rows[0], originalBefore, 'the original is not changed');

    // Every table that leads to a project by its keys, found from the schema.
    const fks = (
      await t.pool.query<{ child: string; parent: string }>(
        `SELECT DISTINCT c.relname AS child, p.relname AS parent FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_class p ON p.oid = k.confrelid
          WHERE k.contype = 'f' AND k.connamespace = 'public'::regnamespace`,
      )
    ).rows;
    const named = (await t.pool.query(`SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name LIKE '%project_id'`)).rows.map((x) => x.table_name as string);
    const base = new Set(await tables());
    const scoped = new Set(['projects', ...named.filter((n) => base.has(n))]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const f of fks) if (scoped.has(f.parent) && !scoped.has(f.child)) grew = !!scoped.add(f.child);
    }
    const decided = new Set([...COPIED, ...NEVER_COPIED]);
    assert.deepEqual([...scoped].filter((x) => !decided.has(x)).sort(), [], 'decide whether duplicating a project copies these tables, and add them to COPIED or NEVER_COPIED');
    assert.deepEqual([...decided].filter((x) => !scoped.has(x)).sort(), [], 'listed tables that are not part of a project');
    assert.ok(scoped.size > 60, 'the tables were found');
  });

  describe('what must be decided', () => {
    test('each one alone is refused and nothing is created', async () => {
      await refused({ name: ` ${ORIGINAL.toUpperCase()} ` }, "Give the new project a name different from the original's.");
      await refused({ plannedEnd: '2026-12-31' }, "Give a planned end date different from the original's.");
      await refused({ plannedEnd: undefined }, 'Give a planned end date or choose "No planned end".');
      await refused({ noPlannedEnd: true }, 'Give a planned end date or choose "No planned end", not both.');
      await refused({ purpose: 'Survey the harbour for Dummy Customer' }, 'Change the purpose or confirm it is still correct.');
      await refused({ plannedEnd: '31/12/2027' }, 'The planned end must be a date in the form YYYY-MM-DD.');
      const all = await refused({ name: ORIGINAL, plannedEnd: null }, /different from the original's\. Give a planned end/);
      assert.equal(all.problems.length, 2);
      const p = await made({ plannedEnd: null, noPlannedEnd: true, purpose: 'Survey the harbour for Dummy Customer', purposeConfirmed: true });
      assert.equal(p.plannedEnd, null);
    });

    test('a retired department must be replaced or removed', async () => {
      await t.pool.query(`UPDATE departments SET status = 'retired' WHERE id = $1`, [contributing]);
      assert.equal((await getOffer()).original.contributingDepartments[0].retired, true);
      await refused({}, 'Choose active contributing departments.');
      await t.pool.query(`UPDATE departments SET status = 'retired' WHERE id = $1`, [dept]);
      await refused({ contributingDepartmentIds: [] }, 'Choose an active owning department.');
      await made({ owningDepartmentId: await seedDepartment(t.pool, 'Third'), contributingDepartmentIds: [] });
    });

    test('old terms in every carried text, ignoring case; changed or confirmed', async () => {
      const r = await refused({ oldTerms: ['dummy CUSTOMER', '2026'] }, '4 texts still hold an old term. Change each one or confirm it is still correct.');
      const o = await getOffer();
      const found = r.terms.map((x: any) => `${x.key} ${x.term}`).sort();
      assert.deepEqual(found, [`task:${task}:title 2026`, `task:${task}:description dummy CUSTOMER`, `risk:${risk} dummy CUSTOMER`, `${o.holidays[0].key} dummy CUSTOMER`].sort());
      const keys = r.terms.map((x: any) => x.key);
      const b = await body({ oldTerms: ['dummy CUSTOMER', '2026'], confirmedKeys: keys.slice(1) });
      await refused({ oldTerms: ['dummy CUSTOMER', '2026'], confirmedKeys: keys.slice(1) }, /^1 text still holds/);
      b.tasks[0].title = 'Order samples';
      b.tasks[0].description = 'From the new customer';
      b.risks[0].text = 'The customer may delay';
      b.holidays = [];
      b.confirmedKeys = [];
      const done = await c.pm.request('POST', `/projects/${project}/duplicate`, b);
      assert.equal(done.status, 201, JSON.stringify(done.body));
      assert.equal((await t.pool.query(`SELECT 1 FROM audit_events WHERE detail::text ILIKE '%dummy customer%'`)).rowCount, 0, 'the terms are not stored');
      await made({ name: 'Third survey', oldTerms: ['dummy CUSTOMER', '2026'], confirmedKeys: keys });
    });

    test('an old term in the name, a stage, a substage, a subtask or a one-off line', async () => {
      const o = await getOffer();
      const r = await refused({ oldTerms: ['2027', o.stages[0].name, o.stages[0].substages[0].name, 'pack', 'boat'] }, /still hold an old term/);
      const keys = new Set(r.terms.map((x: any) => x.key));
      for (const k of ['name', o.stages[0].key, o.stages[0].substages[0].key, `task:${sub}:title`, `resource:${oneOff}`]) assert.ok(keys.has(k), k);
    });

    test('at most ten terms', async () => {
      await refused({ oldTerms: Array.from({ length: 11 }, (_, i) => `t${i}`) }, 'List at most 10 old terms.');
    });
  });

  describe('what may be copied is checked again at Create', () => {
    const GONE = /^Some of what you chose can no longer be copied \(1 (task|subtask|risk|resource line|stage|holiday)\)\. Take it out and create the project again\.$/;

    test('held, Deleted, cancelled, retired and foreign ids', async () => {
      const b = await body();
      const post = (over: Record<string, unknown> = {}) => c.pm.request('POST', `/projects/${project}/duplicate`, { ...b, ...over });
      const gone = async (over: Record<string, unknown> = {}) => {
        const before = await counts();
        const r = await post(over);
        assert.equal(r.status, 400, JSON.stringify(r.body));
        assert.match(r.body.message, GONE);
        assert.deepEqual(await counts(), before);
      };
      const during = async (apply: string, undo: string, params: unknown[]) => {
        await t.pool.query(apply, params);
        await gone();
        const o = JSON.stringify(await getOffer());
        assert.ok(!o.includes(params[0] as string), 'nor is it offered');
        await t.pool.query(undo, [params[0]]);
      };
      await during(`UPDATE risks SET deleted_at = now(), deleted_by = $2, delete_reason = 'x' WHERE id = $1`, `UPDATE risks SET deleted_at = NULL, deleted_by = NULL, delete_reason = NULL WHERE id = $1`, [risk, ids.pm]);
      await during(`UPDATE tasks SET status = 'cancelled' WHERE id = $1`, `UPDATE tasks SET status = 'completed' WHERE id = $1`, [deep]);
      await during(`UPDATE tasks SET deleted_at = now(), deleted_by = $2, delete_reason = 'x' WHERE id = $1`, `UPDATE tasks SET deleted_at = NULL, deleted_by = NULL, delete_reason = NULL WHERE id = $1`, [deep, ids.pm]);
      await during(`UPDATE resource_lines SET status = 'cancelled' WHERE id = $1`, `UPDATE resource_lines SET status = 'needed' WHERE id = $1`, [line]);
      await t.pool.query(`UPDATE resource_items SET status = 'retired' WHERE id = $1`, [item]);
      await gone();
      await t.pool.query(`UPDATE resource_items SET status = 'active' WHERE id = $1`, [item]);

      const other = await seedProject(t.pool, { name: 'Other', members: [{ userId: ids.pm, role: 'pm' }] });
      const theirs = await addTask('Theirs', { project: other });
      const theirRisk = await addRisk('Theirs', other);
      await gone({ tasks: [{ id: theirs, title: 'Theirs', subtasks: [] }] });
      await gone({ risks: [{ id: theirRisk, text: 'Theirs' }] });
      await gone({ risks: [{ id: 'nonsense', text: 'x' }] });
      await gone({ risks: [b.risks[0], b.risks[0]] });
      await gone({ resources: [{ id: uuidv7() }] });
      await gone({ stages: [{ id: uuidv7(), name: 'Stage', substages: [] }] });
      await gone({ holidays: [{ id: uuidv7(), date: '2027-01-04', name: 'Day' }] });
      await gone({ tasks: [{ id: sub, title: 'Pack', subtasks: [] }] });
    });

    for (const [kind, id] of [['task', () => task], ['risk', () => risk]] as const) {
      test(`a ${kind} reported as a suspected secret, although cleaned and still in the work views`, async () => {
        await t.pool.query(`UPDATE tasks SET title = 'Order Kp9vault-Rotor42' WHERE id = $1`, [task]);
        await t.pool.query(`UPDATE risks SET description = 'Lost Kp9vault-Rotor42' WHERE id = $1`, [risk]);
        const b = await body();
        const r = await c.pm.request('POST', `/projects/${project}/secret-reports`, { kind, id: id(), marked: ['Kp9vault-Rotor42'], reason: 'Looks like a code' });
        assert.equal(r.status, 201, JSON.stringify(r.body));
        const after = await c.pm.request('POST', `/projects/${project}/duplicate`, b);
        assert.deepEqual([after.status, after.body.message], [409, OPEN]);
        const o = await getOffer();
        assert.ok(!(kind === 'task' ? o.tasks : o.risks).some((x: any) => x.id === id()), 'held');
        assert.ok(!(kind === 'task' ? o.risks : o.tasks).some((x: any) => x.id === (kind === 'task' ? risk : task)), 'nor the possible copy masked at once');
      });
    }

    test('a subtask needs its parent', async () => {
      const b = await body();
      await refused({ tasks: [{ ...b.tasks[0], subtasks: [b.tasks[0].subtasks[1]] }] }, 'A subtask can be copied only with the task it belongs to.');
    });
  });

  test('credentials and lengths in what is typed or carried', async () => {
    const b = await body();
    const secret = /looks like it contains/;
    await refused({ name: `New ${PASSWORD}` }, secret);
    await refused({ purpose: PASSWORD }, secret);
    await refused({ stages: [{ name: PASSWORD, substages: [] }] }, secret);
    await refused({ stages: [{ name: 'One', substages: [PASSWORD] }] }, secret);
    await refused({ tasks: [{ ...b.tasks[0], title: PASSWORD }] }, secret);
    await refused({ tasks: [{ ...b.tasks[0], description: PASSWORD }] }, secret);
    await refused({ tasks: [{ ...b.tasks[0], subtasks: [{ ...b.tasks[0].subtasks[0], description: PASSWORD }] }] }, secret);
    await refused({ risks: [{ id: risk, text: PASSWORD }] }, secret);
    await refused({ resources: [{ id: oneOff, description: PASSWORD }] }, secret);
    await refused({ holidays: [{ ...b.holidays[0], name: PASSWORD }] }, secret);
    await refused({ name: 'x'.repeat(201) }, 'A project name can be at most 200 characters.');
    await refused({ tasks: [{ ...b.tasks[0], title: 'x'.repeat(2001) }] }, 'Give each task title 1 to 2,000 characters.');
    await refused({ tasks: [{ ...b.tasks[0], title: ' ' }] }, 'Give each task title 1 to 2,000 characters.');
    await refused({ tasks: [{ ...b.tasks[0], description: 'x'.repeat(4001) }] }, 'Write a description of up to 4,000 characters.');
    await refused({ tasks: [{ ...b.tasks[0], due: 'soon' }] }, 'Dates must be in the form YYYY-MM-DD.');
    await refused({ stages: [] }, 'Keep at least one stage.');
    await refused({ stages: [{ name: 'A', substages: [] }, { name: 'a', substages: [] }] }, 'This project already has a stage with that name.');
    await refused({ resources: [{ id: line, quantity: 0 }] }, 'Enter a quantity above 0 with at most 2 decimal places.');
    await t.pool.query(`UPDATE tasks SET title = $2 WHERE id = $1`, [task, PASSWORD]);
    await refused({ tasks: [{ id: task, subtasks: [] }] }, secret);
  });

  test('settings: kept, left at the default, or set where projects may set them', async () => {
    await refused({ settings: { requiredApprovals: 1 } }, /^Keep the original's number of approvals/);
    const p = await made({ holidays: [], settings: { requiredApprovals: null, notifications: { dayCounting: null, leadDays: null, digestEnabled: false, digestFrequency: null, digestWeekday: null, digestTime: null }, outputs: { inputFormats: null, outputFormats: null, exportRoles: ['pm', 'deputy', 'owner', 'sponsor'], destinationId: uuidv7() } } });
    for (const table of ['project_notification_settings', 'project_output_settings', 'approval_policy_changes']) {
      assert.equal((await t.pool.query(`SELECT 1 FROM ${table} WHERE project_id = $1`, [p.id])).rowCount, 0, table);
    }
    const q = await made({ name: 'Fourth', settings: { notifications: { escalationDays: 9 } }, holidays: [{ date: '2027-03-01', name: 'New day' }] });
    assert.equal((await t.pool.query(`SELECT escalation_days AS n FROM project_notification_settings WHERE project_id = $1`, [q.id])).rows[0].n, 9);
  });

  test('an exception is carried only where a project could set it now; the screen is told which are not', async () => {
    assert.deepEqual((await getOffer()).settings.notCarried, []);
    const b = await body();
    await t.pool.query(`UPDATE notification_settings SET projects_may_change_calendar = false, projects_may_change_timings = false, projects_may_change_digest = false`);
    await t.pool.query(`UPDATE storage_settings SET projects_may_change_formats = false, projects_may_set_export_roles = false`);
    await t.pool.query(`UPDATE approval_policy SET projects_may_override = false`);
    const o = await getOffer();
    assert.deepEqual(o.settings.notCarried.map((x: any) => x.setting).sort(), ['calendar', 'digest', 'exportRoles', 'formats', 'holidays', 'requiredApprovals', 'timings']);
    assert.ok(o.settings.notCarried.every((x: any) => x.notCarried === true && /organisation/.test(x.reason)));
    assert.deepEqual([o.holidays, o.settings.requiredApprovals, o.settings.notifications.dayCounting, o.settings.notifications.digestEnabled], [[], null, null, false]);
    assert.deepEqual(o.settings.outputs, { inputFormats: null, outputFormats: null, exportRoles: ['pm', 'deputy', 'owner', 'sponsor'] });
    // A page opened before the switches went off: what it sends is checked again.
    const post = (over: object) => c.pm.request('POST', `/projects/${project}/duplicate`, { ...b, ...over });
    assert.match((await post({})).body.message, /can no longer be copied \(1 holiday\)/);
    for (const [settings, message] of [
      [{ requiredApprovals: 2 }, /number of approvals/],
      [{ notifications: { dayCounting: 'calendar' } }, /has not allowed projects to change this setting/],
      [{ notifications: { leadDays: [5, 2] } }, /has not allowed projects to change this setting/],
      [{ notifications: { digestEnabled: true, digestFrequency: 'daily', digestTime: '09:00' } }, /has not allowed projects to change this setting/],
      [{ outputs: { inputFormats: ['txt'] } }, /change their own formats/],
      [{ outputs: { exportRoles: ['pm', 'owner'] } }, /set their own export roles/],
    ] as const) {
      const r = await post({ holidays: [], settings });
      assert.equal(r.status, 400, JSON.stringify(settings));
      assert.match(r.body.message, message);
    }
    assert.match((await post({ holidays: [{ date: '2027-01-04', name: 'Own' }] })).body.message, /has not allowed projects to change this setting/);
    const r = await post({ holidays: [] });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    for (const table of ['holidays', 'project_notification_settings', 'project_output_settings', 'approval_policy_changes']) {
      assert.equal((await t.pool.query(`SELECT 1 FROM ${table} WHERE project_id = $1`, [r.body.project.id])).rowCount, 0, table);
    }
    assert.equal((await t.pool.query(`SELECT required_approvals AS n FROM projects WHERE id = $1`, [r.body.project.id])).rows[0].n, null);
  });

  describe('a page opened before something was put under review', () => {
    const CODE = 'Kp9vault-Rotor42';
    const CHANGED = 'Something in the original was put under review or cleaned after you opened this page. Load the project again.';
    const PLACES: Record<string, () => Promise<unknown>> = {
      'a task title': () => t.pool.query(`UPDATE tasks SET title = title || ' ' || $2 WHERE id = $1`, [task, CODE]),
      'a risk': () => t.pool.query(`UPDATE risks SET description = description || ' ' || $2 WHERE id = $1`, [risk, CODE]),
      'a stage': () => t.pool.query(`UPDATE project_stages SET name = name || ' ' || $2 WHERE project_id = $1 AND position = 2`, [project, CODE]),
      'the purpose': () => t.pool.query(`UPDATE projects SET purpose = purpose || ' ' || $2 WHERE id = $1`, [project, CODE]),
      'a holiday': () => t.pool.query(`UPDATE holidays SET name = name || ' ' || $2 WHERE project_id = $1`, [project, CODE]),
      'a one-off line': () => t.pool.query(`UPDATE resource_lines SET description = description || ' ' || $2 WHERE id = $1`, [oneOff, CODE]),
    };
    for (const [place, put] of Object.entries(PLACES)) {
      test(`${place} cleaned meanwhile, its case already released`, async () => {
        await put();
        const reported: [string, string] = place === 'a risk' ? ['risk', risk] : ['task', task];
        // The other places are found when a task holding the same code is reported.
        if (place !== 'a risk' && place !== 'a task title') await t.pool.query(`UPDATE tasks SET title = 'Holds ' || $2 WHERE id = $1`, [task, CODE]);
        const b = await body({ purpose: (await getOffer()).original.purpose, purposeConfirmed: true });
        if (place !== 'a risk' && place !== 'a task title') b.tasks[0].title = 'Holds nothing';
        assert.ok(JSON.stringify(b).includes(CODE), 'the page holds it');
        const reply = await c.pm.request('POST', `/projects/${project}/secret-reports`, { kind: reported[0], id: reported[1], marked: [CODE], reason: 'Looks like a code' });
        assert.equal(reply.status, 201, JSON.stringify(reply.body));
        const open = await c.pm.request('POST', `/projects/${project}/duplicate`, b);
        assert.deepEqual([open.status, open.body.message], [409, OPEN]);
        assert.equal((await getOffer()).blocked, OPEN, 'the page says so before anything is reviewed');
        assert.equal((await c.pm.request('POST', `/quarantine/cases/${reply.body.caseId}/release`, { reason: 'Reviewed' })).status, 200);
        assert.equal((await getOffer()).blocked, null);
        const before = await counts();
        const stale = await c.pm.request('POST', `/projects/${project}/duplicate`, b);
        assert.deepEqual([stale.status, stale.body.message], [409, CHANGED]);
        assert.deepEqual(await counts(), before);
        const fresh = await body({ purpose: (await getOffer()).original.purpose, purposeConfirmed: true });
        assert.ok(!JSON.stringify(fresh).includes(CODE));
        assert.equal((await c.pm.request('POST', `/projects/${project}/duplicate`, fresh)).status, 201, 'the page loaded again works');
      });
    }

    test('asOf is required, not in the future and at most a day old', async () => {
      const b = await body();
      assert.match(b.asOf, /^[^~]+~[0-9a-f]{32}$/, 'the mark shows no counts');
      const [time, mark] = [b.asOf.slice(0, b.asOf.indexOf('~')), b.asOf.slice(b.asOf.indexOf('~'))];
      const shift = (ms: number) => new Date(Date.parse(time) + ms).toISOString() + mark;
      for (const asOf of [undefined, null, '', 5, 'nonsense', time, shift(3_600_000), shift(-25 * 3_600_000)]) {
        const r = await c.pm.request('POST', `/projects/${project}/duplicate`, { ...b, asOf });
        assert.deepEqual([r.status, r.body.message], [400, 'Load the project again.'], String(asOf));
      }
      assert.equal((await c.pm.request('POST', `/projects/${project}/duplicate`, { ...b, asOf: shift(-23 * 3_600_000) })).status, 201);
    });

    test('a report committed while Create waits for it, or under way when the page was loaded', async () => {
      const b = await body();
      const db = await t.pool.connect();
      try {
        await db.query('BEGIN');
        await db.query(`SELECT pg_advisory_xact_lock(hashtextextended('kainow.quarantine:' || $1::text, 0))`, [project]);
        // A closed case whose times are long before the page was loaded: no clock is compared.
        await db.query(
          `INSERT INTO quarantine_cases (id, project_id, item_kind, item_id, reporter_id, reason, marked_length, state, reported_at, cleaned_at, closed_at, closed_by, close_reason)
           VALUES ($1, $2, 'task', $3, $4, 'x', 5, 'released', '2026-01-01', '2026-01-01', '2026-01-01', $4, 'x')`,
          [uuidv7(), project, task, ids.pm],
        );
        const loadedDuring = await body();
        let answered = false;
        const waiting = c.pm.request('POST', `/projects/${project}/duplicate`, b).then((r) => {
          answered = true;
          return r;
        });
        await new Promise((r) => setTimeout(r, 700));
        assert.equal(answered, false, 'Create waits for the report');
        await db.query('COMMIT');
        const first = await waiting;
        assert.deepEqual([first.status, first.body.message], [409, CHANGED]);
        const second = await c.pm.request('POST', `/projects/${project}/duplicate`, loadedDuring);
        assert.deepEqual([second.status, second.body.message], [409, CHANGED], 'the page was loaded before the report was committed');
      } finally {
        await db.query('ROLLBACK').catch(() => undefined);
        db.release();
      }
    });
  });

  test('a second identical Create is refused', async () => {
    const b = await body();
    const [x, y] = await Promise.all([1, 2].map(() => c.pm.request('POST', `/projects/${project}/duplicate`, b)));
    assert.deepEqual([x.status, y.status].sort(), [201, 409]);
    const late = [x, y].find((r) => r.status === 409)!;
    assert.equal(late.body.message, 'You created this project a moment ago. To make another copy with the same name, wait a minute and press Create project again, or give it a different name.');
    assert.equal(late.body.projectId, [x, y].find((r) => r.status === 201)!.body.project.id);
    await made({ name: 'Another name' });
    // A minute later it is meant: names need not be unique.
    t.clock.advanceSeconds(58);
    assert.equal((await c.pm.request('POST', `/projects/${project}/duplicate`, b)).status, 409);
    t.clock.advanceSeconds(2);
    assert.equal((await c.pm.request('POST', `/projects/${project}/duplicate`, b)).status, 201);
  });

  test('the reference to a retired stage template is not kept', async () => {
    await t.pool.query(`UPDATE stage_templates SET status = 'retired', retired_by = $2, retired_at = now() WHERE id = (SELECT stage_template_id FROM projects WHERE id = $1)`, [project, ids.admin]).catch(() =>
      t.pool.query(`UPDATE stage_templates SET status = 'retired' WHERE id = (SELECT stage_template_id FROM projects WHERE id = $1)`, [project]),
    );
    assert.equal((await made()).stageTemplate, null);
  });

  test('an old term in anything typed new is refused until changed, whatever is confirmed', async () => {
    const o = await getOffer();
    const day = { date: '2027-05-01', name: 'Left 2026 day' };
    const cases: Array<[object, string]> = [
      [{ stages: [...o.stages, { name: 'Left 2026 here', substages: [] }] }, 'The new stage "Left 2026 here" holds an old term. Change it.'],
      [{ stages: [...o.stages, { name: 'Brand new', substages: ['Left 2026 here'] }] }, 'The substage "Left 2026 here" of "Brand new" holds an old term. Change it.'],
      [{ stages: [{ ...o.stages[0], substages: ['Left 2026 here'] }] }, `The substage "Left 2026 here" of "${o.stages[0].name}" holds an old term. Change it.`],
      [{ stages: [{ ...o.stages[0], substages: [...o.stages[0].substages, { name: 'Left 2026 here' }] }] }, `The substage "Left 2026 here" of "${o.stages[0].name}" holds an old term. Change it.`],
      [{ stages: [{ ...o.stages[0], substages: [{ key: 'stage:made-up', name: 'Left 2026 here' }] }] }, `The substage "Left 2026 here" of "${o.stages[0].name}" holds an old term. Change it.`],
      [{ holidays: [day] }, 'The new holiday "Left 2026 day" holds an old term. Change it.'],
    ];
    for (const [over, message] of cases) {
      const r = await refused({ oldTerms: ['left 2026'], ...over }, message);
      assert.equal(r.terms.length, 1);
      await refused({ oldTerms: ['left 2026'], ...over, confirmedKeys: [r.terms[0].key, 'stage:made-up'] }, message);
    }
    // An unchanged substage sent as plain text is still the carried one, so it can be confirmed.
    const first = o.stages[0].substages[0];
    const plainText = { oldTerms: [first.name], stages: [{ ...o.stages[0], substages: [first.name] }] };
    assert.equal((await refused(plainText, /^1 text still holds/)).terms[0].key, first.key);
    await made({ ...plainText, confirmedKeys: [first.key] });
  });

  test('stages may be renamed, added, removed and put in another order', async () => {
    const o = await getOffer();
    const p = await made({ stages: [{ name: 'Brand new', substages: ['First'] }, { ...o.stages[1], name: 'Renamed' }] });
    assert.deepEqual(p.stages.map((s: any) => s.name), ['Brand new', 'Renamed']);
    assert.equal(p.stage.stage, 'Brand new');
  });

  test('only a current Project Manager who may create projects', async () => {
    const b = await body();
    const both = async (who: Client, status: number, message?: string) => {
      for (const r of [await who.request('GET', `/projects/${project}/duplicate`), await who.request('POST', `/projects/${project}/duplicate`, b)]) {
        assert.equal(r.status, status, JSON.stringify(r.body));
        if (message) assert.equal(r.body.message, message);
      }
    };
    const before = await counts();
    for (const who of [c.mem, c.dep, c.own]) await both(who, 403, 'Only the Project Manager can duplicate a project.');
    for (const who of [c.late, c.admin, c.new]) await both(who, 404);
    const hold = (at: string | null) => t.pool.query(`UPDATE memberships SET held_at = $2, held_by = $3, hold_reason = 'x' WHERE project_id = $1 AND user_id = $4`, [project, at, ids.own, ids.pm]);
    await hold('2026-11-01');
    await both(c.pm, 404);
    await t.pool.query(`UPDATE memberships SET restored_at = '2026-11-02', restored_by = $2, restore_reason = 'x' WHERE project_id = $1 AND user_id = $3`, [project, ids.own, ids.pm]);
    await t.pool.query(`UPDATE eligible_domains SET removed_at = now(), removed_by = $1 WHERE domain = 'example.org'`, [ids.admin]);
    await both(c.pm, 403, 'Your email domain is no longer eligible; ask an Administrator.');
    const after = await counts();
    assert.deepEqual([after.projects, after.human_proposals, after.audit_events], [before.projects, before.human_proposals, before.audit_events]);
    await t.pool.query(`UPDATE eligible_domains SET removed_at = NULL, removed_by = NULL WHERE domain = 'example.org'`);
    await t.pool.query(`UPDATE memberships SET revoked_at = now(), revoked_by = $2, revoke_reason = 'x' WHERE project_id = $1 AND user_id = $3`, [project, ids.own, ids.pm]);
    await both(c.pm, 404);
  });

  test('an original in any state', async () => {
    let n = 0;
    for (const status of ['draft', 'planned', 'active', 'deferred']) {
      await t.pool.query(`UPDATE projects SET status = $2, closure_outcome = NULL WHERE id = $1`, [project, status]);
      n += 1;
      await made({ name: `Copy ${n}` });
    }
    await t.pool.query(`UPDATE projects SET status = 'closed', closure_outcome = 'abandoned' WHERE id = $1`, [project]);
    assert.equal((await c.pm.request('GET', `/projects/${project}`)).body.project.archived, true, 'archived');
    await made({ name: 'Copy of the archived one' });
  });

  test('limits refuse with the counts', async () => {
    const many = (n: number) => Array.from({ length: n }, () => ({ id: uuidv7(), title: 'x', subtasks: [] }));
    await refused({ tasks: [{ id: task, title: 'x', subtasks: many(500) }] }, 'You chose 501 tasks and subtasks; at most 500 can be copied at once.');
    await refused({ risks: many(201), resources: many(201) }, 'You chose 201 risks; at most 200 can be copied at once. You chose 201 resource lines; at most 200 can be copied at once.');
  });

  test('a failure midway creates nothing', async () => {
    const b = await body();
    await t.pool.query(`CREATE FUNCTION test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'midway'; END $$`);
    await t.pool.query(`CREATE TRIGGER test_fail BEFORE INSERT ON resource_lines FOR EACH ROW EXECUTE FUNCTION test_fail()`);
    const before = await counts();
    assert.equal((await c.pm.request('POST', `/projects/${project}/duplicate`, b)).status, 500);
    assert.deepEqual(await counts(), before);
  });

  test("the original's name only for those who may open it", async () => {
    const p = await made();
    await t.pool.query(`INSERT INTO memberships (id, project_id, user_id, role, starts_on) VALUES ($1, $2, $3, 'member', '2026-11-01'), ($4, $2, $5, 'owner', '2026-11-01'), ($6, $2, $7, 'sponsor', '2026-11-01')`, [
      uuidv7(), p.id, ids.new, uuidv7(), ids.own2, uuidv7(), ids.late,
    ]);
    const seen: string[] = [];
    for (const path of [`/projects/${p.id}`, `/projects/${p.id}/proposals`, `/projects/${p.id}/records`, `/projects/${p.id}/resources`, `/projects/${p.id}/notification-settings`, `/projects/${p.id}/approval-policy`, '/projects', `/search?q=${encodeURIComponent(ORIGINAL)}`, `/search?q=samples`]) {
      const r = await c.new.request('GET', path);
      seen.push(JSON.stringify(r.body));
    }
    seen.push(JSON.stringify((await t.pool.query(`SELECT * FROM notifications`)).rows), JSON.stringify(await t.outbox()));
    // Whatever was stored for the new project or said in the audit trail never holds the name.
    for (const name of await tables()) {
      const { rows } = await t.pool.query(`SELECT x::text AS row FROM "${name}" x WHERE x::text LIKE '%' || $1 || '%'`, [ORIGINAL]);
      assert.deepEqual(rows.length, name === 'projects' ? 1 : 0, `${name} holds the original's name`);
    }
    for (const s of seen) {
      assert.ok(!s.replace(JSON.stringify(`q=${ORIGINAL}`), '').includes(ORIGINAL), s);
      assert.ok(!s.includes(project), 'nor its id');
    }
    const detail = (await c.new.request('GET', `/projects/${p.id}`)).body.project;
    assert.deepEqual(detail.copiedFrom, { hidden: true });
    assert.ok((await c.new.request('GET', `/projects/${p.id}/proposals`)).body.proposals.every((x: any) => x.copiedFrom.hidden === true && x.copiedFrom.name === undefined));
    assert.deepEqual((await c.late.request('GET', `/projects/${p.id}`)).body.project.copiedFrom, { hidden: true }, 'a role in the original that has ended does not count');
    assert.deepEqual((await c.pm.request('GET', `/projects/${p.id}`)).body.project.copiedFrom, { id: project, name: ORIGINAL });
    assert.equal((await c.pm.request('GET', `/projects/${project}`)).body.project.copiedFrom, null);
  });

  describe('authorising several', () => {
    let copy: string;
    let proposals: any[];
    let owner2: Client;

    beforeEach(async () => {
      const b = await body();
      copy = (await c.pm.request('POST', `/projects/${project}/duplicate`, { ...b, settings: { requiredApprovals: null } })).body.project.id;
      await t.pool.query(`UPDATE projects SET status = 'active' WHERE id = $1`, [copy]);
      for (const [u, role] of [['own', 'owner'], ['own2', 'sponsor'], ['mem', 'member']]) {
        await t.pool.query(`INSERT INTO memberships (id, project_id, user_id, role, starts_on) VALUES ($1, $2, $3, $4, '2026-11-01')`, [uuidv7(), copy, ids[u], role]);
      }
      owner2 = await t.signIn('own2@example.org');
      for (const text of ['Second', 'Third']) assert.equal((await c.pm.request('POST', `/projects/${copy}/proposals`, { kind: 'action', text })).status, 201);
      proposals = (await c.own.request('GET', `/projects/${copy}/proposals`)).body.proposals;
    });

    const many = (who: Client, items: unknown) => who.request('POST', `/projects/${copy}/proposals/authorise-many`, { items });
    const ready = (p: any) => ({ proposalId: p.id, assigneeId: ids.mem, dueOn: '2027-02-01' });

    test('each on its own: one bad item is named and undoes none of the others', async () => {
      const copied = proposals.find((p) => p.text === 'Order samples for 2026');
      const second = proposals.find((p) => p.text === 'Second');
      const third = proposals.find((p) => p.text === 'Third');
      const riskCopy = proposals.find((p) => p.kind === 'risk');
      const r = await many(c.own, [
        { ...ready(copied), subtasks: copied.proposedSubtasks.map((s: any) => ({ title: s.title, description: s.description, assigneeId: ids.mem, dueOn: '2027-01-15' })) },
        { proposalId: second.id, assigneeId: ids.mem },
        ready(third),
        { proposalId: riskCopy.id, severity: 'low' },
        { proposalId: uuidv7(), assigneeId: ids.mem, dueOn: '2027-02-01' },
        'nonsense',
      ]);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(r.body.results.map((x: any) => [x.ok, x.error ?? null]), [
        [true, null],
        [false, 'A task needs one assignee and a due date before it can be authorised.'],
        [true, null],
        [true, null],
        [false, 'That proposal was not found.'],
        [false, 'That proposal was not found.'],
      ]);
      const tasks = (await t.pool.query(`SELECT title, description, depth FROM tasks WHERE project_id = $1 ORDER BY depth, title`, [copy])).rows;
      assert.deepEqual(tasks, [
        { title: 'Order samples for 2026', description: 'From Dummy Customer', depth: 0 },
        { title: 'Third', description: null, depth: 0 },
        { title: 'Label the boxes', description: null, depth: 1 },
        { title: 'Pack the samples', description: 'Two boxes', depth: 1 },
      ]);
      const again = await many(c.own, [ready(third)]);
      assert.deepEqual([again.body.results[0].ok, again.body.results[0].record.kind], [true, 'task'], 'authorised before: its record');
    });

    test('nothing is authorised by copying: subtasks left out are not made', async () => {
      const copied = proposals.find((p) => p.text === 'Order samples for 2026');
      await many(c.own, [ready(copied)]);
      assert.equal((await t.pool.query(`SELECT 1 FROM tasks WHERE project_id = $1`, [copy])).rowCount, 1);
    });

    test('with two required approvals each waits for the second approver', async () => {
      await t.pool.query(`UPDATE projects SET required_approvals = 2 WHERE id = $1`, [copy]);
      const second = proposals.find((p) => p.text === 'Second');
      const third = proposals.find((p) => p.text === 'Third');
      const r = await many(c.own, [ready(second), ready(third)]);
      assert.deepEqual(r.body.results.map((x: any) => [x.ok, x.waiting, x.request.status]), [[true, true, 'pending'], [true, true, 'pending']]);
      const twice = await many(owner2, [ready(second)]);
      assert.deepEqual([twice.body.results[0].ok, twice.body.results[0].error], [false, 'This proposal already has a change waiting for authorisation.'], 'the words of the single route');
      const approve = await owner2.request('POST', `/changes/${r.body.results[0].request.id}/approve`, { version: 1 });
      assert.equal(approve.status, 200, JSON.stringify(approve.body));
      assert.equal((await t.pool.query(`SELECT 1 FROM tasks WHERE project_id = $1`, [copy])).rowCount, 1);
    });

    test('a Member, an outsider, an empty list, too many and another project', async () => {
      assert.equal((await many(c.mem, [ready(proposals[0])])).status, 403);
      assert.equal((await many(c.pm, [ready(proposals[0])])).status, 403);
      assert.equal((await many(c.new, [ready(proposals[0])])).status, 404);
      assert.equal((await many(c.own, [])).body.message, 'Choose the proposals to authorise.');
      assert.equal((await many(c.own, 'x')).status, 400);
      const over = await many(c.own, Array.from({ length: 101 }, () => ready(proposals[0])));
      assert.deepEqual([over.status, over.body.message], [400, 'At most 100 proposals can be authorised at once; you chose 101.']);
      const other = await seedProject(t.pool, { status: 'active', members: [{ userId: ids.own, role: 'owner' }] });
      const foreign = await c.own.request('POST', `/projects/${other}/proposals/authorise-many`, { items: [ready(proposals[0])] });
      assert.deepEqual(foreign.body.results.map((x: any) => x.error), ['That proposal was not found.']);
      await t.pool.query(`UPDATE projects SET status = 'draft' WHERE id = $1`, [copy]);
      assert.equal((await many(c.own, [ready(proposals[0])])).status, 403, 'not in a Draft');
    });
  });

  test('a credential inside proposed subtasks can be reported, and is removed there', async () => {
    const b = await body();
    b.tasks[0].subtasks[0].description = 'Gate code Kp9vault-Rotor42 today';
    const p = (await c.pm.request('POST', `/projects/${project}/duplicate`, b)).body.project;
    const proposal = (await c.pm.request('GET', `/projects/${p.id}/proposals`)).body.proposals[0];
    const r = await c.pm.request('POST', `/projects/${p.id}/secret-reports`, { kind: 'human_proposal', id: proposal.id, marked: ['Kp9vault-Rotor42'], reason: 'Looks like a code' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const stored = (await t.pool.query(`SELECT proposed_subtasks FROM human_proposals WHERE id = $1`, [proposal.id])).rows[0].proposed_subtasks;
    assert.deepEqual(stored[0], { title: 'Pack the samples', description: 'Gate code [credential removed] today', due: null });
  });
});
