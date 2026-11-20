import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { draftAccess, loadDraftRow } from '../assist/reports.service';
import type { AuthUser } from '../auth/tokens';
import { uuidv7 } from '../common/uuid7';
import { ProjectAccess } from '../projects/access.service';
import { SKIP_NO_DB } from '../testing/db';
import { materialFor, seedDraft } from '../testing/drafts';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedProject, seedUser } from '../testing/projects';
import { isWholeProject, materialReaders, outputReaders } from './readers';

describe('output readers', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  const ids: Record<string, string> = {};
  let project: string;
  let pm: Client;
  const person = (k: string): AuthUser => ({ id: ids[k], email: `${k}@example.org`, displayName: k, role: 'member' });
  const names = (set: Set<string>) => Object.keys(ids).filter((k) => set.has(ids[k])).sort();

  const grant = async (userId: string, startsOn: string, expiresOn: string) => {
    await t.pool.query(
      `INSERT INTO access_grants (id, project_id, user_id, kind, purpose, scope, starts_on, expires_on, requested_by, requested_at, decision, decided_by, decided_at)
       VALUES ($1, $2, $3, 'audit', 'Annual audit', 'Everything', $4, $5, $6, now(), 'approved', $7, now())`,
      [uuidv7(), project, userId, startsOn, expiresOn, ids.pm, ids.admin],
    );
  };
  /** A meeting with one message; Restricted to the named people when given. */
  const meeting = async (title: string, message: string, named?: string[]) => {
    const r = await pm.request('POST', `/projects/${project}/threads`, { kind: 'meeting', title, ...(named ? { audience: { mode: 'restricted', namedUserIds: named } } : {}) });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const m = await pm.request('POST', `/threads/${r.body.id}/messages`, { body: message });
    assert.equal(m.status, 201, JSON.stringify(m.body));
  };
  const output = async (opts: { status?: string; review?: string; audience?: string[]; author?: string; draftVersionId?: string; deleted?: boolean } = {}) => {
    const id = uuidv7();
    let audienceId: string | null = null;
    if (opts.audience) {
      audienceId = uuidv7();
      await t.pool.query(`INSERT INTO audiences (id, project_id, mode, created_at) VALUES ($1, $2, 'restricted', now())`, [audienceId, project]);
      for (const u of opts.audience) await t.pool.query(`INSERT INTO audience_members (audience_id, user_id, added_by, added_at) VALUES ($1, $2, $3, now())`, [audienceId, u, ids.pm]);
    }
    await t.pool.query(
      `INSERT INTO outputs (id, project_id, title, status, review_state, audience_id, author_id, created_at, deleted_at, deleted_by, delete_reason)
       VALUES ($1, $2, 'Weekly status', $3, $4, $5, $6, now(), $7, $8, $9)`,
      [id, project, opts.status ?? 'registered', opts.review ?? 'none', audienceId, opts.author ?? ids.pm, opts.deleted ? new Date() : null, opts.deleted ? ids.pm : null, opts.deleted ? 'Duplicate' : null],
    );
    if (opts.draftVersionId) {
      await t.pool.query(
        `INSERT INTO output_versions (id, output_id, version_no, origin, format, draft_version_id, status, sha256, size_bytes, created_by, created_at)
         VALUES ($1, $2, 1, 'draft_report', 'md', $3, 'draft', 'abc', 10, $4, now())`,
        [uuidv7(), id, opts.draftVersionId, ids.pm],
      );
    }
    return id;
  };

  beforeEach(async () => {
    t = await startTestApp();
    ids.admin = await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    for (const k of ['pm', 'deputy', 'owner', 'sponsor', 'ada', 'bob', 'gone', 'auditor', 'lapsed', 'leader', 'outsider']) ids[k] = await seedUser(t.pool, `${k}@example.org`);
    project = await seedProject(t.pool, {
      status: 'active',
      members: [
        { userId: ids.pm, role: 'pm' },
        { userId: ids.deputy, role: 'deputy_pm' },
        { userId: ids.owner, role: 'owner' },
        { userId: ids.sponsor, role: 'sponsor' },
        { userId: ids.ada, role: 'member' },
        { userId: ids.bob, role: 'member' },
        { userId: ids.gone, role: 'member', revoked: true },
      ],
    });
    await grant(ids.auditor, '2026-11-01', '2026-11-30');
    await grant(ids.lapsed, '2026-10-01', '2026-11-05');
    await t.pool.query(
      `INSERT INTO leadership_grants (id, user_id, scope_kind, starts_on, reason, granted_by, granted_at) VALUES ($1, $2, 'organisation', '2026-11-01', 'Board view', $3, now())`,
      [uuidv7(), ids.leader, ids.admin],
    );
    pm = await t.signIn('pm@example.org');
    delete ids.admin;
  });
  afterEach(async () => t.close());

  test('materialReaders matches draftAccess for every project reader', async () => {
    await meeting('Board meeting', 'The pump service is booked for Thursday morning.', [ids.ada]);
    await meeting('Plant meeting', 'The valve audit is planned for Friday.');
    const access = t.app.get(ProjectAccess);
    const restricted = await seedDraft(t.pool, { projectId: project, requesterId: ids.ada, items: await materialFor(t.pool, access, project, person('ada'), 'pump service') });
    const open = await seedDraft(t.pool, { projectId: project, requesterId: ids.bob, items: await materialFor(t.pool, access, project, person('bob'), 'valve audit') });
    for (const seeded of [restricted, open]) {
      const got = await materialReaders(t.pool, seeded.aiVersionId, project, t.clock.now());
      const row = await loadDraftRow(t.pool, seeded.draftId);
      assert.ok(row);
      for (const k of Object.keys(ids)) {
        const ctx = await access.load(project, person(k));
        const expected: boolean = (await draftAccess(t.pool, ctx, row)) === 'readable';
        assert.equal(got.has(ids[k]), expected, `${k} for ${seeded === open ? 'open' : 'restricted'} material`);
      }
    }
    assert.deepEqual(names(await materialReaders(t.pool, restricted.editedVersionId, project, t.clock.now())), ['ada', 'deputy', 'owner', 'pm', 'sponsor']);
    assert.deepEqual(names(await materialReaders(t.pool, open.aiVersionId, project, t.clock.now())), ['ada', 'auditor', 'bob', 'deputy', 'owner', 'pm', 'sponsor']);
    // Another project's draft version has no readers here.
    const other = await seedProject(t.pool, { status: 'active', members: [{ userId: ids.pm, role: 'pm' }] });
    assert.equal((await materialReaders(t.pool, restricted.aiVersionId, other, t.clock.now())).size, 0);
  });

  test('outputReaders is project content readers for Project-wide, the audience intersection for Restricted, and PM/Deputy/Owner/Sponsor among material readers in review', async () => {
    const at = t.clock.now();
    const everyone = ['ada', 'auditor', 'bob', 'deputy', 'owner', 'pm', 'sponsor'];
    const wide = await output();
    assert.deepEqual(names(await outputReaders(t.pool, wide, at)), everyone);
    assert.equal(await isWholeProject(t.pool, wide, at), true);

    // Restricted: the named people who can still read the project; roles add nobody.
    const narrow = await output({ audience: [ids.ada, ids.owner, ids.gone, ids.outsider] });
    assert.deepEqual(names(await outputReaders(t.pool, narrow, at)), ['ada', 'owner']);
    assert.equal(await isWholeProject(t.pool, narrow, at), false);

    // In review: PM, Deputy, Owner and Sponsor among those who can read all its material.
    await meeting('Board meeting', 'The pump service is booked for Thursday morning.', [ids.ada]);
    const seeded = await seedDraft(t.pool, { projectId: project, requesterId: ids.ada, items: await materialFor(t.pool, t.app.get(ProjectAccess), project, person('ada'), 'pump service') });
    const review = await output({ review: 'review_required', draftVersionId: seeded.aiVersionId });
    assert.deepEqual(names(await outputReaders(t.pool, review, at)), ['deputy', 'owner', 'pm', 'sponsor']);
    assert.equal(await isWholeProject(t.pool, review, at), false);
    // A draft in review is read only by its reviewers, so its material narrows to them.
    await t.pool.query(`UPDATE report_drafts SET review_state = 'review_required' WHERE id = $1`, [seeded.draftId]);
    assert.deepEqual(names(await outputReaders(t.pool, review, at)), ['deputy', 'pm'], 'only reviewers of a draft in review read its material');
    // Cleared: back to its audience.
    await t.pool.query(`UPDATE report_drafts SET review_state = 'none' WHERE id = $1`, [seeded.draftId]);
    const cleared = await output({ review: 'cleared', draftVersionId: seeded.aiVersionId });
    assert.deepEqual(names(await outputReaders(t.pool, cleared, at)), everyone);

    // In review and Restricted: only those of them also in the audience (an Owner outside it reads nothing).
    const narrowReview = await output({ review: 'review_required', draftVersionId: seeded.aiVersionId, audience: [ids.pm, ids.sponsor, ids.ada] });
    assert.deepEqual(names(await outputReaders(t.pool, narrowReview, at)), ['pm', 'sponsor']);

    // Submitted, Declined, Withdrawn: submitter, PM and Deputies, within the audience.
    for (const status of ['submitted', 'declined', 'withdrawn']) {
      assert.deepEqual(names(await outputReaders(t.pool, await output({ status, author: ids.bob }), at)), ['bob', 'deputy', 'pm'], status);
      assert.deepEqual(names(await outputReaders(t.pool, await output({ status, author: ids.bob, audience: [ids.pm, ids.owner] }), at)), ['pm'], `${status} restricted`);
      assert.equal(await isWholeProject(t.pool, await output({ status }), at), false);
    }
    const deleted = await output({ deleted: true });
    assert.equal((await outputReaders(t.pool, deleted, at)).size, 0);
    assert.equal(await isWholeProject(t.pool, deleted, at), false);
    assert.equal((await outputReaders(t.pool, uuidv7(), at)).size, 0);
  });

  test('Audit grant holders read within scope; leadership grant holders never', async () => {
    const wide = await output();
    const readers = await outputReaders(t.pool, wide, t.clock.now());
    assert.ok(readers.has(ids.auditor), 'an Active Audit grant reads');
    assert.ok(!readers.has(ids.lapsed), 'a grant past its end does not');
    assert.ok(!readers.has(ids.leader), 'a leadership grant never includes outputs');
    assert.ok(!readers.has(ids.outsider));
    assert.ok(!readers.has(ids.gone), 'a revoked membership does not');
    // Before the grant starts, and after it ends.
    assert.ok(!(await outputReaders(t.pool, wide, new Date('2026-10-20T02:00:00Z'))).has(ids.auditor));
    assert.ok(!(await outputReaders(t.pool, wide, new Date('2026-12-02T02:00:00Z'))).has(ids.auditor));
    // A grant holder named in a Restricted audience reads it; one not named does not.
    assert.ok((await outputReaders(t.pool, await output({ audience: [ids.auditor] }), t.clock.now())).has(ids.auditor));
    assert.ok(!(await outputReaders(t.pool, await output({ audience: [ids.pm] }), t.clock.now())).has(ids.auditor));
    // Submissions are never for grant holders.
    assert.ok(!(await outputReaders(t.pool, await output({ status: 'submitted' }), t.clock.now())).has(ids.auditor));
  });
});
