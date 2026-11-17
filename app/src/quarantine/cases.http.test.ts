import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { AssistRunner } from '../assist/assist-runner';
import { findMaterial } from '../assist/material';
import { uuidv7 } from '../common/uuid7';
import { writeOutbox } from '../email/outbox';
import type { JsonSchemaModel, ModelRequest } from '../extraction/model';
import { ProjectAccess } from '../projects/access.service';
import type { Usage } from '../spend/cost';
import { MVP_SPEND_SETTINGS } from '../spend/mvp-settings';
import { SpendService } from '../spend/spend.service';
import { SpendSettingsService } from '../spend/spend.settings';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedProject, seedUser } from '../testing/projects';
import { CANCELLED_REASON, POSSIBLE_COPY_TEXT, cleanWaitingCases } from './cases.service';
import { MARKER } from './clean-text';
import { loadProtectedKey } from './protected-key';

const USAGE: Usage = { inputTokens: 2_000, cachedInputTokens: 0, outputTokens: 300 };
/** A secret the credential check does not know: only a person can mark it. */
const SECRET = 'Kp9vault-Rotor42';
const PLANT = `The kestrel pump service is booked for Thursday morning. The plant room vault code is ${SECRET} until March.`;
const NOTICE = (kind: string) => `A suspected ${kind} was reported in Alpha Project and held. If it is real, revoke or rotate it. Kainow cannot recall copies already sent.`;

/** Answers a question citing one marker. */
class AnswerModel implements JsonSchemaModel {
  constructor(private readonly marker: string) {}
  async callJson(_req: ModelRequest): Promise<{ content: unknown; usage: Usage }> {
    return { content: JSON.stringify({ answer_markdown: `The pump service is on Thursday [${this.marker}].`, not_found: false, cited: [this.marker] }), usage: USAGE };
  }
}

/** Drafts a summary with the given body. */
class SummaryModel implements JsonSchemaModel {
  constructor(private readonly body: string) {}
  async callJson(_req: ModelRequest): Promise<{ content: unknown; usage: Usage }> {
    return { content: JSON.stringify({ summary_markdown: this.body, omitted_categories: [] }), usage: USAGE };
  }
}

