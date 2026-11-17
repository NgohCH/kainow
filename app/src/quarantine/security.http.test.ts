import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { findMaterial } from '../assist/material';
import { uuidv7 } from '../common/uuid7';
import { buildDigest } from '../digests/digest';
import { ProjectAccess } from '../projects/access.service';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedProject, seedUser } from '../testing/projects';
import { MARKER } from './clean-text';
import { CHANGED_SINCE_CLEANING } from './security.service';

/** A secret the credential check does not know: only a person can mark it. */
const SECRET = 'Kp9vault-Rotor42';
/** A key the credential check recognises (refused in every reason and purpose box). */
const KEY = `sk-${'a1B2c3D4e5F6g7H8i9J0'}kLmN`;
const PLANT = `The kestrel pump service is booked for Thursday morning. The plant room vault code is ${SECRET} until March.`;
/** Friday 13 Nov 2026, HH:MM UTC+8. */
const at = (h: number, m = 0): number => Date.UTC(2026, 10, 13, h - 8, m);
const PURPOSE = 'Check whether the reported vault code is a real credential';

describe('security reviewers, grants, reveal and release unchanged', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let dir: string;
  const ids: Record<string, string> = {};
  let project: string;
  let pm: Client;
  let ada: Client;
  let ben: Client;
  let aud: Client;
  let rev: Client;
  let admin1: Client;
  let admin2: Client;

  const json = (v: unknown) => JSON.stringify(v);
  const ok = async (p: Promise<{ status: number; body: any }>, status = 200) => {
    const r = await p;
    assert.equal(r.status, status, json(r.body));
    return r.body;
  };
  const refused = async (p: Promise<{ status: number; body: any }>, status: number) => {
    const r = await p;
    assert.equal(r.status, status, json(r.body));
    assert.ok(!json(r.body).includes(SECRET), 'a refusal carried the secret');
    return r.body;
  };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'kainow-security-'));
    const keyFile = join(dir, 'p.key');
    writeFileSync(keyFile, randomBytes(32));
    t = await startTestApp(undefined, { assistQueue: { enqueue: async () => undefined }, protectedKeyFile: keyFile });
    t.clock.ms = at(8);
    for (const k of ['pm', 'own', 'ada', 'ben', 'aud', 'rev']) ids[k] = await seedUser(t.pool, `${k}@example.org`);
    ids.admin1 = await seedUser(t.pool, 'admin1@example.org', 'enterprise_administrator');
    ids.admin2 = await seedUser(t.pool, 'admin2@example.org', 'enterprise_administrator');
    project = await seedProject(t.pool, {
      name: 'Alpha Project',
      status: 'active',
      members: [
        { userId: ids.pm, role: 'pm' },
        { userId: ids.own, role: 'owner' },
        { userId: ids.ada, role: 'member' },
        { userId: ids.ben, role: 'member' },
      ],
    });
    [pm, ada, ben, aud, rev, admin1, admin2] = [
      await t.signIn('pm@example.org'),
      await t.signIn('ada@example.org'),
      await t.signIn('ben@example.org'),
      await t.signIn('aud@example.org'),
      await t.signIn('rev@example.org'),
      await t.signIn('admin1@example.org'),
      await t.signIn('admin2@example.org'),
    ];
  });
  afterEach(async () => {
    await t?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const note = async (title: string, text: string) => (await ok(pm.request('POST', `/projects/${project}/notes`, { title, text }), 201)).source.id as string;
  const reported = async (kind: string, id: string, marked = [SECRET]) => {
    const body = await ok(ada.request('POST', `/projects/${project}/secret-reports`, { kind, id, marked, reason: 'Looks like the plant room vault code' }), 201);
    t.clock.advanceSeconds(1);
    return body.caseId as string;
  };
  const designate = async (by: Client, userId: string, reason: unknown = 'Trained in credential handling') => {
    const r = await by.request('POST', `/security/reviewers/${userId}/designate`, { reason });
    t.clock.advanceSeconds(1);
    return r;
  };
  const request = (by: Client, caseIds: string[], extra: object = {}) => by.request('POST', '/security/grants', { caseIds, purpose: PURPOSE, ...extra });
  const decide = (by: Client, grantId: string, decision: string, reason: unknown = 'Purpose is clear') => by.request('POST', `/security/grants/${grantId}/decide`, { decision, reason });
  /** rev designated by admin1, asks for `caseIds`, admin2 approves: the grant id. */
  const granted = async (caseIds: string[]) => {
    await ok(designate(admin1, ids.rev));
    const g = (await ok(request(rev, caseIds), 201)).grantId as string;
    await ok(decide(admin2, g, 'approved'));
    return g;
  };
  const reveal = (by: Client, caseId: string, kind: string, itemId: string, body: unknown = { confirm: true }) =>
    by.request('POST', `/security/cases/${caseId}/items/${kind}/${itemId}/reveal`, body);
  const releaseUnchanged = (by: Client, caseId: string, reason: unknown = 'False alarm: a printed example, not a live code') =>
    by.request('POST', `/security/cases/${caseId}/release-unchanged`, { reason });
  const versions = async (sourceId: string) =>
    (await t.pool.query(`SELECT text_content FROM source_versions WHERE source_id = $1 ORDER BY version_no`, [sourceId])).rows.map((r) => r.text_content as string);
  const passages = async (sourceId: string) =>
    (
      await t.pool.query(
        `SELECT p.ordinal, p.start_offset, p.end_offset, p.body FROM passages p JOIN source_versions v ON v.id = p.owner_id
          WHERE p.owner_kind = 'source_version' AND v.source_id = $1 ORDER BY v.version_no, p.ordinal`,
        [sourceId],
      )
    ).rows;
  /** Every stored row that must never hold the marked text or an original. */
  const leakScan = async () => {
    const out: string[] = [];
    for (const table of ['quarantine_events', 'audit_events', 'notifications', 'quarantine_cases', 'quarantine_grants', 'security_reviewer_events', 'email_outbox']) {
      out.push(json((await t.pool.query(`SELECT * FROM ${table}`)).rows));
    }
    return out.join('\n');
  };
  const task = async (title: string, ownerAsWritten: string | null = null) => {
    const id = uuidv7();
    await t.pool.query(
      `INSERT INTO tasks (id, project_id, depth, title, owner_as_written, assignee_id, due_on, status, authorised_by, authorised_at)
       VALUES ($1, $2, 0, $3, $4, $5, '2026-11-16', 'not_started', $6, $7)`,
      [id, project, title, ownerAsWritten, ids.ben, ids.own, t.clock.now()],
    );
    return id;
  };

  test('an Administrator cannot designate themselves', async () => {
    const self = await refused(designate(admin1, ids.admin1), 403);
    assert.equal(self.message, 'You cannot designate yourself as a security reviewer; another Administrator must.');
    assert.equal((await t.pool.query(`SELECT security_reviewer FROM users WHERE id = $1`, [ids.admin1])).rows[0].security_reviewer, false);
    // The database refuses it too.
    await assert.rejects(
      t.pool.query(`INSERT INTO security_reviewer_events (id, user_id, kind, actor_id, reason, at) VALUES ($1, $2, 'designated', $2, 'x', now())`, [uuidv7(), ids.admin1]),
      /security_reviewer_events_not_self/,
    );
    // Only an Administrator designates; a reason is required and checked for credentials.
    await refused(designate(pm, ids.rev), 403);
    await refused(designate(admin1, ids.rev, ''), 400);
    const keyed = await refused(designate(admin1, ids.rev, `Holder of ${KEY}`), 400);
    assert.ok(!json(keyed).includes(KEY));
    await refused(designate(admin1, uuidv7()), 404);
    await ok(designate(admin1, ids.rev));
    await refused(designate(admin2, ids.rev), 409);
    // Another Administrator may designate an Administrator.
    await ok(designate(admin2, ids.admin1));
    const list = await ok(admin1.request('GET', '/security/reviewers'));
    assert.deepEqual(list.reviewers.map((r: { id: string }) => r.id).sort(), [ids.admin1, ids.rev].sort());
    await refused(pm.request('GET', '/security/reviewers'), 403);
    // Removing: never yourself, always with a reason.
    await refused(admin1.request('POST', `/security/reviewers/${ids.admin1}/undesignate`, { reason: 'Stepping back' }), 403);
    await refused(admin1.request('POST', `/security/reviewers/${ids.rev}/undesignate`, {}), 400);
    await ok(admin1.request('POST', `/security/reviewers/${ids.rev}/undesignate`, { reason: 'Moved to another team' }));
    const events = (await t.pool.query(`SELECT user_id, kind, actor_id, reason FROM security_reviewer_events ORDER BY at, id`)).rows;
    assert.deepEqual(events, [
      { user_id: ids.rev, kind: 'designated', actor_id: ids.admin1, reason: 'Trained in credential handling' },
      { user_id: ids.admin1, kind: 'designated', actor_id: ids.admin2, reason: 'Trained in credential handling' },
      { user_id: ids.rev, kind: 'undesignated', actor_id: ids.admin1, reason: 'Moved to another team' },
    ]);
    assert.equal((await t.pool.query(`SELECT security_reviewer FROM users WHERE id = $1`, [ids.rev])).rows[0].security_reviewer, false);
  });

  test('a non-reviewer cannot request', async () => {
    const id = await note('Plant room', PLANT);
    const caseId = await reported('source', id);
    const r = await refused(request(ada, [caseId]), 403);
    assert.equal(r.message, 'Only a designated security reviewer can ask to open quarantined originals.');
    await refused(request(admin1, [caseId]), 403);
    await refused(request(pm, [caseId]), 403);
    await refused(rev.request('GET', '/security/cases'), 403);
    assert.equal(Number((await t.pool.query(`SELECT count(*) AS n FROM quarantine_grants`)).rows[0].n), 0);
    await ok(designate(admin1, ids.rev));
    // A purpose is required and checked; cases must exist; hours are whole and positive.
    await refused(request(rev, [caseId], { purpose: '' }), 400);
    await refused(request(rev, [caseId], { purpose: `Check ${KEY}` }), 400);
    await refused(request(rev, []), 400);
    await refused(request(rev, [uuidv7()]), 404);
    await refused(request(rev, [caseId], { hours: 0 }), 400);
    await refused(request(rev, [caseId], { hours: 1.5 }), 400);
    const g = await ok(request(rev, [caseId]), 201);
    const row = (await t.pool.query(`SELECT requester_id, purpose, hours, decision, expires_at FROM quarantine_grants WHERE id = $1`, [g.grantId])).rows[0];
    assert.deepEqual(row, { requester_id: ids.rev, purpose: PURPOSE, hours: 24, decision: null, expires_at: null });
    // The reviewer picks cases by reference, project and kind: never content.
    const cases = await ok(rev.request('GET', '/security/cases'));
    assert.equal(cases.cases.length, 1);
    assert.equal(cases.cases[0].caseId, caseId);
    assert.equal(cases.cases[0].project, 'Alpha Project');
    assert.equal(cases.cases[0].kind, 'source');
    assert.ok(!json(cases).includes(SECRET) && !json(cases).includes('kestrel'));
    const event = (await t.pool.query(`SELECT actor_id, detail FROM quarantine_events WHERE action = 'grant_requested'`)).rows;
    assert.deepEqual(event, [{ actor_id: ids.rev, detail: { grantId: g.grantId, hours: 24 } }]);
  });

  test('the requester cannot approve their own grant', async () => {
    const id = await note('Plant room', PLANT);
    const caseId = await reported('source', id);
    await ok(designate(admin2, ids.admin1));
    const g = (await ok(request(admin1, [caseId], { hours: 4 }), 201)).grantId as string;
    // The other Administrator is told: requester and case count only.
    const told = (await t.pool.query(`SELECT user_id, summary, link, urgent FROM notifications WHERE kind = 'quarantine_grant_requested'`)).rows;
    assert.deepEqual(told, [{ user_id: ids.admin2, summary: 'admin1 asked to open quarantined originals in 1 case.', link: '#/security/grants', urgent: true }]);
    const own = await refused(decide(admin1, g, 'approved'), 403);
    assert.equal(own.message, 'You cannot decide your own request; another Administrator must.');
    await assert.rejects(
      t.pool.query(`UPDATE quarantine_grants SET decision = 'approved', decided_by = requester_id, decided_at = now(), expires_at = now() WHERE id = $1`, [g]),
      /quarantine_grants_not_self_decided/,
    );
    await refused(decide(pm, g, 'approved'), 403);
    await refused(decide(admin2, g, 'maybe'), 400);
    await ok(decide(admin2, g, 'approved'));
    const row = (await t.pool.query(`SELECT decision, decided_by, decided_at, expires_at FROM quarantine_grants WHERE id = $1`, [g])).rows[0];
    assert.equal(row.decision, 'approved');
    assert.equal(row.decided_by, ids.admin2);
    assert.equal(row.expires_at.getTime() - row.decided_at.getTime(), 4 * 3600 * 1000);
    await refused(decide(admin2, g, 'declined'), 409);
    // Extension is a fresh approval by an Administrator other than the requester.
    await refused(admin1.request('POST', `/security/grants/${g}/extend`, { hours: 24, reason: 'More time' }), 403);
    const ext = await ok(admin2.request('POST', `/security/grants/${g}/extend`, { hours: 24, reason: 'More time' }), 201);
    const fresh = (await t.pool.query(`SELECT requester_id, decided_by, decision, hours, purpose FROM quarantine_grants WHERE id = $1`, [ext.grantId])).rows[0];
    assert.deepEqual(fresh, { requester_id: ids.admin1, decided_by: ids.admin2, decision: 'approved', hours: 24, purpose: PURPOSE });
    const extended = (await t.pool.query(`SELECT detail FROM quarantine_events WHERE action = 'grant_extended'`)).rows;
    assert.deepEqual(extended, [{ detail: { grantId: ext.grantId, extends: g, hours: 24 } }]);
    // The requester is told of the decision.
    assert.ok((await t.pool.query(`SELECT 1 FROM notifications WHERE user_id = $1 AND kind = 'quarantine_grant_decided'`, [ids.admin1])).rowCount);
  });

  test('with one Administrator who is the requester the request waits', async () => {
    const id = await note('Plant room', PLANT);
    const caseId = await reported('source', id);
    await ok(designate(admin2, ids.admin1));
    // admin2 leaves the role: admin1 is the only Administrator.
    await t.pool.query(`UPDATE users SET role = 'member' WHERE id = $1`, [ids.admin2]);
    const g = (await ok(request(admin1, [caseId]), 201)).grantId as string;
    assert.equal(Number((await t.pool.query(`SELECT count(*) AS n FROM notifications WHERE kind = 'quarantine_grant_requested'`)).rows[0].n), 0);
    await refused(decide(admin1, g, 'approved'), 403);
    await refused(admin1.request('POST', `/security/grants/${g}/extend`, { hours: 24, reason: 'Emergency' }), 403);
    await refused(reveal(admin1, caseId, 'source', id), 403);
    await refused(releaseUnchanged(admin1, caseId), 403);
    const row = (await t.pool.query(`SELECT decision, decided_by, expires_at FROM quarantine_grants WHERE id = $1`, [g])).rows[0];
    assert.deepEqual(row, { decision: null, decided_by: null, expires_at: null });
    const listed = (await ok(admin1.request('GET', '/security/grants'))).grants.find((x: { id: string }) => x.id === g);
    assert.equal(listed.status, 'waiting');
  });

  test('reveal without confirm is refused; with it the original is returned and logged', async () => {
    const id = await note('Plant room', PLANT);
    const caseId = await reported('source', id);
    const otherId = await note('Gate', `The gate code is ${SECRET.split('').reverse().join('')} today.`);
    const otherCase = await reported('source', otherId, [SECRET.split('').reverse().join('')]);
    await ok(designate(admin1, ids.rev));
    const g = (await ok(request(rev, [caseId]), 201)).grantId as string;
    // Not yet approved: refused.
    const waiting = await refused(reveal(rev, caseId, 'source', id), 403);
    assert.equal(waiting.message, 'You need a current approved grant naming this case to open its originals.');
    await ok(decide(admin2, g, 'approved'));
    for (const body of [{}, { confirm: false }, { confirm: 'yes' }]) {
      const r = await refused(reveal(rev, caseId, 'source', id, body), 400);
      assert.equal(r.message, 'Confirm that you are viewing a quarantined credential for the stated purpose.');
    }
    assert.equal(Number((await t.pool.query(`SELECT count(*) AS n FROM quarantine_events WHERE action = 'original_opened'`)).rows[0].n), 0);
    // A case outside the grant, or an item outside the case: refused / not found.
    await refused(reveal(rev, otherCase, 'source', otherId), 403);
    await refused(reveal(rev, caseId, 'source', otherId), 404);

    const r = await rev.raw('POST', `/security/cases/${caseId}/items/source/${id}/reveal`, { confirm: true });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    const body = JSON.parse(r.text);
    const text = body.values.find((v: { table: string; column: string }) => v.table === 'source_versions' && v.column === 'text_content');
    assert.equal(text.text, PLANT);
    assert.deepEqual(text.marks.map((m: { start: number; end: number }) => text.text.slice(m.start, m.end)), [SECRET]);
    assert.ok(body.values.some((v: { table: string }) => v.table === 'passages'));
    assert.equal(body.notice, 'You are viewing a quarantined credential for the stated purpose. Do not copy it.');
    const opened = (await t.pool.query(`SELECT actor_id, item_kind, item_id, detail FROM quarantine_events WHERE action = 'original_opened'`)).rows;
    assert.deepEqual(opened, [{ actor_id: ids.rev, item_kind: 'source', item_id: id, detail: { grantId: g, values: body.values.length } }]);
    // The stored version is still cleaned; nothing written holds the original.
    assert.ok((await versions(id)).every((v) => !v.includes(SECRET) && v.includes(MARKER)));
    assert.ok(!(await leakScan()).includes(SECRET));
    // Undesignated: the grant no longer opens anything.
    await ok(admin1.request('POST', `/security/reviewers/${ids.rev}/undesignate`, { reason: 'Moved to another team' }));
    await refused(reveal(rev, caseId, 'source', id), 403);
  });

  test('reveal after expiry is refused', async () => {
    const id = await note('Plant room', PLANT);
    const caseId = await reported('source', id);
    const g = await granted([caseId]);
    await ok(reveal(rev, caseId, 'source', id));
    t.clock.advanceSeconds(24 * 3600);
    // Sessions last a day too: sign in again.
    [rev, admin1, admin2] = [await t.signIn('rev@example.org'), await t.signIn('admin1@example.org'), await t.signIn('admin2@example.org')];
    const late = await refused(reveal(rev, caseId, 'source', id), 403);
    assert.equal(late.message, 'You need a current approved grant naming this case to open its originals.');
    await refused(releaseUnchanged(rev, caseId), 403);
    // A fresh approval opens it again; revoking (any Administrator, with a reason) closes it.
    const ext = (await ok(admin1.request('POST', `/security/grants/${g}/extend`, { hours: 2, reason: 'Review not finished' }), 201)).grantId as string;
    await ok(reveal(rev, caseId, 'source', id));
    await refused(admin2.request('POST', `/security/grants/${ext}/revoke`, {}), 400);
    await ok(admin2.request('POST', `/security/grants/${ext}/revoke`, { reason: 'Purpose met' }));
    await refused(admin2.request('POST', `/security/grants/${ext}/revoke`, { reason: 'Again' }), 409);
    await refused(reveal(rev, caseId, 'source', id), 403);
    const revoked = (await t.pool.query(`SELECT revoked_by, revoke_reason FROM quarantine_grants WHERE id = $1`, [ext])).rows[0];
    assert.deepEqual(revoked, { revoked_by: ids.admin2, revoke_reason: 'Purpose met' });
    const listed = await ok(rev.request('GET', '/security/grants'));
    assert.deepEqual(listed.grants.map((x: { id: string; status: string }) => [x.id, x.status]).sort(), [[g, 'expired'], [ext, 'revoked']].sort());
  });

  test('ordinary Audit with Inspect Deleted Content cannot reveal', async () => {
    const id = await note('Plant room', PLANT);
    const caseId = await reported('source', id);
    await t.pool.query(
      `INSERT INTO access_grants (id, project_id, user_id, kind, purpose, scope, starts_on, expires_on, requested_by, requested_at, decision, decided_by, decided_at, inspect_deleted)
       VALUES ($1, $2, $3, 'audit', 'Annual audit', 'Everything', '2026-11-01', '2026-11-30', $4, now(), 'approved', $5, now(), true)`,
      [uuidv7(), project, ids.aud, ids.pm, ids.own],
    );
    await refused(reveal(aud, caseId, 'source', id), 403);
    await refused(releaseUnchanged(aud, caseId), 403);
    await refused(aud.request('GET', '/security/cases'), 403);
    await refused(request(aud, [caseId]), 403);
    // Nor an Administrator, nor the approver, nor the project's PM: only the grant's requester.
    await granted([caseId]);
    for (const c of [admin1, admin2, pm]) await refused(reveal(c, caseId, 'source', id), 403);
    assert.equal(Number((await t.pool.query(`SELECT count(*) AS n FROM quarantine_events WHERE action = 'original_opened'`)).rows[0].n), 0);
  });

  test('release unchanged restores originals and passages and notifies Administrators', async () => {
    const id = await note('Plant room', `${'Opening words. '.repeat(30)}\n\n${PLANT}\n\n${'Closing words. '.repeat(30)}`);
    const before = { versions: await versions(id), passages: await passages(id) };
    const th = (await ok(pm.request('POST', `/projects/${project}/threads`, { kind: 'discussion', title: 'Plant' }), 201)).id as string;
    const copy = (await ok(ben.request('POST', `/threads/${th}/messages`, { body: `Use ${SECRET} for the vault.` }), 201)).id as string;
    const caseId = await reported('source', id);
    await ok(pm.request('POST', `/quarantine/cases/${caseId}/copies`, { decisions: [{ kind: 'message', id: copy, decision: 'confirmed' }] }));
    assert.ok((await versions(id)).every((v) => !v.includes(SECRET)));
    assert.notDeepEqual(await passages(id), before.passages);

    await refused(releaseUnchanged(rev, caseId), 403);
    await granted([caseId]);
    await refused(releaseUnchanged(rev, caseId, ''), 400);
    await refused(releaseUnchanged(rev, caseId, `False alarm, ${KEY}`), 400);
    const r = await ok(releaseUnchanged(rev, caseId));
    assert.deepEqual({ ...r, restored: r.restored > 0 }, { caseId, state: 'released_unchanged', restored: true, changed: [] });
    // Originals and passages are back exactly; the copy too; nothing is held.
    assert.deepEqual(await versions(id), before.versions);
    assert.deepEqual(await passages(id), before.passages);
    const body = (await t.pool.query(`SELECT body FROM message_versions WHERE message_id = $1 ORDER BY version_no DESC LIMIT 1`, [copy])).rows[0].body;
    assert.equal(body, `Use ${SECRET} for the vault.`);
    assert.equal((await t.pool.query(`SELECT held_case_id FROM sources WHERE id = $1`, [id])).rows[0].held_case_id, null);
    assert.equal((await t.pool.query(`SELECT held_case_id FROM discussion_messages WHERE id = $1`, [copy])).rows[0].held_case_id, null);
    assert.equal((await ben.request('GET', `/notes/${id}`)).status, 200);
    // The case is closed as released_unchanged by the reviewer, with the reason; encrypted rows are kept.
    const row = (await t.pool.query(`SELECT state, closed_by, close_reason, closed_at FROM quarantine_cases WHERE id = $1`, [caseId])).rows[0];
    assert.deepEqual([row.state, row.closed_by, row.close_reason], ['released_unchanged', ids.rev, 'False alarm: a printed example, not a live code']);
    const originals = (await t.pool.query(`SELECT count(*) AS n, count(restored_at) AS r FROM quarantine_originals WHERE case_id = $1`, [caseId])).rows[0];
    assert.ok(Number(originals.n) > 0);
    assert.equal(originals.n, originals.r);
    const ev = (await t.pool.query(`SELECT actor_id, reason, detail FROM quarantine_events WHERE case_id = $1 AND action = 'released_unchanged'`, [caseId])).rows;
    assert.equal(ev.length, 1);
    assert.equal(ev[0].actor_id, ids.rev);
    assert.deepEqual(ev[0].detail.changed, []);
    // Every Administrator is told; never the text.
    const told = (await t.pool.query(`SELECT user_id, summary FROM notifications WHERE kind = 'quarantine_released_unchanged' ORDER BY user_id`)).rows;
    assert.deepEqual(told.map((n) => n.user_id).sort(), [ids.admin1, ids.admin2].sort());
    for (const n of told) {
      assert.equal(n.summary, 'A case held for a suspected credential in Alpha Project was released unchanged by a security reviewer as a false alarm.');
    }
    // Closed: no second release unchanged; no release; no reveal of a case that holds nothing.
    await refused(releaseUnchanged(rev, caseId), 409);
    await refused(pm.request('POST', `/quarantine/cases/${caseId}/release`, { reason: 'Checked' }), 409);
    assert.ok(!(await leakScan()).includes(SECRET));
  });

  test('release unchanged skips a value changed since cleaning', async () => {
    const id = await task(`Rotate the osprey vault code ${SECRET}`, `owner of ${SECRET}`);
    const caseId = await reported('task', id);
    const cleaned = (await t.pool.query(`SELECT title, owner_as_written FROM tasks WHERE id = $1`, [id])).rows[0];
    assert.deepEqual(cleaned, { title: `Rotate the osprey vault code ${MARKER}`, owner_as_written: `owner of ${MARKER}` });
    // The task, in view and in work while under review, is amended (the change handler's own UPDATE).
    await t.pool.query(`UPDATE tasks SET title = 'Rotate the staging key' WHERE id = $1`, [id]);
    await granted([caseId]);
    const r = await ok(releaseUnchanged(rev, caseId));
    assert.deepEqual(r.changed, [{ table: 'tasks', rowKey: { id }, label: CHANGED_SINCE_CLEANING }]);
    assert.equal(CHANGED_SINCE_CLEANING, 'changed since cleaning — not restored');
    const now = (await t.pool.query(`SELECT title, owner_as_written, held_case_id FROM tasks WHERE id = $1`, [id])).rows[0];
    assert.deepEqual(now, { title: 'Rotate the staging key', owner_as_written: `owner of ${SECRET}`, held_case_id: null }, 'the amendment is kept; the unchanged value is restored');
    // The case lists it, for the reviewer and the Administrators.
    for (const [c, path] of [[rev, '/security/cases'], [admin1, '/security/admin-cases']] as const) {
      const listed = (await ok(c.request('GET', path))).cases.find((x: { caseId: string }) => x.caseId === caseId);
      assert.equal(listed.state, 'released_unchanged');
      assert.deepEqual(listed.changedSinceCleaning, [{ table: 'tasks', rowKey: { id }, label: CHANGED_SINCE_CLEANING }]);
    }
    const left = (await t.pool.query(`SELECT table_name, column_name FROM quarantine_originals WHERE case_id = $1 AND restored_at IS NULL`, [caseId])).rows;
    assert.deepEqual(left, [{ table_name: 'tasks', column_name: 'title' }]);
  });

  test('no export, email or AI path accepts a quarantined original', async () => {
    const id = await note('Plant room', PLANT);
    const caseId = await reported('source', id);
    await granted([caseId]);
    const shown = await ok(reveal(rev, caseId, 'source', id));
    assert.ok(json(shown).includes(SECRET), 'Reveal is the one answer that carries the original');
    // The case is not released unchanged: the original stays out of every path that feeds AI, search, email or export.
    // Ask material (the input of every new AI request), as the project's people and the reviewer would get it.
    for (const user of [ids.ben, ids.pm, ids.rev]) {
      const ctx = await t.app.get(ProjectAccess).load(project, { id: user, email: 'x@example.org', displayName: 'x', role: 'member' });
      if (ctx) assert.ok(!json(await findMaterial(t.pool, { kind: 'personal', ctx }, ['vault', 'kestrel', SECRET])).includes(SECRET));
    }
    assert.ok(!json((await t.pool.query(`SELECT * FROM ai_request_material`)).rows).includes(SECRET));
    // Search, the digest (email body) and every email written, including the reviewer's and Administrators'.
    for (const c of [ben, pm, rev, admin1]) {
      const s = await c.request('GET', `/search?q=${encodeURIComponent(SECRET)}`);
      assert.ok(!json(s.body).includes(SECRET));
    }
    for (const user of [ids.ben, ids.pm]) assert.ok(!json(await buildDigest(t.pool, project, user, t.clock.now(), 'https://kainow.example.org')).includes(SECRET));
    assert.ok(!json((await t.pool.query(`SELECT subject, text_body, html_body FROM email_outbox`)).rows).includes(SECRET));
    // Export and download routes of the item: the cleaned text, or nothing.
    for (const path of [`/notes/${id}`, `/notes/${id}/versions/1`, `/notes/${id}/versions/1/original`]) {
      const r = await pm.raw('GET', path);
      assert.ok(!r.text.includes(SECRET), path);
    }
    // No other security answer carries it: the case lists, the grants, the reviewers.
    for (const [c, path] of [[rev, '/security/cases'], [rev, '/security/grants'], [admin1, '/security/admin-cases'], [admin1, '/security/grants'], [admin1, '/security/reviewers']] as const) {
      const r = await ok(c.request('GET', path));
      assert.ok(!json(r).includes(SECRET), path);
    }
    // Known disclosures are shown to Administrators and reviewers, as counts and dates only.
    const adminCase = (await ok(admin1.request('GET', '/security/admin-cases'))).cases.find((x: { caseId: string }) => x.caseId === caseId);
    assert.deepEqual(Object.keys(adminCase.disclosures).sort(), ['aiRequests', 'audienceSize', 'emails']);
    assert.equal(adminCase.disclosuresLabel, 'Known disclosures (copies outside Kainow cannot be recalled)');
    assert.equal(adminCase.reporter, 'ada');
    assert.equal(adminCase.project, 'Alpha Project');
    // Nothing stored holds it: events, audit, notifications, emails, cases, grants.
    assert.ok(!(await leakScan()).includes(SECRET));
  });
});
