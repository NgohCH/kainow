import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { findMaterial } from '../assist/material';
import { uuidv7 } from '../common/uuid7';
import { ProjectAccess } from '../projects/access.service';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedProject, seedUser } from '../testing/projects';

const PLANT = 'The kestrel pump service is booked for Thursday morning.';

interface Line {
  at: string;
  kind: string;
  action: string;
  actor: string | null;
  reason: string | null;
  title?: string;
  href?: string;
  itemKind?: string;
}

describe('project history and Inspect Deleted Content', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  const ids: Record<string, string> = {};
  let project: string;
  let pm: Client;
  let own: Client;
  let spo: Client;
  let ada: Client;
  let auditor: Client;
  let holder: Client;
  let admin: Client;

  const grant = async (userId: string, inspectDeleted: boolean) =>
    t.pool.query(
      `INSERT INTO access_grants (id, project_id, user_id, kind, purpose, scope, starts_on, expires_on, requested_by, requested_at, decision, decided_by, decided_at, inspect_deleted)
       VALUES ($1, $2, $3, 'audit', 'Annual audit', 'Everything', '2026-11-01', '2026-11-30', $4, now(), 'approved', $5, now(), $6)`,
      [uuidv7(), project, userId, ids.own, ids.admin, inspectDeleted],
    );
  const task = async (title: string, status = 'cancelled') => {
    const id = uuidv7();
    await t.pool.query(
      `INSERT INTO tasks (id, project_id, depth, title, assignee_id, due_on, status, authorised_by, authorised_at) VALUES ($1, $2, 0, $3, $4, '2026-11-20', $5, $6, now())`,
      [id, project, title, ids.ada, status, ids.own],
    );
    return id;
  };
  const note = async (title: string, text: string) => {
    const r = await pm.request('POST', `/projects/${project}/notes`, { title, text });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.source.id as string;
  };
  const restrict = async (sourceId: string, namedUserIds: string[]) => {
    const audienceId = (await t.pool.query(`SELECT audience_id FROM sources WHERE id = $1`, [sourceId])).rows[0].audience_id;
    const r = await pm.request('PUT', `/audiences/${audienceId}`, { mode: 'restricted', namedUserIds, reason: 'Leaders only' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  };
  const ok = async (p: Promise<{ status: number; body: any }>, status = 200) => {
    const r = await p;
    assert.equal(r.status, status, JSON.stringify(r.body));
    return r.body;
  };
  const lines = async (c: Client): Promise<Line[]> => (await ok(c.request('GET', `/projects/${project}/history/deletions`))).lines;
  const thread = async (title: string) => (await ok(ada.request('POST', `/projects/${project}/threads`, { kind: 'discussion', title }), 201)).id as string;
  const message = async (threadId: string, body: string, c: Client = ada) => (await ok(c.request('POST', `/threads/${threadId}/messages`, { body }), 201)).id as string;
  const personal = async (userId: string) => ({
    kind: 'personal' as const,
    ctx: (await t.app.get(ProjectAccess).load(project, { id: userId, email: 'x@example.org', displayName: 'x', role: 'member' }))!,
  });

  beforeEach(async () => {
    t = await startTestApp(undefined, { assistQueue: { enqueue: async () => undefined } });
    for (const k of ['pm', 'own', 'spo', 'dep', 'ada', 'ben', 'auditor', 'holder', 'outsider']) ids[k] = await seedUser(t.pool, `${k}@example.org`);
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
    await grant(ids.auditor, false);
    await grant(ids.holder, true);
    [pm, own, spo, ada, auditor, holder, admin] = [
      await t.signIn('pm@example.org'),
      await t.signIn('own@example.org'),
      await t.signIn('spo@example.org'),
      await t.signIn('ada@example.org'),
      await t.signIn('auditor@example.org'),
      await t.signIn('holder@example.org'),
      await t.signIn('admin@example.org'),
    ];
  });
  afterEach(async () => {
    await t.close();
  });

  test('a Member sees "A task was deleted by <name>" with no title', async () => {
    const id = await task('Order kestrel valves');
    await ok(own.request('POST', `/records/task/${id}/delete`, { reason: 'Duplicate of an earlier task' }));
    t.clock.advanceSeconds(60);
    const n = await note('Kestrel plan', PLANT);
    await ok(pm.request('POST', `/sources/${n}/delete`, { reason: 'Imported into the wrong project' }));
    t.clock.advanceSeconds(60);
    await ok(pm.request('POST', `/sources/${n}/restore`, { reason: 'It belongs here after all' }));
    t.clock.advanceSeconds(60);
    const m = await message(await thread('Kestrel valves chat'), 'The kestrel valves are late again.');
    await ok(pm.request('POST', `/messages/${m}/delete`, { reason: 'Off topic' }));
    t.clock.advanceSeconds(60);
    // A report (Task 11 writes these): the reporter is shown only to PM, Owner, Sponsor and Administrators.
    await t.pool.query(
      `INSERT INTO quarantine_cases (id, project_id, item_kind, item_id, reporter_id, reason, marked_length, reported_at) VALUES ($1, $2, 'note', $3, $4, 'A password', 12, $5)`,
      [uuidv7(), project, n, ids.ben, t.clock.now()],
    );

    const seen = await lines(ada);
    assert.deepEqual(
      seen.map((l) => [l.kind, l.action, l.actor, l.reason]),
      [
        ['credential_report', 'reported', null, null],
        ['message', 'deleted', 'pm', 'Off topic'],
        ['note', 'restored', 'pm', 'It belongs here after all'],
        ['note', 'deleted', 'pm', 'Imported into the wrong project'],
        ['task', 'deleted', 'own', 'Duplicate of an earlier task'],
      ],
    );
    assert.equal(seen[0].itemKind, 'note');
    assert.equal(seen[4].at, new Date(Date.parse(seen[3].at) - 60_000).toISOString());
    // Never a title, a link or the text, for a Member or for a grant holder without the scope.
    for (const c of [ada, auditor, pm]) {
      const body = JSON.stringify(await lines(c));
      for (const word of ['kestrel', 'Kestrel', 'title', 'href', 'password']) assert.ok(!body.includes(word), word);
    }
    for (const c of [pm, own, spo]) assert.equal((await lines(c))[0].actor, 'ben');
    assert.equal((await lines(auditor))[0].actor, null);
    // Outside the project (an Administrator with no role included) it does not exist.
    for (const c of [await t.signIn('outsider@example.org'), admin]) assert.equal((await c.request('GET', `/projects/${project}/history/deletions`)).status, 404);
    assert.equal((await ada.request('GET', `/projects/${uuidv7()}/history/deletions`)).status, 404);
  });

  test('Restore is offered on a deleted line only to those who may restore it, with no title', async () => {
    const id = await task('Order kestrel valves');
    await ok(own.request('POST', `/records/task/${id}/delete`, { reason: 'Duplicate' }));
    const n = await note('Kestrel plan', PLANT);
    await ok(pm.request('POST', `/sources/${n}/delete`, { reason: 'Wrong project' }));
    const ownerLines = await lines(own);
    const ownTask = ownerLines.find((l) => l.kind === 'task') as any;
    assert.deepEqual(ownTask.restore, { kind: 'task', id });
    assert.equal(ownTask.title, undefined);
    assert.ok(!JSON.stringify(ownerLines).includes('Kestrel'));
    const pmNote = (await lines(pm)).find((l) => l.kind === 'note') as any;
    assert.deepEqual(pmNote.restore, { kind: 'source', id: n });
    // A PM without delegation may not restore a task; a Member and an auditor are offered nothing.
    assert.equal(((await lines(pm)).find((l) => l.kind === 'task') as any).restore, undefined);
    for (const c of [ada, auditor]) assert.ok(!JSON.stringify(await lines(c)).includes('restore'));
    // Once restored the line no longer offers it.
    await ok(own.request('POST', `/records/task/${id}/restore`, { reason: 'Back' }));
    assert.ok(!(await lines(own)).some((l: any) => l.restore && l.restore.id === id));
  });

  test('a delegated PM is offered Restore on a deleted task line, with no title', async () => {
    const id = await task('Order kestrel valves');
    await ok(own.request('POST', `/records/task/${id}/delete`, { reason: 'Duplicate' }));
    await ok(own.request('POST', `/projects/${project}/record-deletion-delegation`, { reason: 'PM keeps the register' }));
    const l = (await lines(pm)).find((x) => x.kind === 'task') as any;
    assert.deepEqual(l.restore, { kind: 'task', id });
    assert.equal(l.title, undefined);
    assert.ok(!JSON.stringify(await lines(pm)).includes('Kestrel'));
    // A Deputy is never offered it.
    assert.equal(((await lines(await t.signIn('dep@example.org'))).find((x) => x.kind === 'task') as any).restore, undefined);
  });

  test('a holder with Inspect Deleted Content sees the title and opens the item, logged', async () => {
    const id = await task('Order kestrel valves');
    await ok(own.request('POST', `/records/task/${id}/delete`, { reason: 'Duplicate of an earlier task' }));
    const n = await note('Kestrel plan', PLANT);
    await ok(pm.request('POST', `/sources/${n}/delete`, { reason: 'Imported into the wrong project' }));
    const th = await thread('Valves chat');
    const m = await message(th, 'The kestrel valves are late again.');
    await ok(pm.request('POST', `/messages/${m}/delete`, { reason: 'Off topic' }));

    const seen = await lines(holder);
    const taskLine = seen.find((l) => l.kind === 'task')!;
    assert.deepEqual([taskLine.title, taskLine.href], ['Order kestrel valves', `#/projects/${project}/deleted/task/${id}`]);
    assert.equal(seen.find((l) => l.kind === 'note')!.title, 'Kestrel plan');
    assert.ok(seen.find((l) => l.kind === 'message')!.title);

    const list = (await ok(holder.request('GET', `/projects/${project}/deleted-items`))).items as Array<Record<string, unknown>>;
    assert.deepEqual(list.map((i) => `${i.kind}:${i.id}`).sort(), [`message:${m}`, `note:${n}`, `task:${id}`].sort());
    assert.equal(await count(`SELECT count(*) AS n FROM audit_events WHERE action = 'deleted.inspected'`), 0, 'the list alone opens nothing');

    const opened = await ok(holder.request('GET', `/projects/${project}/deleted-items/task/${id}`));
    assert.equal(opened.title, 'Order kestrel valves');
    assert.deepEqual([opened.deletedBy, opened.deleteReason], ['own', 'Duplicate of an earlier task']);
    assert.ok(opened.deletedAt);
    const source = await ok(holder.request('GET', `/projects/${project}/deleted-items/note/${n}`));
    assert.deepEqual([source.title, source.text], ['Kestrel plan', PLANT]);
    const msg = await ok(holder.request('GET', `/projects/${project}/deleted-items/message/${m}`));
    assert.equal(msg.text, 'The kestrel valves are late again.');
    // Wrong kind for the id, or the wrong project: not found.
    assert.equal((await holder.request('GET', `/projects/${project}/deleted-items/decision/${id}`)).status, 404);
    assert.equal((await holder.request('GET', `/projects/${project}/deleted-items/minutes/${n}`)).status, 404);
    assert.equal((await holder.request('GET', `/projects/${project}/deleted-items/widget/${id}`)).status, 404);
    assert.equal((await holder.request('GET', `/projects/${uuidv7()}/deleted-items/task/${id}`)).status, 404);

    // The test clock does not move between the openings, so compare without order.
    const audit = (await t.pool.query(`SELECT actor_user_id, subject_type, subject_id, detail FROM audit_events WHERE action = 'deleted.inspected'`)).rows;
    assert.deepEqual(audit.map((a) => `${a.actor_user_id} ${a.subject_type} ${a.subject_id}`).sort(), [
      `${ids.holder} task ${id}`,
      `${ids.holder} note ${n}`,
      `${ids.holder} message ${m}`,
    ].sort());
    for (const a of audit) for (const word of ['kestrel', 'Kestrel', 'Duplicate', 'Off topic']) assert.ok(!JSON.stringify(a.detail).includes(word));

    // In place in the thread, labelled with who, when and why; a Member still sees only the tombstone.
    const inThread = (await ok(holder.request('GET', `/threads/${th}`))).messages[0];
    assert.equal(inThread.text, 'The kestrel valves are late again.');
    assert.deepEqual([inThread.deletedBy, inThread.deleteReason], ['pm', 'Off topic']);
    assert.ok(inThread.deletedAt);
    assert.equal(await count(`SELECT count(*) AS n FROM audit_events WHERE action = 'deleted.inspected' AND subject_id = $1`, [m]), 2, 'shown in place is an opening too');
    const forAda = (await ok(ada.request('GET', `/threads/${th}`))).messages[0];
    assert.equal(forAda.text, null);
    assert.equal(forAda.notice, 'Deleted by pm: Off topic');
    assert.equal(forAda.deletedBy, undefined);

    // A restored item is live again: it leaves the Deleted items list and cannot be opened there.
    await ok(own.request('POST', `/records/task/${id}/restore`, { reason: 'It was not a duplicate' }));
    assert.equal((await holder.request('GET', `/projects/${project}/deleted-items/task/${id}`)).status, 404);
    assert.ok(!(await lines(holder)).some((l) => l.kind === 'task' && l.title), 'no title once the task is live again');
  });

  test('an Audit grant without the scope gets 404 for a deleted item', async () => {
    const id = await task('Order kestrel valves');
    await ok(own.request('POST', `/records/task/${id}/delete`, { reason: 'Duplicate of an earlier task' }));
    assert.equal((await auditor.request('GET', `/projects/${project}/deleted-items`)).status, 404);
    assert.equal((await auditor.request('GET', `/projects/${project}/deleted-items/task/${id}`)).status, 404);
    // A suspended scoped grant gives nothing either.
    await t.pool.query(`UPDATE access_grants SET suspended_at = now(), suspended_by = $1, suspend_reason = 'Paused' WHERE user_id = $2`, [ids.own, ids.holder]);
    assert.equal((await holder.request('GET', `/projects/${project}/deleted-items/task/${id}`)).status, 404);
    assert.equal(await count(`SELECT count(*) AS n FROM audit_events WHERE action = 'deleted.inspected'`), 0);
  });

  test('the scope cannot be added to an approved grant', async () => {
    const ask = (inspectDeleted?: unknown) =>
      own.request('POST', `/projects/${project}/grants`, {
        userId: ids.ben, kind: 'oversight', purpose: 'Board review', scope: 'Decisions', startsOn: '2026-11-17',
        ...(inspectDeleted === undefined ? {} : { inspectDeleted }),
      });
    assert.equal((await ask('yes')).status, 400);
    const plain = (await ok(ask(), 201)).grant;
    assert.equal(plain.inspectDeleted, false);
    const scoped = (await ok(ask(true), 201)).grant;
    assert.equal(scoped.inspectDeleted, true);

    // Approving, extending or anything else cannot set or clear it.
    assert.equal((await spo.request('POST', `/grants/${plain.id}/approve`, { inspectDeleted: true })).status, 400);
    await ok(spo.request('POST', `/grants/${plain.id}/approve`, {}));
    assert.equal((await spo.request('POST', `/grants/${plain.id}/extend`, { expiresOn: '2026-12-31', inspectDeleted: true })).status, 400);
    assert.equal((await spo.request('POST', `/grants/${scoped.id}/approve`, { inspectDeleted: false })).status, 400);
    const flags = (await t.pool.query(`SELECT id, inspect_deleted FROM access_grants WHERE id = ANY($1::uuid[])`, [[plain.id, scoped.id]])).rows;
    assert.deepEqual(Object.fromEntries(flags.map((f) => [f.id, f.inspect_deleted])), { [plain.id]: false, [scoped.id]: true });

    // The approval view says so.
    const grants = (await ok(spo.request('GET', `/projects/${project}`))).project.grants as Array<{ id: string; inspectDeleted: boolean }>;
    assert.equal(grants.find((g) => g.id === scoped.id)!.inspectDeleted, true);
    assert.equal(grants.find((g) => g.id === plain.id)!.inspectDeleted, false);
  });

  test('a holder still cannot read a Restricted deleted source outside its audience', async () => {
    const hidden = await note('Leaders kestrel plan', PLANT);
    await restrict(hidden, [ids.ada]);
    await ok(pm.request('POST', `/sources/${hidden}/delete`, { reason: 'Imported into the wrong project' }));
    const open = await note('Open plan', 'Nothing secret here.');
    await ok(pm.request('POST', `/sources/${open}/delete`, { reason: 'Imported twice' }));

    const seen = await lines(holder);
    const hiddenLine = seen.find((l) => l.reason === 'Imported into the wrong project')!;
    assert.equal(hiddenLine.title, undefined);
    assert.equal(hiddenLine.href, undefined);
    assert.ok(!JSON.stringify(seen).includes('Leaders'));
    assert.equal(seen.find((l) => l.reason === 'Imported twice')!.title, 'Open plan');
    const list = (await ok(holder.request('GET', `/projects/${project}/deleted-items`))).items as Array<{ id: string }>;
    assert.deepEqual(list.map((i) => i.id), [open]);
    assert.equal((await holder.request('GET', `/projects/${project}/deleted-items/note/${hidden}`)).status, 404);
    assert.equal(await count(`SELECT count(*) AS n FROM audit_events WHERE action = 'deleted.inspected'`), 0);
  });

  test("deleted items never appear in the holder's Ask material or search", async () => {
    const n = await note('Kestrel plan', PLANT);
    const id = await task('Order kestrel valves');
    const material = async () => (await findMaterial(t.pool, await personal(ids.holder), ['kestrel'])).length;
    const found = async (word: string) => {
      const r = await ok(holder.request('GET', `/search?q=${encodeURIComponent(word)}`));
      return (r.projects as Array<{ results: unknown[] }>).flatMap((p) => p.results).length;
    };
    assert.ok((await material()) >= 2, 'the passage and the task are material before');
    assert.ok((await found('kestrel')) >= 2);

    await ok(pm.request('POST', `/sources/${n}/delete`, { reason: 'Imported into the wrong project' }));
    await ok(own.request('POST', `/records/task/${id}/delete`, { reason: 'Duplicate of an earlier task' }));
    assert.equal(await material(), 0);
    for (const word of ['kestrel', 'Kestrel plan', 'Order kestrel valves']) assert.equal(await found(word), 0, word);
    // The holder can still open them, read-only.
    await ok(holder.request('GET', `/projects/${project}/deleted-items/note/${n}`));
    await ok(holder.request('GET', `/projects/${project}/deleted-items/task/${id}`));
  });

  test('creator, PM and Administrator get 404 for deleted content', async () => {
    const th = await thread('Valves chat');
    const m = await message(th, 'The kestrel valves are late again.');
    await ok(pm.request('POST', `/messages/${m}/delete`, { reason: 'Off topic' }));
    const id = await task('Order kestrel valves');
    await ok(own.request('POST', `/records/task/${id}/delete`, { reason: 'Duplicate of an earlier task' }));
    await t.pool.query(`INSERT INTO memberships (id, project_id, user_id, role, starts_on) VALUES ($1, $2, $3, 'member', '2026-11-01')`, [uuidv7(), project, ids.admin]);
    const adminOutside = await t.signIn('admin@example.org');

    // ada wrote the message; pm deleted it; own deleted the task; the Administrator (also a Member here) has no right by role.
    for (const c of [ada, pm, own, adminOutside]) {
      assert.equal((await c.request('GET', `/projects/${project}/deleted-items`)).status, 404);
      assert.equal((await c.request('GET', `/projects/${project}/deleted-items/message/${m}`)).status, 404);
      assert.equal((await c.request('GET', `/projects/${project}/deleted-items/task/${id}`)).status, 404);
      const shown = (await ok(c.request('GET', `/threads/${th}`))).messages[0];
      assert.equal(shown.text, null);
    }
    assert.equal(await count(`SELECT count(*) AS n FROM audit_events WHERE action = 'deleted.inspected'`), 0);
  });

  const count = async (sql: string, params: unknown[] = []) => Number((await t.pool.query(sql, params)).rows[0].n);
});
