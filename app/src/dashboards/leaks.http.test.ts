import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { uuidv7 } from '../common/uuid7';
import { leadershipProjectIds } from '../leadership/grants';
import { todayUtc8 } from '../projects/membership';
import { UNDER_REVIEW_TEXT } from '../quarantine/labels';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedDepartment, seedProject, seedUser } from '../testing/projects';

/**
 * Leak tests for every dashboard surface (dashboards spec section 14): personal, project, timeline, leadership, each
 * analytics panel, drill-down and CSV. Every item carries a marker word no other text holds, so its absence means
 * something, and each case first shows that the surface displays (or counts) the item before it is Deleted or held.
 *
 * The test clock starts at 2026-11-09T02:00Z: today is Monday 2026-11-09 (UTC+8).
 */

const LIMITED = 'Only counts are shown: you are not a participant in this project.';

type Kind = 'task' | 'question' | 'risk';
const KINDS: readonly Kind[] = ['task', 'question', 'risk'];
const TABLE: Record<Kind, string> = { task: 'tasks', question: 'questions', risk: 'risks' };

/** Marker words of the records under test, one per kind. */
const MARK: Record<Kind, string> = { task: 'capstanflux', question: 'gunwalemist', risk: 'sternpostgale' };

/** Content that no dashboard may ever carry. */
const CONTENT = {
  source: 'hawsertrunnel',
  message: 'mizzenquell',
  quote: 'forepeakquip',
  proposal: 'bilgewhorl',
  aiQuestion: 'scuppernook',
  credentialHeld: 'sekritpass77',
  credentialCleaned: 'tokenvault88',
} as const;

/** What a surface says: all of its text, and the counts it gives. */
interface View {
  text: string;
  counts: Record<string, number>;
}

interface Surface {
  name: string;
  /** The question status this surface lists (personal lists Answered questions the viewer asked; the project lists Open ones). */
  questionStatus: 'open' | 'answered';
  /** The kinds whose text the surface shows. */
  textOf: readonly Kind[];
  /** The counts each kind of record adds 1 to. */
  contributes: Record<Kind, readonly string[]>;
  read(): Promise<View>;
}

const json = (x: unknown): string => JSON.stringify(x);
const sum = (xs: number[]): number => xs.reduce((n, x) => n + x, 0);

/** A small RFC 4180 reader: the data rows (after the `#` lines and the header) as objects keyed by column. */
function csvRows(text: string): Array<Record<string, string>> {
  const lines = text.split('\r\n').filter((l) => l !== '' && !l.startsWith('#'));
  const parse = (line: string): string[] => {
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
  };
  const [head, ...rest] = lines.map(parse);
  return rest.map((cells) => Object.fromEntries(head.map((h, i) => [h, cells[i] ?? ''])));
}
const num = (cell: string | undefined): number => (cell === undefined || cell === '' ? 0 : Number(cell));

