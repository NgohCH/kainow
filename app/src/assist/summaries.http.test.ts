import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { findCredentials } from '../extraction/credentials';
import type { JsonSchemaModel, ModelRequest } from '../extraction/model';
import { ProjectAccess } from '../projects/access.service';
import type { Usage } from '../spend/cost';
import { MVP_SPEND_SETTINGS } from '../spend/mvp-settings';
import { SpendService } from '../spend/spend.service';
import { SpendSettingsService } from '../spend/spend.settings';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedProject, seedUser } from '../testing/projects';
import { uuidv7 } from '../common/uuid7';
import { AssistRunner } from './assist-runner';
import { findMaterial } from './material';

const USAGE: Usage = { inputTokens: 2_000, cachedInputTokens: 0, outputTokens: 300 };
const STALE = 'Someone changed this since you opened it';
const DRAFT_LABEL = 'AI draft — not approved for sharing';
const MARKS_OPEN = 'Every marked phrase or name must be removed by editing or ticked Intended before this version can be approved.';

const ORIGINAL =
  'Confidential board note. The turbine replacement goes ahead next month. Acme Supplies quoted 40,000 and were late again.\n\n' +
  'Ada Lim raised a concern about the Project Nightjar timeline.';
/** The AI's summary: one leave-out phrase and one member name in it, so both get marked. */
const SUMMARY = 'The turbine replacement goes ahead next month.\n\nAcme  supplies will be asked again. Ada Lim follows up.';

class SummaryModel implements JsonSchemaModel {
  calls: ModelRequest[] = [];
  constructor(private readonly body = SUMMARY) {}
  async callJson(req: ModelRequest): Promise<{ content: unknown; usage: Usage }> {
    this.calls.push(req);
    return { content: JSON.stringify({ summary_markdown: this.body, omitted_categories: ['prices', 'Leave out list'] }), usage: USAGE };
  }
}

