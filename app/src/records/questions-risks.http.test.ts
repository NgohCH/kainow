import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { uuidv7 } from '../common/uuid7';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedProject, seedUser } from '../testing/projects';

describe('questions and risks', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let pm: Client;
  let owner: Client;
  let ann: Client;
  let ben: Client;
  const ids: Record<string, string> = {};
  let projectId: string;

  beforeEach(async () => {
    t = await startTestApp();
    await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    for (const p of ['pm', 'owner', 'ann', 'ben']) ids[p] = await seedUser(t.pool, `${p}@example.org`);
    projectId = await seedProject(t.pool, {
      status: 'active',
      members: [{ userId: ids.pm, role: 'pm' }, { userId: ids.owner, role: 'owner' }, { userId: ids.ann, role: 'member' }, { userId: ids.ben, role: 'member' }],
    });
    pm = await t.signIn('pm@example.org');
    owner = await t.signIn('owner@example.org');
    ann = await t.signIn('ann@example.org');
    ben = await t.signIn('ben@example.org');
  });
  afterEach(async () => {
    await t?.close();
  });

  /** A human proposal authorised directly in the database, as the Owner would leave it. */
  const origin = async (kind: string) => {
    const id = uuidv7();
    await t.pool.query(
      `INSERT INTO human_proposals (id, project_id, kind, text, proposed_by, proposed_at, review_status, reviewed_by, reviewed_at)
       VALUES ($1, $2, $3, 'x', $4, now(), 'approved', $4, now())`,
      [id, projectId, kind, ids.owner],
    );
    return id;
  };
  const question = async (requester: string) => {
    const id = uuidv7();
    await t.pool.query(
      `INSERT INTO questions (id, project_id, text, requester_id, origin_proposal_id, authorised_by, authorised_at) VALUES ($1, $2, 'Keep the old barcode?', $3, $4, $5, now())`,
      [id, projectId, requester, await origin('question'), ids.owner],
    );
    return id;
  };
  const risk = async () => {
    const id = uuidv7();
    await t.pool.query(
      `INSERT INTO risks (id, project_id, description, severity, origin_proposal_id, authorised_by, authorised_at) VALUES ($1, $2, 'Vendor late', 'high', $3, $4, now())`,
      [id, projectId, await origin('risk'), ids.owner],
    );
    return id;
  };
  const q = (c: Client, id: string, action: string, body: object = {}) => c.request('POST', `/records/questions/${id}/${action}`, body);
  const r = (c: Client, id: string, action: string, body: object = {}) => c.request('POST', `/records/risks/${id}/${action}`, body);
  const records = async (c: Client) => (await c.request('GET', `/projects/${projectId}/records`)).body;

  test('answering does not resolve', async () => {
    const id = await question(ids.ann);
    const early = await q(ann, id, 'resolve');
    assert.deepEqual([early.status, early.body.message], [409, 'Answered is not Resolved: the requester, Project Manager or a Deputy confirms the answer.']);
    assert.equal((await q(ben, id, 'answer', { text: 'Keep it until March' })).status, 200);
    assert.equal((await q(ben, id, 'resolve')).status, 403, 'a member who is not the requester');
    assert.equal((await q(ann, id, 'resolve')).status, 200);
    const view = (await records(pm)).questions.find((x: { id: string }) => x.id === id);
    assert.equal(view.status, 'resolved');
    assert.deepEqual(view.answers.map((a: { answer: string; author: string }) => [a.answer, a.author]), [['Keep it until March', 'ben']]);
  });

  test('reopen keeps answers; withdraw is final', async () => {
    const id = await question(ids.ann);
    await q(ben, id, 'answer', { text: 'Yes' });
    await q(pm, id, 'resolve');
    assert.equal((await q(pm, id, 'reopen', { reason: 'The vendor changed its format' })).status, 200);
    const view = (await records(pm)).questions.find((x: { id: string }) => x.id === id);
    assert.deepEqual([view.status, view.answers.length], ['open', 1]);
    assert.equal((await q(ann, id, 'withdraw', { reason: 'No longer needed' })).status, 200);
    assert.equal((await q(ann, id, 'reopen', { reason: 'x' })).status, 409);
  });

  test('risk mitigation, acceptance and resolution', async () => {
    const id = await risk();
    assert.equal((await r(ann, id, 'mitigate', { note: 'x' })).status, 403);
    assert.equal((await r(pm, id, 'mitigate', { note: 'Weekly calls with the vendor', mitigation: 'Weekly calls with the vendor' })).status, 200);
    const noDate = await r(owner, id, 'accept', { note: 'We can live with a short delay', responsibleId: ids.pm });
    assert.deepEqual([noDate.status, noDate.body.message], [409, 'Accepting a risk needs a responsible person and a review date.']);
    assert.equal((await r(owner, id, 'accept', { note: 'We can live with a short delay', responsibleId: ids.pm, reviewOn: '2026-12-01' })).status, 200);
    assert.equal((await r(pm, id, 'reopen', { note: 'x' })).status, 403);
    assert.equal((await r(owner, id, 'reopen', { note: 'The delay grew' })).status, 200);
    assert.equal((await r(owner, id, 'resolve', { note: 'Vendor delivered' })).status, 200);
    const view = (await records(ann)).risks.find((x: { id: string }) => x.id === id);
    assert.deepEqual([view.status, view.severity, view.responsible.id, view.reviewOn], ['resolved', 'high', ids.pm, '2026-12-01']);
    const history = (await t.pool.query(`SELECT kind FROM record_events WHERE record_id = $1 ORDER BY at, id`, [id])).rows.length;
    assert.equal(history, 4);
  });

  test('decisions are listed', async () => {
    const d = uuidv7();
    await t.pool.query(
      `INSERT INTO decisions (id, project_id, statement, rationale, origin_proposal_id, authorised_by, authorised_at) VALUES ($1, $2, 'Move to the new system', 'Cheaper', $3, $4, now())`,
      [d, projectId, await origin('decision'), ids.owner],
    );
    const view = (await records(ann)).decisions;
    assert.deepEqual(view.map((x: { statement: string; status: string; authorisedBy: string }) => [x.statement, x.status, x.authorisedBy]), [['Move to the new system', 'active', 'owner']]);
  });
});