describe('dashboard leak suites', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let admin: Client;
  let pm: Client;
  let mem: Client;
  let leader: Client;
  let adminId: string;
  let pmId: string;
  let memId: string;
  let leaderId: string;
  let deptA: string;
  let deptB: string;
  /** Harbour works (Alpha Unit): the Administrator is a Member here; inside the leadership grant. */
  let p: string;
  /** Quay works (Beta Unit): the Administrator is not a participant; outside the leadership grant. */
  let q: string;
  let grantId: string;

  const ok = async (r: Promise<{ status: number; body: any }>, status = 200) => {
    const x = await r;
    assert.equal(x.status, status, json(x.body));
    return x.body;
  };

  beforeEach(async () => {
    t = await startTestApp();
    adminId = await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    pmId = await seedUser(t.pool, 'pm@example.org');
    memId = await seedUser(t.pool, 'mem@example.org');
    leaderId = await seedUser(t.pool, 'leader@example.org');
    deptA = await seedDepartment(t.pool, 'Alpha Unit');
    deptB = await seedDepartment(t.pool, 'Beta Unit');
    p = await seedProject(t.pool, {
      status: 'active',
      name: 'Harbour works',
      departmentId: deptA,
      members: [{ userId: pmId, role: 'pm' }, { userId: pmId, role: 'owner' }, { userId: memId, role: 'member' }, { userId: adminId, role: 'member' }],
    });
    q = await seedProject(t.pool, {
      status: 'active',
      name: 'Quay works',
      departmentId: deptB,
      members: [{ userId: pmId, role: 'pm' }, { userId: pmId, role: 'owner' }, { userId: memId, role: 'member' }],
    });
    admin = await t.signIn('admin@example.org');
    pm = await t.signIn('pm@example.org');
    mem = await t.signIn('mem@example.org');
    leader = await t.signIn('leader@example.org');
    const g = await ok(
      admin.request('POST', '/admin/leadership-grants', { userId: leaderId, scope: { kind: 'departments', departmentIds: [deptA] }, startsOn: '2026-11-09', reason: 'Oversight' }),
      201,
    );
    grantId = g.grant.id;
  });
  afterEach(async () => {
    await t?.close();
  });

  // ---- records ----

  async function proposal(project: string, kind: string, text = 'Proposed'): Promise<string> {
    const id = uuidv7();
    await t.pool.query(
      `INSERT INTO human_proposals (id, project_id, kind, text, proposed_by, proposed_at, review_status, reviewed_by, reviewed_at)
       VALUES ($1, $2, $3, $4, $5, '2026-11-02T02:00:00Z', 'approved', $5, '2026-11-02T02:00:00Z')`,
      [id, project, kind, text, pmId],
    );
    return id;
  }
  /** An overdue, open leaf task for the Member (due Thursday 5 Nov), authorised in the current week. */
  async function addTask(project: string, title: string, opts: { status?: string; dueOn?: string; review?: boolean } = {}): Promise<string> {
    const id = uuidv7();
    await t.pool.query(
      `INSERT INTO tasks (id, project_id, parent_id, depth, title, assignee_id, due_on, status, deadline_review_required, authorised_by, authorised_at)
       VALUES ($1, $2, NULL, 0, $3, $4, $5, $6, $7, $8, '2026-11-09T01:00:00Z')`,
      [id, project, title, memId, opts.dueOn ?? '2026-11-05', opts.status ?? 'not_started', opts.review ?? false, pmId],
    );
    return id;
  }
  /** A question the Member asked. */
  async function addQuestion(project: string, text: string, status: 'open' | 'answered', proposalText = 'Proposed'): Promise<string> {
    const id = uuidv7();
    await t.pool.query(
      `INSERT INTO questions (id, project_id, text, requester_id, status, origin_proposal_id, authorised_by, authorised_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, '2026-11-09T01:00:00Z')`,
      [id, project, text, memId, status, await proposal(project, 'question', proposalText), pmId],
    );
    return id;
  }
  /** An open High risk, review due Friday 20 Nov (or overdue on 2 Nov). */
  async function addRisk(project: string, description: string, reviewOn = '2026-11-20'): Promise<string> {
    const id = uuidv7();
    await t.pool.query(
      `INSERT INTO risks (id, project_id, description, severity, responsible_id, review_on, origin_proposal_id, authorised_by, authorised_at)
       VALUES ($1, $2, $3, 'high', $4, $5, $6, $7, '2026-11-09T01:00:00Z')`,
      [id, project, description, memId, reviewOn, await proposal(project, 'risk'), pmId],
    );
    return id;
  }
  async function seedRecords(project: string, questionStatus: 'open' | 'answered'): Promise<Record<Kind, string>> {
    return {
      task: await addTask(project, `Service the ${MARK.task} pump`),
      question: await addQuestion(project, `Who checks the ${MARK.question} valve?`, questionStatus),
      risk: await addRisk(project, `The ${MARK.risk} crane may fail`),
    };
  }
  async function remove(kind: Kind, id: string): Promise<void> {
    await t.pool.query(`UPDATE ${TABLE[kind]} SET deleted_at = now(), deleted_by = $2, delete_reason = 'Entered in error' WHERE id = $1`, [id, pmId]);
  }
  /** Holds the record in a credential case, cleaned or still waiting. */
  async function hold(kind: Kind, id: string, project: string, state: 'held' | 'cleaned'): Promise<void> {
    const caseId = uuidv7();
    await t.pool.query(
      `INSERT INTO quarantine_cases (id, project_id, item_kind, item_id, reason, marked_length, state, waiting_for_key, reported_at, cleaned_at)
       VALUES ($1, $2, $3, $4, 'Reported', 8, $5, $6, now(), CASE WHEN $5 = 'cleaned' THEN now() END)`,
      [caseId, project, kind, id, state, state === 'held'],
    );
    await t.pool.query(`UPDATE ${TABLE[kind]} SET held_case_id = $2 WHERE id = $1`, [id, caseId]);
  }

  /**
   * Source text, a message, an extraction quote, a proposal's text, a private AI question and credential text, all in
   * Harbour works. Each is first shown to exist where it may be read.
   */
  async function seedContent(): Promise<void> {
    const note = await ok(pm.request('POST', `/projects/${p}/notes`, { title: 'Weekly notes', text: `The ${CONTENT.source} winch is serviced on Thursday.` }), 201);
    const sourceId = note.source.id as string;
    assert.ok(json(await ok(pm.request('GET', `/notes/${sourceId}/versions/1`))).includes(CONTENT.source), 'the note holds the source text');

    const thread = await ok(mem.request('POST', `/projects/${p}/threads`, { kind: 'discussion', title: 'Quay chat' }), 201);
    await ok(mem.request('POST', `/threads/${thread.id}/messages`, { body: `The ${CONTENT.message} gate is stuck again.` }), 201);
    assert.ok(json(await ok(mem.request('GET', `/threads/${thread.id}`))).includes(CONTENT.message), 'the thread holds the message');

    const version = (await t.pool.query(`SELECT id FROM source_versions WHERE source_id = $1`, [sourceId])).rows[0].id as string;
    const run = uuidv7();
    await t.pool.query(
      `INSERT INTO extraction_runs (id, source_version_id, requested_by, status, created_at) VALUES ($1, $2, $3, 'succeeded', now())`,
      [run, version, pmId],
    );
    await t.pool.query(
      `INSERT INTO extraction_items (id, run_id, source_version_id, position, kind, text, quote, quote_matches, created_at)
       VALUES ($1, $2, $3, 0, 'action', 'Service the winch', $4, 0, now())`,
      [uuidv7(), run, version, `the ${CONTENT.quote} winch`],
    );
    assert.equal((await t.pool.query(`SELECT 1 FROM extraction_items WHERE strpos(quote, $1) > 0`, [CONTENT.quote])).rowCount, 1);

    // A question record whose origin proposal carries text of its own.
    await addQuestion(p, 'Who signs off the dredging?', 'open', `Raised in the ${CONTENT.proposal} meeting`);

    const request = uuidv7();
    await t.pool.query(
      `INSERT INTO ai_requests (id, project_id, kind, requested_by, status, scope, created_at, finished_at)
       VALUES ($1, $2, 'question', $3, 'succeeded', 'personal', now(), now())`,
      [request, p, memId],
    );
    await t.pool.query(
      `INSERT INTO ai_answers (request_id, project_id, question, answer_markdown, visibility) VALUES ($1, $2, $3, 'Not found.', 'private')`,
      [request, p, `When is the ${CONTENT.aiQuestion} survey due?`],
    );
    assert.ok(json(await ok(mem.request('GET', `/questions/${request}`))).includes(CONTENT.aiQuestion), 'the asker sees the private question');

    // Credential text in records: one held and waiting, one cleaned (shown by its label only).
    const heldTask = await addTask(p, `Login password ${CONTENT.credentialHeld}`);
    await hold('task', heldTask, p, 'held');
    const cleanedRisk = await addRisk(p, `Token ${CONTENT.credentialCleaned} is in the notes`);
    await hold('risk', cleanedRisk, p, 'cleaned');
  }
  const assertNoContent = (text: string, where: string) => {
    for (const [what, marker] of Object.entries(CONTENT)) assert.ok(!text.includes(marker), `${where} carries ${what} text (${marker})`);
  };

  // ---- the surfaces ----

  const completionTotal = (c: any): number => (c?.state === 'measurable' ? c.total : 0);

  const personal: Surface = {
    name: 'personal dashboard',
    questionStatus: 'answered',
    textOf: ['task', 'question'],
    contributes: { task: ['overdue', 'eligible', 'myOverdue', 'needsOverdue'], question: ['openQuestions', 'needsYou'], risk: ['significantRisks'] },
    async read() {
      const body = await ok(mem.request('GET', '/dashboard/me'));
      const row = body.projects.find((x: any) => x.id === p);
      return {
        text: json(body),
        counts: {
          overdue: row.header.flags.overdue,
          eligible: completionTotal(row.header.completion),
          myOverdue: body.myTasks.overdue.length,
          openQuestions: row.expanded.openQuestions,
          needsYou: body.needsYou.filter((n: any) => n.kind === 'question').length,
          needsOverdue: body.needsYou.filter((n: any) => n.kind === 'overdue').length,
          significantRisks: row.expanded.significantRisks,
        },
      };
    },
  };

  const project: Surface = {
    name: 'project dashboard',
    questionStatus: 'open',
    textOf: ['question', 'risk'],
    contributes: { task: ['overdue', 'eligible'], question: ['questions', 'questionList'], risk: ['significant', 'riskList'] },
    async read() {
      const body = await ok(mem.request('GET', `/projects/${p}/dashboard`));
      const m = body.measures;
      return {
        text: json(body),
        counts: {
          overdue: m.overdue,
          eligible: completionTotal(m.completion),
          questions: m.questions.open + m.questions.answered,
          questionList: body.questions.oldestOpen.length,
          significant: m.risks.significant,
          riskList: body.risks.significant.length,
        },
      };
    },
  };

  const timeline: Surface = {
    name: 'project timeline',
    questionStatus: 'open',
    textOf: ['task', 'risk'],
    contributes: { task: ['tasksDue'], question: [], risk: ['riskReviews'] },
    async read() {
      const body = await ok(mem.request('GET', `/projects/${p}/timeline`));
      const lines = body.months.flatMap((m: any) => m.lines);
      return {
        text: json(body),
        counts: {
          tasksDue: sum(lines.filter((l: any) => l.kind === 'tasks_due').map((l: any) => l.detail.tasks.length)),
          riskReviews: sum(lines.filter((l: any) => l.kind === 'risk_review').map((l: any) => l.detail.risks.length)),
        },
      };
    },
  };

  const leadership: Surface = {
    name: 'leadership summary',
    questionStatus: 'open',
    textOf: ['risk'],
    contributes: { task: ['overdue', 'eligible'], question: [], risk: ['significant', 'riskList'] },
    async read() {
      const body = await ok(leader.request('GET', '/dashboard/leadership'));
      const card = body.cards.find((c: any) => c.id === p);
      return {
        text: json(body),
        counts: {
          overdue: card.overdue,
          eligible: completionTotal(card.taskCompletion),
          significant: card.significantRisks.count,
          riskList: card.significantRisks.items.length,
        },
      };
    },
  };

  const progressPanel: Surface = {
    name: 'analytics progress panel',
    questionStatus: 'open',
    textOf: [],
    contributes: { task: ['overdue', 'eligible', 'deptOverdue', 'deptTotal'], question: [], risk: [] },
    async read() {
      const body = await ok(admin.request('GET', '/admin/analytics?panel=progress'));
      const row = body.data.projects.find((r: any) => r.id === p);
      const dept = body.data.departments.find((d: any) => d.id === deptA);
      return {
        text: json(body),
        counts: { overdue: row.overdue, eligible: completionTotal(row.completion), deptOverdue: dept.overdue, deptTotal: dept.tasksTotal },
      };
    },
  };

  const problemsPanel: Surface = {
    name: 'analytics problems panel',
    questionStatus: 'open',
    textOf: [],
    // The risk under test is reviewed on 20 Nov, so it adds nothing to overdue reviews whatever happens to it.
    contributes: { task: ['orgOverdue', 'overdue'], question: [], risk: ['orgRisks', 'risks'] },
    async read() {
      const body = await ok(admin.request('GET', '/admin/analytics?panel=problems'));
      const row = body.data.projects.find((r: any) => r.id === p);
      return {
        text: json(body),
        counts: {
          orgOverdue: body.data.organisation.overdueTasks,
          overdue: row.overdueTasks,
          orgRisks: body.data.organisation.openHighCriticalRisks,
          risks: row.openHighCriticalRisks,
          overdueReviews: row.overdueRiskReviews,
        },
      };
    },
  };

  const trendsPanel: Surface = {
    name: 'analytics trends panel',
    questionStatus: 'open',
    textOf: [],
    contributes: { task: ['tasksAuthorised', 'becameOverdue'], question: ['proposalsAuthorised'], risk: ['proposalsAuthorised'] },
    async read() {
      const body = await ok(admin.request('GET', '/admin/analytics?panel=trends'));
      return {
        text: json(body),
        counts: {
          tasksAuthorised: sum(body.data.series.tasks_authorised),
          becameOverdue: sum(body.data.series.tasks_became_overdue),
          proposalsAuthorised: sum(body.data.series.proposals_authorised),
        },
      };
    },
  };

  const drill: Surface = {
    name: 'analytics drill-down',
    questionStatus: 'open',
    textOf: ['task', 'risk'],
    contributes: { task: ['overdue', 'overdueList', 'orgOverdue', 'deptOverdue', 'eligible', 'eligibleList'], question: [], risk: ['risks', 'riskList'] },
    async read() {
      const at = (q: string) => ok(admin.request('GET', `/admin/analytics/drill?${q}`));
      const overdue = await at(`level=project&id=${p}&measure=overdueTasks`);
      const completion = await at(`level=project&id=${p}&measure=completion`);
      const risks = await at(`level=project&id=${p}&measure=openHighCriticalRisks`);
      const org = await at('level=org&measure=overdueTasks');
      const dept = await at(`level=department&id=${deptA}&measure=overdueTasks`);
      return {
        text: json([overdue, completion, risks, org, dept]),
        counts: {
          overdue: overdue.counts.total,
          overdueList: overdue.records.length,
          orgOverdue: org.counts.total,
          deptOverdue: dept.counts.total,
          eligible: completion.counts.total.total,
          eligibleList: completion.records.length,
          risks: risks.counts.total,
          riskList: risks.records.length,
        },
      };
    },
  };

  const csv: Surface = {
    name: 'analytics CSV export',
    questionStatus: 'open',
    textOf: [],
    contributes: { task: ['overdue', 'eligible', 'problemOverdue', 'orgOverdue'], question: [], risk: ['risks', 'orgRisks'] },
    async read() {
      const get = async (panel: string) => {
        const r = await admin.raw('GET', `/admin/analytics/export?panel=${panel}`);
        assert.equal(r.status, 200, r.text);
        return r.text;
      };
      const progress = await get('progress');
      const problems = await get('problems');
      const trends = await get('trends');
      const prow = csvRows(progress).find((r) => r.Level === 'Project' && r.Name === 'Harbour works') as Record<string, string>;
      const qrows = csvRows(problems);
      const qrow = qrows.find((r) => r.Level === 'Project' && r.Name === 'Harbour works') as Record<string, string>;
      const orow = qrows.find((r) => r.Level === 'Organisation') as Record<string, string>;
      return {
        text: [progress, problems, trends].join('\n'),
        counts: {
          overdue: num(prow.Overdue),
          eligible: num(prow['Eligible tasks']),
          problemOverdue: num(qrow['Overdue tasks']),
          orgOverdue: num(orow['Overdue tasks']),
          risks: num(qrow['Open High and Critical risks']),
          orgRisks: num(orow['Open High and Critical risks']),
        },
      };
    },
  };

  const SURFACES: readonly Surface[] = [personal, project, timeline, leadership, progressPanel, problemsPanel, trendsPanel, drill, csv];

  /** The counts expected once `kinds` each add one more record. */
  const plus = (s: Surface, base: Record<string, number>, kinds: readonly Kind[]): Record<string, number> => {
    const out = { ...base };
    for (const k of kinds) for (const c of s.contributes[k]) out[c] += 1;
    return out;
  };
  const assertShows = (s: Surface, v: View, expected: Record<string, number>) => {
    for (const k of s.textOf) assert.ok(v.text.includes(MARK[k]), `${s.name} shows the ${k} before it goes`);
    assert.deepEqual(v.counts, expected, `${s.name} counts the records`);
  };
  const assertGone = (s: Surface, v: View, expected: Record<string, number>, what: string) => {
    for (const k of KINDS) assert.ok(!v.text.includes(MARK[k]), `${s.name} still holds the ${what} ${k}`);
    assert.deepEqual(v.counts, expected, `${s.name} still counts a ${what} record`);
  };

  for (const s of SURFACES) {
    describe(s.name, () => {
      test('a Deleted task, question and risk are absent from lists, counts and text', async () => {
        const base = (await s.read()).counts;
        const ids = await seedRecords(p, s.questionStatus);
        assertShows(s, await s.read(), plus(s, base, KINDS));
        for (const k of KINDS) await remove(k, ids[k]);
        assertGone(s, await s.read(), base, 'Deleted');
      });

      test('an uncleaned held task, question and risk are absent from lists, counts and text', async () => {
        const base = (await s.read()).counts;
        const ids = await seedRecords(p, s.questionStatus);
        assertShows(s, await s.read(), plus(s, base, KINDS));
        for (const k of KINDS) await hold(k, ids[k], p, 'held');
        assertGone(s, await s.read(), base, 'held');
      });

      test('a cleaned held record stays counted and shows its label, never its text', async () => {
        const base = (await s.read()).counts;
        const ids = await seedRecords(p, s.questionStatus);
        const shownCounts = plus(s, base, KINDS);
        assertShows(s, await s.read(), shownCounts);
        for (const k of KINDS) await hold(k, ids[k], p, 'cleaned');
        const after = await s.read();
        for (const k of KINDS) assert.ok(!after.text.includes(MARK[k]), `${s.name} shows the cleaned ${k}'s text`);
        assert.deepEqual(after.counts, shownCounts, `${s.name} stops counting a cleaned record`);
        if (s.textOf.length > 0) {
          const labels = after.text.split(UNDER_REVIEW_TEXT).length - 1;
          assert.ok(labels >= s.textOf.length, `${s.name} shows the cleaned label for each record it lists (${labels})`);
        }
      });

      test('no source text, message text, quote, private AI question or credential text', async () => {
        await seedRecords(p, s.questionStatus);
        await seedContent();
        const v = await s.read();
        for (const k of s.textOf) assert.ok(v.text.includes(MARK[k]), `${s.name} shows ordinary record text`);
        assertNoContent(v.text, s.name);
      });
    });
  }

  describe('analytics system panel', () => {
    test('credential cases are a count only, with no record, case or credential text', async () => {
      const read = async () => ok(admin.request('GET', '/admin/analytics?panel=system'));
      assert.equal((await read()).data.security.casesAwaitingReview, 0);
      await seedRecords(p, 'open');
      await seedContent();
      const body = await read();
      // One held task and one cleaned risk are open cases.
      assert.equal(body.data.security.casesAwaitingReview, 2);
      const text = json(body);
      assertNoContent(text, 'the system panel');
      for (const k of KINDS) assert.ok(!text.includes(MARK[k]));
      assert.ok(!text.includes('Harbour works'), 'the system panel names no project');
      const exported = await admin.raw('GET', '/admin/analytics/export?panel=system');
      assert.equal(exported.status, 200, exported.text);
      assert.match(exported.text, /Security,Credential cases awaiting review,2\r\n/);
      assertNoContent(exported.text, 'the system CSV');
    });

    test('the export audit event holds the panel and filters, never data', async () => {
      await seedRecords(p, 'open');
      await seedContent();
      for (const panel of ['progress', 'problems', 'system', 'trends']) {
        assert.equal((await admin.raw('GET', `/admin/analytics/export?panel=${panel}&department=${deptA}`)).status, 200);
      }
      const rows = (await t.pool.query(`SELECT detail FROM audit_events WHERE action = 'analytics.exported' ORDER BY id`)).rows;
      assert.equal(rows.length, 4);
      for (const r of rows) {
        assert.deepEqual(Object.keys(r.detail).sort(), ['filters', 'panel']);
        const text = json(r.detail);
        assertNoContent(text, 'the export audit event');
        for (const k of KINDS) assert.ok(!text.includes(MARK[k]));
        assert.ok(!text.includes('Harbour works'));
      }
    });
  });

  describe('Needs you: overdue, blocked, due soon and risk review', () => {
    const NEW_KINDS = ['overdue', 'blocked', 'due_soon', 'risk_review'];
    const newKinds = async (c: Client) => (await ok(c.request('GET', '/dashboard/me'))).needsYou.filter((n: any) => NEW_KINDS.includes(n.kind));
    async function seedNeeds(): Promise<void> {
      await addTask(p, `Service the ${MARK.task} pump`);
      await addTask(p, `Blocked ${MARK.task} winch`, { status: 'blocked', dueOn: '2026-11-30' });
      await addTask(p, `Soon ${MARK.task} hoist`, { dueOn: '2026-11-10' });
      await addRisk(p, `The ${MARK.risk} crane may fail`, '2026-11-12');
    }

    test('the assignee and risk owner get each kind; the PM gets the Blocked task', async () => {
      await seedNeeds();
      assert.deepEqual((await newKinds(mem)).map((n: any) => n.kind).sort(), ['blocked', 'due_soon', 'overdue', 'risk_review']);
      assert.deepEqual((await newKinds(pm)).map((n: any) => n.kind), ['blocked']);
    });

    test('a removed member gets none of them, and no text', async () => {
      await seedNeeds();
      assert.equal((await newKinds(mem)).length, 4);
      await t.pool.query(`UPDATE memberships SET revoked_at = now(), revoked_by = $2 WHERE project_id = $1 AND user_id = $3`, [p, pmId, memId]);
      const body = await ok(mem.request('GET', '/dashboard/me'));
      assert.deepEqual(body.needsYou.filter((n: any) => n.projectId === p), []);
      assert.ok(!json(body).includes(MARK.task) && !json(body).includes(MARK.risk));
    });

    test('an Audit grant holder and a leadership summary holder get none of them, and no text', async () => {
      await seedNeeds();
      const auditorId = await seedUser(t.pool, 'auditor@example.org');
      await t.pool.query(
        `INSERT INTO access_grants (id, project_id, user_id, kind, purpose, scope, starts_on, expires_on, requested_by, requested_at, decision, decided_by, decided_at)
         VALUES ($1, $2, $3, 'audit', 'Annual audit', 'Everything', '2026-11-01', '2026-12-31', $4, now(), 'approved', $5, now())`,
        [uuidv7(), p, auditorId, pmId, adminId],
      );
      const auditor = await t.signIn('auditor@example.org');
      assert.equal((await auditor.request('GET', `/records/tasks/${(await t.pool.query(`SELECT id FROM tasks WHERE project_id = $1 LIMIT 1`, [p])).rows[0].id}`)).status, 200, 'the holder reads the records');
      for (const c of [auditor, leader]) {
        const body = await ok(c.request('GET', '/dashboard/me'));
        assert.deepEqual(body.needsYou, []);
        assert.ok(!json(body).includes(MARK.task) && !json(body).includes(MARK.risk));
      }
    });
  });

  describe('leadership access', () => {
    const summary = () => leader.request('GET', '/dashboard/leadership');
    /** The leader sees Harbour works with its risk, so losing access below means something. */
    const assertSees = async () => {
      const r = await summary();
      assert.equal(r.status, 200, json(r.body));
      assert.deepEqual(r.body.cards.map((c: any) => c.id), [p]);
      assert.ok(json(r.body).includes(MARK.risk));
    };
    const assertLost = async (status: number) => {
      const r = await summary();
      assert.equal(r.status, status, json(r.body));
      assert.ok(!json(r.body ?? null).includes(MARK.risk));
      assert.ok(!json(r.body ?? null).includes('Harbour works'));
      assert.equal(await leadershipProjectIds(t.pool, leaderId, todayUtc8(t.clock.now())), null);
    };

    test('a holder gets 404 from every content route of an in-scope project, 403 from analytics, and no project of their own', async () => {
      const ids = await seedRecords(p, 'open');
      await assertSees();
      const thread = await ok(mem.request('POST', `/projects/${p}/threads`, { kind: 'discussion', title: 'Quay chat' }), 201);
      const note = await ok(pm.request('POST', `/projects/${p}/notes`, { title: 'Weekly notes', text: 'The winch is serviced on Thursday.' }), 201);
      const paths = [
        `/projects/${p}`,
        `/projects/${p}/records`,
        `/projects/${p}/notes`,
        `/projects/${p}/discussion`,
        `/projects/${p}/dashboard`,
        `/projects/${p}/timeline`,
        `/projects/${p}/history/deletions`,
        `/records/tasks/${ids.task}`,
        `/threads/${thread.id}`,
        `/notes/${note.source.id}`,
      ];
      // A Member reads each of them.
      for (const path of paths) assert.equal((await mem.request('GET', path)).status, 200, path);
      for (const path of paths) assert.equal((await leader.request('GET', path)).status, 404, path);
      for (const path of ['/admin/analytics?panel=progress', `/admin/analytics/drill?level=project&id=${p}&measure=overdueTasks`, '/admin/analytics/export?panel=progress']) {
        assert.equal((await leader.request('GET', path)).status, 403, path);
      }
      const mine = await ok(leader.request('GET', '/dashboard/me'));
      assert.deepEqual(mine.projects, []);
      assert.ok(!json(mine).includes(MARK.task));
      assert.deepEqual((await ok(leader.request('GET', '/projects'))).projects, []);
    });

    test('a holder sees nothing outside the scope; a department scope follows an ownership transfer', async () => {
      await addRisk(q, `The ${MARK.risk} crane may fail`);
      const other = await seedUser(t.pool, 'leader2@example.org');
      await ok(admin.request('POST', '/admin/leadership-grants', { userId: other, scope: { kind: 'organisation' }, startsOn: '2026-11-09', reason: 'Oversight' }), 201);
      // An organisation-scope holder sees Quay works and its risk.
      const wide = await ok((await t.signIn('leader2@example.org')).request('GET', '/dashboard/leadership'));
      assert.ok(wide.cards.some((c: any) => c.id === q));
      assert.ok(json(wide).includes(MARK.risk));

      const body = await ok(summary());
      assert.deepEqual(body.cards.map((c: any) => c.id), [p]);
      assert.deepEqual(body.departments.map((d: any) => d.name), ['Alpha Unit']);
      assert.ok(!json(body).includes('Quay works'));
      assert.ok(!json(body).includes(MARK.risk));
      assert.deepEqual((await ok(leader.request('GET', `/dashboard/leadership?department=${deptB}`))).cards, []);
      assert.deepEqual((await ok(leader.request('GET', '/dashboard/leadership?status=draft,planned,active,deferred,closed'))).cards.map((c: any) => c.id), [p]);

      // Alpha Unit takes over Quay works: it comes into scope; Harbour works moves to Beta Unit and leaves it.
      await t.pool.query(`UPDATE projects SET owning_department_id = $2 WHERE id = $1`, [q, deptA]);
      await t.pool.query(`UPDATE projects SET owning_department_id = $2 WHERE id = $1`, [p, deptB]);
      const moved = await ok(summary());
      assert.deepEqual(moved.cards.map((c: any) => c.id), [q]);
      assert.ok(json(moved).includes(MARK.risk));
      assert.ok(!json(moved).includes('Harbour works'));
    });

    test('access ends at 00:00 UTC+8 after the last day', async () => {
      await addRisk(p, `The ${MARK.risk} crane may fail`);
      await ok(admin.request('POST', `/admin/leadership-grants/${grantId}/end`, { expiresOn: '2026-11-09', reason: 'Review finished' }));
      t.clock.ms = Date.UTC(2026, 10, 9, 15, 58, 0); // 23:58 UTC+8, the last day
      leader = await t.signIn('leader@example.org'); // 23:59
      await assertSees();
      assert.deepEqual((await ok(leader.request('GET', '/leadership/me'))), { hasGrant: true });
      t.clock.ms = Date.UTC(2026, 10, 9, 16, 0, 0); // 00:00 UTC+8 the next day
      await assertLost(404);
      assert.deepEqual((await ok(leader.request('GET', '/leadership/me'))), { hasGrant: false });
    });

    test('access ends at once on revocation', async () => {
      await addRisk(p, `The ${MARK.risk} crane may fail`);
      await assertSees();
      await ok(admin.request('POST', `/admin/leadership-grants/${grantId}/revoke`, { reason: 'Role changed' }));
      await assertLost(404);
      assert.deepEqual((await ok(leader.request('GET', '/leadership/me'))), { hasGrant: false });
    });

    test('access ends at once on account disablement, and the grant stays inert', async () => {
      await addRisk(p, `The ${MARK.risk} crane may fail`);
      await assertSees();
      assert.equal((await admin.request('POST', `/users/${leaderId}/disable`)).status, 204);
      // The session is gone with the account, and the grant itself no longer covers anything.
      await assertLost(401);
      assert.equal((await t.pool.query(`SELECT revoked_at FROM leadership_grants WHERE id = $1`, [grantId])).rows[0].revoked_at, null);
    });
  });

  describe('a non-participant Administrator', () => {
    const LISTING = ['overdueTasks', 'overdue', 'blockedTasks', 'blocked', 'deadlineReviewsPending', 'completion', 'onTime', 'openHighCriticalRisks', 'overdueRiskReviews'];
    const COUNTS_ONLY = ['vacantRequiredRoles', 'openEscalations', 'noIndependentEscalation', 'invitationsExpired'];

    async function seedEverything(project: string): Promise<void> {
      await addTask(project, `Service the ${MARK.task} pump`);
      await addTask(project, `Unblock the ${MARK.task} gate`, { status: 'blocked' });
      await addTask(project, `Review the ${MARK.task} date`, { review: true });
      await addTask(project, `Finish the ${MARK.task} survey`, { status: 'completed', dueOn: '2026-11-20' });
      await addRisk(project, `The ${MARK.risk} crane may fail`, '2026-11-02');
    }

    test('gets counts and the limited message from every listing measure, never records', async () => {
      await seedEverything(q);
      for (const measure of LISTING) {
        const r = await ok(admin.request('GET', `/admin/analytics/drill?level=project&id=${q}&measure=${measure}`));
        assert.equal(r.limited, LIMITED, measure);
        assert.equal(r.records, undefined, measure);
        assert.ok(!json(r).includes(MARK.task) && !json(r).includes(MARK.risk), measure);
      }
      // The counts are there.
      const overdue = await ok(admin.request('GET', `/admin/analytics/drill?level=project&id=${q}&measure=overdueTasks`));
      // Overdue: the open and the blocked task (the one awaiting deadline review is not overdue).
      assert.equal(overdue.counts.total, 2);
      const completion = await ok(admin.request('GET', `/admin/analytics/drill?level=project&id=${q}&measure=completion`));
      assert.deepEqual(completion.counts.total, { done: 1, total: 4, cancelled: 0 });
      // The department and organisation levels never list records, for anyone.
      for (const query of [`level=department&id=${deptB}&measure=overdueTasks`, 'level=org&measure=openHighCriticalRisks']) {
        const r = await ok(admin.request('GET', `/admin/analytics/drill?${query}`));
        assert.equal(r.records, undefined);
        assert.ok(!json(r).includes(MARK.task) && !json(r).includes(MARK.risk));
      }
    });

    test('the same Administrator gets records where a participant, and counts only for counts-only measures', async () => {
      await seedEverything(p);
      for (const measure of LISTING) {
        const r = await ok(admin.request('GET', `/admin/analytics/drill?level=project&id=${p}&measure=${measure}`));
        assert.equal(r.limited, undefined, measure);
        assert.ok(Array.isArray(r.records) && r.records.length > 0, measure);
      }
      for (const project of [p, q]) {
        for (const measure of COUNTS_ONLY) {
          const r = await ok(admin.request('GET', `/admin/analytics/drill?level=project&id=${project}&measure=${measure}`));
          assert.equal(r.records, undefined, measure);
          assert.equal(r.limited, undefined, measure);
          assert.equal(typeof r.counts.total, 'number', measure);
        }
      }
    });

    test('losing the participant role takes the records away at once', async () => {
      await seedEverything(p);
      const before = await ok(admin.request('GET', `/admin/analytics/drill?level=project&id=${p}&measure=overdueTasks`));
      assert.ok(json(before.records).includes(MARK.task));
      await t.pool.query(`UPDATE memberships SET revoked_at = now(), revoked_by = $2 WHERE project_id = $1 AND user_id = $3`, [p, pmId, adminId]);
      const after = await ok(admin.request('GET', `/admin/analytics/drill?level=project&id=${p}&measure=overdueTasks`));
      assert.equal(after.records, undefined);
      assert.equal(after.limited, LIMITED);
      assert.equal(after.counts.total, before.counts.total);
      assert.ok(!json(after).includes(MARK.task));
    });
  });
});
