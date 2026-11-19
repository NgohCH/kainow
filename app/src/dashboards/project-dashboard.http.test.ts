import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { uuidv7 } from '../common/uuid7';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedProject, seedUser } from '../testing/projects';
import { COVERAGE_NOTE } from './measures';

describe('project dashboard endpoint', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let projectId: string;
  const ids: Record<string, string> = {};
  const people: Record<string, Client> = {};

  beforeEach(async () => {
    t = await startTestApp();
    const adminId = await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    await t.pool.query(`INSERT INTO eligible_domains (id, domain, added_by, added_at) VALUES ($1, 'example.com', $2, now())`, [uuidv7(), adminId]);
    for (const p of ['pm', 'mem', 'auditor', 'stranger']) ids[p] = await seedUser(t.pool, `${p}@example.com`);
    projectId = await seedProject(t.pool, {
      status: 'active',
      members: [
        { userId: ids.pm, role: 'pm' },
        { userId: ids.pm, role: 'owner' },
        { userId: ids.mem, role: 'member' },
      ],
    });
    await t.pool.query(
      `INSERT INTO access_grants (id, project_id, user_id, kind, purpose, scope, starts_on, expires_on, requested_by, requested_at, decision, decided_by, decided_at)
       VALUES ($1, $2, $3, 'audit', 'Annual audit', 'Everything', '2026-11-01', '2026-12-31', $4, now(), 'approved', $4, now())`,
      [uuidv7(), projectId, ids.auditor, ids.pm],
    );
    for (const p of ['pm', 'mem', 'auditor', 'stranger']) people[p] = await t.signIn(`${p}@example.com`);
    people.admin = await t.signIn('admin@example.org');
  });
  afterEach(async () => {
    await t?.close();
  });

  async function proposal(kind: 'decision' | 'question' | 'risk'): Promise<string> {
    const id = uuidv7();
    await t.pool.query(
      `INSERT INTO human_proposals (id, project_id, kind, text, proposed_by, proposed_at, review_status, reviewed_by, reviewed_at)
       VALUES ($1, $2, $3, 'Proposed', $4, now(), 'approved', $4, now())`,
      [id, projectId, kind, ids.pm],
    );
    return id;
  }
  async function decision(statement: string, at: string): Promise<string> {
    const id = uuidv7();
    await t.pool.query(
      `INSERT INTO decisions (id, project_id, statement, origin_proposal_id, authorised_by, authorised_at) VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, projectId, statement, await proposal('decision'), ids.pm, at],
    );
    return id;
  }
  async function question(text: string, at: string): Promise<string> {
    const id = uuidv7();
    await t.pool.query(
      `INSERT INTO questions (id, project_id, text, requester_id, origin_proposal_id, authorised_by, authorised_at) VALUES ($1, $2, $3, $4, $5, $4, $6)`,
      [id, projectId, text, ids.pm, await proposal('question'), at],
    );
    return id;
  }
  async function risk(description: string, severity: string, reviewOn: string): Promise<string> {
    const id = uuidv7();
    await t.pool.query(
      `INSERT INTO risks (id, project_id, description, severity, review_on, origin_proposal_id, authorised_by, authorised_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())`,
      [id, projectId, description, severity, reviewOn, await proposal('risk'), ids.pm],
    );
    return id;
  }
  const invite = (name: string, expiresAt = '2026-11-20T00:00:00Z') =>
    t.pool.query(
      `INSERT INTO invitations (id, project_id, email, display_name, role, starts_on, invited_by, token_hash, issued_at, expires_at, status)
       VALUES ($1, $2, $3, $4, 'member', '2026-11-10', $5, $6, '2026-11-09T00:00:00Z', $7, 'invited')`,
      [uuidv7(), projectId, `${uuidv7().slice(-8)}@example.org`, name, ids.pm, uuidv7(), expiresAt],
    );
  const get = (person: string) => people[person].request('GET', `/projects/${projectId}/dashboard`);

  test('member sees figures; names hidden from member, shown to PM', async () => {
    await invite('Ada Invitee');
    await invite('Expired Invitee', '2026-11-01T00:00:00Z');
    await decision('Use the east site', '2026-11-05T02:00:00Z');
    await question('Who signs off?', '2026-11-06T02:00:00Z');
    await risk('Supplier may slip', 'high', '2026-11-30');
    await risk('Minor delay', 'low', '2026-11-30');

    const m = await get('mem');
    assert.equal(m.status, 200);
    assert.equal(m.body.coverage, COVERAGE_NOTE);
    assert.equal(m.body.computedAt, t.clock.now().toISOString());
    assert.equal(m.body.measures.projectId, projectId);
    assert.deepEqual(m.body.invitations, { count: 1 });
    assert.deepEqual(m.body.decisions.recent.map((d: { title: string }) => d.title), ['Use the east site']);
    assert.equal(m.body.decisions.active, 1);
    assert.deepEqual(m.body.questions.oldestOpen.map((q: { text: string }) => q.text), ['Who signs off?']);
    assert.deepEqual(
      m.body.risks.significant.map((r: { description: string; severity: string; reviewOn: string }) => [r.description, r.severity, r.reviewOn]),
      [['Supplier may slip', 'high', '2026-11-30']],
    );

    const pm = await get('pm');
    assert.deepEqual(pm.body.invitations, { count: 1, names: ['Ada Invitee'] });
  });

  test('lists keep to five, newest decisions and oldest questions first', async () => {
    for (let i = 1; i <= 7; i++) await decision(`D${i}`, `2026-11-0${i}T02:00:00Z`);
    for (let i = 1; i <= 7; i++) await question(`Q${i}`, `2026-11-0${i}T02:00:00Z`);
    const r = await get('pm');
    assert.equal(r.body.decisions.active, 7);
    assert.deepEqual(r.body.decisions.recent.map((d: { title: string }) => d.title), ['D7', 'D6', 'D5', 'D4', 'D3']);
    assert.deepEqual(r.body.questions.oldestOpen.map((q: { text: string }) => q.text), ['Q1', 'Q2', 'Q3', 'Q4', 'Q5']);
  });

  test('audit grant holder sees figures', async () => {
    await invite('Ada Invitee');
    const r = await get('auditor');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.invitations, { count: 1 });
    assert.equal(r.body.measures.projectId, projectId);
  });

  test('stranger gets 404', async () => {
    assert.equal((await get('stranger')).status, 404);
    assert.equal((await get('admin')).status, 404, 'an Administrator who is not a participant has no project.view');
    assert.equal((await people.mem.request('GET', `/projects/${uuidv7()}/dashboard`)).status, 404);
    assert.equal((await people.mem.request('GET', `/projects/not-an-id/dashboard`)).status, 404);
    assert.equal((await t.anonymous('GET', `/projects/${projectId}/dashboard`)).status, 401);
  });

  test('Deleted decision is absent from recent and count', async () => {
    await decision('Kept', '2026-11-05T02:00:00Z');
    const gone = await decision('Removed', '2026-11-06T02:00:00Z');
    await t.pool.query(`UPDATE decisions SET deleted_at = now(), deleted_by = $2, delete_reason = 'Entered in error' WHERE id = $1`, [gone, ids.pm]);
    const r = await get('pm');
    assert.equal(r.body.decisions.active, 1);
    assert.deepEqual(r.body.decisions.recent.map((d: { title: string }) => d.title), ['Kept']);
  });

  test('a cleaned held record shows the cleaned label, an uncleaned one is absent', async () => {
    const cleaned = await question('Secret question text', '2026-11-05T02:00:00Z');
    const held = await question('Held question text', '2026-11-06T02:00:00Z');
    for (const [id, state] of [[cleaned, 'cleaned'], [held, 'held']] as const) {
      const caseId = uuidv7();
      await t.pool.query(
        `INSERT INTO quarantine_cases (id, project_id, item_kind, item_id, reason, marked_length, state, waiting_for_key, reported_at, cleaned_at)
         VALUES ($1, $2, 'question', $3, 'test', 8, $4, $5, now(), CASE WHEN $4 = 'cleaned' THEN now() END)`,
        [caseId, projectId, id, state, state === 'held'],
      );
      await t.pool.query(`UPDATE questions SET held_case_id = $2 WHERE id = $1`, [id, caseId]);
    }
    const r = await get('pm');
    assert.deepEqual(r.body.questions.oldestOpen.map((x: { text: string }) => x.text), ['Credential removed — under review']);
  });
});
