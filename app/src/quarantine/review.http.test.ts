import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { AssistRunner } from '../assist/assist-runner';
import { findMaterial } from '../assist/material';
import { buildDigest } from '../digests/digest';
import { ProjectAccess } from '../projects/access.service';
import { uuidv7 } from '../common/uuid7';
import type { JsonSchemaModel, ModelRequest } from '../extraction/model';
import { HELD } from '../history/deleted-sql';
import { Sweep } from '../notifications/sweep';
import type { Usage } from '../spend/cost';
import { MVP_SPEND_SETTINGS } from '../spend/mvp-settings';
import { SpendService } from '../spend/spend.service';
import { SpendSettingsService } from '../spend/spend.settings';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedProject, seedUser } from '../testing/projects';
import { QUOTE_CHANGED_TEXT, WITHHELD_TEXT } from './clean';
import { MARKER } from './clean-text';
import { POSSIBLE_COPY_TEXT, UNDER_REVIEW_TEXT } from './labels';

const USAGE: Usage = { inputTokens: 2_000, cachedInputTokens: 0, outputTokens: 300 };
/** A secret the credential check does not know: only a person can mark it. */
const SECRET = 'Kp9vault-Rotor42';
const MORE = 'Zx81-harbour-gate';
/** A key the credential check recognises (never stored by the notes form: it arrives in a later version). */
const KEY = `sk-${'a1B2c3D4e5F6g7H8i9J0'}kLmN`;
const PLANT = `The kestrel pump service is booked for Thursday morning. The plant room vault code is ${SECRET} until March.`;
/** Friday 13 Nov 2026, HH:MM UTC+8. */
const at = (h: number, m = 0): number => Date.UTC(2026, 10, 13, h - 8, m);
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

class AnswerModel implements JsonSchemaModel {
  constructor(private readonly marker: string) {}
  async callJson(_req: ModelRequest): Promise<{ content: unknown; usage: Usage }> {
    return { content: JSON.stringify({ answer_markdown: `The pump service is on Thursday [${this.marker}].`, not_found: false, cited: [this.marker] }), usage: USAGE };
  }
}

class SummaryModel implements JsonSchemaModel {
  async callJson(_req: ModelRequest): Promise<{ content: unknown; usage: Usage }> {
    return { content: JSON.stringify({ summary_markdown: 'The pump service is booked for Thursday.', omitted_categories: [] }), usage: USAGE };
  }
}