describe('reporting, holding and possible copies', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let dir: string;
  let keyFile: string;
  const ids: Record<string, string> = {};
  let project: string;
  let pm: Client;
  let dep: Client;
  let ada: Client;
  let ben: Client;
  let auditor: Client;
  let queued: string[];

  const count = async (sql: string, params: unknown[] = []) => Number((await t.pool.query(sql, params)).rows[0].n);
  const spend = () => new SpendService(t.pool, t.clock.now);

  async function boot(withKey: boolean): Promise<void> {
    queued = [];
    t = await startTestApp(undefined, { assistQueue: { enqueue: async (id: string) => void queued.push(id) }, ...(withKey ? { protectedKeyFile: keyFile } : {}) });
    for (const k of ['pm', 'own', 'spo', 'dep', 'ada', 'ben', 'auditor', 'kim']) ids[k] = await seedUser(t.pool, `${k}@example.org`);
    ids.admin = await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    ids.admin2 = await seedUser(t.pool, 'admin2@example.org', 'enterprise_administrator');
    project = await seedProject(t.pool, {
      name: 'Alpha Project',
      status: 'active',
      members: [
        { userId: ids.pm, role: 'pm' },
        { userId: ids.own, role: 'owner' },
        { userId: ids.spo, role: 'sponsor' },
        { userId: ids.dep, role: 'deputy_pm' },
        { userId: ids.ada, role: 'member' },
        { userId: ids.ben, role: 'member' },
      ],
    });
    await t.pool.query(
      `INSERT INTO access_grants (id, project_id, user_id, kind, purpose, scope, starts_on, expires_on, requested_by, requested_at, decision, decided_by, decided_at)
       VALUES ($1, $2, $3, 'audit', 'Annual audit', 'Everything', '2026-11-01', '2026-11-30', $4, now(), 'approved', $5, now())`,
      [uuidv7(), project, ids.auditor, ids.pm, ids.admin],
    );
    await new SpendSettingsService(t.pool, t.clock.now).apply(MVP_SPEND_SETTINGS, ids.admin);
    [pm, dep, ada, ben, auditor] = [
      await t.signIn('pm@example.org'),
      await t.signIn('dep@example.org'),
      await t.signIn('ada@example.org'),
      await t.signIn('ben@example.org'),
      await t.signIn('auditor@example.org'),
    ];
  }

  const note = async (title: string, text: string, c: Client = pm) => {
    const r = await c.request('POST', `/projects/${project}/notes`, { title, text });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.source.id as string;
  };
  const restrict = async (sourceId: string, namedUserIds: string[]) => {
    const audienceId = (await t.pool.query(`SELECT audience_id FROM sources WHERE id = $1`, [sourceId])).rows[0].audience_id;
    const r = await pm.request('PUT', `/audiences/${audienceId}`, { mode: 'restricted', namedUserIds, reason: 'Leaders only' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  };
  const startThread = async (c: Client, body: Record<string, unknown>) => {
    const r = await c.request('POST', `/projects/${project}/threads`, body);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.id as string;
  };
  const post = async (c: Client, thread: string, body: string) => {
    const r = await c.request('POST', `/threads/${thread}/messages`, { body });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.id as string;
  };
  const report = (c: Client, body: Record<string, unknown>) => c.request('POST', `/projects/${project}/secret-reports`, body);
  const reported = async (c: Client, kind: string, id: string, extra: Record<string, unknown> = {}) => {
    const r = await report(c, { kind, id, marked: [SECRET], reason: 'Looks like the plant room vault code', ...extra });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.ok(!JSON.stringify(r.body).includes(SECRET));
    t.clock.advanceSeconds(1);
    return r.body.caseId as string;
  };
  const answered = async (c: Client) => {
    const r = await c.request('POST', `/projects/${project}/questions`, { question: 'When is the kestrel pump service?' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const plant = (r.body.sources as Array<{ marker: string; location: string | null }>).find((s) => s.location?.startsWith('Plant room'));
    assert.ok(plant, JSON.stringify(r.body.sources));
    const runner = new AssistRunner({ pool: t.pool, spend: spend(), model: new AnswerModel(plant.marker), clock: t.clock.now });
    assert.equal(await runner.process(r.body.id, 1, false), 'succeeded');
    t.clock.advanceSeconds(1);
    return r.body.id as string;
  };
  const threadMessages = async (c: Client, thread: string) => {
    const r = await c.request('GET', `/threads/${thread}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.messages as Array<{ id: string; text: string | null; notice: string | null; quarantineLabel?: string | null }>;
  };
  /** Every stored row that must never hold the marked text, as JSON. */
  const leakScan = async () => {
    const out: string[] = [];
    for (const table of ['quarantine_events', 'audit_events', 'notifications', 'quarantine_cases', 'quarantine_possible_copies', 'quarantine_items']) {
      out.push(JSON.stringify((await t.pool.query(`SELECT * FROM ${table}`)).rows));
    }
    out.push(JSON.stringify((await t.pool.query(`SELECT * FROM email_outbox WHERE kind <> 'digest'`)).rows));
    return out.join('\n');
  };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'kainow-cases-'));
    keyFile = join(dir, 'p.key');
    writeFileSync(keyFile, randomBytes(32));
    await boot(true);
  });
  afterEach(async () => {
    await t?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('a Member reports a secret in notes; the notes are held and gone from views, search and Ask', async () => {
    const id = await note('Plant room', PLANT);
    const other = await note('Other', 'Nothing to see.');
    const caseId = await reported(ada, 'source', id);

    const row = (await t.pool.query(`SELECT * FROM quarantine_cases WHERE id = $1`, [caseId])).rows[0];
    assert.equal(row.project_id, project);
    assert.equal(row.item_kind, 'source');
    assert.equal(row.item_id, id);
    assert.equal(row.reporter_id, ids.ada);
    assert.equal(row.reason, 'Looks like the plant room vault code');
    assert.equal(row.marked_length, SECRET.length);
    assert.equal(row.state, 'cleaned');
    assert.equal(row.waiting_for_key, false);
    assert.equal((await t.pool.query(`SELECT held_case_id FROM sources WHERE id = $1`, [id])).rows[0].held_case_id, caseId);
    assert.deepEqual((await t.pool.query(`SELECT item_kind, item_id, role FROM quarantine_items WHERE case_id = $1`, [caseId])).rows, [{ item_kind: 'source', item_id: id, role: 'reported' }]);
    const actions = (await t.pool.query(`SELECT action FROM quarantine_events WHERE case_id = $1 ORDER BY at, id`, [caseId])).rows.map((r) => r.action);
    for (const a of ['reported', 'held', 'cleaned', 'notified']) assert.ok(actions.includes(a), `${a} in ${actions}`);
    // The stored text is cleaned; the original is encrypted.
    const text = (await t.pool.query(`SELECT text_content FROM source_versions WHERE source_id = $1`, [id])).rows[0].text_content as string;
    assert.ok(!text.includes(SECRET) && text.includes(MARKER));
    assert.ok((await count(`SELECT count(*) AS n FROM quarantine_originals WHERE case_id = $1`, [caseId])) > 0);

    // Gone from every view, search and Ask, for the reporter, the PM and the auditor alike.
    for (const c of [ada, pm, auditor]) {
      assert.equal((await c.request('GET', `/notes/${id}`)).status, 404);
      const listed = ((await c.request('GET', `/projects/${project}/notes`)).body.sources as Array<{ id: string }>).map((s) => s.id);
      assert.deepEqual(listed, [other]);
      const found = await c.request('GET', `/search?q=${encodeURIComponent('kestrel pump')}`);
      assert.deepEqual((found.body.projects as Array<{ results: unknown[] }>).flatMap((p) => p.results), []);
    }
    const ctx = (await t.app.get(ProjectAccess).load(project, { id: ids.ada, email: 'ada@example.org', displayName: 'ada', role: 'member' }))!;
    assert.equal((await findMaterial(t.pool, { kind: 'personal', ctx }, ['kestrel'])).length, 0);

    // Reporting it again is refused: it is already held.
    const again = await report(pm, { kind: 'source', id, marked: [SECRET], reason: 'Again' });
    assert.equal(again.status, 404);
  });

  test('marked text not in the item is refused', async () => {
    const id = await note('Plant room', PLANT);
    const refusals = [
      { marked: ['Nothing like it'] },
      { marked: [SECRET.toLowerCase()] },
      { marked: ['Kp9'] },
      { marked: [] },
      { marked: 'not a list' },
      { marked: [SECRET, 'absent words'] },
    ];
    for (const r of refusals) {
      const res = await report(ada, { kind: 'source', id, reason: 'Looks like a code', ...r });
      assert.equal(res.status, 400, JSON.stringify(r));
      assert.ok(!JSON.stringify(res.body).includes(SECRET.toLowerCase()) && !JSON.stringify(res.body).includes('Nothing like it'));
    }
    // A reason is required, and it may not repeat the marked text.
    assert.equal((await report(ada, { kind: 'source', id, marked: [SECRET], reason: '' })).status, 400);
    const repeated = await report(ada, { kind: 'source', id, marked: [SECRET], reason: `the code ${SECRET}` });
    assert.equal(repeated.status, 400);
    assert.ok(!JSON.stringify(repeated.body).includes(SECRET));
    // Someone who cannot read the item finds nothing.
    await restrict(id, [ids.ada]);
    assert.equal((await report(ben, { kind: 'source', id, marked: [SECRET], reason: 'x code' })).status, 404);
    await seedUser(t.pool, 'outsider@example.org');
    const outsider = await t.signIn('outsider@example.org');
    assert.equal((await report(outsider, { kind: 'source', id, marked: [SECRET], reason: 'x code' })).status, 404);
    assert.equal((await report(ada, { kind: 'source', id: uuidv7(), marked: [SECRET], reason: 'x code' })).status, 404);
    assert.equal((await report(ada, { kind: 'spaceship', id, marked: [SECRET], reason: 'x code' })).status, 400);
    assert.equal(await count(`SELECT count(*) AS n FROM quarantine_cases`), 0);
    assert.equal((await t.pool.query(`SELECT held_case_id FROM sources WHERE id = $1`, [id])).rows[0].held_case_id, null);
  });

  test('a private answer built on it disappears, a shared one goes to review', async () => {
    const id = await note('Plant room', PLANT);
    const thread = await startThread(pm, { kind: 'discussion', title: 'Plant' });
    const shared = await answered(ada);
    assert.equal((await ada.request('POST', `/questions/${shared}/share`, { threadId: thread })).status, 200);
    const mine = await answered(ben);
    await reported(ada, 'source', id);
    const states = (await t.pool.query(`SELECT request_id AS id, review_state AS state FROM ai_answers ORDER BY request_id`)).rows;
    assert.deepEqual(Object.fromEntries(states.map((s) => [s.id, s.state])), { [shared]: 'review_required', [mine]: 'withdrawn' });
    const causes = (await t.pool.query(`SELECT DISTINCT detail->>'cause' AS cause FROM ai_assist_events WHERE actor_id IS NULL AND target_kind = 'answer'`)).rows;
    assert.deepEqual(causes, [{ cause: 'quarantined' }]);
    assert.equal((await ben.request('GET', `/questions/${mine}`)).status, 404);
  });

  test('an approved summary of it is hidden', async () => {
    const original = await note('Board note', `The turbine replacement goes ahead next month. Portal code ${SECRET}.`);
    await restrict(original, [ids.ada]);
    const asked = await dep.request('POST', `/sources/${original}/summaries`, { intendedAudience: { mode: 'project' }, leaveOut: '' });
    assert.equal(asked.status, 201, JSON.stringify(asked.body));
    const runner = new AssistRunner({ pool: t.pool, spend: spend(), model: new SummaryModel('The turbine is replaced next month.'), clock: t.clock.now });
    assert.equal(await runner.process(queued[queued.length - 1], 1, false), 'succeeded');
    t.clock.advanceSeconds(1);
    const approved = await pm.request('POST', `/summaries/${asked.body.id}/approve`, { versionNo: 1, reason: 'Fine to share' });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    const summarySource = approved.body.approved.sourceId as string;
    assert.equal((await ben.request('GET', `/notes/${summarySource}`)).status, 200);

    await reported(ada, 'source', original);
    assert.equal((await t.pool.query(`SELECT state FROM summaries WHERE id = $1`, [asked.body.id])).rows[0].state, 'hidden');
    assert.equal((await ben.request('GET', `/notes/${summarySource}`)).status, 404);
    assert.equal((await ben.request('GET', `/summaries/${asked.body.id}`)).status, 404);
  });

  test('the same text in a message is masked at once, visible and labelled, and PM and Deputies are alerted without the text', async () => {
    const id = await note('Plant room', PLANT);
    const thread = await startThread(pm, { kind: 'discussion', title: 'Plant' });
    const msg = await post(ben, thread, `Use ${SECRET} for the vault, see the plant note.`);
    const plain = await post(ben, thread, 'Thanks, noted.');
    const caseId = await reported(ada, 'source', id);

    // Masked at once, not held: visible to everyone, with the label.
    assert.equal((await t.pool.query(`SELECT held_case_id FROM discussion_messages WHERE id = $1`, [msg])).rows[0].held_case_id, null);
    for (const c of [ada, ben, pm]) {
      const m = (await threadMessages(c, thread)).find((x) => x.id === msg)!;
      assert.equal(m.text, `Use ${MARKER} for the vault, see the plant note.`);
      assert.equal(m.quarantineLabel, POSSIBLE_COPY_TEXT);
      assert.equal((await threadMessages(c, thread)).find((x) => x.id === plain)!.quarantineLabel ?? null, null);
    }
    assert.equal(POSSIBLE_COPY_TEXT, 'Possible credential removed — awaiting check');
    const copies = (await t.pool.query(`SELECT item_kind, item_id, masked, decision FROM quarantine_possible_copies WHERE case_id = $1`, [caseId])).rows;
    assert.deepEqual(copies, [{ item_kind: 'message', item_id: msg, masked: true, decision: null }]);

    // PM and the Deputy get the urgent in-app alert; nobody else does.
    const alerts = (await t.pool.query(`SELECT user_id, urgent, summary, link FROM notifications WHERE kind = 'quarantine_copies' ORDER BY user_id`)).rows;
    assert.deepEqual(alerts.map((a) => a.user_id).sort(), [ids.pm, ids.dep].sort());
    for (const a of alerts) {
      assert.equal(a.urgent, true);
      assert.equal(a.summary, 'The text reported as a suspected credential in a note also appeared in 1 other place in Alpha Project and has been masked there');
      assert.equal(a.link, `#/quarantine/cases/${caseId}/copies`);
    }
    // The copies list: PM and Deputy only; kind, reference and date, never the text.
    const list = await pm.request('GET', `/quarantine/cases/${caseId}/copies`);
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.equal(list.body.copies.length, 1);
    assert.equal(list.body.copies[0].kind, 'message');
    assert.equal(list.body.copies[0].id, msg);
    assert.ok(!JSON.stringify(list.body).includes(SECRET));
    assert.equal((await dep.request('GET', `/quarantine/cases/${caseId}/copies`)).status, 200);
    assert.equal((await ada.request('GET', `/quarantine/cases/${caseId}/copies`)).status, 403);
    assert.ok(!(await leakScan()).includes(SECRET));
  });

  test('PM confirms one copy and dismisses another, whose original returns', async () => {
    const id = await note('Plant room', PLANT);
    const thread = await startThread(pm, { kind: 'discussion', title: 'Plant' });
    const m1 = await post(ben, thread, `Use ${SECRET} for the vault.`);
    const m2 = await post(ada, thread, `My test word was ${SECRET} too, nothing to do with the vault.`);
    const caseId = await reported(ada, 'source', id);
    const decide = (c: Client, decisions: unknown) => c.request('POST', `/quarantine/cases/${caseId}/copies`, { decisions });
    assert.equal((await decide(ada, [{ kind: 'message', id: m1, decision: 'confirmed' }])).status, 403);
    assert.equal((await decide(pm, [{ kind: 'message', id: uuidv7(), decision: 'confirmed' }])).status, 404);
    assert.equal((await decide(pm, [{ kind: 'message', id: m1, decision: 'maybe' }])).status, 400);

    const r = await decide(pm, [
      { kind: 'message', id: m1, decision: 'confirmed' },
      { kind: 'message', id: m2, decision: 'dismissed' },
    ]);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(!JSON.stringify(r.body).includes(SECRET));
    const body = async (m: string) => (await t.pool.query(`SELECT body FROM message_versions WHERE message_id = $1 ORDER BY version_no DESC LIMIT 1`, [m])).rows[0].body as string;
    assert.equal(await body(m1), `Use ${MARKER} for the vault.`);
    assert.equal(await body(m2), `My test word was ${SECRET} too, nothing to do with the vault.`);
    const rows = (await t.pool.query(`SELECT item_id, decision, decided_by FROM quarantine_possible_copies WHERE case_id = $1 ORDER BY item_id`, [caseId])).rows;
    assert.deepEqual(Object.fromEntries(rows.map((x) => [x.item_id, [x.decision, x.decided_by]])), { [m1]: ['confirmed', ids.pm], [m2]: ['dismissed', ids.pm] });
    const items = (await t.pool.query(`SELECT item_kind, item_id, role FROM quarantine_items WHERE case_id = $1 ORDER BY role, item_id`, [caseId])).rows;
    assert.deepEqual(items, [{ item_kind: 'message', item_id: m1, role: 'copy' }, { item_kind: 'source', item_id: id, role: 'reported' }]);
    const events = (await t.pool.query(`SELECT action, item_id, actor_id FROM quarantine_events WHERE case_id = $1 AND action LIKE 'copy_%' ORDER BY action`, [caseId])).rows;
    assert.deepEqual(events, [{ action: 'copy_confirmed', item_id: m1, actor_id: ids.pm }, { action: 'copy_dismissed', item_id: m2, actor_id: ids.pm }]);
    // The dismissed message shows its original text without a label; the confirmed one keeps the cleaned text, labelled no more.
    const shown = await threadMessages(ben, thread);
    assert.equal(shown.find((x) => x.id === m2)!.quarantineLabel ?? null, null);
    assert.equal(shown.find((x) => x.id === m1)!.quarantineLabel ?? null, null);
    // Decided places cannot be decided again.
    assert.equal((await decide(dep, [{ kind: 'message', id: m1, decision: 'dismissed' }])).status, 409);
  });

  test('a queued digest email containing it is cancelled', async () => {
    const id = await note('Plant room', PLANT);
    const mail = async (body: string, status = 'queued') => {
      const outboxId = await writeOutbox(t.pool, {
        toUserId: ids.ben, toAddress: 'ben@example.org', subject: 'Your digest', body, kind: 'digest', projectId: project, initiatedBy: 'digest', now: t.clock.now(),
      });
      if (status !== 'queued') await t.pool.query(`UPDATE email_outbox SET status = $2, sent_at = now() WHERE id = $1`, [outboxId, status]);
      return outboxId;
    };
    const holding = await mail(`Today: ${SECRET} is the vault code.`);
    const waiting = await mail(`Again: ${SECRET}.`);
    await t.pool.query(`UPDATE email_outbox SET status = 'retry_wait', next_attempt_at = now() WHERE id = $1`, [waiting]);
    const harmless = await mail('Today: nothing new.');
    await mail(`Yesterday: ${SECRET}.`, 'sent');
    const caseId = await reported(ada, 'source', id);
    const rows = (await t.pool.query(`SELECT id, status, last_reason FROM email_outbox WHERE id = ANY($1::uuid[])`, [[holding, waiting, harmless]])).rows;
    assert.deepEqual(Object.fromEntries(rows.map((x) => [x.id, [x.status, x.last_reason]])), {
      [holding]: ['cancelled', CANCELLED_REASON],
      [waiting]: ['cancelled', CANCELLED_REASON],
      [harmless]: ['queued', null],
    });
    assert.equal(CANCELLED_REASON, 'held: suspected credential');
    // The sent one is a known disclosure; copies outside Kainow cannot be recalled.
    const { CasesService } = await import('./cases.service');
    const d = await t.app.get(CasesService).disclosures(caseId);
    assert.equal(d.emails.length, 1);
    assert.equal(d.emails[0].recipients, 1);
    assert.equal(typeof d.audienceSize, 'number');
    assert.ok(d.audienceSize >= 7, `audience ${d.audienceSize}`);
    assert.ok(!JSON.stringify(d).includes(SECRET));
  });

  test('Administrators, the author and the named holder get the urgent notice without the text', async () => {
    const id = await note('Plant room', PLANT, dep);
    // The holder must be a person of the organisation.
    assert.equal((await report(ada, { kind: 'source', id, marked: [SECRET], reason: 'Vault code', holderUserId: uuidv7() })).status, 400);
    const caseId = await reported(ada, 'source', id, { holderUserId: ids.kim });
    assert.equal((await t.pool.query(`SELECT holder_user_id FROM quarantine_cases WHERE id = $1`, [caseId])).rows[0].holder_user_id, ids.kim);
    const notes = (await t.pool.query(`SELECT user_id, urgent, summary FROM notifications WHERE kind = 'credential_reported'`)).rows;
    assert.deepEqual(notes.map((n) => n.user_id).sort(), [ids.admin, ids.admin2, ids.dep, ids.kim].sort());
    for (const n of notes) {
      assert.equal(n.urgent, true);
      assert.equal(n.summary, NOTICE('credential'));
    }
    const emails = (await t.outbox()).filter((e) => e.kind === 'credential_report');
    assert.deepEqual(emails.map((e) => e.to_address).sort(), ['admin2@example.org', 'admin@example.org', 'dep@example.org', 'kim@example.org']);
    for (const e of emails) {
      assert.equal(e.status, 'queued');
      assert.ok(e.text_body.includes(NOTICE('credential')));
      assert.ok(!e.text_body.includes(SECRET) && !e.text_body.includes('kestrel'));
    }
    assert.ok(!(await leakScan()).includes(SECRET));
  });

  test('without the key the item and the places are held, and a job cleans them when the key appears', async () => {
    await t.close();
    await boot(false);
    const id = await note('Plant room', PLANT);
    const thread = await startThread(pm, { kind: 'discussion', title: 'Plant' });
    const msg = await post(ben, thread, `Use ${SECRET} for the vault.`);
    t.clock.advanceSeconds(1);
    const caseId = await reported(ada, 'source', id);
    const row = (await t.pool.query(`SELECT state, waiting_for_key FROM quarantine_cases WHERE id = $1`, [caseId])).rows[0];
    assert.deepEqual(row, { state: 'held', waiting_for_key: true });
    assert.equal((await t.pool.query(`SELECT held_case_id FROM sources WHERE id = $1`, [id])).rows[0].held_case_id, caseId);
    assert.equal((await t.pool.query(`SELECT held_case_id FROM discussion_messages WHERE id = $1`, [msg])).rows[0].held_case_id, caseId);
    assert.deepEqual((await t.pool.query(`SELECT item_id, masked FROM quarantine_possible_copies WHERE case_id = $1`, [caseId])).rows, [{ item_id: msg, masked: false }]);
    assert.equal(await count(`SELECT count(*) AS n FROM quarantine_originals`), 0);
    // Hidden, not cleaned: the note is gone and the message shows no text.
    assert.equal((await ben.request('GET', `/notes/${id}`)).status, 404);
    const m = (await threadMessages(ben, thread)).find((x) => x.id === msg)!;
    assert.equal(m.text, null);
    assert.equal(m.notice, 'Held — suspected credential, under review');
    const alert = (await t.pool.query(`SELECT summary FROM notifications WHERE kind = 'quarantine_copies' LIMIT 1`)).rows[0].summary as string;
    assert.ok(!alert.includes(SECRET));

    // The key appears: the job cleans the waiting case.
    const key = loadProtectedKey(keyFile, () => undefined);
    assert.ok(key);
    assert.equal(await cleanWaitingCases(t.pool, key, t.clock.now()), 1);
    const after = (await t.pool.query(`SELECT state, waiting_for_key, cleaned_at FROM quarantine_cases WHERE id = $1`, [caseId])).rows[0];
    assert.equal(after.state, 'cleaned');
    assert.equal(after.waiting_for_key, false);
    assert.ok(after.cleaned_at);
    const text = (await t.pool.query(`SELECT text_content FROM source_versions WHERE source_id = $1`, [id])).rows[0].text_content as string;
    assert.ok(!text.includes(SECRET) && text.includes(MARKER));
    assert.equal((await t.pool.query(`SELECT held_case_id FROM sources WHERE id = $1`, [id])).rows[0].held_case_id, caseId);
    assert.equal((await t.pool.query(`SELECT held_case_id FROM discussion_messages WHERE id = $1`, [msg])).rows[0].held_case_id, null);
    assert.deepEqual((await t.pool.query(`SELECT masked FROM quarantine_possible_copies WHERE case_id = $1`, [caseId])).rows, [{ masked: true }]);
    const shown = (await threadMessages(ben, thread)).find((x) => x.id === msg)!;
    assert.equal(shown.text, `Use ${MARKER} for the vault.`);
    assert.equal(shown.quarantineLabel, POSSIBLE_COPY_TEXT);
    // Nothing more to do on a second run.
    assert.equal(await cleanWaitingCases(t.pool, key, t.clock.now()), 0);
    assert.ok(!(await leakScan()).includes(SECRET));
  });

  test('report and release work while Closed', async () => {
    // The release half is in Task 13's tests (release.http.test.ts): reporting is protective in every state.
    const id = await note('Plant room', PLANT);
    const other = 'Zq7harbor-Lantern9';
    const second = await note('Second room', `Second vault: ${other}.`);
    await t.pool.query(`UPDATE projects SET status = 'closed', closure_outcome = 'abandoned' WHERE id = $1`, [project]);
    const caseId = await reported(ada, 'source', id);
    assert.equal((await t.pool.query(`SELECT state FROM quarantine_cases WHERE id = $1`, [caseId])).rows[0].state, 'cleaned');
    // Deferred too, by a grant holder.
    await t.pool.query(`UPDATE projects SET status = 'deferred', closure_outcome = NULL WHERE id = $1`, [project]);
    const again = await report(auditor, { kind: 'source', id: second, marked: [other], reason: 'Another code' });
    assert.equal(again.status, 201, JSON.stringify(again.body));
    assert.equal((await t.pool.query(`SELECT state FROM quarantine_cases WHERE id = $1`, [again.body.caseId])).rows[0].state, 'cleaned');
  });

  test('an Audit grant holder may report', async () => {
    const id = await note('Plant room', PLANT);
    const caseId = await reported(auditor, 'source', id);
    assert.equal((await t.pool.query(`SELECT reporter_id FROM quarantine_cases WHERE id = $1`, [caseId])).rows[0].reporter_id, ids.auditor);
  });

  test('Kainow reports with no reporter', async () => {
    const id = await note('Plant room', PLANT);
    const { CasesService } = await import('./cases.service');
    const { caseId } = await t.app.get(CasesService).report('kainow', { projectId: project, kind: 'source', id, marked: [SECRET], reason: null });
    const row = (await t.pool.query(`SELECT reporter_id, reason, state FROM quarantine_cases WHERE id = $1`, [caseId])).rows[0];
    assert.deepEqual(row, { reporter_id: null, reason: null, state: 'cleaned' });
  });

  test('no event, notification or email row contains the marked text', async () => {
    const id = await note('Plant room', PLANT, dep);
    const thread = await startThread(pm, { kind: 'discussion', title: 'Plant' });
    const m1 = await post(ben, thread, `Use ${SECRET} for the vault.`);
    await post(ada, thread, `And ${SECRET} again.`);
    await writeOutbox(t.pool, { toUserId: ids.ben, toAddress: 'ben@example.org', subject: 'Notice', body: `Code ${SECRET}`, kind: 'notice', projectId: project, initiatedBy: 'trigger', now: t.clock.now() });
    const caseId = await reported(ada, 'source', id, { holderUserId: ids.kim });
    const r = await pm.request('POST', `/quarantine/cases/${caseId}/copies`, { decisions: [{ kind: 'message', id: m1, decision: 'dismissed' }] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const all = await leakScan();
    assert.ok(!all.includes(SECRET));
    const digestish = JSON.stringify((await t.pool.query(`SELECT subject, text_body, html_body, last_reason FROM email_outbox`)).rows);
    assert.ok(!digestish.includes(SECRET), 'queued emails are cleaned as well as cancelled');
  });
});
