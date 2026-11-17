import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { AssistRunner } from '../assist/assist-runner';
import { findMaterial } from '../assist/material';
import { uuidv7 } from '../common/uuid7';
import { buildDigest } from '../digests/digest';
import { EmailDispatcher } from '../email/dispatcher';
import type { MailTransport, OutgoingEmail } from '../email/transport';
import type { JsonSchemaModel, ModelRequest } from '../extraction/model';
import { Sweep } from '../notifications/sweep';
import { ProjectAccess } from '../projects/access.service';
import type { Usage } from '../spend/cost';
import { MVP_SPEND_SETTINGS } from '../spend/mvp-settings';
import { SpendService } from '../spend/spend.service';
import { SpendSettingsService } from '../spend/spend.settings';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedProject, seedUser } from '../testing/projects';

/**
 * Leak tests for Deleted content (history spec section 10): a Deleted message, source and record never appear to an
 * ordinary Member, or to an Audit grant holder without Inspect Deleted Content, on any surface. Each item carries a
 * marker word no other text holds, so absence means something; each test first proves the surface does show the
 * item before it is deleted (where the surface can show that kind of item at all).
 */

const USAGE: Usage = { inputTokens: 2_000, cachedInputTokens: 0, outputTokens: 300 };
const APP_URL = 'https://kainow.example.org';
const QUESTION = 'When is the pump service booked?';
/** Friday 13 Nov 2026, HH:MM UTC+8. */
const at = (h: number, m = 0): number => Date.UTC(2026, 10, 13, h - 8, m);

/** Records every request and answers that nothing matched, so the input can be inspected. */
class CapturingModel implements JsonSchemaModel {
  calls: ModelRequest[] = [];
  async callJson(req: ModelRequest): Promise<{ content: unknown; usage: Usage }> {
    this.calls.push(req);
    return { content: JSON.stringify({ answer_markdown: 'The passages do not say.', not_found: true, cited: [] }), usage: USAGE };
  }
  get input(): string {
    return this.calls.map((c) => `${c.system}\n${c.user}`).join('\n');
  }
}

class CaptureTransport implements MailTransport {
  sent: OutgoingEmail[] = [];
  async send(m: OutgoingEmail): Promise<{ messageId: string | null }> {
    this.sent.push(m);
    return { messageId: 'id' };
  }
}

interface Kind {
  /** The word in the item's title or text that appears nowhere else. */
  marker: string;
  /** The item kind in the Deleted items and History APIs. */
  apiKind: string;
  /** Whether a digest, a reminder or an email can be built from this kind of item at all. */
  producesMail: boolean;
}

const MESSAGE: Kind = { marker: 'mizzenmast', apiKind: 'message', producesMail: false };
const SOURCE: Kind = { marker: 'gantrycrane', apiKind: 'note', producesMail: false };
const RECORD: Kind = { marker: 'bollardwinch', apiKind: 'task', producesMail: true };

