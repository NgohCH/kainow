import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { uuidv7 } from '../common/uuid7';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedProject, seedUser } from '../testing/projects';

describe('outputs in search, history and the system panel', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let project: string;
  const ids: Record<string, string> = {};
  const c: Record<string, Client> = {};

  const typeId = async (name: string) => (await t.pool.query(`SELECT id FROM report_types WHERE name = $1`, [name])).rows[0].id as string;

  async function seedOutput(title: string, o: { status?: string; type?: string; categories?: string[]; restrictTo?: string[]; author?: string; review?: boolean } = {}): Promise<string> {
    const id = uuidv7();
    let audienceId: string | null = null;
    if (o.restrictTo) {
      audienceId = uuidv7();
      await t.pool.query(`INSERT INTO audiences (id, project_id, mode, created_at) VALUES ($1, $2, 'restricted', now())`, [audienceId, project]);
      for (const u of o.restrictTo) await t.pool.query(`INSERT INTO audience_members (audience_id, user_id, added_by, added_at) VALUES ($1, $2, $3, now())`, [audienceId, u, ids.pm]);
    }
    await t.pool.query(
      `INSERT INTO outputs (id, project_id, title, report_type_id, issue_date, audience_id, status, review_state, author_id, created_at)
       VALUES ($1, $2, $3, $4, '2026-11-09', $5, $6, $7, $8, '2026-11-09T02:00:00Z')`,
      [id, project, title, await typeId(o.type ?? 'Status reports'), audienceId, o.status ?? 'registered', o.review ? 'review_required' : 'none', o.author ?? ids.pm],
    );
    for (const cat of o.categories ?? []) await t.pool.query(`INSERT INTO output_categories (output_id, report_type_id) VALUES ($1, $2)`, [id, await typeId(cat)]);
    return id;
  }
  async function holdCase(itemId: string): Promise<string> {
    const id = uuidv7();
    await t.pool.query(
      `INSERT INTO quarantine_cases (id, project_id, item_kind, item_id, reporter_id, marked_length, state, reported_at) VALUES ($1, $2, 'output', $3, $4, 10, 'held', now())`,
      [id, project, itemId, ids.pm],
    );
    return id;
  }
  const found = async (who: Client, phrase: string): Promise<Array<{ kind: string; id: string; title: string; href: string; projectId?: string; outputId?: string }>> => {
    const r = await who.request('GET', `/search?q=${encodeURIComponent(phrase)}&kinds=output`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.projects.flatMap((p: any) => p.results);
  };
  let tick = 0;
  const event = async (outputId: string, kind: string, actor: string | null, reason: string | null = null) => {
    tick += 1;
    await t.pool.query(`INSERT INTO output_events (id, output_id, kind, actor_id, at, reason) VALUES ($1, $2, $3, $4, $5, $6)`, [
      uuidv7(), outputId, kind, actor, new Date(Date.parse('2026-11-09T03:00:00Z') + tick * 1000).toISOString(), reason,
    ]);
  };
  const panel = async () => (await c.admin.request('GET', '/admin/analytics?panel=system')).body.data;

  beforeEach(async () => {
    t = await startTestApp();
    ids.admin = await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    for (const k of ['pm', 'deputy', 'owner', 'ada', 'ben']) ids[k] = await seedUser(t.pool, `${k}@example.org`);
    project = await seedProject(t.pool, {
      status: 'active',
      name: 'Pump station renewal',
      members: [
        { userId: ids.pm, role: 'pm' },
        { userId: ids.deputy, role: 'deputy_pm' },
        { userId: ids.owner, role: 'owner' },
        { userId: ids.ada, role: 'member' },
        { userId: ids.ben, role: 'member' },
      ],
    });
    for (const k of ['admin', 'pm', 'deputy', 'owner', 'ada', 'ben']) c[k] = await t.signIn(`${k}@example.org`);
  });
  afterEach(async () => {
    await t?.close();
  });

  test('outputs are found by title and category by their readers only', async () => {
    const out = await seedOutput('Weekly valve status', { type: 'Status reports', categories: ['Risk summaries'] });
    const hits = await found(c.ada, 'valve');
    assert.deepEqual(hits.map((h) => [h.kind, h.id, h.title, h.projectId, h.outputId]), [['output', out, 'Weekly valve status', project, out]]);
    assert.equal(hits[0].href, `#/projects/${project}/outputs/${out}`);
    // By report type and by an additional category, still shown by its title, once.
    assert.deepEqual((await found(c.ada, 'Risk summaries')).map((h) => h.title), ['Weekly valve status']);
    assert.deepEqual((await found(c.ada, 'Status reports')).map((h) => h.title), ['Weekly valve status']);
    // A person who is not on the project finds nothing.
    await seedUser(t.pool, 'outsider@example.org');
    assert.deepEqual(await found(await t.signIn('outsider@example.org'), 'valve'), []);
  });

  test('a retitled output is found by its current title only', async () => {
    const out = await seedOutput('Weekly valve status');
    await t.pool.query(`UPDATE outputs SET title = 'Fortnightly pump status' WHERE id = $1`, [out]);
    assert.deepEqual(await found(c.ada, 'valve'), []);
    assert.deepEqual((await found(c.ada, 'Fortnightly')).map((h) => h.id), [out]);
  });

  test('deleted, held and withdrawn outputs are not found', async () => {
    const deleted = await seedOutput('Gauge deleted note');
    const held = await seedOutput('Gauge held note');
    const withdrawn = await seedOutput('Gauge withdrawn note', { status: 'withdrawn' });
    const live = await seedOutput('Gauge live note');
    await t.pool.query(`UPDATE outputs SET deleted_at = now(), deleted_by = $2, delete_reason = 'Twice' WHERE id = $1`, [deleted, ids.pm]);
    await t.pool.query(`UPDATE outputs SET held_case_id = $2 WHERE id = $1`, [held, await holdCase(held)]);
    assert.ok(withdrawn);
    for (const who of [c.pm, c.ada]) assert.deepEqual((await found(who, 'Gauge')).map((h) => h.id), [live]);
  });

  test('restricted outputs are not found by non-readers', async () => {
    const out = await seedOutput('Budget valve review', { restrictTo: [ids.pm, ids.ada] });
    assert.deepEqual((await found(c.ada, 'Budget')).map((h) => h.id), [out]);
    assert.deepEqual((await found(c.pm, 'Budget')).map((h) => h.id), [out]);
    for (const who of [c.ben, c.owner, c.deputy]) assert.deepEqual(await found(who, 'Budget'), [], 'roles add nobody to a Restricted audience');
  });

  test('submitted and declined outputs are found by their submitter and the PM and Deputies; one in access review by managers', async () => {
    const sub = await seedOutput('Pending flow report', { status: 'submitted', author: ids.ada });
    const dec = await seedOutput('Declined flow report', { status: 'declined', author: ids.ada });
    for (const who of [c.ada, c.pm, c.deputy]) assert.deepEqual((await found(who, 'flow report')).map((h) => h.id).sort(), [dec, sub].sort());
    for (const who of [c.ben, c.owner]) assert.deepEqual(await found(who, 'flow report'), []);
    const review = await seedOutput('Reviewed meter report', { review: true });
    assert.deepEqual((await found(c.pm, 'meter')).map((h) => h.id), [review]);
    assert.deepEqual((await found(c.owner, 'meter')).map((h) => h.id), [review]);
    assert.deepEqual(await found(c.ada, 'meter'), []);
  });

  test('history lists output events in time order, to the people who may read the output', async () => {
    const open = await seedOutput('Public valve report');
    const secret = await seedOutput('Private valve report', { restrictTo: [ids.pm] });
    await event(open, 'submitted', ids.ada);
    await event(open, 'registered', ids.pm);
    await event(open, 'filed', null);
    await event(secret, 'registered', ids.pm);
    await event(open, 'deleted', ids.pm, 'Registered twice');
    await t.pool.query(`UPDATE outputs SET deleted_at = now(), deleted_by = $2, delete_reason = 'Registered twice' WHERE id = $1`, [open, ids.pm]);
    const lines = async (who: Client) => (await who.request('GET', `/projects/${project}/history/deletions`)).body.lines.filter((l: any) => l.kind === 'output');
    const mine = await lines(c.pm);
    // Newest first, as the rest of History.
    assert.deepEqual(
      mine.map((l: any) => [l.action, l.output.id === secret ? 'private' : 'public']),
      [['deleted', 'public'], ['registered', 'private'], ['filed', 'public'], ['registered', 'public'], ['submitted', 'public']],
    );
    assert.equal(mine[0].reason, 'Registered twice');
    assert.equal(mine[0].output.title, null, 'a Deleted output is not named');
    assert.equal(mine[1].output.title, 'Private valve report');
    assert.equal(mine[2].actor, null, 'Kainow itself');
    // Everyone else sees the project-wide output's lines and never the Restricted one's.
    for (const who of [c.ada, c.ben]) assert.deepEqual((await lines(who)).map((l: any) => l.action), ['deleted', 'filed', 'registered', 'submitted']);
  });

  test('history leaves out the events of an output held in a security case, and of one a person may not read', async () => {
    const held = await seedOutput('Held valve report');
    await event(held, 'registered', ids.pm);
    await t.pool.query(`UPDATE outputs SET held_case_id = $2 WHERE id = $1`, [held, await holdCase(held)]);
    const submitted = await seedOutput('Waiting valve report', { status: 'submitted', author: ids.ada });
    await event(submitted, 'submitted', ids.ada);
    const lines = async (who: Client) => (await who.request('GET', `/projects/${project}/history/deletions`)).body.lines.filter((l: any) => l.kind === 'output');
    assert.deepEqual(await lines(c.pm).then((l) => l.map((x: any) => x.output.id)), [submitted]);
    assert.deepEqual(await lines(c.ada).then((l) => l.map((x: any) => x.output.id)), [submitted]);
    assert.deepEqual(await lines(c.ben), []);
  });

  test('system panel counts storage problems', async () => {
    const file = async (state: string, extra: Record<string, unknown> = {}) => {
      const cols = { id: uuidv7(), purpose: 'output', project_id: project, name: 'a.md', state, created_at: new Date().toISOString(), ...extra };
      const keys = Object.keys(cols);
      await t.pool.query(`INSERT INTO stored_files (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(cols));
    };
    const baseline = await panel();
    assert.deepEqual([baseline.storageFailures, baseline.storageWaiting, baseline.withholdFailures, baseline.sharingToRepair], [0, 0, 0, 0]);
    await file('failed');
    await file('failed');
    await file('pending');
    await file('storing');
    await file('stored');
    // Held files: removal still pending (no notice yet) is not a failure; one the Administrators were told about is; a removed one is not.
    const caseId = await holdCase(uuidv7());
    await file('withheld', { withhold_case_id: caseId });
    await file('withheld', { withhold_case_id: caseId, remove_notice_at: new Date().toISOString() });
    await file('withheld', { withhold_case_id: caseId, remove_notice_at: new Date().toISOString(), removed_at: new Date().toISOString() });
    // Sharing to repair: an output whose files could not be moved.
    const out = await seedOutput('Moved report');
    await t.pool.query(`UPDATE outputs SET place_failed_at = now() WHERE id = $1`, [out]);
    const body = await panel();
    assert.deepEqual([body.storageFailures, body.storageWaiting, body.withholdFailures, body.sharingToRepair], [2, 2, 1, 1]);
    // Counts only: no titles, names or paths.
    assert.ok(!JSON.stringify(body).includes('Moved report'));
  });
});
