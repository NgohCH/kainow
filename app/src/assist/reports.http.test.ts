import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { uuidv7 } from '../common/uuid7';
import type { JsonSchemaModel, ModelRequest } from '../extraction/model';
import type { Usage } from '../spend/cost';
import { MVP_SPEND_SETTINGS } from '../spend/mvp-settings';
import { SpendService } from '../spend/spend.service';
import { SpendSettingsService } from '../spend/spend.settings';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedProject, seedUser } from '../testing/projects';
import { AssistRunner } from './assist-runner';

const USAGE: Usage = { inputTokens: 3_000, cachedInputTokens: 0, outputTokens: 600 };
const STALE = 'Someone changed this since you opened it';

/** Writes one narrative per requested section, citing P1 unless told otherwise. */
class ReportModel implements JsonSchemaModel {
  calls: ModelRequest[] = [];
  constructor(private readonly cite: string[] = ['P1']) {}
  async callJson(req: ModelRequest): Promise<{ content: unknown; usage: Usage }> {
    this.calls.push(req);
    const sections = [...req.user.matchAll(/^- (.+)$/gm)].map((m) => m[1]);
    const out = sections.map((section, i) => {
      const marker = this.cite[i % this.cite.length];
      return { section, markdown: `Narrative for ${section} [${marker}].`, cited: [marker] };
    });
    return { content: JSON.stringify({ sections: out }), usage: USAGE };
  }
}

