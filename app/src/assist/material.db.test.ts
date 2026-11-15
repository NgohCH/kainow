import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { uuidv7 } from '../common/uuid7';
import { sha256Hex } from '../notes/text';
import { type ProjectContext, ProjectAccess } from '../projects/access.service';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedProject, seedUser } from '../testing/projects';
import { type MaterialItem, type MaterialScope, findMaterial, readableMaterial, snapshotOf, stillReadable } from './material';
import { buildTerms } from './terms';

describe('material search', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  const ids: Record<string, string> = {};
  let project: string;
  let pm: Client;
  let ada: Client;

  const ctxOf = async (userId: string): Promise<ProjectContext> => {
    const ctx = await t.app.get(ProjectAccess).load(project, { id: userId, email: 'x@example.org', displayName: 'x', role: 'member' });
    assert.ok(ctx);
    return ctx;
  };
  const personal = async (userId: string): Promise<MaterialScope> => ({ kind: 'personal', ctx: await ctxOf(userId) });
  const threadScope = async (threadId: string): Promise<MaterialScope> => ({
    kind: 'thread',
    ctx: await ctxOf(ids.pm),
    threadAudienceId: (await t.pool.query(`SELECT audience_id FROM discussion_threads WHERE id = $1`, [threadId])).rows[0].audience_id,
  });
  const ask = async (scope: MaterialScope, question: string, opts?: Parameters<typeof findMaterial>[3]) => findMaterial(t.pool, scope, buildTerms(question), opts);
  const texts = (items: MaterialItem[]) => items.map((i) => i.text);
  const has = (items: MaterialItem[], fragment: string) => items.some((i) => i.text.includes(fragment));

  const note = async (title: string, text: string, by: Client = pm) => {
    const r = await by.request('POST', `/projects/${project}/notes`, { title, text });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.source.id as string;
  };
  const thread = async (c: Client, body: Record<string, unknown>) => {
    const r = await c.request('POST', `/projects/${project}/threads`, body);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.id as string;
  };
  const post = async (c: Client, threadId: string, body: string) => {
    const r = await c.request('POST', `/threads/${threadId}/messages`, { body });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.id as string;
  };
  /** A meeting with published minutes; Restricted to the named people when given. */
  const minutes = async (title: string, body: string, named?: string[]) => {
    const audience = named ? { mode: 'restricted', namedUserIds: named } : { mode: 'project', namedUserIds: [] };
    const id = await thread(pm, { kind: 'meeting', title, audience });
    const s = await pm.request('POST', `/threads/${id}/minutes`, { body, basedOnVersion: 0 });
    assert.equal(s.status, 201, JSON.stringify(s.body));
    const p = await pm.request('POST', `/threads/${id}/minutes/1/publish`);
    assert.equal(p.status, 200, JSON.stringify(p.body));
    return id;
  };
  const saveRequest = async (requester: string, items: MaterialItem[]) => {
    const id = uuidv7();
    await t.pool.query(
      `INSERT INTO ai_requests (id, project_id, kind, requested_by, status, scope, created_at) VALUES ($1, $2, 'question', $3, 'queued', 'personal', now())`,
      [id, project, requester],
    );
    for (const [n, i] of items.entries()) {
      await t.pool.query(
        `INSERT INTO ai_request_material (request_id, ordinal, marker, passage_id, record_kind, record_id, record_audience_id, snapshot, location)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [id, n, i.marker, i.passageId, i.recordKind, i.recordId, i.recordAudienceId, i.snapshot, i.location],
      );
    }
    return id;
  };

  beforeEach(async () => {
    t = await startTestApp();
    for (const k of ['pm', 'ada', 'ben']) ids[k] = await seedUser(t.pool, `${k}@example.org`);
    await t.pool.query(`UPDATE users SET display_name = 'Ada Lim' WHERE id = $1`, [ids.ada]);
    project = await seedProject(t.pool, {
      name: 'Alpha Project',
      status: 'active',
      members: [
        { userId: ids.pm, role: 'pm' },
        { userId: ids.pm, role: 'owner' },
        { userId: ids.ada, role: 'member' },
        { userId: ids.ben, role: 'member', expiresOn: '2026-11-10' },
      ],
    });
    [pm, ada] = [await t.signIn('pm@example.org'), await t.signIn('ada@example.org')];
  });
  afterEach(async () => {
    await t.close();
  });

  test('decided finds a decision passage', async () => {
    await note('Vendor review', 'Final call from the steering group: the team decides to keep the current vendor for the pump contract.');
    await note('Lunch', 'Sandwiches will be served at noon on Friday.');
    const found = await ask(await personal(ids.ada), 'What was decided?');
    assert.equal(found.length, 1, JSON.stringify(texts(found)));
    assert.match(found[0].text, /team decides to keep the current vendor/);
    assert.equal(found[0].marker, 'P1');
    assert.equal(found[0].recordKind, null);
    assert.match(found[0].location, /^Vendor review — Paragraph 1$/);
    assert.match(found[0].href, /^#\/notes\/[0-9a-f-]{36}$/);
    assert.ok(found[0].rank > 0);
  });

  test('Malay word matches exactly', async () => {
    await note('Nota mesyuarat', 'Mesyuarat seterusnya bersama pembekal akan diadakan pada hari Isnin di tapak projek.');
    await note('Other', 'The crane arrives next week and the road is closed.');
    const found = await ask(await personal(ids.ada), 'Bila mesyuarat dengan pembekal?');
    assert.deepEqual(texts(found), ['Mesyuarat seterusnya bersama pembekal akan diadakan pada hari Isnin di tapak projek.']);
    assert.deepEqual(texts(await ask(await personal(ids.ada), 'pembekalan')), [], 'a longer word is not the same word');
  });

  test('restricted minutes found for the PM, not for a Member', async () => {
    await minutes('Closed door', '## Budget\nThe turbine order is over budget by a wide margin.', [ids.ada]);
    assert.ok(has(await ask(await personal(ids.pm), 'turbine budget'), 'turbine order'), 'PM by role');
    assert.ok(has(await ask(await personal(ids.ada), 'turbine budget'), 'turbine order'), 'named person');
    assert.deepEqual(await ask(await personal(ids.ben), 'turbine budget'), [], 'Member outside the audience');
    const m = (await ask(await personal(ids.pm), 'turbine'))[0];
    assert.equal(m.location, 'Closed door — §Budget, paragraph 1');
  });

  test('thread scope excludes restricted minutes even for the PM', async () => {
    await minutes('Closed door', 'The turbine order is over budget.', [ids.ada]);
    await note('Open notes', 'The turbine was inspected and passed.');
    const open = await thread(pm, { kind: 'discussion', title: 'General' });
    const found = await ask(await threadScope(open), 'turbine');
    assert.deepEqual(texts(found), ['The turbine was inspected and passed.']);
  });

  test('thread scope of a restricted meeting admits its own minutes', async () => {
    const closed = await minutes('Closed door', 'The turbine order is over budget.', [ids.ada]);
    await minutes('Another closed door', 'The turbine warranty is disputed.', [ids.ada]);
    const message = await post(ada, closed, 'Turbine invoice attached for the record.');
    assert.ok(message);
    const found = await ask(await threadScope(closed), 'turbine');
    assert.deepEqual(texts(found).sort(), ['The turbine order is over budget.', 'Turbine invoice attached for the record.'].sort());
    const m = found.find((i) => i.text.startsWith('Turbine invoice')) as MaterialItem;
    assert.equal(m.href, `#/projects/${project}/threads/${closed}?m=1`);
    assert.match(m.location, /^Closed door — Message #1 by Ada Lim, 9 Nov \d\d:\d\d$/);
  });

  test('hidden message never found', async () => {
    const id = await thread(ada, { kind: 'discussion', title: 'Site access' });
    const hidden = await post(ada, id, 'The crane permit was refused by the council.');
    const deleted = await post(ada, id, 'The crane operator is on leave.');
    await post(ada, id, 'The crane arrives on Monday.');
    assert.equal((await pm.request('POST', `/messages/${hidden}/hide`, { reason: 'Off topic' })).status, 200);
    assert.equal((await pm.request('POST', `/messages/${deleted}/delete`, { reason: 'Off topic' })).status, 200);
    for (const who of [ids.pm, ids.ada]) {
      assert.deepEqual(texts(await ask(await personal(who), 'crane')), ['The crane arrives on Monday.']);
    }
    assert.deepEqual(texts(await ask(await threadScope(id), 'crane')), ['The crane arrives on Monday.']);
  });

  test('old message version not found, current one is', async () => {
    const id = await thread(ada, { kind: 'discussion', title: 'Deliveries' });
    const m = await post(ada, id, 'Gravel delivery on Tuesday.');
    const e = await ada.request('PUT', `/messages/${m}`, { body: 'Concrete delivery on Wednesday.', basedOnVersion: 1 });
    assert.equal(e.status, 200, JSON.stringify(e.body));
    assert.deepEqual(await ask(await personal(ids.ada), 'gravel'), []);
    assert.deepEqual(texts(await ask(await personal(ids.ada), 'concrete delivery')), ['Concrete delivery on Wednesday.']);
  });

  test('pending proposal only in personal scope, labelled', async () => {
    const sourceId = await note('Plant room', 'Walked through the plant room with the facilities team today.');
    const { rows } = await t.pool.query(`SELECT v.id, s.audience_id FROM source_versions v JOIN sources s ON s.id = v.source_id WHERE s.id = $1`, [sourceId]);
    const [{ id: versionId, audience_id: audienceId }] = rows;
    const run = uuidv7();
    await t.pool.query(`INSERT INTO extraction_runs (id, source_version_id, requested_by, status, created_at) VALUES ($1, $2, $3, 'succeeded', now())`, [run, versionId, ids.pm]);
    const item = uuidv7();
    await t.pool.query(
      `INSERT INTO extraction_items (id, run_id, source_version_id, position, kind, text, owner, due, quote, quote_matches, created_at)
       VALUES ($1, $2, $3, 0, 'action', 'Order spare filters for the chiller', 'Ada', 'next week', 'secret quoted wording', 0, now())`,
      [item, run, versionId],
    );
    await t.pool.query(
      `INSERT INTO human_proposals (id, project_id, kind, text, proposed_by, proposed_at) VALUES ($1, $2, 'risk', 'Chiller may fail in the heatwave', $3, now())`,
      [uuidv7(), project, ids.ada],
    );
    const task = uuidv7();
    await t.pool.query(
      `INSERT INTO tasks (id, project_id, depth, title, assignee_id, due_on, status, authorised_by, authorised_at)
       VALUES ($1, $2, 0, 'Service the chiller', $3, '2026-11-20', 'in_progress', $4, now())`,
      [task, project, ids.ada, ids.pm],
    );

    const mine = await ask(await personal(ids.ben), 'chiller');
    const proposal = mine.find((i) => i.recordKind === 'ai_proposal') as MaterialItem;
    assert.ok(proposal, JSON.stringify(mine));
    assert.equal(proposal.recordId, item);
    assert.equal(proposal.recordAudienceId, audienceId);
    assert.ok(proposal.snapshot?.startsWith('Proposed — not authorised: '), proposal.snapshot ?? '');
    assert.ok(!proposal.snapshot?.includes('secret quoted wording'), 'never the quote');
    assert.equal(proposal.text, proposal.snapshot);
    assert.equal(proposal.href, `#/runs/${run}`);
    const human = mine.find((i) => i.recordKind === 'human_proposal') as MaterialItem;
    assert.ok(human?.snapshot?.startsWith('Proposed — not authorised: Risk: Chiller may fail in the heatwave'));
    const authorised = mine.find((i) => i.recordKind === 'task') as MaterialItem;
    assert.equal(authorised.snapshot, 'Task: Service the chiller. Status: In progress. Assigned to: Ada Lim. Due: 2026-11-20.');
    assert.equal(authorised.href, `#/projects/${project}/work/${task}`);
    assert.equal(authorised.recordAudienceId, null);

    const open = await thread(pm, { kind: 'discussion', title: 'General' });
    const shared = await ask(await threadScope(open), 'chiller');
    assert.deepEqual(shared.map((i) => i.recordKind), ['task'], 'no pending proposals in thread scope');
    assert.deepEqual(await readableMaterial(t.pool, await threadScope(open), mine), mine.map((i) => i.recordKind === 'task'));

    // Ben's request used the proposal; narrowing its note's audience makes the answer unreadable for him.
    const request = await saveRequest(ids.ben, [proposal]);
    assert.equal(await stillReadable(t.pool, await ctxOf(ids.ben), request), true);
    await t.pool.query(`UPDATE audiences SET mode = 'restricted' WHERE id = $1`, [audienceId]);
    assert.equal(await stillReadable(t.pool, await ctxOf(ids.ben), request), false);
    assert.equal(await stillReadable(t.pool, await ctxOf(ids.pm), request), true);
    await t.pool.query(`UPDATE audiences SET mode = 'project' WHERE id = $1`, [audienceId]);

    // A proposal from Restricted minutes follows its source's audience.
    const closed = await minutes('Closed door', 'Chiller replacement costs were discussed in detail at length.', [ids.ada]);
    const cv = (await t.pool.query(`SELECT v.id FROM source_versions v JOIN sources s ON s.id = v.source_id WHERE s.thread_id = $1`, [closed])).rows[0].id;
    const run2 = uuidv7();
    await t.pool.query(`INSERT INTO extraction_runs (id, source_version_id, requested_by, status, created_at) VALUES ($1, $2, $3, 'succeeded', now())`, [run2, cv, ids.pm]);
    await t.pool.query(
      `INSERT INTO extraction_items (id, run_id, source_version_id, position, kind, text, quote, quote_matches, created_at)
       VALUES ($1, $2, $3, 0, 'decision', 'Replace the chiller next year', 'x', 0, now())`,
      [uuidv7(), run2, cv],
    );
    assert.ok(!has(await ask(await personal(ids.ben), 'chiller'), 'Replace the chiller'), 'outside the audience');
    assert.ok(has(await ask(await personal(ids.ada), 'chiller'), 'Replace the chiller'), 'named person');
  });

  test('budget stops at 40 passages or 30,000 characters', async () => {
    const block = (word: string, n: number, len: number) => `${word} paragraph ${n}. ${'Plain filler words about the site. '.repeat(60)}`.slice(0, len).trim();
    await note('Many short', Array.from({ length: 50 }, (_, i) => block('widget', i, 300)).join('\n\n'));
    const many = await ask(await personal(ids.ada), 'widget');
    assert.equal(many.length, 40);
    assert.deepEqual(many.map((i) => i.marker), Array.from({ length: 40 }, (_, i) => `P${i + 1}`));

    await note('Few long', Array.from({ length: 30 }, (_, i) => `${block('gadget', i, 1400)}${' More plain words.'.repeat(80)}`.slice(0, 1400).trim()).join('\n\n'));
    const long = await ask(await personal(ids.ada), 'gadget');
    const chars = long.reduce((n, i) => n + i.text.length, 0);
    assert.ok(chars <= 30_000, String(chars));
    assert.ok(chars + 1400 > 30_000, 'stops only when the next passage would not fit');
    assert.equal(long.length, 21);
  });

  test("stillReadable turns false after the viewer's membership expires", async () => {
    await note('Open notes', 'The boiler service is booked for Thursday.');
    const found = await ask(await personal(ids.ben), 'boiler');
    assert.equal(found.length, 1);
    const request = await saveRequest(ids.ben, found);
    assert.equal(await stillReadable(t.pool, await ctxOf(ids.ben), request), true);
    t.clock.advanceMinutes(2 * 24 * 60);
    assert.equal(await stillReadable(t.pool, await ctxOf(ids.ben), request), false);
    assert.equal(await stillReadable(t.pool, await ctxOf(ids.ada), request), true);
  });

  test('stillReadable survives an edit, not hiding or a narrowed audience', async () => {
    const id = await thread(ada, { kind: 'discussion', title: 'Plant' });
    const m = await post(ada, id, 'The boiler pressure is low.');
    const request = await saveRequest(ids.ada, await ask(await personal(ids.ada), 'boiler'));
    assert.equal((await ada.request('PUT', `/messages/${m}`, { body: 'The boiler pressure is fine now.', basedOnVersion: 1 })).status, 200);
    assert.equal(await stillReadable(t.pool, await ctxOf(ids.ada), request), true, 'an edit does not make the old version unreadable');
    assert.equal((await pm.request('POST', `/messages/${m}/hide`, { reason: 'Off topic' })).status, 200);
    assert.equal(await stillReadable(t.pool, await ctxOf(ids.ada), request), false);

    const source = await note('Plant notes', 'The boiler was replaced in March.');
    const r2 = await saveRequest(ids.ben, await ask(await personal(ids.ben), 'replaced boiler'));
    assert.equal(await stillReadable(t.pool, await ctxOf(ids.ben), r2), true);
    const audience = (await t.pool.query(`SELECT audience_id FROM sources WHERE id = $1`, [source])).rows[0].audience_id;
    await t.pool.query(`UPDATE audiences SET mode = 'restricted' WHERE id = $1`, [audience]);
    assert.equal(await stillReadable(t.pool, await ctxOf(ids.ben), r2), false);
    assert.equal(await stillReadable(t.pool, await ctxOf(ids.pm), r2), true, 'the PM is in every Restricted audience');
  });

  test('chosen owners with no terms come in document order', async () => {
    const a = await note('First', `Alpha one. ${'x '.repeat(120)}\n\nAlpha two. ${'y '.repeat(120)}`);
    await note('Second', 'Unrelated text that is not chosen.');
    const found = await findMaterial(t.pool, await personal(ids.ada), [], { sourceIds: [a] });
    assert.deepEqual(found.map((i) => i.text.slice(0, 9)), ['Alpha one', 'Alpha two']);
    assert.deepEqual(await findMaterial(t.pool, await personal(ids.ada), []), []);
  });

  test('deleted, submitted and returned notes and a discussion transcript are never found', async () => {
    await note('Kept', 'The generator inspection passed on Monday.');
    const gone = await note('Gone', 'The generator lease ends in June.');
    const waiting = await note('Waiting', 'The generator fuel order is waiting for review.');
    const sentBack = await note('Sent back', 'The generator noise complaint needs more detail.');
    await t.pool.query(`UPDATE sources SET status = 'deleted' WHERE id = $1`, [gone]);
    await t.pool.query(`UPDATE sources SET publication = 'submitted', submitted_by = $2 WHERE id = $1`, [waiting, ids.ada]);
    await t.pool.query(`UPDATE sources SET publication = 'returned', submitted_by = $2, returned_reason = 'Needs detail' WHERE id = $1`, [sentBack, ids.ada]);

    // A thread's transcript source is never indexed; even a passage written for one directly is not material.
    const talk = await thread(pm, { kind: 'discussion', title: 'Generators' });
    const audience = (await t.pool.query(`SELECT audience_id FROM discussion_threads WHERE id = $1`, [talk])).rows[0].audience_id;
    const [source, version] = [uuidv7(), uuidv7()];
    const text = '[#1 · pm] The generator transcript mentions the lease.';
    await t.pool.query(
      `INSERT INTO sources (id, title, created_by, created_at, project_id, kind, audience_id, thread_id) VALUES ($1, 'Discussion: Generators', $2, now(), $3, 'discussion', $4, $5)`,
      [source, ids.pm, project, audience, talk],
    );
    await t.pool.query(
      `INSERT INTO source_versions (id, source_id, version_no, origin, text_content, text_sha256, char_count, created_by, created_at)
       VALUES ($1, $2, 1, 'discussion', $3, $4, $5, $6, now())`,
      [version, source, text, sha256Hex(text), text.length, ids.pm],
    );
    await t.pool.query(
      `INSERT INTO passages (id, project_id, owner_kind, owner_id, ordinal, location, start_offset, end_offset, body) VALUES ($1, $2, 'source_version', $3, 0, 'Paragraph 1', 0, $4, $5)`,
      [uuidv7(), project, version, text.length, text],
    );

    for (const scope of [await personal(ids.pm), await personal(ids.ada), await threadScope(talk)]) {
      assert.deepEqual(texts(await ask(scope, 'generator')), ['The generator inspection passed on Monday.']);
    }
  });

  test('stillReadable turns false after a note used by a request is deleted', async () => {
    const source = await note('Plant notes', 'The boiler flue was cleaned on Tuesday.');
    const request = await saveRequest(ids.ada, await ask(await personal(ids.ada), 'boiler flue'));
    assert.equal(await stillReadable(t.pool, await ctxOf(ids.ada), request), true);
    await t.pool.query(`UPDATE sources SET status = 'deleted' WHERE id = $1`, [source]);
    assert.equal(await stillReadable(t.pool, await ctxOf(ids.ada), request), false);
    assert.equal(await stillReadable(t.pool, await ctxOf(ids.pm), request), false, 'not even for the PM');
  });

  test('snapshotOf renders Kainow fields only', () => {
    assert.equal(snapshotOf('risk', { text: 'Flooding', status: 'open', severity: 'high', person: null, due: '2026-12-01', mitigation: 'Sandbags' }), 'Risk: Flooding. Severity: High. Status: Open. Review on: 2026-12-01. Mitigation: Sandbags.');
    assert.equal(snapshotOf('question', { text: 'Who signs?', status: 'answered', person: 'Ada Lim', answers: ['The Owner signs.'] }), 'Question: Who signs? Status: Answered. Asked by: Ada Lim. Answer: The Owner signs.');
  });
});