describe('review, mark more and release', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let dir: string;
  let keyFile: string;
  const ids: Record<string, string> = {};
  let project: string;
  let other: string;
  let pm: Client;
  let own: Client;
  let spo: Client;
  let dep: Client;
  let ada: Client;
  let ben: Client;
  let pm2: Client;
  let queued: string[];

  const count = async (sql: string, params: unknown[] = []) => Number((await t.pool.query(sql, params)).rows[0].n);
  const json = (v: unknown) => JSON.stringify(v);

  async function boot(withKey: boolean): Promise<void> {
    queued = [];
    t = await startTestApp(undefined, { assistQueue: { enqueue: async (id: string) => void queued.push(id) }, ...(withKey ? { protectedKeyFile: keyFile } : {}) });
    t.clock.ms = at(8);
    for (const k of ['pm', 'own', 'spo', 'dep', 'ada', 'ben', 'pm2', 'own2', 'spo2']) ids[k] = await seedUser(t.pool, `${k}@example.org`);
    ids.admin = await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
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
    other = await seedProject(t.pool, {
      name: 'Beta Project',
      status: 'active',
      members: [
        { userId: ids.pm2, role: 'pm' },
        { userId: ids.own2, role: 'owner' },
        { userId: ids.spo2, role: 'sponsor' },
      ],
    });
    await new SpendSettingsService(t.pool, t.clock.now).apply(MVP_SPEND_SETTINGS, ids.admin);
    [pm, own, spo, dep, ada, ben, pm2] = [
      await t.signIn('pm@example.org'),
      await t.signIn('own@example.org'),
      await t.signIn('spo@example.org'),
      await t.signIn('dep@example.org'),
      await t.signIn('ada@example.org'),
      await t.signIn('ben@example.org'),
      await t.signIn('pm2@example.org'),
    ];
  }

  const ok = async (p: Promise<{ status: number; body: any }>, status = 200) => {
    const r = await p;
    assert.equal(r.status, status, json(r.body));
    return r.body;
  };
  const note = async (title: string, text: string) => (await ok(pm.request('POST', `/projects/${project}/notes`, { title, text }), 201)).source.id as string;
  const restrict = async (sourceId: string, namedUserIds: string[]) => {
    const audienceId = (await t.pool.query(`SELECT audience_id FROM sources WHERE id = $1`, [sourceId])).rows[0].audience_id;
    await ok(pm.request('PUT', `/audiences/${audienceId}`, { mode: 'restricted', namedUserIds, reason: 'Leaders only' }));
  };
  const thread = async () => (await ok(pm.request('POST', `/projects/${project}/threads`, { kind: 'discussion', title: 'Plant' }), 201)).id as string;
  const post = async (c: Client, threadId: string, body: string) => (await ok(c.request('POST', `/threads/${threadId}/messages`, { body }), 201)).id as string;
  const reported = async (c: Client, kind: string, id: string, marked = [SECRET]) => {
    const body = await ok(c.request('POST', `/projects/${project}/secret-reports`, { kind, id, marked, reason: 'Looks like the plant room vault code' }), 201);
    t.clock.advanceSeconds(1);
    return body.caseId as string;
  };
  const release = (c: Client, caseId: string, reason: unknown = 'Cleaned and checked; the code was rotated') => c.request('POST', `/quarantine/cases/${caseId}/release`, { reason });
  const versions = async (sourceId: string) =>
    (await t.pool.query(`SELECT text_content FROM source_versions WHERE source_id = $1 ORDER BY version_no`, [sourceId])).rows.map((r) => r.text_content as string);
  /** A later version holding `text`, stored directly (the notes form refuses a recognisable key on the way in). */
  const laterVersion = async (sourceId: string, text: string, upload?: Buffer) => {
    const version = uuidv7();
    const n = (await t.pool.query(`SELECT max(version_no) + 1 AS n FROM source_versions WHERE source_id = $1`, [sourceId])).rows[0].n;
    await t.pool.query(
      `INSERT INTO source_versions (id, source_id, version_no, origin, filename, media_type, original_bytes, original_sha256, text_content, text_sha256, char_count, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        version, sourceId, n, upload ? 'upload' : 'paste', upload ? 'plant.docx' : null,
        upload ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : null,
        upload ?? null, upload ? sha(upload) : null, text, sha(text), text.length, ids.pm, t.clock.now(),
      ],
    );
    return version;
  };
  const answered = async (c: Client) => {
    const r = await c.request('POST', `/projects/${project}/questions`, { question: 'When is the kestrel pump service?' });
    assert.equal(r.status, 201, json(r.body));
    const plant = (r.body.sources as Array<{ marker: string; location: string | null }>).find((s) => s.location?.startsWith('Plant room'));
    assert.ok(plant, json(r.body.sources));
    const runner = new AssistRunner({ pool: t.pool, spend: new SpendService(t.pool, t.clock.now), model: new AnswerModel(plant.marker), clock: t.clock.now });
    assert.equal(await runner.process(r.body.id, 1, false), 'succeeded');
    t.clock.advanceSeconds(1);
    return r.body.id as string;
  };
  /** Every stored row that must never hold the marked text. */
  const leakScan = async () => {
    const out: string[] = [];
    for (const table of ['quarantine_events', 'audit_events', 'notifications', 'quarantine_cases']) out.push(json((await t.pool.query(`SELECT * FROM ${table}`)).rows));
    return out.join('\n');
  };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'kainow-review-'));
    keyFile = join(dir, 'p.key');
    writeFileSync(keyFile, randomBytes(32));
    await boot(true);
  });
  afterEach(async () => {
    await t?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('PM in the audience sees the cleaned text only', async () => {
    const id = await note('Plant room', PLANT);
    const caseId = await reported(ada, 'source', id);
    for (const c of [pm, own, spo]) {
      const list = await ok(c.request('GET', `/projects/${project}/held`));
      assert.equal(list.cases.length, 1, json(list));
      assert.equal(list.cases[0].caseId, caseId);
      assert.equal(list.cases[0].kind, 'source');
      assert.equal(list.cases[0].itemId, id);
      assert.equal(list.cases[0].state, 'cleaned');
      assert.ok(!json(list).includes(SECRET));

      const view = await ok(c.request('GET', `/quarantine/cases/${caseId}`));
      assert.ok(!json(view).includes(SECRET), 'the original reached a reviewer');
      assert.equal(view.text, `Plant room\nThe kestrel pump service is booked for Thursday morning. The plant room vault code is ${MARKER} until March.`);
      assert.equal(view.markers.length, 1);
      for (const m of view.markers) assert.equal(view.text.slice(m.start, m.end), MARKER);
      assert.equal(view.state, 'cleaned');
    }
    // A Member, a Deputy (not a reviewer) and the reporter get no review.
    for (const c of [ada, ben, dep]) {
      assert.equal((await c.request('GET', `/quarantine/cases/${caseId}`)).status, 403);
      assert.equal((await c.request('GET', `/projects/${project}/held`)).status, 403);
    }
    assert.equal((await pm.request('GET', `/quarantine/cases/${uuidv7()}`)).status, 404);
    assert.ok(!(await leakScan()).includes(SECRET));
  });

  test('a PM of another project, and a PM outside a private answer\'s audience, get 404', async () => {
    const id = await note('Plant room', PLANT);
    await restrict(id, [ids.ada]);
    const caseId = await reported(ada, 'source', id);
    // The PM of another project is outside the source's audience: nothing is found, not even the case.
    assert.equal((await pm2.request('GET', `/quarantine/cases/${caseId}`)).status, 404);
    assert.equal((await pm2.request('POST', `/quarantine/cases/${caseId}/mark-more`, { marked: ['kestrel pump'] })).status, 404);
    assert.equal((await release(pm2, caseId)).status, 404);
    assert.equal((await pm2.request('GET', `/projects/${project}/held`)).status, 404);
    // A private AI answer is in its requester's audience only: the project's PM is outside it too.
    const plant = await note('Plant room', 'The kestrel pump service is booked for Thursday morning.');
    const answer = await answered(ben);
    await t.pool.query(`UPDATE ai_answers SET answer_markdown = $2 WHERE request_id = $1`, [answer, `Thursday. Vault ${SECRET}.`]);
    const answerCase = await reported(ben, 'answer', answer);
    assert.equal((await pm.request('GET', `/quarantine/cases/${answerCase}`)).status, 404);
    assert.equal((await release(pm, answerCase)).status, 404);
    const listed = (await ok(pm.request('GET', `/projects/${project}/held`))).cases.map((c: { caseId: string }) => c.caseId);
    assert.deepEqual(listed, [caseId]);
    assert.ok(plant);
  });

  test('mark more cleans further text and encrypts it into the same case', async () => {
    const id = await note('Plant room', `${PLANT} The harbour gate opens with ${MORE}.`);
    const caseId = await reported(ada, 'source', id);
    const before = await count(`SELECT count(*) AS n FROM quarantine_originals WHERE case_id = $1`, [caseId]);
    const mark = (c: Client, marked: unknown) => c.request('POST', `/quarantine/cases/${caseId}/mark-more`, { marked });
    assert.equal((await mark(ada, [MORE])).status, 403);
    assert.equal((await mark(pm, ['not in the text'])).status, 400);
    assert.equal((await mark(pm, [SECRET])).status, 400, 'text already removed is not in the cleaned text');
    assert.equal((await mark(pm, ['removed]'])).status, 400, 'the marker itself cannot be marked');
    const r = await mark(pm, [MORE]);
    assert.equal(r.status, 200, json(r.body));
    assert.ok(!json(r.body).includes(MORE));
    for (const v of await versions(id)) assert.ok(!v.includes(MORE) && !v.includes(SECRET), v);
    const view = await ok(pm.request('GET', `/quarantine/cases/${caseId}`));
    assert.equal(view.markers.length, 2);
    assert.ok(!json(view).includes(MORE));
    // Same case; more originals; one marked_more event without text.
    assert.equal(await count(`SELECT count(*) AS n FROM quarantine_cases`), 1);
    assert.ok((await count(`SELECT count(*) AS n FROM quarantine_originals WHERE case_id = $1`, [caseId])) > before);
    const events = (await t.pool.query(`SELECT actor_id, detail FROM quarantine_events WHERE case_id = $1 AND action = 'marked_more'`, [caseId])).rows;
    assert.equal(events.length, 1);
    assert.equal(events[0].actor_id, ids.pm);
    assert.ok(!(await leakScan()).includes(MORE));
  });

  test('a person marks one secret; a second, detector-recognisable key elsewhere in the same notes is also cleaned', async () => {
    const id = await note('Plant room', 'The kestrel pump service is booked for Thursday morning.');
    await laterVersion(id, `${PLANT} The portal key is ${KEY} for now.`);
    await reported(ada, 'source', id);
    for (const v of await versions(id)) assert.ok(!v.includes(SECRET) && !v.includes(KEY), v);
    assert.ok((await versions(id))[1].includes(`The portal key is ${MARKER} for now.`));
    // The copies list holds only what the person marked: the key found by the check is not searched for elsewhere.
    assert.ok(!(await leakScan()).includes(KEY));
  });

  test('release returns the item and confirmed copies to their audience; withdrawn answers stay withdrawn; hidden summary stays hidden', async () => {
    const id = await note('Plant room', PLANT);
    await restrict(id, [ids.ada, ids.ben]);
    const answer = await answered(ben);
    const asked = await ok(dep.request('POST', `/sources/${id}/summaries`, { intendedAudience: { mode: 'project' }, leaveOut: '' }), 201);
    const runner = new AssistRunner({ pool: t.pool, spend: new SpendService(t.pool, t.clock.now), model: new SummaryModel(), clock: t.clock.now });
    assert.equal(await runner.process(queued[queued.length - 1], 1, false), 'succeeded');
    t.clock.advanceSeconds(1);
    await ok(pm.request('POST', `/summaries/${asked.id}/approve`, { versionNo: 1, reason: 'Fine to share' }));
    const th = await thread();
    const copy = await post(ben, th, `Use ${SECRET} for the vault.`);
    const caseId = await reported(ada, 'source', id);
    await ok(pm.request('POST', `/quarantine/cases/${caseId}/copies`, { decisions: [{ kind: 'message', id: copy, decision: 'confirmed' }] }));
    assert.equal((await ben.request('GET', `/notes/${id}`)).status, 404);
    assert.equal((await t.pool.query(`SELECT review_state FROM ai_answers WHERE request_id = $1`, [answer])).rows[0].review_state, 'withdrawn');
    assert.equal((await t.pool.query(`SELECT state FROM summaries WHERE id = $1`, [asked.id])).rows[0].state, 'hidden');
    // Held items cannot be deleted or restored until released.
    const refused = await pm.request('POST', `/sources/${id}/delete`, { reason: 'Imported into the wrong project' });
    assert.equal(refused.status, 409, json(refused.body));
    assert.equal(refused.body.message, HELD);

    // A reason is required and is checked for credentials; a Member cannot release.
    assert.equal((await release(pm, caseId, '')).status, 400);
    const keyed = await release(pm, caseId, `rotated, new one is ${KEY}`);
    assert.equal(keyed.status, 400);
    assert.ok(!json(keyed.body).includes(KEY));
    assert.equal((await release(ada, caseId)).status, 403);

    const r = await release(own, caseId);
    assert.equal(r.status, 200, json(r.body));
    assert.ok(!json(r.body).includes(SECRET));
    const row = (await t.pool.query(`SELECT state, closed_by, close_reason, closed_at FROM quarantine_cases WHERE id = $1`, [caseId])).rows[0];
    assert.deepEqual([row.state, row.closed_by, row.close_reason], ['released', ids.own, 'Cleaned and checked; the code was rotated']);
    assert.ok(row.closed_at);
    assert.equal((await t.pool.query(`SELECT held_case_id FROM sources WHERE id = $1`, [id])).rows[0].held_case_id, null);
    // The item is back, cleaned, for its audience; still not for anyone outside it.
    const back = (await ok(ben.request('GET', `/notes/${id}/versions/1`))).version;
    assert.ok(back.text.includes(MARKER) && !back.text.includes(SECRET));
    assert.equal((await dep.request('GET', `/notes/${id}`)).status, 200);
    // The confirmed copy stays cleaned and loses its label.
    const shown = (await ok(ben.request('GET', `/threads/${th}`))).messages.find((m: { id: string }) => m.id === copy);
    assert.equal(shown.text, `Use ${MARKER} for the vault.`);
    assert.equal(shown.quarantineLabel ?? null, null);
    // Withdrawn answers stay withdrawn; the hidden summary stays hidden until confirmed.
    assert.equal((await t.pool.query(`SELECT review_state FROM ai_answers WHERE request_id = $1`, [answer])).rows[0].review_state, 'withdrawn');
    assert.equal((await ben.request('GET', `/questions/${answer}`)).status, 404);
    assert.equal((await t.pool.query(`SELECT state FROM summaries WHERE id = $1`, [asked.id])).rows[0].state, 'hidden');
    const event = (await t.pool.query(`SELECT actor_id, reason FROM quarantine_events WHERE case_id = $1 AND action = 'released'`, [caseId])).rows;
    assert.deepEqual(event, [{ actor_id: ids.own, reason: 'Cleaned and checked; the code was rotated' }]);
    // Closed: no second release, no mark more, gone from the list.
    assert.equal((await release(pm, caseId)).status, 409);
    assert.equal((await pm.request('POST', `/quarantine/cases/${caseId}/mark-more`, { marked: ['kestrel pump'] })).status, 409);
    assert.deepEqual((await ok(pm.request('GET', `/projects/${project}/held`))).cases, []);
    // Released: it can be deleted, and restoring brings back the cleaned text.
    await ok(pm.request('POST', `/sources/${id}/delete`, { reason: 'Imported into the wrong project' }));
    await ok(pm.request('POST', `/sources/${id}/restore`, { reason: 'Needed after all' }));
    const restored = (await ok(ben.request('GET', `/notes/${id}/versions/1`))).version;
    assert.ok(restored.text.includes(MARKER) && !restored.text.includes(SECRET));
    assert.ok(!(await leakScan()).includes(SECRET));
  });

  test('a cleaned task stays visible labelled Credential removed — under review and reminders continue', async () => {
    const task = uuidv7();
    await t.pool.query(
      `INSERT INTO tasks (id, project_id, depth, title, assignee_id, due_on, status, authorised_by, authorised_at)
       VALUES ($1, $2, 0, $3, $4, '2026-11-16', 'not_started', $5, $6)`,
      [task, project, `Rotate the osprey vault code ${SECRET}`, ids.ben, ids.own, t.clock.now()],
    );
    const caseId = await reported(ada, 'task', task);
    assert.equal(UNDER_REVIEW_TEXT, 'Credential removed — under review');
    for (const c of [ben, ada, pm]) {
      const listed = (await ok(c.request('GET', `/projects/${project}/records`))).tasks.find((x: { id: string }) => x.id === task);
      assert.ok(listed, 'the cleaned task is listed');
      assert.equal(listed.title, `Rotate the osprey vault code ${MARKER}`);
      assert.equal(listed.quarantineLabel, UNDER_REVIEW_TEXT);
      const page = await ok(c.request('GET', `/records/tasks/${task}`));
      assert.equal(page.task.quarantineLabel, UNDER_REVIEW_TEXT);
    }
    // Work continues: the assignee starts it.
    await ok(ben.request('POST', `/records/tasks/${task}/start`, {}));
    // Reminders continue, with the cleaned title.
    t.clock.ms = at(9);
    await new Sweep({ pool: t.pool, clock: t.clock.now, appUrl: 'https://kainow.example.org', nudge: { nudge: async () => undefined }, log: { warn: () => undefined } }).run();
    const reminders = (await t.pool.query(`SELECT summary FROM notifications WHERE user_id = $1 AND summary LIKE '%osprey%'`, [ids.ben])).rows;
    assert.ok(reminders.length > 0, 'a reminder about the cleaned task');
    for (const r of reminders) assert.ok(!r.summary.includes(SECRET));
    // Still held: not deleted or restored until released, and the case is still open.
    assert.equal((await t.pool.query(`SELECT held_case_id FROM tasks WHERE id = $1`, [task])).rows[0].held_case_id, caseId);
    // Released: the label goes.
    await ok(release(pm, caseId));
    const after = (await ok(ben.request('GET', `/projects/${project}/records`))).tasks.find((x: { id: string }) => x.id === task);
    assert.equal(after.quarantineLabel, null);
  });

  test('a cleaned record under review is kept out of Ask material, search and digests, and stays in the work list labelled', async () => {
    const task = uuidv7();
    await t.pool.query(
      `INSERT INTO tasks (id, project_id, depth, title, assignee_id, due_on, status, authorised_by, authorised_at)
       VALUES ($1, $2, 0, $3, $4, '2026-11-16', 'not_started', $5, $6)`,
      [task, project, `Rotate the osprey vault code ${SECRET}`, ids.ben, ids.own, t.clock.now()],
    );
    const material = async () => {
      const ctx = (await t.app.get(ProjectAccess).load(project, { id: ids.ben, email: 'ben@example.org', displayName: 'ben', role: 'member' }))!;
      return findMaterial(t.pool, { kind: 'personal', ctx }, ['osprey']);
    };
    const searched = async () => {
      const r = await ok(ben.request('GET', `/search?q=${encodeURIComponent('osprey vault')}`));
      return (r.projects as Array<{ results: Array<{ kind: string; id: string }> }>).flatMap((x) => x.results.map((y) => `${y.kind}:${y.id}`));
    };
    const digest = async () => (await buildDigest(t.pool, project, ids.ben, t.clock.now(), 'https://kainow.example.org')).body.toLowerCase();
    // Before the report it is everywhere.
    assert.ok((await material()).length > 0);
    assert.deepEqual(await searched(), [`task:${task}`]);
    assert.ok((await digest()).includes('osprey'));
    await reported(ada, 'task', task);
    // Cleaned and under review: out of Ask material (the input of any new AI request), search and the digest ...
    assert.equal((await material()).length, 0);
    assert.deepEqual(await searched(), []);
    assert.ok(!(await digest()).includes('osprey'));
    // ... but in the work list, labelled.
    const listed = (await ok(ben.request('GET', `/projects/${project}/records`))).tasks.find((x: { id: string }) => x.id === task);
    assert.equal(listed?.quarantineLabel, UNDER_REVIEW_TEXT);
  });

  test('mark more finds a dismissed place again: it is masked, undecided, labelled and alerted afresh', async () => {
    const id = await note('Plant room', `${PLANT} The harbour gate opens with ${MORE}.`);
    const th = await thread();
    const msg = await post(ben, th, `Vault ${SECRET} and gate ${MORE}.`);
    const caseId = await reported(ada, 'source', id);
    await ok(pm.request('POST', `/quarantine/cases/${caseId}/copies`, { decisions: [{ kind: 'message', id: msg, decision: 'dismissed' }] }));
    const label = async () => (await ok(ben.request('GET', `/threads/${th}`))).messages.find((m: { id: string }) => m.id === msg).quarantineLabel ?? null;
    assert.equal(await label(), null);
    const alerts = () => count(`SELECT count(*) AS n FROM notifications WHERE kind = 'quarantine_copies'`);
    const before = await alerts();
    await ok(pm.request('POST', `/quarantine/cases/${caseId}/mark-more`, { marked: [MORE] }));
    const row = (await t.pool.query(`SELECT masked, decision, decided_by, decided_at FROM quarantine_possible_copies WHERE case_id = $1 AND item_id = $2`, [caseId, msg])).rows[0];
    assert.deepEqual(row, { masked: true, decision: null, decided_by: null, decided_at: null });
    assert.equal(await label(), POSSIBLE_COPY_TEXT);
    assert.ok((await alerts()) > before, 'the PM and Deputy are alerted again');
    const body = (await t.pool.query(`SELECT body FROM message_versions WHERE message_id = $1 ORDER BY version_no DESC LIMIT 1`, [msg])).rows[0].body as string;
    assert.ok(!body.includes(MORE));
    // It can be decided again.
    await ok(pm.request('POST', `/quarantine/cases/${caseId}/copies`, { decisions: [{ kind: 'message', id: msg, decision: 'confirmed' }] }));
  });

  test('release confirms every place still undecided, keeping it masked', async () => {
    const id = await note('Plant room', PLANT);
    const th = await thread();
    const msg = await post(ben, th, `Use ${SECRET} for the vault.`);
    const caseId = await reported(ada, 'source', id);
    await ok(release(own, caseId));
    const row = (await t.pool.query(`SELECT masked, decision, decided_by FROM quarantine_possible_copies WHERE case_id = $1 AND item_id = $2`, [caseId, msg])).rows[0];
    assert.deepEqual(row, { masked: true, decision: 'confirmed', decided_by: ids.own });
    assert.equal((await t.pool.query(`SELECT role FROM quarantine_items WHERE case_id = $1 AND item_id = $2`, [caseId, msg])).rows[0].role, 'copy');
    const ev = (await t.pool.query(`SELECT actor_id, detail FROM quarantine_events WHERE case_id = $1 AND action = 'copy_confirmed'`, [caseId])).rows;
    assert.deepEqual(ev, [{ actor_id: ids.own, detail: { auto: true } }]);
    const shown = (await ok(ben.request('GET', `/threads/${th}`))).messages.find((m: { id: string }) => m.id === msg);
    assert.equal(shown.text, `Use ${MARKER} for the vault.`);
    assert.equal(shown.quarantineLabel ?? null, null);
  });

  test('an uncleaned held task stays hidden until the key cleans it', async () => {
    await t.close();
    await boot(false);
    const task = uuidv7();
    await t.pool.query(
      `INSERT INTO tasks (id, project_id, depth, title, assignee_id, due_on, status, authorised_by, authorised_at)
       VALUES ($1, $2, 0, $3, $4, '2026-11-16', 'not_started', $5, now())`,
      [task, project, `Rotate the osprey vault code ${SECRET}`, ids.ben, ids.own],
    );
    const caseId = await reported(ada, 'task', task);
    assert.deepEqual((await ok(ben.request('GET', `/projects/${project}/records`))).tasks, []);
    assert.equal((await ben.request('GET', `/records/tasks/${task}`)).status, 404);
    // The reviewer sees that it waits, never the text; it cannot be released or marked yet.
    const view = await ok(pm.request('GET', `/quarantine/cases/${caseId}`));
    assert.equal(view.text, null);
    assert.equal(view.label, 'Waiting for the protected key');
    assert.ok(!json(view).includes(SECRET));
    assert.equal((await release(pm, caseId)).status, 409);
  });

  test('the reporter and the PM are told when released', async () => {
    const id = await note('Plant room', PLANT);
    const caseId = await reported(ada, 'source', id);
    await ok(release(own, caseId));
    const notes = (await t.pool.query(`SELECT user_id, summary, link, urgent FROM notifications WHERE kind = 'quarantine_released' ORDER BY user_id`)).rows;
    assert.deepEqual(notes.map((n) => n.user_id).sort(), [ids.ada, ids.pm].sort());
    for (const n of notes) {
      assert.equal(n.summary, 'The item held for a suspected credential in Alpha Project (a note) was released after review, with the credential removed.');
      assert.equal(n.link, `#/notes/${id}`);
      assert.ok(!n.summary.includes(SECRET) && !n.summary.includes('kestrel'));
    }
    // Kainow's own report has no person to tell: the PM only.
    const second = await note('Second', `Second vault: ${SECRET} again.`);
    const { CasesService } = await import('./cases.service');
    const kainowCase = (await t.app.get(CasesService).report('kainow', { projectId: project, kind: 'source', id: second, marked: [SECRET], reason: null })).caseId;
    await ok(release(pm, kainowCase));
    const told = (await t.pool.query(`SELECT user_id FROM notifications WHERE kind = 'quarantine_released' AND link = $1`, [`#/notes/${second}`])).rows;
    assert.deepEqual(told.map((n) => n.user_id), [ids.pm]);
  });

  test('report and release work while Closed', async () => {
    // Task 11's test of the same name covers reporting in Closed and Deferred; this one releases too (Review Focus 5).
    const id = await note('Plant room', PLANT);
    const second = await note('Second room', 'Second vault: Zq7harbor-Lantern9.');
    await t.pool.query(`UPDATE projects SET status = 'closed', closure_outcome = 'abandoned' WHERE id = $1`, [project]);
    const caseId = await reported(ada, 'source', id);
    assert.equal((await ok(pm.request('GET', `/quarantine/cases/${caseId}`))).state, 'cleaned');
    await ok(release(pm, caseId));
    assert.equal((await t.pool.query(`SELECT state FROM quarantine_cases WHERE id = $1`, [caseId])).rows[0].state, 'released');
    assert.equal((await ben.request('GET', `/notes/${id}`)).status, 200);
    await t.pool.query(`UPDATE projects SET status = 'deferred', closure_outcome = NULL WHERE id = $1`, [project]);
    const again = await reported(ada, 'source', second, ['Zq7harbor-Lantern9']);
    await ok(pm.request('POST', `/quarantine/cases/${again}/mark-more`, { marked: ['Second vault'] }));
    await ok(release(spo, again));
    assert.equal((await t.pool.query(`SELECT state FROM quarantine_cases WHERE id = $1`, [again])).rows[0].state, 'released');
  });

  test('a quote that held the secret shows Quote changed, and a withheld upload says so', async () => {
    const id = await note('Plant room', PLANT);
    const v1 = (await t.pool.query(`SELECT id FROM source_versions WHERE source_id = $1 AND version_no = 1`, [id])).rows[0].id as string;
    const quote = `vault code is ${SECRET}`;
    const start = PLANT.indexOf(quote);
    const run = uuidv7();
    await t.pool.query(`INSERT INTO extraction_runs (id, source_version_id, requested_by, status, created_at) VALUES ($1, $2, $3, 'succeeded', now())`, [run, v1, ids.pm]);
    const quoted = uuidv7();
    const plain = uuidv7();
    for (const [item, q, s, pos] of [[quoted, quote, start, 0], [plain, 'pump service is booked', PLANT.indexOf('pump service is booked'), 1]] as const) {
      await t.pool.query(
        `INSERT INTO extraction_items (id, run_id, source_version_id, position, kind, text, quote, quote_start, quote_end, quote_matches, created_at)
         VALUES ($1, $2, $3, $4, 'action', 'Rotate it', $5, $6, $7, 1, now())`,
        [item, run, v1, pos, q, s, s + q.length],
      );
    }
    await laterVersion(id, PLANT, Buffer.from(`PK fake docx holding ${SECRET}`));
    const caseId = await reported(ada, 'source', id);
    await ok(pm.request('POST', `/quarantine/cases/${caseId}/release`, { reason: 'Checked' }));
    const view = await ok(pm.request('GET', `/extractions/${run}`));
    const byId = new Map(view.items.map((i: { id: string }) => [i.id, i]));
    assert.equal((byId.get(quoted) as { quoteChanged: string | null }).quoteChanged, QUOTE_CHANGED_TEXT);
    assert.equal((byId.get(plain) as { quoteChanged: string | null }).quoteChanged, null);
    assert.ok(!json(view).includes(SECRET));
    const shown = await ok(pm.request('GET', `/notes/${id}`));
    assert.deepEqual(shown.versions.map((v: { originalWithheld: string | null }) => v.originalWithheld), [null, WITHHELD_TEXT]);
    assert.equal((await pm.request('GET', `/notes/${id}/versions/2/original`)).status, 404);
  });

  test('a moderation reason containing an sk- key is refused', async () => {
    const th = await thread();
    const msg = await post(ben, th, 'Off topic chatter.');
    const r = await pm.request('POST', `/messages/${msg}/hide`, { reason: `Pasted ${KEY} by mistake` });
    assert.equal(r.status, 400, json(r.body));
    assert.equal(r.body.message, 'Not posted: this looks like it contains API secret key (sk-). Remove it and post again.');
    assert.ok(!json(r.body).includes(KEY));
    assert.equal((await t.pool.query(`SELECT state FROM discussion_messages WHERE id = $1`, [msg])).rows[0].state, 'visible');
    await ok(pm.request('POST', `/messages/${msg}/hide`, { reason: 'Off topic' }));
  });

  test('a grant purpose containing an sk- key is refused', async () => {
    const r = await pm.request('POST', `/projects/${project}/grants`, {
      kind: 'audit', purpose: `Audit of the vault; key ${KEY}`, scope: 'Everything', startsOn: '2026-11-14', expiresOn: '2026-11-30', userId: ids.admin, inspectDeleted: false,
    });
    assert.equal(r.status, 400, json(r.body));
    assert.ok(String(r.body.message).includes('API secret key (sk-)'));
    assert.ok(!json(r.body).includes(KEY));
    assert.equal(await count(`SELECT count(*) AS n FROM access_grants`), 0);
  });
});