describe('Deleted content never leaks to a Member or an Audit grant holder without the scope', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  const ids: Record<string, string> = {};
  let project: string;
  let pm: Client;
  let own: Client;
  let ada: Client;
  let ben: Client;
  let auditor: Client;
  let holder: Client;
  /** The Deleted item under test. */
  let itemId = '';
  let threadId = '';
  let nudges = 0;

  const json = (x: unknown): string => JSON.stringify(x);
  const ok = async (p: Promise<{ status: number; body: any }>, status = 200) => {
    const r = await p;
    assert.equal(r.status, status, json(r.body));
    return r.body;
  };
  const personal = async (userId: string) => ({
    kind: 'personal' as const,
    ctx: (await t.app.get(ProjectAccess).load(project, { id: userId, email: 'x@example.org', displayName: 'x', role: 'member' }))!,
  });

  // ---- how each kind of item is made, deleted and shown ----

  const makeMessage = async () => {
    threadId = (await ok(ada.request('POST', `/projects/${project}/threads`, { kind: 'discussion', title: 'Quay chat' }), 201)).id;
    itemId = (await ok(ada.request('POST', `/threads/${threadId}/messages`, { body: `The ${MESSAGE.marker} pump service is booked for Thursday.` }), 201)).id;
  };
  const makeSource = async () => {
    const r = await ok(pm.request('POST', `/projects/${project}/notes`, { title: `${SOURCE.marker} plan`, text: `The ${SOURCE.marker} pump service is booked for Thursday.` }), 201);
    itemId = r.source.id;
  };
  /** An open task for Ben, due Monday 16 Nov. */
  const makeRecord = async () => {
    itemId = uuidv7();
    await t.pool.query(
      `INSERT INTO tasks (id, project_id, depth, title, assignee_id, due_on, status, authorised_by, authorised_at)
       VALUES ($1, $2, 0, $3, $4, '2026-11-16', 'not_started', $5, $6)`,
      [itemId, project, `Order ${RECORD.marker} pump service`, ids.ben, ids.own, new Date(at(8))],
    );
  };
  const make = (k: Kind) => (k === MESSAGE ? makeMessage() : k === SOURCE ? makeSource() : makeRecord());

  const remove = async (k: Kind) => {
    if (k === MESSAGE) await ok(pm.request('POST', `/messages/${itemId}/delete`, { reason: 'Off topic' }));
    else if (k === SOURCE) await ok(pm.request('POST', `/sources/${itemId}/delete`, { reason: 'Imported into the wrong project' }));
    else {
      // Only a finished task can be deleted; it is then forced open again so every open-work surface would show it if it could.
      await ok(ben.request('POST', `/records/tasks/${itemId}/complete`, { note: 'Done' }));
      await ok(own.request('POST', `/records/task/${itemId}/delete`, { reason: 'Duplicate of an earlier task' }));
      await t.pool.query(`UPDATE tasks SET status = 'in_progress', completed_at = NULL WHERE id = $1`, [itemId]);
    }
  };

  /** The direct links of the item: a path and whether it is a plain read (404 once Deleted). */
  const links = (k: Kind): string[] =>
    k === MESSAGE
      ? [`/messages/${itemId}/versions`]
      : k === SOURCE
        ? [`/notes/${itemId}`, `/notes/${itemId}/versions/1`]
        : [`/records/tasks/${itemId}`];

  /** Everything the project's own lists and counts say, as one string, for `c`. */
  const lists = async (k: Kind, c: Client): Promise<string> => {
    const parts: unknown[] = [
      (await ok(c.request('GET', `/projects/${project}`))),
      (await ok(c.request('GET', `/projects`))),
      (await ok(c.request('GET', `/projects/${project}/discussion`))),
      (await ok(c.request('GET', `/projects/${project}/notes`))),
      (await ok(c.request('GET', `/projects/${project}/records`))),
    ];
    if (k === MESSAGE) parts.push(await ok(c.request('GET', `/threads/${threadId}`)));
    return json(parts);
  };
  const found = async (c: Client, q: string): Promise<number> =>
    ((await ok(c.request('GET', `/search?q=${encodeURIComponent(q)}`))).projects as Array<{ results: unknown[] }>).flatMap((p) => p.results).length;

  beforeEach(async () => {
    nudges = 0;
    t = await startTestApp(at(8), { assistQueue: { enqueue: async () => undefined } });
    for (const k of ['pm', 'own', 'ada', 'ben', 'auditor', 'holder']) ids[k] = await seedUser(t.pool, `${k}@example.org`);
    ids.admin = await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
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
    for (const [user, scoped] of [[ids.auditor, false], [ids.holder, true]] as const) {
      await t.pool.query(
        `INSERT INTO access_grants (id, project_id, user_id, kind, purpose, scope, starts_on, expires_on, requested_by, requested_at, decision, decided_by, decided_at, inspect_deleted)
         VALUES ($1, $2, $3, 'audit', 'Annual audit', 'Everything', '2026-11-01', '2026-11-30', $4, now(), 'approved', $5, now(), $6)`,
        [uuidv7(), project, user, ids.own, ids.admin, scoped],
      );
    }
    await new SpendSettingsService(t.pool, t.clock.now).apply(MVP_SPEND_SETTINGS, ids.admin);
    await t.pool.query(`UPDATE notification_settings SET lead_days = '{7,1}', sweep_minutes = 15, notices_from = NULL`);
    [pm, own, ada, ben, auditor, holder] = [
      await t.signIn('pm@example.org'),
      await t.signIn('own@example.org'),
      await t.signIn('ada@example.org'),
      await t.signIn('ben@example.org'),
      await t.signIn('auditor@example.org'),
      await t.signIn('holder@example.org'),
    ];
    t.clock.ms = at(8);
  });
  afterEach(async () => {
    await t.close();
  });

  const sweep = () => new Sweep({ pool: t.pool, clock: t.clock.now, appUrl: APP_URL, nudge: { nudge: async () => { nudges += 1; } }, log: { warn: () => undefined } });
  const dispatch = async () => {
    const transport = new CaptureTransport();
    await new EmailDispatcher({ pool: t.pool, transport, from: 'Kainow <noreply@example.org>', clock: t.clock.now, log: { warn: () => undefined } }).dispatchDue();
    return transport;
  };

  for (const k of [MESSAGE, SOURCE, RECORD]) {
    const name = k === MESSAGE ? 'a Deleted message' : k === SOURCE ? 'a Deleted source' : 'a Deleted record';

    describe(name, () => {
      test('project lists, counts and the personal dashboard', async () => {
        await make(k);
        const before = await lists(k, ben);
        assert.ok(before.includes(k.marker), 'the lists show the item before deletion');
        const mine = async () => ((await ok(ben.request('GET', '/projects'))).projects as Array<{ myOpenTasks: number }>)[0].myOpenTasks;
        if (k === RECORD) assert.equal(await mine(), 1);
        await remove(k);
        for (const c of [ben, ada, auditor]) {
          const after = await lists(k, c);
          assert.ok(!after.includes(k.marker), `a list still holds ${k.marker}: ${after}`);
        }
        if (k === RECORD) assert.equal(await mine(), 0, 'the dashboard counts no Deleted task');
      });

      test('global search', async () => {
        await make(k);
        assert.ok((await found(ben, k.marker)) >= 1, 'search finds the item before deletion');
        await remove(k);
        for (const c of [ben, ada, auditor, pm]) assert.equal(await found(c, k.marker), 0);
      });

      test('Ask material and a new AI request', async () => {
        await make(k);
        const material = async () => (await findMaterial(t.pool, await personal(ids.ben), [k.marker])).map((m) => m.text).join('\n');
        const ask = async () => {
          const model = new CapturingModel();
          const r = await ok(ben.request('POST', `/projects/${project}/questions`, { question: QUESTION }), 201);
          if (r.status === 'queued') {
            const runner = new AssistRunner({ pool: t.pool, spend: new SpendService(t.pool, t.clock.now), model, clock: t.clock.now });
            await runner.process(r.id, 1, false);
          }
          return { model, view: await ok(ben.request('GET', `/questions/${r.id}`)) };
        };
        assert.ok((await material()).toLowerCase().includes(k.marker), 'material holds the item before deletion');
        const first = await ask();
        assert.ok(first.model.input.toLowerCase().includes(k.marker), 'the AI request is built from the item before deletion');
        t.clock.advanceSeconds(1);
        await remove(k);
        assert.equal(await material(), '');
        assert.equal((await findMaterial(t.pool, await personal(ids.pm), [k.marker])).length, 0);
        assert.equal((await findMaterial(t.pool, await personal(ids.auditor), [k.marker])).length, 0);
        const after = await ask();
        assert.ok(!after.model.input.toLowerCase().includes(k.marker), 'the deleted text reached the model');
        assert.ok(!json(after.view).toLowerCase().includes(k.marker));
      });

      test('digest content and queued email bodies', async () => {
        await make(k);
        const body = async () => (await buildDigest(t.pool, project, ids.ben, t.clock.now(), APP_URL)).body.toLowerCase();
        const queuedBodies = async () => (await t.outbox()).map((m) => `${m.subject}\n${m.text_body}`).join('\n').toLowerCase();
        if (k.producesMail) {
          assert.ok((await body()).includes(k.marker), 'the digest lists the open task before deletion');
          await ok(own.request('POST', `/projects/${project}/digest`), 201);
          assert.ok((await queuedBodies()).includes(k.marker), 'the digest email holds the task before deletion');
          // A reminder queued before the deletion.
          t.clock.ms = at(9);
          await sweep().run();
          assert.ok((await queuedBodies()).includes(`reminder: 'order ${k.marker}`), 'a reminder email is queued before deletion');
        }
        const earlier = new Set((await t.outbox()).map((m) => m.id));
        await remove(k);
        assert.ok(!(await body()).includes(k.marker), 'the digest lists the Deleted item');
        // With the only open task Deleted there is nothing to send, and nothing is queued.
        const refused = await own.request('POST', `/projects/${project}/digest`);
        assert.equal(refused.status, 409, json(refused.body));
        for (const m of (await t.outbox()).filter((x) => x.kind === 'digest' && !earlier.has(x.id))) assert.ok(!`${m.subject}
${m.text_body}`.toLowerCase().includes(k.marker));
        // What was queued earlier is cancelled at send time, not delivered.
        const transport = await dispatch();
        for (const m of transport.sent) assert.ok(!`${m.subject}\n${m.text}`.toLowerCase().includes(k.marker), 'a queued email delivered the Deleted item');
        const stillQueued = (await t.pool.query(`SELECT text_body FROM email_outbox WHERE status IN ('queued', 'sending')`)).rows;
        for (const r of stillQueued) assert.ok(!String(r.text_body).toLowerCase().includes(k.marker), 'a queued email still holds the Deleted item');
      });

      test('notifications', async () => {
        await make(k);
        const shown = async (c: Client) => json(await ok(c.request('GET', '/notifications'))).toLowerCase();
        if (k.producesMail) {
          t.clock.ms = at(9);
          await sweep().run();
          assert.ok((await shown(ben)).includes(k.marker), 'the reminder is in the assignee list before deletion');
        }
        await remove(k);
        // A later sweep fires nothing about it.
        t.clock.ms = at(10);
        await sweep().run();
        for (const c of [ben, ada, pm, own, auditor]) assert.ok(!(await shown(c)).includes(k.marker), 'a notification still names the Deleted item');
      });

      test('History lines carry no title or text', async () => {
        await make(k);
        await remove(k);
        for (const c of [ben, ada, auditor]) {
          const body = await ok(c.request('GET', `/projects/${project}/history/deletions`));
          const lines = body.lines as Array<{ kind: string; action: string; title?: string; href?: string }>;
          const line = lines.find((l) => l.kind === k.apiKind && l.action === 'deleted');
          assert.ok(line, json(body));
          assert.equal(line.title, undefined);
          assert.equal(line.href, undefined);
          assert.ok(!json(body).toLowerCase().includes(k.marker), 'a History line holds the title or text');
        }
        // The line would carry it for a holder with the scope.
        const seen = await ok(holder.request('GET', `/projects/${project}/history/deletions`));
        const held = (seen.lines as Array<{ kind: string; action: string; title?: string }>).find((l) => l.kind === k.apiKind && l.action === 'deleted');
        assert.ok(held?.title, 'a holder with Inspect Deleted Content sees the title');
        const inspected = await ok(holder.request('GET', `/projects/${project}/deleted-items/${k.apiKind}/${itemId}`));
        assert.ok(json(inspected).toLowerCase().includes(k.marker));
      });

      test('direct links answer 404', async () => {
        await make(k);
        // A plain Member can open it before deletion.
        for (const path of links(k)) {
          const r = await ben.request('GET', path);
          assert.equal(r.status, 200, path);
          assert.ok(json(r.body).toLowerCase().includes(k.marker), `${path} shows the item before deletion`);
        }
        await remove(k);
        for (const c of [ben, ada, auditor, pm, own]) {
          for (const path of links(k)) {
            const r = await c.request('GET', path);
            assert.equal(r.status, 404, `${path} ${json(r.body)}`);
          }
        }
        if (k === MESSAGE) {
          // Only a grant with Inspect Deleted Content may still list the versions.
          assert.equal((await holder.request('GET', links(k)[0])).status, 200);
          // The thread still shows that a message was deleted, never its text.
          const view = await ok(ben.request('GET', `/threads/${threadId}`));
          assert.equal(view.messages[0].text, null);
          assert.ok(!json(view).toLowerCase().includes(k.marker));
        }
      });

      test('an Audit grant holder without Inspect Deleted Content gets 404', async () => {
        await make(k);
        await remove(k);
        assert.equal((await auditor.request('GET', `/projects/${project}/deleted-items`)).status, 404);
        assert.equal((await auditor.request('GET', `/projects/${project}/deleted-items/${k.apiKind}/${itemId}`)).status, 404);
        for (const c of [ben, ada, pm, own]) {
          assert.equal((await c.request('GET', `/projects/${project}/deleted-items/${k.apiKind}/${itemId}`)).status, 404);
        }
        // The grant holder's own reads show nothing of it either.
        assert.ok(!(await lists(k, auditor)).includes(k.marker));
        assert.equal(await found(auditor, k.marker), 0);
        // With the scope the same item opens, read-only.
        assert.equal((await holder.request('GET', `/projects/${project}/deleted-items/${k.apiKind}/${itemId}`)).status, 200);
      });
    });
  }
});