describe('shareable summaries', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  const ids: Record<string, string> = {};
  let project: string;
  let pm: Client;
  let dep: Client;
  let spo: Client;
  let ada: Client;
  let ben: Client;
  let queued: string[];

  const run = (id: string, model: JsonSchemaModel = new SummaryModel()) =>
    new AssistRunner({ pool: t.pool, spend: new SpendService(t.pool, t.clock.now), model, clock: t.clock.now }).process(id, 1, false);
  const lastRequest = () => queued[queued.length - 1];
  const note = async (title: string, text: string) => {
    const r = await pm.request('POST', `/projects/${project}/notes`, { title, text });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.source.id as string;
  };
  const restrict = async (sourceId: string, namedUserIds: string[]) => {
    const audienceId = (await t.pool.query(`SELECT audience_id FROM sources WHERE id = $1`, [sourceId])).rows[0].audience_id;
    const r = await pm.request('PUT', `/audiences/${audienceId}`, { mode: 'restricted', namedUserIds, reason: 'Board only' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  };
  /** A Restricted board note (Ada named), as the original. */
  const boardNote = async () => {
    const id = await note('Board note', ORIGINAL);
    await restrict(id, [ids.ada]);
    return id;
  };
  const ask = (c: Client, sourceId: string, body: Record<string, unknown> = { intendedAudience: { mode: 'project' }, leaveOut: 'Acme Supplies\nProject Nightjar, 40,000' }) =>
    c.request('POST', `/sources/${sourceId}/summaries`, body);
  /** Requested by `c` and drafted by the AI. */
  const drafted = async (c: Client, sourceId: string, model = new SummaryModel()) => {
    const r = await ask(c, sourceId);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(await run(lastRequest(), model), 'succeeded');
    t.clock.advanceSeconds(1);
    return r.body.id as string;
  };
  const view = (c: Client, id: string) => c.request('GET', `/summaries/${id}`);
  const tickAll = async (c: Client, id: string) => {
    const v = (await view(c, id)).body;
    for (const m of v.current.marks) {
      const r = await c.request('POST', `/summaries/${id}/marks/${m.id}/intended`, { versionNo: v.current.no });
      assert.equal(r.status, 200, JSON.stringify(r.body));
    }
    return v.current.no as number;
  };
  /** Drafted, every mark ticked, approved by the PM: returns the summary and its source. */
  const approved = async () => {
    const original = await boardNote();
    const id = await drafted(dep, original);
    const no = await tickAll(pm, id);
    const r = await pm.request('POST', `/summaries/${id}/approve`, { versionNo: no, reason: 'Fine to share with the team' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return { original, id, sourceId: r.body.approved.sourceId as string, approval: r.body };
  };

  beforeEach(async () => {
    queued = [];
    t = await startTestApp(undefined, { assistQueue: { enqueue: async (id: string) => void queued.push(id) } });
    for (const k of ['pm', 'dep', 'spo', 'ada', 'ben']) ids[k] = await seedUser(t.pool, `${k}@example.org`);
    ids.admin = await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    await t.pool.query(`UPDATE users SET display_name = 'Ada Lim' WHERE id = $1`, [ids.ada]);
    await t.pool.query(`UPDATE users SET display_name = 'Ben Tan' WHERE id = $1`, [ids.ben]);
    project = await seedProject(t.pool, {
      name: 'Alpha Project',
      status: 'active',
      members: [
        { userId: ids.pm, role: 'pm' },
        { userId: ids.pm, role: 'owner' },
        { userId: ids.dep, role: 'deputy_pm' },
        { userId: ids.spo, role: 'sponsor' },
        { userId: ids.ada, role: 'member' },
        { userId: ids.ben, role: 'member' },
      ],
    });
    await new SpendSettingsService(t.pool, t.clock.now).apply(MVP_SPEND_SETTINGS, ids.admin);
    [pm, dep, spo, ada, ben] = [
      await t.signIn('pm@example.org'),
      await t.signIn('dep@example.org'),
      await t.signIn('spo@example.org'),
      await t.signIn('ada@example.org'),
      await t.signIn('ben@example.org'),
    ];
  });
  afterEach(async () => {
    await t.close();
  });

  test('Deputy drafts; Deputy cannot approve (403)', async () => {
    const original = await boardNote();
    const r = await ask(dep, original);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.status, 'queued');
    assert.equal(r.body.label, DRAFT_LABEL);
    assert.equal(r.body.current, null);
    assert.deepEqual(r.body.original, { kind: 'source', id: original, title: 'Board note' });
    assert.ok(r.body.intendedAudience.covers.some((p: { displayName: string }) => p.displayName === 'Ben Tan'), 'shown with the people it covers');

    const model = new SummaryModel();
    assert.equal(await run(lastRequest(), model), 'succeeded');
    t.clock.advanceSeconds(1);
    // The Leave out text is instruction in the system part; the original's text is the user part, alone.
    assert.match(model.calls[0].system, /Acme Supplies\nProject Nightjar, 40,000$/);
    assert.match(model.calls[0].system, /The summary is for: everyone on the project\./);
    assert.equal(model.calls[0].user, ORIGINAL);
    const spend = (await t.pool.query(`SELECT purpose, actor_user_id FROM ai_spend_entries`)).rows;
    assert.deepEqual(spend.map((s) => [s.purpose, s.actor_user_id]), [['summary_draft', ids.dep]]);

    const v = (await view(dep, r.body.id)).body;
    assert.equal(v.status, 'ready');
    assert.equal(v.current.body, SUMMARY.trim());
    assert.equal(v.current.label, DRAFT_LABEL);
    assert.deepEqual(v.current.omittedCategories, ['prices', 'Leave out list']);
    assert.equal(v.canApprove, false, 'a Deputy never approves');
    assert.equal(v.approval, null);

    const denied = await dep.request('POST', `/summaries/${r.body.id}/approve`, { versionNo: 1, reason: 'Looks fine' });
    assert.equal(denied.status, 403);

    // Ask for approval: PM/Owner and the Sponsor are told, title only, in-app only.
    const asked = await dep.request('POST', `/summaries/${r.body.id}/ask-approval`, { versionNo: 1 });
    assert.equal(asked.status, 200, JSON.stringify(asked.body));
    assert.equal(asked.body.notified, 2);
    assert.equal(asked.body.current.approvalRequested, true);
    const notes = (await t.pool.query(`SELECT user_id, summary, link, email_off FROM notifications WHERE kind = 'summary_approval_requested' ORDER BY user_id`)).rows;
    assert.deepEqual(notes.map((n) => n.user_id).sort(), [ids.pm, ids.spo].sort());
    assert.ok(notes.every((n) => n.summary === 'Shareable summary waiting for approval: Board note' && n.link === `#/summaries/${r.body.id}` && n.email_off));
    const actions = (await t.pool.query(`SELECT action FROM ai_assist_events WHERE target_id = $1 ORDER BY at, id`, [r.body.id])).rows.map((e) => e.action);
    assert.deepEqual(actions, ['summary_requested', 'summary_approval_requested']);
    const review = await pm.request('GET', `/projects/${project}/summaries-to-review`);
    assert.equal(review.status, 200);
    assert.deepEqual(review.body.items.map((i: { id: string; approvalRequested: boolean }) => [i.id, i.approvalRequested]), [[r.body.id, true]]);
    assert.equal((await dep.request('GET', `/projects/${project}/summaries-to-review`)).status, 403);
  });

  test('Member cannot draft (403)', async () => {
    const original = await boardNote();
    // Ada is named in the original's audience, so she sees it; she may not request a summary.
    assert.equal((await ask(ada, original)).status, 403);
    // Ben is outside the audience: the original does not exist for him.
    assert.equal((await ask(ben, original)).status, 404);
    assert.equal(Number((await t.pool.query(`SELECT count(*) AS n FROM summaries`)).rows[0].n), 0);
  });

  test('a credential in Leave out is refused and nothing is stored', async () => {
    const original = await boardNote();
    const leaveOut = 'Acme Supplies\npassword: hunter2hunter2';
    const kinds = findCredentials(leaveOut).map((f) => f.pattern).join(', ');
    assert.notEqual(kinds, '');
    const r = await ask(pm, original, { intendedAudience: { mode: 'project' }, leaveOut });
    assert.equal(r.status, 400);
    assert.equal(r.body.message, `Not posted: this looks like it contains ${kinds}. Remove it and post again.`);
    for (const table of ['summaries', 'ai_requests', 'ai_assist_events']) {
      assert.equal(Number((await t.pool.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n), 0, table);
    }
    assert.equal(queued.length, 0);
  });

  test('the Ask panel finds an approved summary only for its audience', async () => {
    const personal = async (userId: string) => ({
      kind: 'personal' as const,
      ctx: (await t.app.get(ProjectAccess).load(project, { id: userId, email: 'x@example.org', displayName: 'x', role: 'member' }))!,
    });
    /** The sources of the passages found for "turbine". */
    const found = async (userId: string) => {
      const items = await findMaterial(t.pool, await personal(userId), ['turbine']);
      const passageIds = items.map((i) => i.passageId).filter((x): x is string => x !== null);
      return (
        await t.pool.query(`SELECT DISTINCT v.source_id AS id FROM passages p JOIN source_versions v ON v.id = p.owner_id WHERE p.id = ANY($1::uuid[])`, [passageIds])
      ).rows.map((x) => x.id as string);
    };
    // One summary for the managers and Ada only, one for the whole project.
    const managers = await boardNote();
    const narrow = await ask(dep, managers, { intendedAudience: { mode: 'restricted', namedUserIds: [] }, leaveOut: '' });
    assert.equal(narrow.status, 201, JSON.stringify(narrow.body));
    assert.equal(await run(lastRequest(), new SummaryModel('The turbine is narrow news.')), 'succeeded');
    t.clock.advanceSeconds(1);
    // The Deputy is in the original's audience, so the draft is visible to him: still only the original is material.
    assert.deepEqual(await found(ids.dep), [managers], 'a draft is not material');
    let a = await pm.request('POST', `/summaries/${narrow.body.id}/approve`, { versionNo: 1, reason: 'Managers only' });
    assert.equal(a.status, 200, JSON.stringify(a.body));
    const narrowSource = a.body.approved.sourceId as string;
    assert.deepEqual(await found(ids.ben), [], 'outside its audience');
    assert.ok((await found(ids.dep)).includes(narrowSource));

    const wide = await ask(dep, managers, { intendedAudience: { mode: 'project' }, leaveOut: '' });
    assert.equal(wide.status, 201);
    assert.equal(await run(lastRequest(), new SummaryModel('The turbine is wide news.')), 'succeeded');
    t.clock.advanceSeconds(1);
    a = await pm.request('POST', `/summaries/${wide.body.id}/approve`, { versionNo: 1, reason: 'Everyone' });
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.deepEqual(await found(ids.ben), [a.body.approved.sourceId], 'only the Project-wide summary, never the original');
  });

  test('a summary of a deleted original is blocked before any AI call', async () => {
    const original = await boardNote();
    const r = await ask(dep, original);
    assert.equal(r.status, 201);
    await t.pool.query(`UPDATE sources SET status = 'deleted' WHERE id = $1`, [original]);
    const model = new SummaryModel();
    assert.equal(await run(lastRequest(), model), 'blocked');
    assert.equal(model.calls.length, 0);
    const req = (await t.pool.query(`SELECT failure_code FROM ai_requests WHERE id = $1`, [lastRequest()])).rows[0];
    assert.equal(req.failure_code, 'original_removed');
    assert.equal(Number((await t.pool.query(`SELECT count(*) AS n FROM ai_spend_entries`)).rows[0].n), 0);
  });

  test('a requester whose Deputy role ended while the request waited is blocked before any AI call', async () => {
    // The Deputy is also a Member and named in the original's audience, so only the request right is lost.
    await t.pool.query(`INSERT INTO memberships (id, project_id, user_id, role, starts_on) VALUES ($1, $2, $3, 'member', '2026-11-01')`, [uuidv7(), project, ids.dep]);
    const original = await note('Board note', ORIGINAL);
    await restrict(original, [ids.ada, ids.dep]);
    const r = await ask(dep, original);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    await t.pool.query(
      `UPDATE memberships SET expires_on = ($3::timestamptz AT TIME ZONE 'Asia/Kuala_Lumpur')::date WHERE project_id = $1 AND user_id = $2 AND role = 'deputy_pm'`,
      [project, ids.dep, t.clock.now()],
    );
    t.clock.advanceMinutes(24 * 60);
    const model = new SummaryModel();
    assert.equal(await run(lastRequest(), model), 'blocked');
    assert.equal(model.calls.length, 0);
    const req = (await t.pool.query(`SELECT failure_code FROM ai_requests WHERE id = $1`, [lastRequest()])).rows[0];
    assert.equal(req.failure_code, 'requester_cannot_request');
    assert.equal(Number((await t.pool.query(`SELECT count(*) AS n FROM ai_spend_entries`)).rows[0].n), 0);
  });

  test('summary of a Project-wide source refused', async () => {
    const open = await note('Open note', ORIGINAL);
    const r = await ask(pm, open);
    assert.equal(r.status, 409);
    assert.match(r.body.message, /Only a Restricted source or meeting/);
    // Nor can an approved summary itself be summarised.
    const { sourceId } = await approved();
    await restrict(sourceId, [ids.ada]);
    const again = await ask(pm, sourceId);
    assert.equal(again.status, 409);
    assert.equal(again.body.message, 'A shareable summary cannot itself be summarised.');
  });

  test('approve blocked while a mark is open', async () => {
    const original = await boardNote();
    const id = await drafted(dep, original);
    const v = (await view(pm, id)).body;
    assert.deepEqual(
      v.current.marks.map((m: { kind: string; phrase: string; places: { start: number; end: number }[] }) => [m.kind, m.phrase, m.places.map((p) => v.current.body.slice(p.start, p.end))]),
      [
        ['leave_out', 'Acme Supplies', ['Acme  supplies']],
        ['name', 'Ada Lim', ['Ada Lim']],
      ],
    );
    assert.equal(v.current.openMarks, 2);
    assert.equal(v.canApprove, false);
    assert.deepEqual(v.approval.gainAccess.map((p: { displayName: string }) => p.displayName), ['Ben Tan'], 'exactly who gains access');

    let r = await pm.request('POST', `/summaries/${id}/approve`, { versionNo: 1, reason: 'Share it' });
    assert.equal(r.status, 409);
    assert.equal(r.body.message, MARKS_OPEN);
    // One mark ticked Intended: still blocked.
    const name = v.current.marks.find((m: { kind: string }) => m.kind === 'name');
    r = await pm.request('POST', `/summaries/${id}/marks/${name.id}/intended`, { versionNo: 1 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.current.openMarks, 1);
    assert.equal((await pm.request('POST', `/summaries/${id}/marks/${name.id}/intended`, { versionNo: 1 })).status, 409);
    assert.equal((await pm.request('POST', `/summaries/${id}/approve`, { versionNo: 1, reason: 'Share it' })).status, 409);

    // A tick names the version it was seen on: required, and refused once a newer version exists.
    const leave = v.current.marks.find((m: { kind: string }) => m.kind === 'leave_out');
    assert.equal((await pm.request('POST', `/summaries/${id}/marks/${leave.id}/intended`, {})).status, 400);
    assert.ok(!/acme|ada|lim/i.test(leave.id), 'mark ids are opaque');
    // Editing the phrase away: the new version's marks are found again (the name is marked again, not yet ticked).
    r = await dep.request('PUT', `/summaries/${id}`, { body: 'The turbine replacement goes ahead next month. Ada Lim follows up.', basedOnVersion: 1 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.current.no, 2);
    assert.match(r.body.current.editedByLabel, /^Edited by /);
    assert.deepEqual(r.body.current.marks.map((m: { kind: string; intended: boolean }) => [m.kind, m.intended]), [['name', false]]);
    const staleTick = await pm.request('POST', `/summaries/${id}/marks/${leave.id}/intended`, { versionNo: 1 });
    assert.equal(staleTick.status, 409);
    assert.equal(staleTick.body.message, STALE);
    // A stale version is refused with the summary as it is now.
    const stale = await pm.request('POST', `/summaries/${id}/approve`, { versionNo: 1, reason: 'Share it' });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.message, STALE);
    assert.equal(stale.body.current.current.no, 2);
    // Secret check on edits.
    const secret = await dep.request('PUT', `/summaries/${id}`, { body: 'password: hunter2hunter2', basedOnVersion: 2 });
    assert.equal(secret.status, 400);
    assert.match(secret.body.message, /^Not posted: this looks like it contains /);
    assert.equal(Number((await t.pool.query(`SELECT count(*) AS n FROM summaries s JOIN sources src ON src.summary_id = s.id`)).rows[0].n), 0);
  });

  test('approve after marking intended creates a summary source visible Project-wide', async () => {
    const original = await boardNote();
    const id = await drafted(dep, original);
    const no = await tickAll(dep, id);
    assert.equal((await pm.request('POST', `/summaries/${id}/approve`, { versionNo: no })).status, 400, 'a reason is required');
    const r = await spo.request('POST', `/summaries/${id}/approve`, { versionNo: no, reason: 'Fine to share with the team' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.gainedAccess.map((p: { displayName: string }) => p.displayName), ['Ben Tan']);
    assert.equal(r.body.state, 'approved');
    assert.equal(r.body.label, 'Summary approved for sharing');
    assert.equal(r.body.approved.versionNo, 1);
    const sourceId = r.body.approved.sourceId as string;

    const src = (
      await t.pool.query(
        `SELECT s.kind, s.publication, s.summary_id, a.mode, v.origin, v.text_content, v.created_by
           FROM sources s JOIN audiences a ON a.id = s.audience_id JOIN source_versions v ON v.source_id = s.id WHERE s.id = $1`,
        [sourceId],
      )
    ).rows;
    assert.deepEqual(src, [{ kind: 'summary', publication: 'published', summary_id: id, mode: 'project', origin: 'summary', text_content: SUMMARY.trim(), created_by: ids.spo }]);
    const passages = Number((await t.pool.query(`SELECT count(*) AS n FROM passages p JOIN source_versions v ON v.id = p.owner_id WHERE v.source_id = $1`, [sourceId])).rows[0].n);
    assert.ok(passages > 0, 'its passages are indexed');
    const event = (await t.pool.query(`SELECT reason, detail FROM ai_assist_events WHERE target_id = $1 AND action = 'summary_approved'`, [id])).rows[0];
    assert.equal(event.reason, 'Fine to share with the team');
    assert.equal(event.detail.sourceId, sourceId);

    const listed = (await ben.request('GET', `/projects/${project}/notes`)).body.sources;
    assert.deepEqual(listed.map((s: { id: string; kind: string; label: string }) => [s.id, s.kind, s.label]), [[sourceId, 'summary', 'Shareable summary']]);

    // A later approved version becomes a new version of the same source.
    const edited = await pm.request('PUT', `/summaries/${id}`, { body: 'The turbine replacement goes ahead in December.', basedOnVersion: 1 });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(edited.body.current.label, DRAFT_LABEL);
    assert.equal(edited.body.current.openMarks, 0);
    const again = await pm.request('POST', `/summaries/${id}/approve`, { versionNo: 2, reason: 'Updated date' });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.approved.sourceId, sourceId);
    const versions = (await t.pool.query(`SELECT version_no, origin FROM source_versions WHERE source_id = $1 ORDER BY version_no`, [sourceId])).rows;
    assert.deepEqual(versions, [{ version_no: 1, origin: 'summary' }, { version_no: 2, origin: 'summary' }]);
    // Edited and edited back to the approved wording: approving it again adds no source version and does not fail.
    assert.equal((await pm.request('PUT', `/summaries/${id}`, { body: 'Something else.', basedOnVersion: 2 })).status, 200);
    assert.equal((await pm.request('PUT', `/summaries/${id}`, { body: 'The turbine replacement goes ahead in December.', basedOnVersion: 3 })).status, 200);
    const same = await pm.request('POST', `/summaries/${id}/approve`, { versionNo: 4, reason: 'Same wording' });
    assert.equal(same.status, 200, JSON.stringify(same.body));
    assert.equal(same.body.approved.versionNo, 4);
    assert.equal(Number((await t.pool.query(`SELECT count(*) AS n FROM source_versions WHERE source_id = $1`, [sourceId])).rows[0].n), 2);
  });

  test('outsider sees Summary approved for sharing and From a restricted source, no link to the original', async () => {
    const { original, id, sourceId } = await approved();
    const r = await ben.request('GET', `/notes/${sourceId}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.source.label, 'Shareable summary');
    const pmName = (await t.pool.query(`SELECT display_name FROM users WHERE id = $1`, [ids.pm])).rows[0].display_name;
    assert.deepEqual(r.body.source.summary, { label: 'Summary approved for sharing', approved: `Approved by ${pmName} on 9 Nov 2026`, from: 'From a restricted source' });
    const text = JSON.stringify(r.body) + JSON.stringify((await ben.request('GET', `/notes/${sourceId}/versions/1`)).body);
    assert.ok(!text.includes(original), 'no link to the original');
    assert.ok(!text.includes('Board note'), 'no title of the original');
    assert.ok(!text.includes(id), 'no link to the draft');
    // The wider audience reads the approved summary only; the draft and its versions stay with the original's audience.
    const shared = await view(ben, id);
    assert.equal(shared.status, 200, JSON.stringify(shared.body));
    assert.deepEqual(Object.keys(shared.body).sort(), ['approved', 'body', 'from', 'id', 'label', 'projectId', 'sourceId', 'view']);
    assert.equal(shared.body.view, 'shared');
    assert.equal(shared.body.approved, `Approved by ${pmName} on 9 Nov 2026`);
    assert.equal((await ben.request('GET', `/summaries/${id}/versions/1`)).status, 404);
    const versionId = (await view(pm, id)).body.current.id;
    const flag = (c: Client) => c.request('POST', `/projects/${project}/feedback`, { targetKind: 'summary_version', targetId: versionId, category: 'incorrect', note: 'Wrong date.' });
    assert.equal((await flag(ben)).status, 404);
    assert.equal((await flag(ada)).status, 201, 'someone in the original audience may flag the AI version');
  });

  test('re-approval shows who gains access against the summary source as it is now, not the intended audience', async () => {
    const { id, sourceId } = await approved();
    t.clock.advanceSeconds(1);
    // The PM narrows the published summary to the managers only: Ben no longer reads it.
    const audienceId = (await t.pool.query(`SELECT audience_id FROM sources WHERE id = $1`, [sourceId])).rows[0].audience_id;
    const narrowed = await pm.request('PUT', `/audiences/${audienceId}`, { mode: 'restricted', namedUserIds: [], reason: 'Managers only' });
    assert.equal(narrowed.status, 200, JSON.stringify(narrowed.body));
    t.clock.advanceSeconds(1);
    const edited = await dep.request('PUT', `/summaries/${id}`, { body: 'The turbine replacement goes ahead next month.', basedOnVersion: 1 });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    t.clock.advanceSeconds(1);
    const v = (await view(pm, id)).body;
    assert.deepEqual(v.approval.gainAccess, [], 'nobody outside the original reads the summary source now');
    assert.equal(v.approval.audience, 'restricted');
    const r = await pm.request('POST', `/summaries/${id}/approve`, { versionNo: v.current.no, reason: 'Updated wording' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.gainedAccess, []);
    const event = (await t.pool.query(`SELECT detail FROM ai_assist_events WHERE target_id = $1 AND action = 'summary_approved' ORDER BY at DESC LIMIT 1`, [id])).rows[0];
    assert.deepEqual([event.detail.audience, event.detail.gained], ['restricted', 0]);
  });

  test('original stays 404 to the outsider', async () => {
    const { original } = await approved();
    assert.equal((await ben.request('GET', `/notes/${original}`)).status, 404);
    assert.equal((await ben.request('GET', `/notes/${original}/versions/1`)).status, 404);
    assert.equal((await ada.request('GET', `/notes/${original}`)).status, 200);
  });

  test('extraction refused on a summary source', async () => {
    const { sourceId } = await approved();
    const r = await pm.request('POST', `/notes/${sourceId}/versions/1/extractions`);
    assert.equal(r.status, 409);
    assert.match(r.body.message, /never used as evidence/);
    assert.equal(Number((await t.pool.query(`SELECT count(*) AS n FROM extraction_runs`)).rows[0].n), 0);
    assert.equal((await pm.request('GET', `/notes/${sourceId}`)).body.source.mayExtract, false);
    assert.equal((await pm.request('POST', `/notes/${sourceId}/versions`, { text: 'Changed by hand' })).status, 409);
  });

  test('summary appears in search for its audience', async () => {
    const original = await boardNote();
    const search = async (c: Client) =>
      ((await c.request('GET', `/search?q=turbine&project=${project}`)).body.projects[0]?.results ?? []).map((x: { id: string; kind: string }) => [x.kind, x.id]);
    const id = await drafted(dep, original);
    assert.deepEqual(await search(ben), [], 'a draft is never found');
    const no = await tickAll(pm, id);
    const r = await pm.request('POST', `/summaries/${id}/approve`, { versionNo: no, reason: 'Share it' });
    assert.equal(r.status, 200);
    assert.deepEqual(await search(ben), [['note', r.body.approved.sourceId]]);
    assert.deepEqual((await search(ada)).map((x: string[]) => x[1]).sort(), [original, r.body.approved.sourceId].sort());
  });

  test('leave-out text never shown to the wider audience', async () => {
    const { sourceId, id } = await approved();
    const seen = [
      await ben.request('GET', `/projects/${project}/notes`),
      await ben.request('GET', `/notes/${sourceId}`),
      await ben.request('GET', `/notes/${sourceId}/versions/1`),
      await ben.request('GET', `/search?q=turbine&project=${project}`),
      await ben.request('GET', `/search?q=nightjar&project=${project}`),
      await ben.request('GET', `/summaries/${id}`),
    ];
    for (const r of seen) {
      const text = JSON.stringify(r.body);
      assert.ok(!/Nightjar/i.test(text) && !text.includes('Leave out list') && !text.includes('omitted'), text);
    }
    // Never in event rows or the audit trail either: lengths and a hash only.
    const rows = JSON.stringify((await t.pool.query(`SELECT detail, reason FROM ai_assist_events`)).rows) + JSON.stringify((await t.pool.query(`SELECT detail FROM audit_events`)).rows);
    assert.ok(!/Nightjar|Acme Supplies/i.test(rows));
    // The original's audience sees it on the draft.
    assert.equal((await view(pm, id)).body.leaveOut, 'Acme Supplies\nProject Nightjar, 40,000');
  });

  test('input over 120,000 characters refused', async () => {
    const long = await note('Long board pack', `${'The turbine plan in detail. '.repeat(4_300)}`.slice(0, 120_001));
    await restrict(long, [ids.ada]);
    const r = await ask(pm, long);
    assert.equal(r.status, 400);
    assert.equal(r.body.message, 'This source is too long to summarise in one request.');
    assert.equal(Number((await t.pool.query(`SELECT count(*) AS n FROM ai_requests`)).rows[0].n), 0);
    assert.equal(queued.length, 0);
  });

  test('a Restricted meeting is summarised from its visible messages', async () => {
    const m = await pm.request('POST', `/projects/${project}/threads`, { kind: 'meeting', title: 'Board meeting', audience: { mode: 'restricted', namedUserIds: [ids.ada] } });
    assert.equal(m.status, 201, JSON.stringify(m.body));
    for (const body of ['The turbine goes ahead.', 'Acme Supplies were late.']) {
      const p = await ada.request('POST', `/threads/${m.body.id}/messages`, { body });
      assert.equal(p.status, 201, JSON.stringify(p.body));
    }
    assert.equal((await ben.request('POST', `/threads/${m.body.id}/summaries`, { intendedAudience: { mode: 'project' }, leaveOut: '' })).status, 404);
    const r = await dep.request('POST', `/threads/${m.body.id}/summaries`, { intendedAudience: { mode: 'restricted', namedUserIds: [ids.ben] }, leaveOut: '' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.original.kind, 'meeting');
    const model = new SummaryModel('The turbine goes ahead.');
    assert.equal(await run(lastRequest(), model), 'succeeded');
    assert.match(model.calls[0].user, /^\[#1 · Ada Lim · .+\]\nThe turbine goes ahead\.\n\n\[#2 · Ada Lim · .+\]\nAcme Supplies were late\.$/);
    assert.match(model.calls[0].system, /named participants: Ben Tan/);
    // A discussion is never summarised for sharing: only a meeting.
    const d = await pm.request('POST', `/projects/${project}/threads`, { kind: 'discussion', title: 'Plant' });
    const refused = await pm.request('POST', `/threads/${d.body.id}/summaries`, { intendedAudience: { mode: 'project' } });
    assert.equal(refused.status, 409);
    assert.match(refused.body.message, /^Only a meeting can have a shareable summary/);
  });
});