describe('draft reports and specifications', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  const ids: Record<string, string> = {};
  let project: string;
  let pm: Client;
  let dep: Client;
  let ada: Client;
  let ben: Client;
  let auditor: Client;
  let thread: string;
  let queued: string[];

  const count = async (sql: string, params: unknown[] = []) => Number((await t.pool.query(sql, params)).rows[0].n);
  const run = (id: string, model: JsonSchemaModel = new ReportModel(), last = false) =>
    new AssistRunner({ pool: t.pool, spend: new SpendService(t.pool, t.clock.now), model, clock: t.clock.now }).process(id, 1, last);
  const request = (c: Client, body: Record<string, unknown>) => c.request('POST', `/projects/${project}/reports`, body);
  const lastRequest = () => queued[queued.length - 1];
  const note = async (title: string, text: string) => {
    const r = await pm.request('POST', `/projects/${project}/notes`, { title, text });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.source.id as string;
  };
  const restrict = async (sourceId: string, namedUserIds: string[]) => {
    const audienceId = (await t.pool.query(`SELECT audience_id FROM sources WHERE id = $1`, [sourceId])).rows[0].audience_id;
    const r = await pm.request('PUT', `/audiences/${audienceId}`, { mode: 'restricted', namedUserIds, reason: 'Audience review' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  };
  const post = async (c: Client, body: string) => {
    const r = await c.request('POST', `/threads/${thread}/messages`, { body });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.id as string;
  };
  /** A specification of the chosen note, drafted by the AI. */
  const drafted = async (c: Client, chosen: Record<string, string[]>, kind = 'specification') => {
    const r = await request(c, { kind, title: 'Pump specification', brief: kind === 'free_form' ? 'Write up the pump plan.' : undefined, chosen });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(await run(lastRequest()), 'succeeded');
    t.clock.advanceSeconds(1);
    return r.body.id as string;
  };
  const view = (c: Client, id: string) => c.request('GET', `/reports/${id}`);
  const listed = async (c: Client) => ((await c.request('GET', `/projects/${project}/reports`)).body.items as Array<{ id: string }>).map((i) => i.id);
  const grant = (userId: string) =>
    t.pool.query(
      `INSERT INTO access_grants (id, project_id, user_id, kind, purpose, scope, starts_on, expires_on, requested_by, requested_at, decision, decided_by, decided_at)
       VALUES ($1, $2, $3, 'audit', 'Annual audit', 'Everything', '2026-11-01', '2026-11-30', $4, now(), 'approved', $5, now())`,
      [uuidv7(), project, userId, ids.pm, ids.admin],
    );
  const task = (title: string, due: string, status: string, assignee = ids.ada) =>
    t.pool.query(
      `INSERT INTO tasks (id, project_id, depth, title, assignee_id, due_on, status, authorised_by, authorised_at) VALUES ($1, $2, 0, $3, $4, $5, $6, $7, $8)`,
      [uuidv7(), project, title, assignee, due, status, ids.pm, new Date('2026-11-01T02:00:00Z')],
    );
  const events = async (id: string) => (await t.pool.query(`SELECT action, detail FROM ai_assist_events WHERE target_id = $1 ORDER BY at, id`, [id])).rows;

  beforeEach(async () => {
    queued = [];
    t = await startTestApp(undefined, { assistQueue: { enqueue: async (id: string) => void queued.push(id) } });
    for (const k of ['pm', 'dep', 'ada', 'ben', 'auditor']) ids[k] = await seedUser(t.pool, `${k}@example.org`);
    ids.admin = await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    await t.pool.query(`UPDATE users SET display_name = 'Ada Lim' WHERE id = $1`, [ids.ada]);
    project = await seedProject(t.pool, {
      name: 'Alpha Project',
      status: 'active',
      members: [
        { userId: ids.pm, role: 'pm' },
        { userId: ids.pm, role: 'owner' },
        { userId: ids.dep, role: 'deputy_pm' },
        { userId: ids.ada, role: 'member' },
        { userId: ids.ben, role: 'member' },
      ],
    });
    await grant(ids.auditor);
    await new SpendSettingsService(t.pool, t.clock.now).apply(MVP_SPEND_SETTINGS, ids.admin);
    [pm, dep, ada, ben, auditor] = [
      await t.signIn('pm@example.org'),
      await t.signIn('dep@example.org'),
      await t.signIn('ada@example.org'),
      await t.signIn('ben@example.org'),
      await t.signIn('auditor@example.org'),
    ];
    const r = await pm.request('POST', `/projects/${project}/threads`, { kind: 'discussion', title: 'Plant' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    thread = r.body.id;
  });
  afterEach(async () => {
    await t.close();
  });

  test('member requests a status report', async () => {
    await task('Replace the pump seal', '2026-11-05', 'in_progress');
    await task('Order spare filters', '2026-11-12', 'not_started', ids.ben);
    await note('Site visit', 'The pump seal replacement is delayed by a week because the part is late.');

    const r = await request(ada, { kind: 'status' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.status, 'queued');
    assert.equal(r.body.title, 'Status report');
    // Default period: the last 14 days, UTC+8 (the clock is 9 November 2026, 10:00 in UTC+8).
    assert.deepEqual(r.body.period, { from: '2026-10-27', to: '2026-11-09' });
    assert.equal(r.body.label, 'AI draft — not approved');
    assert.equal(r.body.current, null);
    assert.equal(queued.length, 1);
    const material = (await t.pool.query(`SELECT record_kind, passage_id FROM ai_request_material WHERE request_id = $1 ORDER BY ordinal`, [lastRequest()])).rows;
    assert.ok(material.some((m) => m.passage_id !== null), 'a passage found by the section terms');
    assert.equal(material.filter((m) => m.record_kind === 'task').length, 2, 'snapshots of the period records');

    const model = new ReportModel();
    assert.equal(await run(lastRequest(), model), 'succeeded');
    assert.equal(model.calls.length, 1, 'one AI call per draft');
    assert.ok(model.calls[0].user.includes('- Overdue and blocked'));
    const v = await view(ada, r.body.id);
    assert.equal(v.status, 200, JSON.stringify(v.body));
    assert.equal(v.body.status, 'ready');
    assert.deepEqual(v.body.versions.map((x: { no: number; origin: string }) => [x.no, x.origin]), [[1, 'ai']]);
    const body = v.body.current.body as string;
    assert.match(body, /^# Status report\n/);
    assert.match(body, /Drafted by AI for Ada Lim on 2026-11-09/);
    assert.match(body, /## Overdue and blocked\n\n\| Task \| Assignee \| Due date \| Status \|[\s\S]*Replace the pump seal\]\([^)]+\) \| Ada Lim \| 2026-11-05 \| In progress \|/);
    assert.match(body, /## Due in the next 14 days\n\n[\s\S]*Order spare filters\]\([^)]+\) \| ben \| 2026-11-12 \| Not started \|/);
    assert.match(body, /Narrative for Summary \[\^P1\]\./);
    assert.match(body, /## Sources\n\n\[\^P1\]: \[/);
    assert.equal(v.body.canEdit, true);
    assert.equal(v.body.canShare, true);

    // Private to the requester; charged to her personal cap.
    assert.equal((await view(ben, r.body.id)).status, 404);
    assert.equal((await view(pm, r.body.id)).status, 404);
    assert.deepEqual(await listed(ada), [r.body.id]);
    assert.deepEqual(await listed(ben), []);
    assert.equal(await count(`SELECT count(*) AS n FROM ai_requests WHERE id = $1 AND requested_by = $2 AND kind = 'report'`, [lastRequest(), ids.ada]), 1);
    assert.equal(await count(`SELECT count(*) AS n FROM ai_spend_entries WHERE request_id = $1 AND purpose = 'report_draft'`, [lastRequest()]), 1);
    const ev = await events(r.body.id);
    assert.deepEqual(ev.map((e) => e.action), ['draft_requested']);
    assert.equal(ev[0].detail.requestId, lastRequest());
    assert.ok(!JSON.stringify(ev).includes('pump'), 'no draft text in events');
  });

  test('specification needs 1–10 chosen sources', async () => {
    const pump = await note('Pump notes', 'The pump must deliver 40 litres a minute.\n\nIt must run on single-phase power.');
    await task('Pump commissioning', '2026-11-05', 'in_progress');
    assert.equal((await request(ada, { kind: 'specification' })).status, 400);
    assert.equal((await request(ada, { kind: 'specification', chosen: { sourceIds: [] } })).status, 400);
    const eleven = Array.from({ length: 11 }, () => uuidv7());
    const tooMany = await request(ada, { kind: 'specification', chosen: { sourceIds: eleven } });
    assert.equal(tooMany.status, 400);
    assert.equal(tooMany.body.message, 'Choose 1 to 10 sources or threads.');
    assert.equal((await request(ada, { kind: 'status', chosen: { sourceIds: [pump] } })).status, 400, 'record kinds take no chosen sources');
    assert.equal((await request(ada, { kind: 'specification', chosen: { sourceIds: [uuidv7()] } })).status, 404, 'unknown source');
    assert.equal(await count(`SELECT count(*) AS n FROM report_drafts`), 0);

    const r = await request(ada, { kind: 'specification', chosen: { sourceIds: [pump] } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual(r.body.chosen, { sourceIds: [pump], threadIds: [] });
    assert.equal(r.body.period, null, 'a specification has no default period');
    const material = (await t.pool.query(`SELECT record_kind, passage_id FROM ai_request_material WHERE request_id = $1`, [lastRequest()])).rows;
    const notePassages = await count(`SELECT count(*) AS n FROM passages p JOIN source_versions v ON v.id = p.owner_id WHERE v.source_id = $1`, [pump]);
    assert.ok(notePassages >= 1);
    assert.equal(material.length, notePassages, 'every passage of the chosen note');
    assert.ok(material.every((m) => m.passage_id !== null && m.record_kind === null), 'no Project-wide records');
    assert.equal(await run(lastRequest()), 'succeeded');
    const body = (await view(ada, r.body.id)).body.current.body as string;
    for (const s of ['Purpose', 'Scope', 'Requirements', 'Constraints', 'Open questions', 'Decisions referenced']) assert.ok(body.includes(`## ${s}\n`), s);
  });

  test('restricted source can be chosen only by someone in its audience', async () => {
    const secret = await note('Vendor terms', 'The pump vendor offers a two-year warranty.');
    await restrict(secret, [ids.ben]);
    const refused = await request(ada, { kind: 'specification', chosen: { sourceIds: [secret] } });
    assert.equal(refused.status, 404, JSON.stringify(refused.body));
    assert.equal((await request(ada, { kind: 'free_form', title: 'Notes', brief: 'Summarise.', chosen: { threadIds: [uuidv7()] } })).status, 404);
    assert.equal((await request(ben, { kind: 'specification', chosen: { sourceIds: [secret] } })).status, 201);
  });

  test('brief over 2,000 refused', async () => {
    const pump = await note('Pump notes', 'The pump must deliver 40 litres a minute.');
    const long = await request(ada, { kind: 'free_form', title: 'Pump plan', brief: 'x'.repeat(2_001), chosen: { sourceIds: [pump] } });
    assert.equal(long.status, 400);
    assert.equal(long.body.message, 'A brief must be 1 to 2,000 characters.');
    assert.equal((await request(ada, { kind: 'free_form', title: 'Pump plan', chosen: { sourceIds: [pump] } })).status, 400, 'free-form needs a brief');
    assert.equal((await request(ada, { kind: 'free_form', brief: 'Plan it.', chosen: { sourceIds: [pump] } })).status, 400, 'free-form needs a title');
    assert.equal((await request(ada, { kind: 'status', title: 't'.repeat(201) })).status, 400);
    const secret = await request(ada, { kind: 'free_form', title: 'Pump plan', brief: 'Use password=Hunter2Hunter2 to log in.', chosen: { sourceIds: [pump] } });
    assert.equal(secret.status, 400);
    assert.match(secret.body.message, /^Not posted: this looks like it contains .+\. Remove it and post again\.$/);
    assert.equal((await request(ada, { kind: 'status', periodFrom: '2026-11-09', periodTo: '2026-11-01' })).status, 400);
    assert.equal(await count(`SELECT count(*) AS n FROM report_drafts`), 0);
    assert.equal(await count(`SELECT count(*) AS n FROM ai_requests`), 0);
    assert.equal((await request(ada, { kind: 'free_form', title: 'Pump plan', brief: 'b'.repeat(2_000), chosen: { sourceIds: [pump] } })).status, 201);
  });

  test('edit creates a human version; stale edit 409', async () => {
    const pump = await note('Pump notes', 'The pump must deliver 40 litres a minute.');
    const id = await drafted(ada, { sourceIds: [pump] });
    const edited = await ada.request('PUT', `/reports/${id}`, { body: '# Pump specification\n\nEdited by hand.', basedOnVersion: 1 });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.deepEqual(edited.body.versions.map((v: { no: number; origin: string }) => [v.no, v.origin]), [[1, 'ai'], [2, 'human']]);
    assert.equal(edited.body.current.editedByLabel, 'Edited by Ada Lim');
    assert.equal(edited.body.current.body, '# Pump specification\n\nEdited by hand.');
    assert.equal(edited.body.label, 'AI draft — not approved');

    t.clock.advanceSeconds(1);
    const stale = await ada.request('PUT', `/reports/${id}`, { body: 'Another edit.', basedOnVersion: 1 });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.message, STALE);
    assert.equal(stale.body.current.current.no, 2);
    assert.equal((await ada.request('PUT', `/reports/${id}`, { body: 'Edited.', basedOnVersion: undefined })).status, 400);
    assert.equal((await ada.request('PUT', `/reports/${id}`, { body: 'y'.repeat(100_001), basedOnVersion: 2 })).status, 400);
    assert.equal((await ada.request('PUT', `/reports/${id}`, { body: 'token: password=Hunter2Hunter2', basedOnVersion: 2 })).status, 400);
    // Private: nobody else can edit, not even the PM.
    assert.equal((await pm.request('PUT', `/reports/${id}`, { body: 'PM edit.', basedOnVersion: 2 })).status, 404);

    t.clock.advanceSeconds(1);
    assert.equal((await ada.request('POST', `/reports/${id}/share`)).status, 200);
    t.clock.advanceSeconds(1);
    assert.equal((await ben.request('PUT', `/reports/${id}`, { body: 'Ben edit.', basedOnVersion: 2 })).status, 403, 'a member may read but not edit');
    const byPm = await pm.request('PUT', `/reports/${id}`, { body: 'PM edit.', basedOnVersion: 2 });
    assert.equal(byPm.status, 200, JSON.stringify(byPm.body));
    assert.equal(byPm.body.current.editedByLabel, 'Edited by pm');
    const ev = await events(id);
    assert.deepEqual(ev.map((e) => e.action), ['draft_requested', 'draft_edited', 'draft_shared', 'draft_edited']);
    assert.ok(!JSON.stringify(ev).includes('Edited by hand') && !JSON.stringify(ev).includes('PM edit'), 'no draft text in events');
    // The PM may unshare it too.
    assert.equal((await pm.request('POST', `/reports/${id}/unshare`)).status, 200);
    assert.equal((await view(ben, id)).status, 404);
  });

  test('regenerate creates a new ai version', async () => {
    const pump = await note('Pump notes', 'The pump must deliver 40 litres a minute.');
    const id = await drafted(ada, { sourceIds: [pump] });
    assert.equal((await ada.request('PUT', `/reports/${id}`, { body: 'Hand edit.', basedOnVersion: 1 })).status, 200);
    const again = await ada.request('POST', `/reports/${id}/regenerate`);
    assert.equal(again.status, 201, JSON.stringify(again.body));
    assert.equal(again.body.warning, 'A new AI version does not include edits people made to earlier versions.');
    assert.equal(again.body.status, 'queued');
    assert.equal((await ada.request('POST', `/reports/${id}/regenerate`)).status, 409, 'one at a time');
    assert.equal(await run(lastRequest()), 'succeeded');
    const v = (await view(ada, id)).body;
    assert.deepEqual(v.versions.map((x: { no: number; origin: string }) => [x.no, x.origin]), [[1, 'ai'], [2, 'human'], [3, 'ai']]);
    assert.ok(!v.current.body.includes('Hand edit.'));
    assert.equal(await count(`SELECT count(*) AS n FROM ai_assist_events WHERE target_id = $1 AND action = 'draft_requested'`, [id]), 2);
    // Only the requester regenerates.
    assert.equal((await ada.request('POST', `/reports/${id}/share`)).status, 200);
    assert.equal((await pm.request('POST', `/reports/${id}/regenerate`)).status, 403);
  });

  test('shared draft hidden from a member who cannot read one passage', async () => {
    const open = await note('Pump notes', 'The pump must deliver 40 litres a minute.');
    const secret = await note('Vendor terms', 'The pump vendor offers a two-year warranty.');
    await restrict(secret, [ids.ada]);
    const id = await drafted(ada, { sourceIds: [open, secret] });
    const shared = await ada.request('POST', `/reports/${id}/share`);
    assert.equal(shared.status, 200, JSON.stringify(shared.body));
    assert.equal(shared.body.shared, true);
    assert.equal((await view(ben, id)).status, 404, 'Ben cannot read the vendor terms');
    assert.equal((await ben.request('GET', `/reports/${id}/versions/1`)).status, 404, 'nor any version of it');
    assert.equal((await ben.raw('GET', `/reports/${id}/versions/1/markdown`)).status, 404, 'nor its Markdown');
    const v1 = (await view(ada, id)).body.current.id as string;
    const flagged = await ben.request('POST', `/projects/${project}/feedback`, { targetKind: 'report_version', targetId: v1, category: 'incorrect', note: 'Wrong.' });
    assert.equal(flagged.status, 404, 'nor flag it');
    assert.deepEqual(await listed(ben), []);
    assert.equal((await view(dep, id)).status, 200, 'the Deputy may read every passage');
    assert.equal((await view(auditor, id)).status, 404, 'nor can the auditor, who is not named');

    const plain = await drafted(ada, { sourceIds: [open] });
    assert.equal((await ada.request('POST', `/reports/${plain}/share`)).status, 200);
    assert.equal((await view(ben, plain)).status, 200);
    assert.deepEqual(await listed(ben), [plain]);
  });

  test('a draft too long to keep fails once, with one AI call', async () => {
    const pump = await note('Pump notes', 'The pump must deliver 40 litres a minute.');
    const r = await request(ada, { kind: 'specification', chosen: { sourceIds: [pump] } });
    assert.equal(r.status, 201);
    const huge: JsonSchemaModel & { calls: number } = {
      calls: 0,
      async callJson() {
        this.calls++;
        return { content: JSON.stringify({ sections: [{ section: 'Purpose', markdown: `${'Long text. '.repeat(10_000)}[P1]`, cited: ['P1'] }] }), usage: USAGE };
      },
    };
    // Not the last attempt: a retry would be possible, but asking again would not help.
    assert.equal(await run(lastRequest(), huge, false), 'failed');
    assert.equal(huge.calls, 1);
    assert.deepEqual((await t.pool.query(`SELECT status, failure_code, attempts FROM ai_requests WHERE id = $1`, [lastRequest()])).rows[0], {
      status: 'failed',
      failure_code: 'draft_too_long',
      attempts: 1,
    });
    assert.equal(await count(`SELECT count(*) AS n FROM ai_spend_entries WHERE request_id = $1`, [lastRequest()]), 1, 'charged once');
    assert.equal(await count(`SELECT count(*) AS n FROM report_draft_versions`), 0);
    const v = (await view(ada, r.body.id)).body;
    assert.equal(v.notice, 'AI draft unavailable: the draft would be longer than 100,000 characters, so nothing was kept');
  });

  test('heading shows a period only when the draft is limited by one; chosen items are shown only when readable', async () => {
    const pump = await note('Pump notes', 'The pump must deliver 40 litres a minute.');
    const spec = await drafted(ada, { sourceIds: [pump] });
    assert.ok(!(await view(ada, spec)).body.current.body.includes('Period:'));
    const r = await request(ada, { kind: 'free_form', title: 'Pump plan', brief: 'Write it up.', periodFrom: '2026-11-01', periodTo: '2026-11-09', chosen: { sourceIds: [pump] } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(await run(lastRequest()), 'succeeded');
    assert.match((await view(ada, r.body.id)).body.current.body, /Period: 2026-11-01 to 2026-11-09/);

    // A restricted meeting with no messages adds no material, so Ben may read the draft, but not learn the thread.
    const hidden = await pm.request('POST', `/projects/${project}/threads`, { kind: 'meeting', title: 'Private', audience: { mode: 'restricted', namedUserIds: [ids.ada] } });
    assert.equal(hidden.status, 201, JSON.stringify(hidden.body));
    const both = await drafted(ada, { sourceIds: [pump], threadIds: [hidden.body.id] });
    assert.equal((await ada.request('POST', `/reports/${both}/share`)).status, 200);
    assert.deepEqual((await view(ada, both)).body.chosen, { sourceIds: [pump], threadIds: [hidden.body.id] });
    const forBen = await view(ben, both);
    assert.equal(forBen.status, 200);
    assert.deepEqual(forBen.body.chosen, { sourceIds: [pump], threadIds: [] });
  });

  test('a reviewer who cannot read a cleared draft finds nothing', async () => {
    const msg = await post(ben, 'The pump must deliver 40 litres a minute.');
    const id = await drafted(ada, { threadIds: [thread] }, 'free_form');
    assert.equal((await ada.request('POST', `/reports/${id}/share`)).status, 200);
    assert.equal((await pm.request('POST', `/messages/${msg}/hide`, { reason: 'Posted in error' })).status, 200);
    assert.equal((await pm.request('POST', `/assist-review/draft/${id}/clear`, { reason: 'Checked' })).status, 200);
    // Cleared, but built on a hidden message the PM cannot read: not found, rather than "not waiting for review".
    assert.equal((await pm.request('POST', `/assist-review/draft/${id}/clear`, { reason: 'Again' })).status, 404);
    assert.equal((await view(pm, id)).status, 404);
  });

  test('download returns Markdown', async () => {
    const pump = await note('Pump notes', 'The pump must deliver 40 litres a minute.');
    const id = await drafted(ada, { sourceIds: [pump] });
    const file = await ada.raw('GET', `/reports/${id}/versions/1/markdown`);
    assert.equal(file.status, 200, file.text);
    assert.match(file.headers.get('content-type') ?? '', /^text\/markdown/);
    assert.equal(file.headers.get('content-disposition'), 'attachment; filename="pump-specification-v1.md"');
    assert.match(file.text, /^> AI draft — not approved\n\n# Pump specification\n/);
    assert.equal((await ben.raw('GET', `/reports/${id}/versions/1/markdown`)).status, 404);
    assert.equal((await ada.raw('GET', `/reports/${id}/versions/2/markdown`)).status, 404);
    const one = await ada.request('GET', `/reports/${id}/versions/1`);
    assert.equal(one.status, 200);
    assert.match(one.body.body, /^# Pump specification/);
  });

  test('Audit grant holder cannot request (403)', async () => {
    await note('Pump notes', 'The pump must deliver 40 litres a minute.');
    const r = await request(auditor, { kind: 'status' });
    assert.equal(r.status, 403);
    assert.equal(r.body.message, 'Audit and Oversight access is read-only.');
    assert.equal((await t.signIn('admin@example.org').then((c) => request(c, { kind: 'status' }))).status, 404);
  });

  test('one bad citation fails the whole draft, no version saved', async () => {
    const pump = await note('Pump notes', 'The pump must deliver 40 litres a minute.');
    const r = await request(ada, { kind: 'specification', chosen: { sourceIds: [pump] } });
    assert.equal(r.status, 201);
    // Every section cites P1 except one, which cites P9 (never sent).
    assert.equal(await run(lastRequest(), new ReportModel(['P1', 'P1', 'P9']), true), 'failed');
    const req = (await t.pool.query(`SELECT status, failure_code FROM ai_requests WHERE id = $1`, [lastRequest()])).rows[0];
    assert.deepEqual(req, { status: 'failed', failure_code: 'bad_response' });
    assert.equal(await count(`SELECT count(*) AS n FROM report_draft_versions`), 0, 'nothing partial is saved');
    assert.equal(await count(`SELECT count(*) AS n FROM ai_request_material WHERE request_id = $1 AND cited`, [lastRequest()]), 0);
    const v = (await view(ada, r.body.id)).body;
    assert.equal(v.status, 'failed');
    assert.equal(v.notice, 'AI draft unavailable: the AI draft did not match its sources, so nothing was kept');
    assert.equal(v.current, null);
    assert.equal(v.canShare, false);
  });

  test('hiding a message used by a private draft withdraws it', async () => {
    const msg = await post(ben, 'The pump must deliver 40 litres a minute.');
    const id = await drafted(ada, { threadIds: [thread] }, 'free_form');
    assert.equal((await view(ada, id)).status, 200);
    assert.equal((await pm.request('POST', `/messages/${msg}/hide`, { reason: 'Posted in error' })).status, 200);
    assert.equal((await view(ada, id)).status, 404, 'gone for the requester');
    assert.deepEqual(await listed(ada), []);
    assert.equal((await ada.raw('GET', `/reports/${id}/versions/1/markdown`)).status, 404);
    assert.deepEqual((await pm.request('GET', `/projects/${project}/assist-review`)).body.items, [], 'nobody reviews a private draft');
    const row = (await t.pool.query(`SELECT review_state, review_reason FROM report_drafts WHERE id = $1`, [id])).rows[0];
    assert.deepEqual(row, { review_state: 'withdrawn', review_reason: 'material_removed' });
  });

  test('hiding a message used by a shared draft sends it to review', async () => {
    const msg = await post(ben, 'The pump must deliver 40 litres a minute.');
    const id = await drafted(ada, { threadIds: [thread] }, 'free_form');
    assert.equal((await ada.request('POST', `/reports/${id}/share`)).status, 200);
    assert.equal((await view(ben, id)).status, 200);
    assert.equal((await pm.request('POST', `/messages/${msg}/hide`, { reason: 'Posted in error' })).status, 200);
    assert.equal((await view(ben, id)).status, 404, 'hidden from members');
    assert.equal((await view(ada, id)).status, 404, 'and from the requester, who does not review');
    assert.deepEqual(await listed(ben), []);
    const items = (await pm.request('GET', `/projects/${project}/assist-review`)).body.items;
    assert.deepEqual(items.map((i: { kind: string; id: string; title: string }) => [i.kind, i.id, i.title]), [['draft', id, 'Pump specification']]);
    const forPm = await view(pm, id);
    assert.equal(forPm.status, 200);
    assert.equal(forPm.body.inReview, true);
    assert.equal(forPm.body.current, null, 'the PM cannot read the hidden message either');
    // A member who cannot see the draft finds nothing (404), not a refusal (403).
    assert.equal((await ben.request('POST', `/assist-review/draft/${id}/clear`, { reason: 'Fine' })).status, 404);
    assert.equal((await pm.request('PUT', `/reports/${id}`, { body: 'Edit.', basedOnVersion: 1 })).status, 409, 'not edited while in review');
    assert.equal((await pm.request('POST', `/assist-review/draft/${id}/withdraw`, { reason: 'Built on a hidden message' })).status, 200);
    // Withdrawn: 404 for everyone, before any 403.
    assert.equal((await ben.request('POST', `/assist-review/draft/${id}/clear`, { reason: 'Fine' })).status, 404);
    assert.equal((await pm.request('POST', `/assist-review/draft/${id}/clear`, { reason: 'Fine' })).status, 404);
    assert.equal((await view(pm, id)).status, 404);
  });

  test('a draft request still queued when its material is hidden is withdrawn and never runs', async () => {
    const msg = await post(ben, 'The pump must deliver 40 litres a minute.');
    const r = await request(ada, { kind: 'free_form', title: 'Pump plan', brief: 'Write up the pump plan.', chosen: { threadIds: [thread] } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const pending = lastRequest();
    assert.equal((await pm.request('POST', `/messages/${msg}/hide`, { reason: 'Posted in error' })).status, 200);
    assert.equal((await t.pool.query(`SELECT review_state FROM report_drafts WHERE id = $1`, [r.body.id])).rows[0].review_state, 'withdrawn');
    assert.equal((await view(ada, r.body.id)).status, 404);
    const model = new ReportModel();
    assert.equal(await run(pending, model), 'blocked');
    assert.equal(model.calls.length, 0, 'no AI call');
    assert.equal((await t.pool.query(`SELECT failure_code FROM ai_requests WHERE id = $1`, [pending])).rows[0].failure_code, 'material_removed');
    assert.equal(await count(`SELECT count(*) AS n FROM ai_spend_entries WHERE request_id = $1`, [pending]), 0, 'no spend');
    assert.equal(await count(`SELECT count(*) AS n FROM report_draft_versions WHERE draft_id = $1`, [r.body.id]), 0);
  });

  test('a regenerate still queued on a shared draft sends it to review when its material is hidden', async () => {
    const pump = await note('Pump notes', 'The pump must deliver 40 litres a minute.');
    // The first version is built from the note alone: the thread has no messages yet.
    const id = await drafted(ada, { sourceIds: [pump], threadIds: [thread] }, 'free_form');
    assert.equal((await ada.request('POST', `/reports/${id}/share`)).status, 200);
    const msg = await post(ben, 'The pump must run on single-phase power.');
    assert.equal((await ada.request('POST', `/reports/${id}/regenerate`)).status, 201);
    const pending = lastRequest();
    assert.equal(await count(`SELECT count(*) AS n FROM ai_request_material m JOIN passages p ON p.id = m.passage_id WHERE m.request_id = $1 AND p.owner_kind = 'message_version'`, [pending]), 1);
    // No version of the draft used the message: only the pending request links it to the draft.
    assert.equal((await pm.request('POST', `/messages/${msg}/hide`, { reason: 'Posted in error' })).status, 200);
    assert.equal((await t.pool.query(`SELECT review_state FROM report_drafts WHERE id = $1`, [id])).rows[0].review_state, 'review_required');
    const model = new ReportModel();
    assert.equal(await run(pending, model), 'blocked');
    assert.equal(model.calls.length, 0);
    assert.equal(await count(`SELECT count(*) AS n FROM ai_spend_entries WHERE request_id = $1`, [pending]), 0, 'no spend');
    assert.equal(await count(`SELECT count(*) AS n FROM report_draft_versions WHERE draft_id = $1`, [id]), 1, 'no new version');
  });

  test('feedback on a report version follows the draft', async () => {
    const pump = await note('Pump notes', 'The pump must deliver 40 litres a minute.');
    const id = await drafted(ada, { sourceIds: [pump] });
    const v1 = (await view(ada, id)).body.current.id as string;
    const flag = (c: Client, targetId: string) =>
      c.request('POST', `/projects/${project}/feedback`, { targetKind: 'report_version', targetId, category: 'incorrect', note: 'The flow rate is wrong.' });
    assert.equal((await flag(ben, v1)).status, 404, 'private draft');
    const r = await flag(ada, v1);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const edited = await ada.request('PUT', `/reports/${id}`, { body: 'Hand edit.', basedOnVersion: 1 });
    assert.equal((await flag(ada, edited.body.current.id)).status, 400, 'a human version is not AI output');
    assert.equal((await flag(ada, uuidv7())).status, 404);
    const escalated = await pm.request('POST', `/feedback/${r.body.id}/escalate`, { note: 'Please check the draft.' });
    assert.equal(escalated.status, 200, JSON.stringify(escalated.body));
    const admin = await t.signIn('admin@example.org');
    const rows = (await admin.request('GET', '/admin/feedback')).body.feedback;
    assert.deepEqual(rows.map((f: { runRef: string; model: string }) => [f.runRef, f.model]), [[queued[0], MVP_SPEND_SETTINGS.modelId]]);
  });
});
