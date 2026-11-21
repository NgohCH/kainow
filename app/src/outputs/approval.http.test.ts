import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { uuidv7 } from '../common/uuid7';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedProject, seedUser } from '../testing/projects';
import { DOES_NOT_APPROVE_COMMITMENTS, endOutputApprovalRequests, FILE_NOT_AS_FILED, IN_REVIEW, LATER_APPROVED, NOT_A_DRAFT, NOT_CHECKED, NOT_FILED, NOT_REGISTERED } from './approval-handler';

function multipart(fields: Record<string, string>, file: { name: string; bytes: Buffer }): { body: Buffer; type: string } {
  const b = 'approvalboundary42';
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`), file.bytes, Buffer.from(`\r\n--${b}--\r\n`));
  return { body: Buffer.concat(parts), type: `multipart/form-data; boundary=${b}` };
}

describe('approving an output version', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let project: string;
  const ids: Record<string, string> = {};
  const c: Record<string, Client> = {};
  const url = (p = '') => `/projects/${project}/outputs${p}`;
  const rows = async (sql: string, params: unknown[] = []) => (await t.pool.query(sql, params)).rows;

  /** A registered output (version 1 uploaded, not filed). */
  async function registered(title = 'Status report', by = 'pm', restrictTo?: string[]): Promise<string> {
    const m = multipart({ title }, { name: 'report.md', bytes: Buffer.from(`# ${title}\n\nThe valve audit is on Friday.\n`) });
    const sub = await c[by].upload('POST', url(), m.body, m.type);
    assert.equal(sub.status, 201, JSON.stringify(sub.body));
    const typeId = (await rows(`SELECT id FROM report_types WHERE name = 'Status reports'`))[0].id;
    const reg = await c[by].request('POST', url(`/${sub.body.id}/register`), { reportTypeId: typeId, issueDate: '2026-11-09', ...(restrictTo ? { audience: { mode: 'restricted', namedUserIds: restrictTo } } : {}) });
    assert.equal(reg.status, 200, JSON.stringify(reg.body));
    return sub.body.id;
  }
  async function addVersion(outputId: string): Promise<number> {
    const m = multipart({}, { name: 'report.md', bytes: Buffer.from(`# Next\n\nChanged ${uuidv7()}\n`) });
    const r = await c.pm.upload('POST', url(`/${outputId}/versions`), m.body, m.type);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.versions.length;
  }
  /** Gives version `n` a stored file as filing would leave it (state and the last check as given). */
  async function filed(outputId: string, n: number, state = 'stored', check = 'unverified'): Promise<void> {
    const id = uuidv7();
    await t.pool.query(
      `INSERT INTO stored_files (id, purpose, project_id, name, state, check_status, created_at) VALUES ($1, 'output', $2, $3, $4, $5, now())`,
      [id, project, `v${n}.md`, state, check],
    );
    await t.pool.query(`UPDATE output_versions SET stored_file_id = $1 WHERE output_id = $2 AND version_no = $3`, [id, outputId, n]);
  }
  const ask = (who: Client, outputId: string, n = 1) => who.request('POST', url(`/${outputId}/versions/${n}/approval`));
  const asked = async (who: Client, outputId: string, n = 1) => {
    const r = await ask(who, outputId, n);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.request as { id: string; version: number; status: string; requiredApprovals: number };
  };
  const approve = (who: Client, request: { id: string; version: number }) => who.request('POST', `/changes/${request.id}/approve`, { version: request.version });
  const statuses = async (outputId: string) => (await rows(`SELECT version_no AS n, status FROM output_versions WHERE output_id = $1 ORDER BY version_no`, [outputId])).map((r) => `${r.n}:${r.status}`);
  const events = async (outputId: string) =>
    (await rows(`SELECT e.kind, v.version_no AS n FROM output_events e LEFT JOIN output_versions v ON v.id = e.version_id WHERE e.output_id = $1 ORDER BY e.at, e.id`, [outputId])).map((r) => `${r.kind}${r.n ? `:${r.n}` : ''}`);
  const required = (n: number) => t.pool.query(`UPDATE approval_policy SET required = $1`, [n]);
  const refusal = async (p: Promise<{ status: number; body: any }>, status: number, text: string) => {
    const r = await p;
    assert.equal(r.status, status, JSON.stringify(r.body));
    assert.equal(r.body.message, text);
  };

  beforeEach(async () => {
    t = await startTestApp();
    await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    for (const k of ['pm', 'deputy', 'owner', 'sponsor', 'ada', 'pmowner']) ids[k] = await seedUser(t.pool, `${k}@example.org`);
    project = await seedProject(t.pool, {
      status: 'active',
      name: 'Pump station renewal',
      members: [
        { userId: ids.pm, role: 'pm' },
        { userId: ids.deputy, role: 'deputy_pm' },
        { userId: ids.owner, role: 'owner' },
        { userId: ids.sponsor, role: 'sponsor' },
        { userId: ids.ada, role: 'member' },
      ],
    });
    for (const k of Object.keys(ids)) c[k] = await t.signIn(`${k}@example.org`);
  });
  afterEach(async () => t.close());

  test('PM requests approval of a filed version; Owner approves; version Approved with reference', async () => {
    const out = await registered();
    await filed(out, 1);
    const req = await asked(c.pm, out);
    assert.equal(req.status, 'pending');
    assert.deepEqual(await statuses(out), ['1:draft']);
    assert.equal((await c.pm.request('GET', url(`/${out}`))).body.versions[0].approvalRequestId, null);

    const done = await approve(c.owner, req);
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(done.body.request.status, 'authorised');
    assert.deepEqual(await statuses(out), ['1:approved']);
    assert.equal((await rows(`SELECT approval_request_id AS r FROM output_versions WHERE output_id = $1`, [out]))[0].r, req.id);
    // Events written in one instant have no order among themselves, so they are compared as a set.
    assert.deepEqual((await events(out)).sort(), ['approval_requested:1', 'approved:1', 'registered', 'submitted:1']);
    const detail = await c.pm.request('GET', url(`/${out}`));
    assert.equal(detail.body.versions[0].status, 'approved');
    assert.equal(detail.body.versions[0].approvalRequestId, req.id, 'the register shows the approval reference');
    assert.ok(detail.body.history.some((h: { kind: string; versionNo: number }) => h.kind === 'approved' && h.versionNo === 1));
  });

  test('approving v2 supersedes approved v1; a draft v1 stays draft', async () => {
    const out = await registered();
    await filed(out, 1);
    await approve(c.owner, await asked(c.pm, out, 1));
    assert.equal(await addVersion(out), 2);
    await filed(out, 2);
    assert.deepEqual(await statuses(out), ['1:approved', '2:draft']);
    const done = await approve(c.sponsor, await asked(c.deputy, out, 2));
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.deepEqual(await statuses(out), ['1:superseded', '2:approved']);
    // The approval first, then the version it replaced, in that order (not sorted; the test clock is frozen, so only offsets order them).
    assert.deepEqual((await events(out)).filter((e) => e === 'approved:2' || e === 'superseded:1'), ['approved:2', 'superseded:1']);

    // A draft earlier version is not changed by a later approval, and can no longer be approved itself.
    const other = await registered('Second report');
    await filed(other, 1);
    await addVersion(other);
    await filed(other, 2);
    await approve(c.owner, await asked(c.pm, other, 2));
    assert.deepEqual(await statuses(other), ['1:draft', '2:approved']);
    await refusal(ask(c.pm, other, 1), 409, LATER_APPROVED);
    // An approved version cannot be put for approval again.
    await refusal(ask(c.pm, other, 2), 409, NOT_A_DRAFT);
  });

  test('unfiled, changed, missing and access-denied versions cannot be put for approval', async () => {
    const unfiled = await registered('Unfiled');
    await refusal(ask(c.pm, unfiled), 409, NOT_FILED);
    for (const state of ['pending', 'storing', 'failed', 'withheld', 'relocating', 'missing']) {
      const o = await registered(`State ${state}`);
      await filed(o, 1, state);
      await refusal(ask(c.pm, o), 409, NOT_FILED);
    }
    for (const check of ['changed', 'missing', 'access_denied']) {
      const o = await registered(`Check ${check}`);
      await filed(o, 1, 'stored', check);
      await refusal(ask(c.pm, o), 409, FILE_NOT_AS_FILED);
    }
    // A link counts as checked only when its last check passed.
    const link = await registered('A link');
    await filed(link, 1, 'linked', 'unverified');
    await refusal(ask(c.pm, link), 409, NOT_CHECKED);
    await t.pool.query(`UPDATE stored_files SET check_status = 'moved' WHERE state = 'linked'`);
    await refusal(ask(c.pm, link), 409, NOT_CHECKED);
    await t.pool.query(`UPDATE stored_files SET check_status = 'ok' WHERE state = 'linked'`);
    await asked(c.pm, link);
    // A filed version whose check has passed, or has not run, is fine.
    const good = await registered('Good');
    await filed(good, 1, 'stored', 'ok');
    await asked(c.pm, good);
    assert.equal((await rows(`SELECT count(*)::int AS n FROM change_requests WHERE kind = 'approve_output' AND status = 'pending'`))[0].n, 2);
  });

  test('a file that changes after the request is checked again when approving', async () => {
    const out = await registered();
    await filed(out, 1);
    const req = await asked(c.pm, out);
    await t.pool.query(`UPDATE stored_files SET check_status = 'changed' WHERE state = 'stored'`);
    await refusal(approve(c.owner, req), 409, FILE_NOT_AS_FILED);
    assert.deepEqual(await statuses(out), ['1:draft']);
  });

  test('a submitted, in-review, deleted or unknown output or version cannot be put for approval', async () => {
    const m = multipart({ title: 'Only submitted' }, { name: 'r.md', bytes: Buffer.from('# R\n\nText.\n') });
    const sub = await c.pm.upload('POST', url(), m.body, m.type);
    await filed(sub.body.id, 1);
    await refusal(ask(c.pm, sub.body.id), 409, NOT_REGISTERED);

    const out = await registered();
    await filed(out, 1);
    await t.pool.query(`UPDATE outputs SET review_state = 'review_required' WHERE id = $1`, [out]);
    await refusal(ask(c.pm, out), 409, IN_REVIEW);
    await t.pool.query(`UPDATE outputs SET review_state = 'cleared' WHERE id = $1`, [out]);
    assert.equal((await ask(c.pm, out, 9)).status, 404);
    await t.pool.query(`UPDATE outputs SET deleted_at = now(), deleted_by = $2, delete_reason = 'x' WHERE id = $1`, [out, ids.pm]);
    assert.equal((await ask(c.pm, out, 1)).status, 404);
  });

  test('two-approval policy needs two distinct people', async () => {
    await required(2);
    const out = await registered();
    await filed(out, 1);
    const req = await asked(c.pm, out);
    assert.equal(req.requiredApprovals, 2);
    const first = await approve(c.owner, req);
    assert.equal(first.status, 200);
    assert.equal(first.body.request.status, 'pending');
    // The same person again changes nothing.
    const again = await approve(c.owner, req);
    assert.equal(again.body.request.status, 'pending');
    assert.deepEqual(await statuses(out), ['1:draft']);
    assert.equal((await rows(`SELECT count(*)::int AS n FROM approvals WHERE request_id = $1`, [req.id]))[0].n, 1);
    const second = await approve(c.sponsor, req);
    assert.equal(second.body.request.status, 'authorised');
    assert.deepEqual(await statuses(out), ['1:approved']);
  });

  test('combined PM-Owner counts once toward a two-approval policy', async () => {
    await required(2);
    const both = await seedProject(t.pool, {
      status: 'active',
      name: 'Small team',
      members: [
        { userId: ids.pmowner, role: 'pm' },
        { userId: ids.pmowner, role: 'owner' },
        { userId: ids.sponsor, role: 'sponsor' },
        { userId: ids.ada, role: 'member' },
      ],
    });
    project = both;
    const out = await registered('Status report', 'pmowner');
    await filed(out, 1);
    // The person who asks, holding both roles, approves in the request itself and again afterwards: one approval.
    const versionId = (await rows(`SELECT id FROM output_versions WHERE output_id = $1`, [out]))[0].id;
    const sub = await c.pmowner.request('POST', `/projects/${both}/changes`, { kind: 'approve_output', targetKind: 'output_version', targetId: versionId, terms: {}, approve: true });
    assert.equal(sub.status, 201, JSON.stringify(sub.body));
    // Asking by the generic route records the request on the output and the audit trail just as the output route does.
    assert.ok((await events(out)).includes('approval_requested:1'));
    assert.equal((await rows(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'output.approval_requested' AND subject_id = $1`, [out]))[0].n, 1);
    const req = sub.body.request;
    assert.equal(req.status, 'pending');
    assert.equal(req.approvals.length, 1);
    const again = await approve(c.pmowner, req);
    assert.equal(again.body.request.status, 'pending');
    assert.equal((await rows(`SELECT count(*)::int AS n FROM approvals WHERE request_id = $1`, [req.id]))[0].n, 1);
    assert.deepEqual(await statuses(out), ['1:draft']);
    // A second distinct approver completes it.
    const done = await approve(c.sponsor, req);
    assert.equal(done.body.request.status, 'authorised');
    assert.deepEqual(await statuses(out), ['1:approved']);

    // With nobody but the PM-Owner able to approve, two approvals cannot be reached.
    await t.pool.query(`UPDATE memberships SET revoked_at = now(), revoked_by = $2 WHERE project_id = $1 AND role = 'sponsor'`, [both, ids.pmowner]);
    const next = await registered('Next report', 'pmowner');
    await filed(next, 1);
    const pending = await asked(c.pmowner, next);
    const blocked = await approve(c.pmowner, pending);
    assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
    assert.match(blocked.body.message, /Not enough approvers: needs 2, the project has 1/);
    assert.deepEqual(await statuses(next), ['1:draft']);
  });

  test('rejection leaves the version Draft', async () => {
    const out = await registered();
    await filed(out, 1);
    const req = await asked(c.pm, out);
    const rej = await c.owner.request('POST', `/changes/${req.id}/reject`, { reason: 'Not ready' });
    assert.equal(rej.status, 200, JSON.stringify(rej.body));
    assert.equal(rej.body.request.status, 'rejected');
    assert.deepEqual(await statuses(out), ['1:draft']);
    assert.equal((await rows(`SELECT approval_request_id AS r FROM output_versions WHERE output_id = $1`, [out]))[0].r, null);
    // It may be put for approval again.
    assert.equal((await ask(c.deputy, out)).status, 201);
  });

  test('Member cannot request; Deputy can; Owner and Sponsor approve; Planned and Active only', async () => {
    const out = await registered();
    await filed(out, 1);
    assert.equal((await ask(c.ada, out)).status, 403);
    assert.equal((await ask(c.owner, out)).status, 403);
    assert.equal((await ask(c.sponsor, out)).status, 403);
    const req = await asked(c.deputy, out);
    // Only an Owner or Sponsor approves.
    assert.equal((await approve(c.pm, req)).status, 403);
    assert.equal((await approve(c.deputy, req)).status, 403);
    assert.equal((await approve(c.ada, req)).status, 403);
    assert.equal((await approve(c.sponsor, req)).status, 200);
    assert.deepEqual(await statuses(out), ['1:approved']);

    const second = await registered('Second');
    await filed(second, 1);
    assert.equal((await approve(c.owner, await asked(c.pm, second))).status, 200);

    for (const status of ['deferred', 'closed']) {
      const o = await registered(`Not for ${status}`);
      await filed(o, 1);
      await t.pool.query(`UPDATE projects SET status = $2, closure_outcome = $3 WHERE id = $1`, [project, status, status === 'closed' ? 'abandoned' : null]);
      assert.equal((await ask(c.pm, o)).status, 403, status);
      await t.pool.query(`UPDATE projects SET status = 'active', closure_outcome = NULL WHERE id = $1`, [project]);
    }
    // A request waiting when the project is deferred cannot be approved until it is Planned or Active again.
    const waiting = await registered('Waiting');
    await filed(waiting, 1);
    const wreq = await asked(c.pm, waiting);
    await t.pool.query(`UPDATE projects SET status = 'deferred' WHERE id = $1`, [project]);
    assert.equal((await approve(c.owner, wreq)).status, 409);
    await t.pool.query(`UPDATE projects SET status = 'planned' WHERE id = $1`, [project]);
    assert.equal((await approve(c.owner, wreq)).status, 200);
  });

  test('approval requests are listed only to people who may read the output, and leave with a Deleted one', async () => {
    const out = await registered('Board paper', 'pm', [ids.pm, ids.owner, ids.sponsor]);
    await filed(out, 1);
    const req = await asked(c.pm, out);
    assert.equal((await ask(c.deputy, out)).status, 404); // a Deputy outside the audience cannot even see it
    const listed = async (who: Client) => {
      const r = await who.request('GET', `/projects/${project}/changes`);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      return (r.body.requests ?? r.body) as Array<{ id: string; output?: unknown }>;
    };
    assert.ok((await listed(c.owner)).some((x) => x.id === req.id));
    const seen = await listed(c.ada);
    assert.ok(!seen.some((x) => x.id === req.id));
    assert.ok(!JSON.stringify(seen).includes('Board paper'));
    // The people who may not read it do not get it from their own dashboard either.
    assert.ok(!JSON.stringify((await c.ada.request('GET', '/dashboard/me')).body).includes('Board paper'));
    await t.pool.query(`UPDATE outputs SET deleted_at = now(), deleted_by = $2, delete_reason = 'x' WHERE id = $1`, [out, ids.pm]);
    assert.ok(!(await listed(c.owner)).some((x) => x.id === req.id));
  });

  test('ending an output ends its waiting approval requests; approving a later version ends earlier ones', async () => {
    const ended = await registered('Withdrawn soon');
    await filed(ended, 1);
    const req = await asked(c.pm, ended);
    const cx = await t.pool.connect();
    try {
      await cx.query('BEGIN');
      assert.equal(await endOutputApprovalRequests(cx, ended, ids.pm, new Date()), 1);
      await cx.query('COMMIT');
    } finally {
      cx.release();
    }
    const row = (await rows(`SELECT status, decided_by AS "by" FROM change_requests WHERE id = $1`, [req.id]))[0];
    assert.deepEqual([row.status, row.by], ['withdrawn', ids.pm]);
    assert.equal((await approve(c.owner, req)).status, 409);

    const out = await registered('Two versions');
    await filed(out, 1);
    await addVersion(out);
    await filed(out, 2);
    const first = await asked(c.pm, out, 1);
    const second = await asked(c.pm, out, 2);
    assert.equal((await approve(c.owner, second)).status, 200);
    assert.equal((await rows(`SELECT status FROM change_requests WHERE id = $1`, [first.id]))[0].status, 'superseded');
    assert.deepEqual(await statuses(out), ['1:draft', '2:approved']);
    assert.equal((await approve(c.owner, first)).status, 409);
  });

  test('approval response carries the does-not-approve-commitments text', async () => {
    const out = await registered('Quarterly plan');
    await filed(out, 1);
    const r = await ask(c.pm, out);
    assert.equal(r.body.notice, DOES_NOT_APPROVE_COMMITMENTS);
    assert.equal(r.body.request.notice, 'Approving this document does not approve the commitments it mentions.');
    assert.deepEqual(r.body.request.output, { id: out, title: 'Quarterly plan', versionNo: 1 });
    const listed = await c.owner.request('GET', `/projects/${project}/changes?status=pending`);
    assert.equal(listed.status, 200);
    const item = (listed.body.requests ?? listed.body).find((x: { id: string }) => x.id === r.body.request.id);
    assert.equal(item.notice, DOES_NOT_APPROVE_COMMITMENTS);
    const done = await approve(c.owner, r.body.request);
    assert.equal(done.body.request.notice, DOES_NOT_APPROVE_COMMITMENTS);
  });
});
