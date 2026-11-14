import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { uuidv7 } from '../common/uuid7';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedProject, seedUser } from '../testing/projects';
import { insertAiDraft } from './meetings.service';
import { MEETING_STILL_OPEN } from './publishing.service';

const KEY = `sk-${'a1B2c3D4e5'.repeat(3)}`;

describe('publishing minutes, member submissions and note audiences', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let autoOn: boolean;
  const ids: Record<string, string> = {};
  let project: string;
  let pm: Client;
  let deputy: Client;
  let sponsor: Client;
  let ada: Client;
  let ben: Client;
  let meeting: string;

  const startMeeting = async (c: Client, body: Record<string, unknown> = { kind: 'meeting', title: 'Weekly check-in' }) => {
    const r = await c.request('POST', `/projects/${project}/threads`, body);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.id as string;
  };
  const saveMinutes = async (c: Client, id: string, body: string, based = 0) => {
    const r = await c.request('POST', `/threads/${id}/minutes`, { body, basedOnVersion: based });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  };
  const publish = (c: Client, id = meeting, n = 1) => c.request('POST', `/threads/${id}/minutes/${n}/publish`);
  const count = async (sql: string, params: unknown[] = []) => Number((await t.pool.query(sql, params)).rows[0].n);
  const submitNote = (c: Client, extra: Record<string, unknown> = {}) =>
    c.request('POST', `/projects/${project}/notes/submissions`, { title: 'Site visit notes', text: 'We saw the pump.', intendedMode: 'project', ...extra });
  const seedAiRun = async (threadId: string) => {
    const id = uuidv7();
    await t.pool.query(`INSERT INTO analysis_runs (id, thread_id, kind, trigger, requested_by, status, created_at) VALUES ($1, $2, 'minutes', 'button', $3, 'succeeded', now())`, [id, threadId, ids.ada]);
    return id;
  };

  beforeEach(async () => {
    autoOn = true;
    t = await startTestApp(undefined, { automaticAnalysis: { isOn: async () => autoOn } });
    for (const k of ['pm', 'deputy', 'sponsor', 'ada', 'ben', 'outsider']) ids[k] = await seedUser(t.pool, `${k}@example.org`);
    project = await seedProject(t.pool, {
      name: 'Alpha Project',
      status: 'active',
      members: [
        { userId: ids.pm, role: 'pm' },
        { userId: ids.pm, role: 'owner' },
        { userId: ids.deputy, role: 'deputy_pm' },
        { userId: ids.sponsor, role: 'sponsor' },
        { userId: ids.ada, role: 'member' },
        { userId: ids.ben, role: 'member' },
      ],
    });
    [pm, deputy, sponsor, ada, ben] = [
      await t.signIn('pm@example.org'),
      await t.signIn('deputy@example.org'),
      await t.signIn('sponsor@example.org'),
      await t.signIn('ada@example.org'),
      await t.signIn('ben@example.org'),
    ];
    meeting = await startMeeting(ada);
  });
  afterEach(async () => {
    await t.close();
  });

  test("publishing creates a minutes source with the meeting's audience", async () => {
    const closed = await startMeeting(pm, { kind: 'meeting', title: 'Closed door', audience: { mode: 'restricted', namedUserIds: [ids.ada] } });
    await saveMinutes(pm, closed, '## Minutes\nAgreed to ship.');
    const r = await publish(pm, closed);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.versionNo, 1);
    assert.equal(r.body.notice, MEETING_STILL_OPEN, 'the meeting is open');
    const src = (await t.pool.query(`SELECT s.*, t.audience_id AS t_aud FROM sources s JOIN discussion_threads t ON t.id = s.thread_id WHERE s.id = $1`, [r.body.sourceId])).rows[0];
    assert.equal(src.kind, 'minutes');
    assert.equal(src.title, 'Closed door');
    assert.equal(src.audience_id, src.t_aud, 'the same audience row');
    assert.equal(src.publication, 'published');
    const v = (await t.pool.query(`SELECT origin, minutes_draft_id, text_content FROM source_versions WHERE source_id = $1`, [src.id])).rows[0];
    assert.equal(v.origin, 'meeting');
    assert.ok(v.minutes_draft_id);
    assert.equal(v.text_content, '## Minutes\nAgreed to ship.');
    assert.equal((await t.pool.query(`SELECT detail FROM discussion_events WHERE thread_id = $1 AND action = 'minutes_published'`, [closed])).rowCount, 1);
    // Restricted to Ada: she and the managers read it, Ben does not.
    for (const c of [pm, ada]) assert.equal((await c.request('GET', `/notes/${src.id}`)).status, 200);
    const detail = (await ada.request('GET', `/notes/${src.id}`)).body.source;
    assert.equal(detail.label, 'Minutes — from meeting');
    assert.equal((await ben.request('GET', `/notes/${src.id}`)).status, 404);
    // Ended meetings publish too, with no notice.
    assert.equal((await pm.request('POST', `/threads/${closed}/end`)).status, 200);
    await saveMinutes(pm, closed, 'Second text.', 1);
    const again = await publish(pm, closed, 2);
    assert.equal(again.body.notice, null);
  });

  test('second publish adds version 2, and the same text again is refused', async () => {
    await saveMinutes(pm, meeting, 'First text.');
    const first = await publish(pm);
    await saveMinutes(pm, meeting, 'Second text.', 1);
    const second = await publish(pm, meeting, 2);
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.equal(second.body.sourceId, first.body.sourceId);
    assert.equal(second.body.versionNo, 2);
    assert.equal(await count(`SELECT count(*) AS n FROM sources WHERE thread_id = $1`, [meeting]), 1);
    // Publishing draft 1 again would repeat nothing: its text differs from version 2, so it is version 3.
    assert.equal((await publish(pm, meeting, 2)).status, 409);
    const list = (await ben.request('GET', `/projects/${project}/notes`)).body.sources;
    assert.deepEqual(list.map((s: any) => [s.title, s.kind, s.label, s.latestVersion]), [['Weekly check-in', 'minutes', 'Minutes — from meeting', 2]]);
  });

  test('published minutes extraction shows "Automatic: minutes published"', async () => {
    await saveMinutes(pm, meeting, 'Ali will email Sam.');
    const r = await publish(pm);
    assert.ok(r.body.extractionRunId);
    const row = (await t.pool.query(`SELECT requested_by, trigger, status FROM extraction_runs WHERE id = $1`, [r.body.extractionRunId])).rows[0];
    assert.deepEqual(row, { requested_by: null, trigger: 'minutes_published', status: 'queued' });
    const run = await pm.request('GET', `/extractions/${r.body.extractionRunId}`);
    assert.equal(run.status, 200, JSON.stringify(run.body));
    assert.equal(run.body.run.requestedByLabel, 'Automatic: minutes published');
    const runs = await pm.request('GET', `/notes/${r.body.sourceId}/versions/1/extractions`);
    assert.equal(runs.body.runs[0].requestedByLabel, 'Automatic: minutes published');
  });

  test('no automatic extraction when automatic analysis is off', async () => {
    autoOn = false;
    await saveMinutes(pm, meeting, 'Ali will email Sam.');
    const r = await publish(pm);
    assert.equal(r.status, 200);
    assert.equal(r.body.extractionRunId, null);
    assert.equal(await count(`SELECT count(*) AS n FROM extraction_runs`), 0);
    // Run extraction still works as today.
    assert.equal((await pm.request('POST', `/notes/${r.body.sourceId}/versions/1/extractions`)).status, 202);
  });

  test('provenance names the AI draft, the editors and the publisher', async () => {
    const run = await seedAiRun(meeting);
    await insertAiDraft(t.pool, meeting, { body: '# Draft\nPump agreed.', coversThroughNo: 3, analysisRunId: run });
    await saveMinutes(ada, meeting, '# Draft\nPump agreed on Friday.', 1);
    await saveMinutes(pm, meeting, '# Draft\nPump agreed on Friday by Ali.', 2);
    const r = await publish(deputy, meeting, 3);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const detail = (await pm.request('GET', `/notes/${r.body.sourceId}`)).body;
    assert.equal(detail.source.provenance, 'Drafted by AI from meeting Weekly check-in; edited by ada, pm; published by deputy on 9 Nov 2026');
    // An unedited AI draft omits "edited by".
    const m2 = await startMeeting(ada, { kind: 'meeting', title: 'Second' });
    await insertAiDraft(t.pool, m2, { body: 'Plain.', coversThroughNo: 1, analysisRunId: await seedAiRun(m2) });
    const p2 = await publish(pm, m2, 1);
    assert.equal((await pm.request('GET', `/notes/${p2.body.sourceId}/versions/1`)).body.version.provenance, 'Drafted by AI from meeting Second; published by pm on 9 Nov 2026');
    // Ordinary notes carry no provenance.
    const plain = (await pm.request('POST', `/projects/${project}/notes`, { title: 'Plain', text: 'x' })).body.source.id;
    assert.equal((await pm.request('GET', `/notes/${plain}`)).body.source.provenance, null);
  });

  test('Member submission is visible only to submitter and managers', async () => {
    const made = await submitNote(ada, { text: 'Zebrafish pump notes.' });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const id = made.body.id as string;
    const row = (await t.pool.query(`SELECT publication, submitted_by, intended_mode, kind FROM sources WHERE id = $1`, [id])).rows[0];
    assert.deepEqual(row, { publication: 'submitted', submitted_by: ids.ada, intended_mode: 'project', kind: 'notes' });
    for (const c of [ada, pm, deputy, sponsor]) {
      assert.equal((await c.request('GET', `/notes/${id}`)).status, 200);
      assert.equal((await c.request('GET', `/notes/${id}/versions/1`)).status, 200);
    }
    assert.equal((await ben.request('GET', `/notes/${id}`)).status, 404);
    assert.equal((await ben.request('GET', `/notes/${id}/versions/1`)).status, 404);
    assert.equal((await ben.request('GET', `/notes/${id}/versions/1/extractions`)).status, 404);
    // Never in the notes list, never analysed, never searched by anyone but the submitter and the managers.
    for (const c of [ada, pm, ben]) assert.deepEqual((await c.request('GET', `/projects/${project}/notes`)).body.sources, []);
    assert.equal((await pm.request('POST', `/notes/${id}/versions/1/extractions`)).status, 409);
    assert.equal((await pm.request('POST', `/notes/${id}/versions`, { text: 'more' })).status, 409);
    for (const [c, n] of [[ben, 0], [pm, 1], [ada, 1], [deputy, 1], [sponsor, 1]] as Array<[Client, number]>) {
      const found = (await c.request('GET', '/search?q=Zebrafish')).body.projects.flatMap((p: any) => p.results);
      assert.equal(found.length, n);
    }
    // The discussion list shows it to the submitter and managers only.
    const listed = async (c: Client) => (await c.request('GET', `/projects/${project}/discussion`)).body.items.filter((i: any) => i.kind === 'submission');
    assert.deepEqual((await listed(ada)).map((i: any) => [i.title, i.label]), [['Site visit notes', 'Submitted for review']]);
    assert.equal((await listed(pm)).length, 1);
    assert.equal((await listed(ben)).length, 0);
  });

  test('a submission with a secret is refused and nothing is stored', async () => {
    const r = await submitNote(ada, { text: `the key is ${KEY}` });
    assert.equal(r.status, 400);
    assert.match(r.body.message, /^Not posted: this looks like it contains /);
    assert.equal(await count(`SELECT count(*) AS n FROM sources`), 0);
    assert.equal((await submitNote(ada, { intendedMode: 'everyone' })).status, 400);
    assert.equal((await submitNote(pm)).status, 201, 'a manager may submit too');
  });

  test('submission notifies PM, Deputy, Owner and Sponsors', async () => {
    const made = await submitNote(ada);
    const rows = (await t.pool.query(`SELECT user_id, kind, summary, link FROM notifications WHERE project_id = $1 ORDER BY user_id`, [project])).rows;
    assert.deepEqual(rows.map((r) => r.user_id).sort(), [ids.pm, ids.deputy, ids.sponsor].sort());
    for (const r of rows) {
      assert.equal(r.kind, 'minutes_submitted');
      assert.equal(r.summary, 'Minutes submitted for review: Site visit notes');
      assert.equal(r.link, `#/notes/${made.body.id}`);
      assert.ok(!r.summary.includes('pump'), 'titles only');
    }
  });

  test('the Member path from a meeting submits a draft, and a reviewer publishes it', async () => {
    await saveMinutes(ada, meeting, 'Minutes by Ada.');
    assert.equal((await ben.request('POST', `/threads/${meeting}/minutes/1/submit`)).status, 403, 'only the starter');
    const s = await ada.request('POST', `/threads/${meeting}/minutes/1/submit`);
    assert.equal(s.status, 201, JSON.stringify(s.body));
    assert.equal((await ada.request('POST', `/threads/${meeting}/minutes/1/submit`)).status, 409);
    assert.equal((await t.pool.query(`SELECT 1 FROM notifications WHERE kind = 'minutes_submitted' AND summary = 'Minutes submitted for review: Weekly check-in'`)).rowCount, 3);
    assert.equal((await ben.request('GET', `/notes/${s.body.id}`)).status, 404);
    assert.equal((await pm.request('POST', `/notes/${s.body.id}/publish`, { audience: { mode: 'project' } })).status, 400, 'the meeting keeps its audience');
    t.clock.advanceSeconds(86_400);
    [pm, ada, ben] = [await t.signIn('pm@example.org'), await t.signIn('ada@example.org'), await t.signIn('ben@example.org')]; // old sessions have expired
    const pub = await pm.request('POST', `/notes/${s.body.id}/publish`);
    assert.equal(pub.status, 200, JSON.stringify(pub.body));
    // The reviewer and the day of publication are named, not the submitter and the day of submission.
    assert.equal((await pm.request('GET', `/notes/${s.body.id}`)).body.source.provenance, 'Written by ada for meeting Weekly check-in; published by pm on 10 Nov 2026');
    assert.ok(pub.body.extractionRunId);
    assert.equal((await ben.request('GET', `/notes/${s.body.id}`)).status, 200);
    assert.equal((await t.pool.query(`SELECT 1 FROM discussion_events WHERE thread_id = $1 AND action = 'minutes_published'`, [meeting])).rowCount, 1);
    // Once published, a Member cannot submit again.
    assert.equal((await ada.request('POST', `/threads/${meeting}/minutes/1/submit`)).status, 409);
  });

  test('publishing the very draft a member submitted publishes that submission without a new version', async () => {
    await saveMinutes(ada, meeting, 'Minutes by Ada.');
    const s = await ada.request('POST', `/threads/${meeting}/minutes/1/submit`);
    assert.equal(s.status, 201, JSON.stringify(s.body));
    const pub = await pm.request('POST', `/threads/${meeting}/minutes/1/publish`);
    assert.equal(pub.status, 200, JSON.stringify(pub.body));
    assert.deepEqual([pub.body.sourceId, pub.body.versionNo], [s.body.id, 1]);
    assert.equal((await t.pool.query(`SELECT count(*)::int AS n FROM source_versions WHERE source_id = $1`, [s.body.id])).rows[0].n, 1);
    assert.equal((await t.pool.query(`SELECT publication FROM sources WHERE id = $1`, [s.body.id])).rows[0].publication, 'published');
    assert.equal((await ben.request('GET', `/notes/${s.body.id}`)).status, 200);
  });

  test('reviewer publishes with the chosen audience', async () => {
    const made = await submitNote(ada, { intendedMode: 'project' });
    const id = made.body.id as string;
    assert.equal((await pm.request('POST', `/notes/${id}/publish`, {})).status, 400, 'an audience must be chosen');
    const r = await pm.request('POST', `/notes/${id}/publish`, { audience: { mode: 'restricted', namedUserIds: [ids.ben] } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.versionNo, 1);
    assert.ok(r.body.extractionRunId, 'automatic extraction follows');
    const src = (await t.pool.query(`SELECT s.publication, a.mode FROM sources s JOIN audiences a ON a.id = s.audience_id WHERE s.id = $1`, [id])).rows[0];
    assert.deepEqual(src, { publication: 'published', mode: 'restricted' });
    // Named Ben reads it; the submitter, now outside the restricted audience, does not.
    assert.equal((await ben.request('GET', `/notes/${id}`)).status, 200);
    assert.equal((await ada.request('GET', `/notes/${id}`)).status, 404);
    assert.deepEqual((await ben.request('GET', `/projects/${project}/notes`)).body.sources.map((s: any) => s.title), ['Site visit notes']);
    assert.deepEqual((await ada.request('GET', `/projects/${project}/notes`)).body.sources, []);
    assert.equal((await pm.request('POST', `/notes/${id}/publish`, { audience: { mode: 'project' } })).status, 409, 'already published');
    // A named person from outside the project is refused.
    const second = (await submitNote(ada, { title: 'Another' })).body.id;
    assert.equal((await pm.request('POST', `/notes/${second}/publish`, { audience: { mode: 'restricted', namedUserIds: [ids.outsider] } })).status, 400);
    assert.equal((await t.pool.query(`SELECT publication FROM sources WHERE id = $1`, [second])).rows[0].publication, 'submitted');
  });

  test('only people the server allows are offered a new version', async () => {
    const id = (await submitNote(ada)).body.id as string;
    assert.equal((await ada.request('GET', `/notes/${id}`)).body.mayAddVersion, false, 'submitted: waits for a reviewer');
    assert.equal((await pm.request('POST', `/notes/${id}/return`, { reason: 'Add the attendees.' })).status, 200);
    assert.equal((await ada.request('GET', `/notes/${id}`)).body.mayAddVersion, true, 'the submitter revises a returned submission');
    assert.equal((await pm.request('GET', `/notes/${id}`)).body.mayAddVersion, false, 'a reviewer cannot revise it');
    assert.equal((await ada.request('POST', `/notes/${id}/versions`, { text: 'Revised.' })).status, 201);
    assert.equal((await pm.request('POST', `/notes/${id}/publish`, { audience: { mode: 'project' } })).status, 200);
    assert.equal((await pm.request('GET', `/notes/${id}`)).body.mayAddVersion, true);
    assert.equal((await ada.request('GET', `/notes/${id}`)).body.mayAddVersion, false, 'a Member cannot add to published notes');
    await saveMinutes(pm, meeting, 'Meeting minutes.');
    const minutes = await publish(pm);
    assert.equal((await pm.request('GET', `/notes/${minutes.body.sourceId}`)).body.mayAddVersion, false, 'minutes get versions from the meeting');
  });

  test('return needs a reason and notifies the submitter', async () => {
    const id = (await submitNote(ada)).body.id as string;
    assert.equal((await pm.request('POST', `/notes/${id}/return`, {})).status, 400);
    assert.equal((await pm.request('POST', `/notes/${id}/return`, { reason: '   ' })).status, 400);
    const r = await deputy.request('POST', `/notes/${id}/return`, { reason: 'Please add the attendees.' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const note = (await t.pool.query(`SELECT user_id, kind, summary, link FROM notifications WHERE kind = 'minutes_returned'`)).rows;
    assert.deepEqual(note, [{ user_id: ids.ada, kind: 'minutes_returned', summary: 'Minutes returned: Site visit notes', link: `#/notes/${id}` }]);
    const detail = (await ada.request('GET', `/notes/${id}`)).body.source;
    assert.equal(detail.publication, 'returned');
    assert.equal(detail.returnedReason, 'Please add the attendees.');
    assert.equal((await ben.request('GET', `/notes/${id}`)).status, 404);
    assert.equal((await pm.request('POST', `/notes/${id}/return`, { reason: 'again' })).status, 409);
    assert.equal((await pm.request('POST', `/notes/${id}/publish`, { audience: { mode: 'project' } })).status, 409, 'a returned submission is not published');
  });

  test('a returned meeting submission can be submitted again by its starter', async () => {
    await saveMinutes(ada, meeting, 'Minutes by Ada.');
    const s = await ada.request('POST', `/threads/${meeting}/minutes/1/submit`);
    assert.equal((await pm.request('POST', `/notes/${s.body.id}/return`, { reason: 'Add owners.' })).status, 200);
    assert.equal((await t.pool.query(`SELECT reason FROM discussion_events WHERE thread_id = $1 AND action = 'submission_returned'`, [meeting])).rows[0].reason, 'Add owners.');
    await saveMinutes(ada, meeting, 'Minutes by Ada, with owners.', 1);
    const again = await ada.request('POST', `/threads/${meeting}/minutes/2/submit`);
    assert.equal(again.status, 201, JSON.stringify(again.body));
    assert.equal(again.body.id, s.body.id);
    assert.equal(again.body.latestVersion, 2);
    assert.equal((await t.pool.query(`SELECT publication, returned_reason FROM sources WHERE id = $1`, [s.body.id])).rows[0].publication, 'submitted');
  });

  test('the submitter revises a returned submission; nobody else can', async () => {
    const id = (await submitNote(ada)).body.id as string;
    await t.pool.query(`DELETE FROM notifications`);
    const add = (c: Client, text: string) => c.request('POST', `/notes/${id}/versions`, { text });
    assert.equal((await add(ada, 'early revision')).status, 403, 'not while it waits for review');
    assert.equal((await pm.request('POST', `/notes/${id}/return`, { reason: 'Add the attendees.' })).status, 200);
    assert.equal((await add(ben, 'mine')).status, 404, 'another Member cannot see it');
    assert.equal((await add(pm, 'manager edit')).status, 409, 'a manager cannot add a version to a submission');
    assert.equal((await add(ada, `key ${KEY}`)).status, 400, 'secret check');
    assert.equal((await t.pool.query(`SELECT publication FROM sources WHERE id = $1`, [id])).rows[0].publication, 'returned');
    const ok = await add(ada, 'We saw the pump. Present: Ada, Ben.');
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(ok.body.version.versionNo, 2);
    const row = (await t.pool.query(`SELECT publication, returned_reason FROM sources WHERE id = $1`, [id])).rows[0];
    assert.deepEqual(row, { publication: 'submitted', returned_reason: null });
    const notes = (await t.pool.query(`SELECT user_id, kind, summary FROM notifications WHERE kind = 'minutes_submitted'`)).rows;
    assert.deepEqual(notes.map((n) => n.user_id).sort(), [ids.pm, ids.deputy, ids.sponsor].sort());
    assert.ok(notes.every((n) => n.kind === 'minutes_submitted' && n.summary === 'Minutes submitted for review: Site visit notes'));
    assert.equal((await pm.request('POST', `/notes/${id}/publish`, { audience: { mode: 'project' } })).status, 200);
  });

  test('Member cannot publish (403)', async () => {
    const id = (await submitNote(ada)).body.id as string;
    assert.equal((await ada.request('POST', `/notes/${id}/publish`, { audience: { mode: 'project' } })).status, 403);
    assert.equal((await ada.request('POST', `/notes/${id}/return`, { reason: 'no' })).status, 403);
    assert.equal((await ben.request('POST', `/notes/${id}/publish`, { audience: { mode: 'project' } })).status, 404, 'someone who cannot see it finds nothing');
    await saveMinutes(ada, meeting, 'Minutes.');
    assert.equal((await ada.request('POST', `/threads/${meeting}/minutes/1/publish`)).status, 403);
    assert.equal((await t.anonymous('POST', `/threads/${meeting}/minutes/1/publish`)).status, 401);
    assert.equal(await count(`SELECT count(*) AS n FROM sources WHERE kind = 'minutes'`), 0);
  });

  test('restricted note is 404 for a Member outside the audience in list, detail, version and original', async () => {
    const up = async (c: Client) => {
      const form = Buffer.from('{"plan": 1}'); // valid JSON so the test client can read the download back
      const boundary = '----kainow';
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="plan.txt"\r\nContent-Type: text/plain\r\n\r\n`),
        form,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      return c.upload('POST', `/projects/${project}/notes/upload`, body, `multipart/form-data; boundary=${boundary}`);
    };
    const made = await up(pm);
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const id = made.body.source.id as string;
    const audience = uuidv7();
    await t.pool.query(`INSERT INTO audiences (id, project_id, mode, created_at) VALUES ($1, $2, 'restricted', now())`, [audience, project]);
    await t.pool.query(`INSERT INTO audience_members (audience_id, user_id, added_by, added_at) VALUES ($1, $2, $3, now())`, [audience, ids.ada, ids.pm]);
    await t.pool.query(`UPDATE sources SET audience_id = $2 WHERE id = $1`, [id, audience]);
    for (const path of [`/notes/${id}`, `/notes/${id}/versions/1`, `/notes/${id}/versions/1/original`, `/notes/${id}/versions/1/extractions`]) {
      assert.equal((await ben.request('GET', path)).status, 404, `ben ${path}`);
      assert.equal((await ada.request('GET', path)).status, 200, `ada ${path}`);
      assert.equal((await pm.request('GET', path)).status, 200, `pm ${path}`);
    }
    assert.equal((await ben.request('POST', `/notes/${id}/versions/1/extractions`)).status, 404, 'not even the refusal reveals it');
    assert.deepEqual((await ben.request('GET', `/projects/${project}/notes`)).body.sources, []);
    assert.deepEqual((await ada.request('GET', `/projects/${project}/notes`)).body.sources.map((s: any) => s.id), [id]);
    assert.equal((await ben.request('GET', `/projects/${project}/discussion`)).body.items.filter((i: any) => i.kind === 'notes').length, 0);
    // A run on the note is just as closed to Ben.
    const run = await pm.request('POST', `/notes/${id}/versions/1/extractions`);
    assert.equal(run.status, 202, JSON.stringify(run.body));
    assert.equal((await ben.request('GET', `/extractions/${run.body.run.id}`)).status, 404);
    assert.equal((await ada.request('GET', `/extractions/${run.body.run.id}`)).status, 200);
  });

  test('discussion transcripts never appear in the notes list', async () => {
    const thread = await startMeeting(ada, { kind: 'discussion', title: 'Plain thread' });
    const audience = (await t.pool.query(`SELECT audience_id FROM discussion_threads WHERE id = $1`, [thread])).rows[0].audience_id;
    const source = uuidv7();
    await t.pool.query(
      `INSERT INTO sources (id, title, created_by, created_at, project_id, kind, audience_id, thread_id) VALUES ($1, 'Transcript', NULL, now(), $2, 'discussion', $3, $4)`,
      [source, project, audience, thread],
    );
    await t.pool.query(
      `INSERT INTO source_versions (id, source_id, version_no, origin, text_content, text_sha256, char_count, created_by, created_at)
       VALUES ($1, $2, 1, 'discussion', 'Ada: hello', 'x', 10, NULL, now())`,
      [uuidv7(), source],
    );
    await pm.request('POST', `/projects/${project}/notes`, { title: 'Real note', text: 'x' });
    for (const c of [pm, ada, ben]) assert.deepEqual((await c.request('GET', `/projects/${project}/notes`)).body.sources.map((s: any) => s.title), ['Real note']);
    assert.ok(!(await ada.request('GET', `/projects/${project}/discussion`)).body.items.some((i: any) => i.title === 'Transcript'));
    assert.equal((await pm.request('POST', `/notes/${source}/versions`, { text: 'tamper' })).status, 409);
  });

  test('minutes appear in the discussion list labelled, and only to their audience', async () => {
    await saveMinutes(pm, meeting, 'Minutes.');
    await publish(pm);
    const items = (await ben.request('GET', `/projects/${project}/discussion`)).body.items;
    assert.deepEqual(items.filter((i: any) => i.kind === 'minutes').map((i: any) => i.label), ['Minutes — from meeting']);
    assert.ok(items.some((i: any) => i.kind === 'meeting'));
  });
});
