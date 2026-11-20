import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { AuthUser } from '../auth/tokens';
import { ProjectAccess } from '../projects/access.service';
import { SKIP_NO_DB } from '../testing/db';
import { materialFor, seedDraft } from '../testing/drafts';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedProject, seedUser } from '../testing/projects';

const LABEL = 'Access review required';
const OUTSIDE_MATERIAL = 'Only people who can read all the material this output was built from can be in its audience.';
const MUST_RESTRICT = 'This output uses material some of the project’s readers cannot read, so it must be Restricted to people who can read it.';
const NAMED_OUTSIDE = 'Only people in this project can be named.';
const AUDIENCE_REFUSAL = 'Only the Project Manager, the Owner or a Sponsor can change who may read an output.';
const SECRET = 'Kp9vault-Rotor42';

describe('output audiences and review after removed material over HTTP', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  const ids: Record<string, string> = {};
  const c: Record<string, Client> = {};
  let project: string;
  const url = (p = '') => `/projects/${project}/outputs${p}`;
  const person = (k: string): AuthUser => ({ id: ids[k], email: `${k}@example.org`, displayName: k, role: 'member' });
  const typeId = async (name: string) => (await t.pool.query(`SELECT id FROM report_types WHERE name = $1`, [name])).rows[0].id as string;
  const ok = async (p: Promise<{ status: number; body: any }>, status = 200) => {
    const r = await p;
    assert.equal(r.status, status, JSON.stringify(r.body));
    return r.body;
  };

  const note = async (title: string, text: string) => (await ok(c.pm.request('POST', `/projects/${project}/notes`, { title, text }), 201)).source.id as string;
  const meeting = async (title: string, messages: string[], named?: string[]) => {
    const th = await ok(c.pm.request('POST', `/projects/${project}/threads`, { kind: 'meeting', title, ...(named ? { audience: { mode: 'restricted', namedUserIds: named } } : {}) }), 201);
    const out: string[] = [];
    for (const body of messages) out.push((await ok(c.pm.request('POST', `/threads/${th.id}/messages`, { body }), 201)).id);
    return out;
  };
  /** A registered output built from a shared draft of what `by` finds for `question`. */
  const registered = async (question: string, opts: { by?: string; title?: string; audience?: string[] } = {}) => {
    const by = opts.by ?? 'pm';
    const items = await materialFor(t.pool, t.app.get(ProjectAccess), project, person(by), question);
    assert.ok(items.length > 0, `material for ${question}`);
    const d = await seedDraft(t.pool, { projectId: project, requesterId: ids[by], items });
    const out = await ok(c[by].request('POST', url(), { kind: 'draft', draftVersionId: d.aiVersionId, format: 'md', title: opts.title ?? 'Weekly status' }), 201);
    const body: Record<string, unknown> = { reportTypeId: await typeId('Status reports') };
    if (opts.audience) body.audience = { mode: 'restricted', namedUserIds: opts.audience };
    await ok(c.pm.request('POST', url(`/${out.id}/register`), body));
    return out.id as string;
  };
  const audience = (who: Client, id: string, body: Record<string, unknown>) => who.request('PUT', url(`/${id}/audience`), body);
  const sees = async (id: string) => {
    const out: string[] = [];
    for (const k of ['pm', 'deputy', 'owner', 'sponsor', 'ada', 'bob']) if ((await c[k].request('GET', url(`/${id}`))).status === 200) out.push(k);
    return out;
  };
  const names = (xs: Array<{ id: string; name: string }>) => xs.map((x) => x.name);
  const outbox = async (id: string) =>
    (await t.pool.query(`SELECT job, urgent FROM storage_outbox WHERE subject_id = $1 AND sent_at IS NULL ORDER BY created_at, id`, [id])).rows.map((r) => [r.job, r.urgent]);
  const clearOutbox = () => t.pool.query(`DELETE FROM storage_outbox`);
  const state = async (id: string) => (await t.pool.query(`SELECT status, review_state FROM outputs WHERE id = $1`, [id])).rows[0];
  const events = async (id: string) => (await t.pool.query(`SELECT kind, actor_id, reason FROM output_events WHERE output_id = $1 ORDER BY at, id`, [id])).rows;
  const notified = async (id: string) =>
    (
      await t.pool.query(
        `SELECT u.display_name AS name, n.summary FROM notifications n JOIN users u ON u.id = n.user_id WHERE n.kind = 'output_access_review' AND n.link LIKE '%' || $1 ORDER BY u.display_name`,
        [id],
      )
    ).rows.map((r) => [r.name, r.summary]);

  beforeEach(async () => {
    t = await startTestApp();
    for (const k of ['pm', 'deputy', 'owner', 'sponsor', 'ada', 'bob', 'outsider']) ids[k] = await seedUser(t.pool, `${k}@example.org`);
    project = await seedProject(t.pool, {
      status: 'active',
      name: 'Pump station renewal',
      members: [
        { userId: ids.pm, role: 'pm' },
        { userId: ids.deputy, role: 'deputy_pm' },
        { userId: ids.owner, role: 'owner' },
        { userId: ids.sponsor, role: 'sponsor' },
        { userId: ids.ada, role: 'member' },
        { userId: ids.bob, role: 'member' },
      ],
    });
    for (const k of Object.keys(ids)) c[k] = await t.signIn(`${k}@example.org`);
  });
  afterEach(async () => t.close());

  test('PM, Owner or Sponsor change the audience with a reason; widening preview lists names gaining access', async () => {
    await note('Pump note', 'The kestrel pump service is booked for Thursday morning.');
    const id = await registered('kestrel pump');
    const narrow = { mode: 'restricted', userIds: [ids.pm, ids.owner, ids.ada], reason: 'Board only' };
    const preview = await ok(audience(c.owner, id, { ...narrow, preview: true }));
    assert.deepEqual(preview, { gaining: [], losing: [{ id: ids.bob, name: 'bob' }, { id: ids.deputy, name: 'deputy' }, { id: ids.sponsor, name: 'sponsor' }] });
    assert.deepEqual(await sees(id), ['pm', 'deputy', 'owner', 'sponsor', 'ada', 'bob'], 'a preview changes nothing');
    assert.equal((await audience(c.owner, id, { ...narrow, reason: '' })).status, 400, 'a reason is required');
    const r = await audience(c.deputy, id, narrow);
    assert.equal(r.status, 403);
    assert.equal(r.body.message, AUDIENCE_REFUSAL);
    assert.equal((await audience(c.ada, id, narrow)).status, 403);
    assert.equal((await audience(c.outsider, id, narrow)).status, 404);
    t.clock.advanceSeconds(1);
    const saved = await ok(audience(c.owner, id, narrow));
    assert.deepEqual(names(saved.losing), ['bob', 'deputy', 'sponsor']);
    assert.deepEqual(await sees(id), ['pm', 'owner', 'ada']);
    assert.equal((await audience(c.owner, id, narrow)).status, 400, 'nothing to change');

    // Widening: the names that gain access are listed before confirming.
    const wide = await ok(audience(c.pm, id, { mode: 'project', reason: 'Everyone needs it', preview: true }));
    assert.deepEqual(wide, { gaining: [{ id: ids.bob, name: 'bob' }, { id: ids.deputy, name: 'deputy' }, { id: ids.sponsor, name: 'sponsor' }], losing: [] });
    assert.deepEqual(await sees(id), ['pm', 'owner', 'ada']);
    t.clock.advanceSeconds(1);
    await ok(audience(c.pm, id, { mode: 'project', reason: 'Everyone needs it' }));
    assert.deepEqual(await sees(id), ['pm', 'deputy', 'owner', 'sponsor', 'ada', 'bob']);
    // A Sponsor narrows to a few, adding nobody new.
    t.clock.advanceSeconds(1);
    await ok(audience(c.sponsor, id, { mode: 'restricted', userIds: [ids.sponsor, ids.pm], reason: 'Sponsor review' }));
    assert.deepEqual(await sees(id), ['pm', 'sponsor']);

    const ev = (await events(id)).filter((e) => e.kind === 'audience_changed');
    assert.deepEqual(ev.map((e) => [e.actor_id, e.reason]), [[ids.owner, 'Board only'], [ids.pm, 'Everyone needs it'], [ids.sponsor, 'Sponsor review']]);
    const aud = (await t.pool.query(`SELECT e.from_mode, e.to_mode, e.reason FROM audience_events e JOIN audiences a ON a.id = e.audience_id
                                       WHERE a.project_id = $1 AND e.reason <> 'Set when the output was registered' ORDER BY e.at, e.id`, [project])).rows;
    assert.deepEqual(aud.map((a) => [a.from_mode, a.to_mode, a.reason]), [['project', 'restricted', 'Board only'], ['restricted', 'project', 'Everyone needs it'], ['project', 'restricted', 'Sponsor review']]);
    const audits = (await t.pool.query(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'output.audience_changed' AND subject_id = $1`, [id])).rows[0].n;
    assert.equal(audits, 3);
  });

  test('audience cannot include people outside material readers', async () => {
    await meeting('Board meeting', ['The kestrel pump service is booked for Thursday morning.'], [ids.pm, ids.owner, ids.ada]);
    const id = await registered('kestrel pump', { audience: [ids.pm, ids.owner] });
    for (const [body, message] of [
      [{ mode: 'restricted', userIds: [ids.pm, ids.bob] }, OUTSIDE_MATERIAL],
      [{ mode: 'restricted', userIds: [ids.pm, ids.outsider] }, NAMED_OUTSIDE],
      [{ mode: 'project' }, MUST_RESTRICT],
    ] as const) {
      for (const preview of [true, false]) {
        const r = await audience(c.pm, id, { ...body, reason: 'Wider', preview });
        assert.equal(r.status, 400, JSON.stringify(body));
        assert.equal(r.body.message, message);
      }
    }
    assert.equal((await audience(c.pm, id, { mode: 'restricted', userIds: [], reason: 'Nobody' })).status, 400);
    const r = await ok(audience(c.owner, id, { mode: 'restricted', userIds: [ids.pm, ids.owner, ids.ada], reason: 'Ada wrote it', preview: true }));
    assert.deepEqual(r, { gaining: [{ id: ids.ada, name: 'ada' }], losing: [] });
    await ok(audience(c.owner, id, { mode: 'restricted', userIds: [ids.pm, ids.owner, ids.ada], reason: 'Ada wrote it' }));
    assert.deepEqual(await sees(id), ['pm', 'owner', 'ada']);
  });

  test('audience change queues placement and sharing; Kainow access changes at once', async () => {
    await note('Pump note', 'The kestrel pump service is booked for Thursday morning.');
    const id = await registered('kestrel pump');
    await clearOutbox();
    await ok(audience(c.pm, id, { mode: 'restricted', userIds: [ids.pm, ids.ada], reason: 'Narrower' }));
    assert.deepEqual(await outbox(id), [['place-output', true]], 'narrowing moves the files out first, urgently');
    assert.equal((await c.bob.request('GET', url(`/${id}`))).status, 404, 'hidden in Kainow at once');
    assert.ok(!(await ok(c.bob.request('GET', url()))).outputs.some((o: { id: string }) => o.id === id));
    await clearOutbox();
    await ok(audience(c.pm, id, { mode: 'restricted', userIds: [ids.pm, ids.ada, ids.bob], reason: 'Bob too' }));
    assert.deepEqual(await outbox(id), [['place-output', false]], 'widening is not urgent');
    assert.equal((await c.bob.request('GET', url(`/${id}`))).status, 200);
    await clearOutbox();
    await ok(audience(c.pm, id, { mode: 'project', reason: 'Everyone' }));
    assert.deepEqual(await outbox(id), [['place-output', false]]);
    await clearOutbox();
    await ok(audience(c.pm, id, { mode: 'restricted', userIds: [ids.pm], reason: 'Just me', preview: true }));
    assert.deepEqual(await outbox(id), [], 'a preview queues nothing');
  });

  test('deleting a source a version used sets review_required and limits readers to PM, Deputies, Owner and Sponsors who can still read it', async () => {
    const src = await note('Pump note', 'The kestrel pump service is booked for Thursday morning.');
    await meeting('Plant meeting', ['The kestrel valve audit is planned for Friday.']);
    const id = await registered('kestrel', { title: 'Kestrel status' });
    const untouched = await registered('valve audit', { title: 'Valve status' });
    await clearOutbox();
    await ok(c.pm.request('POST', `/sources/${src}/delete`, { reason: 'Wrong project' }));
    assert.deepEqual(await state(id), { status: 'registered', review_state: 'review_required' });
    assert.deepEqual(await state(untouched), { status: 'registered', review_state: 'none' }, 'an output not built from it is untouched');
    assert.deepEqual(await sees(id), ['pm', 'deputy', 'owner', 'sponsor']);
    assert.deepEqual(await sees(untouched), ['pm', 'deputy', 'owner', 'sponsor', 'ada', 'bob']);
    const detail = await ok(c.owner.request('GET', url(`/${id}`)));
    assert.equal(detail.reviewRequired, true);
    assert.equal(detail.reviewLabel, LABEL);
    assert.deepEqual(await outbox(id), [['place-output', true]]);
    const ev = (await events(id)).filter((e) => e.kind === 'review_required');
    assert.deepEqual(ev.map((e) => [e.actor_id, e.reason]), [[null, null]], 'recorded once, with no actor and no text');
    const cause = (await t.pool.query(`SELECT detail FROM output_events WHERE output_id = $1 AND kind = 'review_required'`, [id])).rows[0].detail;
    assert.deepEqual(cause, { cause: 'deleted' });
    assert.deepEqual(await notified(id), ['deputy', 'owner', 'pm', 'sponsor'].map((n) => [n, `${LABEL}: Kestrel status`]));
  });

  test('a hidden message, a held source and a tightened source audience set review_required too', async () => {
    const [msg] = await meeting('Plant meeting', ['The kestrel valve audit is planned for Friday.']);
    const hidden = await registered('kestrel valve', { title: 'Valve status' });
    await ok(c.pm.request('POST', `/messages/${msg}/hide`, { reason: 'Off topic' }));
    assert.equal((await state(hidden)).review_state, 'review_required');
    assert.deepEqual(await sees(hidden), ['pm', 'deputy', 'owner', 'sponsor']);
    assert.equal((await notified(hidden)).length, 4);

    const heldSrc = await note('Plant room', `The heron pump room vault code is ${SECRET} until March.`);
    const held = await registered('heron pump', { title: 'Heron status' });
    await ok(c.ada.request('POST', `/projects/${project}/secret-reports`, { kind: 'source', id: heldSrc, marked: [SECRET], reason: 'Looks like a vault code' }), 201);
    assert.equal((await state(held)).review_state, 'review_required');
    assert.deepEqual(await sees(held), ['pm', 'deputy', 'owner', 'sponsor']);

    const tightSrc = await note('Crane note', 'The osprey crane inspection is due on Monday.');
    const tight = await registered('osprey crane', { title: 'Crane status' });
    const audienceId = (await t.pool.query(`SELECT audience_id FROM sources WHERE id = $1`, [tightSrc])).rows[0].audience_id;
    await ok(c.pm.request('PUT', `/audiences/${audienceId}`, { mode: 'restricted', namedUserIds: [ids.pm, ids.sponsor, ids.ada], reason: 'Commercial terms' }));
    assert.equal((await state(tight)).review_state, 'review_required');
    // A Restricted audience always includes the PM, Deputies, Owner and Sponsors (sub-project 4a), so they keep it.
    assert.deepEqual(await sees(tight), ['pm', 'deputy', 'owner', 'sponsor']);
    assert.deepEqual(await notified(tight), ['deputy', 'owner', 'pm', 'sponsor'].map((n) => [n, `${LABEL}: Crane status`]));
    // The material rule holds while in review: the audience may name only those who can read the material now.
    const r = await audience(c.pm, tight, { mode: 'restricted', userIds: [ids.pm, ids.bob], reason: 'Bob too' });
    assert.equal(r.status, 400);
    assert.equal(r.body.message, OUTSIDE_MATERIAL);
    assert.equal((await audience(c.pm, tight, { mode: 'project', reason: 'Everyone' })).status, 400);
    await ok(audience(c.pm, tight, { mode: 'restricted', userIds: [ids.pm, ids.ada], reason: 'Ada is named on the note' }));
    assert.deepEqual(await sees(tight), ['pm'], 'still in review: only reviewers in the audience');
    await ok(c.pm.request('POST', url(`/${tight}/review/clear`), { reason: 'Checked' }));
    assert.deepEqual(await sees(tight), ['pm', 'ada']);
  });

  test('clear returns the audience; withdraw ends the output', async () => {
    const [first, second] = await meeting('Plant meeting', ['The kestrel valve audit is planned for Friday.', 'The kestrel valve spares arrive on Tuesday.']);
    const id = await registered('kestrel valve', { title: 'Valve status' });
    await ok(c.pm.request('POST', `/messages/${first}/hide`, { reason: 'Off topic' }));
    assert.deepEqual(await sees(id), ['pm', 'deputy', 'owner', 'sponsor']);
    const deputy = await c.deputy.request('POST', url(`/${id}/review/clear`), { reason: 'Checked' });
    assert.equal(deputy.status, 403, 'a Deputy reads it but cannot clear it');
    assert.equal((await c.ada.request('POST', url(`/${id}/review/clear`), { reason: 'Checked' })).status, 404);
    assert.equal((await c.owner.request('POST', url(`/${id}/review/clear`), {})).status, 400, 'a reason is required');
    await clearOutbox();
    t.clock.advanceSeconds(1);
    const cleared = await ok(c.owner.request('POST', url(`/${id}/review/clear`), { reason: 'Nothing sensitive left' }));
    assert.equal(cleared.reviewRequired, false);
    assert.equal(cleared.reviewLabel, null);
    assert.deepEqual(await state(id), { status: 'registered', review_state: 'cleared' });
    assert.deepEqual(await sees(id), ['pm', 'deputy', 'owner', 'sponsor', 'ada', 'bob'], 'back to its audience');
    assert.deepEqual(await outbox(id), [['place-output', false]]);
    assert.equal((await c.owner.request('POST', url(`/${id}/review/clear`), { reason: 'Again' })).status, 409, 'not in review');

    // A new removal puts it back in review.
    await ok(c.pm.request('POST', `/messages/${second}/hide`, { reason: 'Off topic' }));
    assert.equal((await state(id)).review_state, 'review_required');
    assert.equal((await c.deputy.request('POST', url(`/${id}/review/withdraw`), { reason: 'Gone' })).status, 403);
    assert.equal((await c.sponsor.request('POST', url(`/${id}/review/withdraw`), {})).status, 400);
    await clearOutbox();
    t.clock.advanceSeconds(1);
    const w = await ok(c.sponsor.request('POST', url(`/${id}/review/withdraw`), { reason: 'Built on removed messages' }));
    assert.equal(w.status, 'withdrawn');
    assert.equal((await state(id)).status, 'withdrawn');
    assert.deepEqual(await outbox(id), [['place-output', true]], 'its files leave the project folder');
    const ev = (await events(id)).filter((e) => ['review_cleared', 'withdrawn'].includes(e.kind));
    assert.deepEqual(ev.map((e) => [e.kind, e.actor_id, e.reason]), [['review_cleared', ids.owner, 'Nothing sensitive left'], ['withdrawn', ids.sponsor, 'Built on removed messages']]);
    assert.deepEqual(await sees(id), ['pm', 'deputy'], 'a withdrawn output: the PM and Deputies (its submitter is the PM)');
    assert.equal((await c.pm.request('POST', url(`/${id}/review/withdraw`), { reason: 'Again' })).status, 409);
    assert.equal((await audience(c.pm, id, { mode: 'restricted', userIds: [ids.pm], reason: 'x' })).status, 409, 'a withdrawn output is final');
  });
});
