import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { AssistRunner } from '../assist/assist-runner';
import { findMaterial } from '../assist/material';
import { uuidv7 } from '../common/uuid7';
import { buildDigest } from '../digests/digest';
import { EmailDispatcher } from '../email/dispatcher';
import { writeOutbox } from '../email/outbox';
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
import { readOriginals } from './clean';
import { MARKER } from './clean-text';
import { loadProtectedKey } from './protected-key';
import { TEXT_COLUMNS } from './registry';
import { aiDeps, aiReady, byAttempt } from '../testing/ai-runners';

/**
 * Leak tests for held items (history spec 10): an item held in a quarantine case never appears to a Member, an Audit
 * grant holder or a holder of Inspect Deleted Content on any surface, both while it waits for the protected key
 * (held, not cleaned) and once it is cleaned. A cleaned authorised record stays in work views, labelled (spec 7.5),
 * but never carries the marked text and never reaches search, AI or digests. Each item carries a marker word no other
 * text holds and the marked secret; each test first proves the surface shows the item before the report.
 */

const USAGE: Usage = { inputTokens: 2_000, cachedInputTokens: 0, outputTokens: 300 };
const APP_URL = 'https://kainow.example.org';
const QUESTION = 'When is the pump service booked?';
/** A secret the credential check does not know: only a person can mark it. */
const SECRET = 'Kp9vault-Rotor42';
/** A secret whose HTML-escaped form differs, for email_outbox.html_body. */
const SECRET_HTML = 'Rx7&gate<Key9';
const ESCAPED_HTML = 'Rx7&amp;gate&lt;Key9';
const HELD_NOTICE = 'Held — suspected credential, under review';
const UNDER_REVIEW = 'Credential removed — under review';
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
  marker: string;
  /** The item kind in the report API. */
  reportKind: string;
  /** The item kind in the Deleted items API. */
  apiKind: string;
  /** Whether a digest, a reminder or an email can be built from this kind of item at all. */
  producesMail: boolean;
}

const MESSAGE: Kind = { marker: 'mizzenmast', reportKind: 'message', apiKind: 'message', producesMail: false };
const SOURCE: Kind = { marker: 'gantrycrane', reportKind: 'source', apiKind: 'note', producesMail: false };
const RECORD: Kind = { marker: 'bollardwinch', reportKind: 'task', apiKind: 'task', producesMail: true };

/** The two states of a held item: waiting for the protected key (hidden, uncleaned), and cleaned under review. */
type Mode = 'waiting' | 'cleaned';

const json = (x: unknown): string => JSON.stringify(x);

/** One test app per test, with or without the protected key. */
function harness(mode: Mode) {
  const h = {
    t: undefined as unknown as TestApp,
    dir: '',
    keyFile: '',
    ids: {} as Record<string, string>,
    project: '',
    pm: undefined as unknown as Client,
    dep: undefined as unknown as Client,
    own: undefined as unknown as Client,
    ada: undefined as unknown as Client,
    ben: undefined as unknown as Client,
    auditor: undefined as unknown as Client,
    holder: undefined as unknown as Client,
  };
  beforeEach(async () => {
    h.dir = mkdtempSync(join(tmpdir(), 'kainow-leaks-'));
    h.keyFile = join(h.dir, 'p.key');
    writeFileSync(h.keyFile, randomBytes(32));
    h.t = await startTestApp(at(8), { assistQueue: { enqueue: async () => undefined }, ...(mode === 'cleaned' ? { protectedKeyFile: h.keyFile } : {}) });
    const { t, ids } = h;
    for (const k of ['pm', 'own', 'dep', 'ada', 'ben', 'auditor', 'holder']) ids[k] = await seedUser(t.pool, `${k}@example.org`);
    ids.admin = await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    h.project = await seedProject(t.pool, {
      name: 'Alpha Project',
      status: 'active',
      members: [
        { userId: ids.pm, role: 'pm' },
        { userId: ids.own, role: 'owner' },
        { userId: ids.dep, role: 'deputy_pm' },
        { userId: ids.ada, role: 'member' },
        { userId: ids.ben, role: 'member' },
      ],
    });
    await aiReady(t.pool, h.project);
    for (const [user, scoped] of [[ids.auditor, false], [ids.holder, true]] as const) {
      await t.pool.query(
        `INSERT INTO access_grants (id, project_id, user_id, kind, purpose, scope, starts_on, expires_on, requested_by, requested_at, decision, decided_by, decided_at, inspect_deleted)
         VALUES ($1, $2, $3, 'audit', 'Annual audit', 'Everything', '2026-11-01', '2026-11-30', $4, now(), 'approved', $5, now(), $6)`,
        [uuidv7(), h.project, user, ids.own, ids.admin, scoped],
      );
    }
    await new SpendSettingsService(t.pool, t.clock.now).apply(MVP_SPEND_SETTINGS, ids.admin);
    await t.pool.query(`UPDATE notification_settings SET lead_days = '{7,1}', sweep_minutes = 15, notices_from = NULL`);
    [h.pm, h.own, h.dep, h.ada, h.ben, h.auditor, h.holder] = [
      await t.signIn('pm@example.org'),
      await t.signIn('own@example.org'),
      await t.signIn('dep@example.org'),
      await t.signIn('ada@example.org'),
      await t.signIn('ben@example.org'),
      await t.signIn('auditor@example.org'),
      await t.signIn('holder@example.org'),
    ];
    t.clock.ms = at(8);
  });
  afterEach(async () => {
    await h.t?.close();
    rmSync(h.dir, { recursive: true, force: true });
  });
  return h;
}

const ok = async (p: Promise<{ status: number; body: any }>, status = 200) => {
  const r = await p;
  assert.equal(r.status, status, json(r.body));
  return r.body;
};

for (const mode of ['waiting', 'cleaned'] as const) {
  describe(`a held item ${mode === 'waiting' ? 'waiting for the protected key' : 'once cleaned'} never leaks`, { skip: SKIP_NO_DB }, () => {
    const h = harness(mode);
    let itemId = '';
    let threadId = '';
    let caseId = '';

    const personal = async (userId: string) => ({
      kind: 'personal' as const,
      ctx: (await h.t.app.get(ProjectAccess).load(h.project, { id: userId, email: 'x@example.org', displayName: 'x', role: 'member' }))!,
    });

    const make = async (k: Kind) => {
      const { t, ids, project } = h;
      if (k === MESSAGE) {
        threadId = (await ok(h.ada.request('POST', `/projects/${project}/threads`, { kind: 'discussion', title: 'Quay chat' }), 201)).id;
        itemId = (await ok(h.ada.request('POST', `/threads/${threadId}/messages`, { body: `The ${k.marker} pump service is booked for Thursday, gate code ${SECRET}.` }), 201)).id;
      } else if (k === SOURCE) {
        itemId = (await ok(h.pm.request('POST', `/projects/${project}/notes`, { title: `${k.marker} plan`, text: `The ${k.marker} pump service is booked for Thursday, gate code ${SECRET}.` }), 201)).source.id;
      } else {
        // An open task for Ben, due Monday 16 Nov.
        itemId = uuidv7();
        await t.pool.query(
          `INSERT INTO tasks (id, project_id, depth, title, assignee_id, due_on, status, authorised_by, authorised_at)
           VALUES ($1, $2, 0, $3, $4, '2026-11-16', 'not_started', $5, $6)`,
          [itemId, project, `Order ${k.marker} pump service, gate code ${SECRET}`, ids.ben, ids.own, new Date(at(8))],
        );
      }
    };

    /** Ada reports the secret in the item. */
    const report = async (k: Kind) => {
      const r = await ok(h.ada.request('POST', `/projects/${h.project}/secret-reports`, { kind: k.reportKind, id: itemId, marked: [SECRET], reason: 'Looks like the gate code' }), 201);
      caseId = r.caseId;
      const state = (await h.t.pool.query(`SELECT state FROM quarantine_cases WHERE id = $1`, [caseId])).rows[0].state;
      assert.equal(state, mode === 'waiting' ? 'held' : 'cleaned');
      h.t.clock.advanceSeconds(1);
    };

    /** A cleaned record stays in work views (spec 7.5); everything else held is gone from them. */
    const inWorkViews = (k: Kind): boolean => mode === 'cleaned' && k === RECORD;

    const lists = async (k: Kind, c: Client): Promise<string> => {
      const { project } = h;
      const parts: unknown[] = [
        await ok(c.request('GET', `/projects/${project}`)),
        await ok(c.request('GET', `/projects`)),
        await ok(c.request('GET', `/projects/${project}/discussion`)),
        await ok(c.request('GET', `/projects/${project}/notes`)),
        await ok(c.request('GET', `/projects/${project}/records`)),
      ];
      if (k === MESSAGE) parts.push(await ok(c.request('GET', `/threads/${threadId}`)));
      return json(parts);
    };
    const found = async (c: Client, q: string): Promise<number> =>
      ((await ok(c.request('GET', `/search?q=${encodeURIComponent(q)}`))).projects as Array<{ results: unknown[] }>).flatMap((p) => p.results).length;
    const links = (k: Kind): string[] =>
      k === MESSAGE ? [`/messages/${itemId}/versions`] : k === SOURCE ? [`/notes/${itemId}`, `/notes/${itemId}/versions/1`] : [`/records/tasks/${itemId}`];
    const sweep = () => new Sweep({ pool: h.t.pool, clock: h.t.clock.now, appUrl: APP_URL, nudge: { nudge: async () => undefined }, log: { warn: () => undefined } });

    for (const k of [MESSAGE, SOURCE, RECORD]) {
      const name = k === MESSAGE ? 'a held message' : k === SOURCE ? 'a held source' : 'a held record';

      describe(name, () => {
        test('project lists, counts and the personal dashboard', async () => {
          await make(k);
          assert.ok((await lists(k, h.ben)).includes(k.marker), 'the lists show the item before the report');
          const mine = async () => ((await ok(h.ben.request('GET', '/projects'))).projects as Array<{ myOpenTasks: number }>)[0].myOpenTasks;
          if (k === RECORD) assert.equal(await mine(), 1);
          await report(k);
          for (const c of [h.ben, h.ada, h.auditor, h.holder, h.pm]) {
            const after = await lists(k, c);
            assert.ok(!after.includes(SECRET), `a list holds the marked text: ${after}`);
            if (inWorkViews(k)) {
              assert.ok(after.includes(k.marker), 'a cleaned record stays in the work views');
              assert.ok(after.includes(UNDER_REVIEW), 'and is labelled');
            } else {
              assert.ok(!after.includes(k.marker), `a list still holds ${k.marker}: ${after}`);
            }
          }
          if (k === RECORD) assert.equal(await mine(), inWorkViews(k) ? 1 : 0, 'the dashboard counts a held task only once cleaned');
        });

        test('global search', async () => {
          await make(k);
          assert.ok((await found(h.ben, k.marker)) >= 1, 'search finds the item before the report');
          await report(k);
          for (const c of [h.ben, h.ada, h.auditor, h.holder, h.pm, h.own]) {
            assert.equal(await found(c, k.marker), 0);
            assert.equal(await found(c, SECRET), 0);
          }
        });

        test('Ask material and a new AI request', async () => {
          await make(k);
          const material = async (userId: string) => (await findMaterial(h.t.pool, await personal(userId), [k.marker])).map((m) => m.text).join('\n');
          const ask = async () => {
            const model = new CapturingModel();
            const r = await ok(h.ben.request('POST', `/projects/${h.project}/questions`, { question: QUESTION }), 201);
            if (r.status === 'queued') {
              const runner = byAttempt(h.t.pool, 'ai_requests', new AssistRunner({ pool: h.t.pool, spend: new SpendService(h.t.pool, h.t.clock.now), ...aiDeps(model), clock: h.t.clock.now }));
              await runner.process(r.id, 1, false);
            }
            return { model, view: await ok(h.ben.request('GET', `/questions/${r.id}`)) };
          };
          assert.ok((await material(h.ids.ben)).toLowerCase().includes(k.marker), 'material holds the item before the report');
          const first = await ask();
          assert.ok(first.model.input.toLowerCase().includes(k.marker), 'the AI request is built from the item before the report');
          h.t.clock.advanceSeconds(1);
          await report(k);
          for (const u of ['ben', 'ada', 'pm', 'auditor', 'holder']) assert.equal(await material(h.ids[u]), '', `material for ${u}`);
          const after = await ask();
          assert.ok(!after.model.input.toLowerCase().includes(k.marker), 'the held item reached the model');
          assert.ok(!after.model.input.includes(SECRET), 'the marked text reached the model');
          assert.ok(!json(after.view).toLowerCase().includes(k.marker));
        });

        test('digest content and queued email bodies', async () => {
          await make(k);
          const { t, project, ids } = h;
          const body = async () => (await buildDigest(t.pool, project, ids.ben, t.clock.now(), APP_URL)).body;
          const queued = async () => (await t.outbox()).map((m) => `${m.subject}\n${m.text_body}`).join('\n');
          if (k.producesMail) {
            assert.ok((await body()).includes(k.marker), 'the digest lists the open task before the report');
            await ok(h.own.request('POST', `/projects/${project}/digest`), 201);
            assert.ok((await queued()).includes(k.marker), 'the digest email holds the task before the report');
            t.clock.ms = at(9);
            await sweep().run();
            assert.ok((await queued()).toLowerCase().includes(`reminder: 'order ${k.marker}`), 'a reminder email is queued before the report');
          }
          const earlier = new Set((await t.outbox()).map((m) => m.id));
          await report(k);
          const digest = await body();
          assert.ok(!digest.includes(k.marker) && !digest.includes(SECRET), 'the digest lists the held item');
          // With the only open task held there is nothing to send.
          const refused = await h.own.request('POST', `/projects/${project}/digest`);
          assert.equal(refused.status, 409, json(refused.body));
          for (const m of (await t.outbox()).filter((x) => !earlier.has(x.id))) {
            assert.ok(!`${m.subject}\n${m.text_body}`.includes(k.marker) && !`${m.subject}\n${m.text_body}`.includes(SECRET), `a new email names the held item: ${m.kind}`);
          }
          // What was queued earlier holding the text is cancelled, never delivered.
          const transport = new CaptureTransport();
          await new EmailDispatcher({ pool: t.pool, transport, from: 'Kainow <noreply@example.org>', clock: t.clock.now, log: { warn: () => undefined } }).dispatchDue();
          for (const m of transport.sent) {
            const all = `${m.subject}\n${m.text}\n${m.html}`;
            assert.ok(!all.includes(k.marker) && !all.includes(SECRET), 'a queued email delivered the held item');
          }
          const still = (await t.pool.query(`SELECT subject, text_body, html_body FROM email_outbox WHERE status IN ('queued', 'sending', 'retry_wait')`)).rows;
          assert.ok(!json(still).includes(k.marker) && !json(still).includes(SECRET), 'a queued email still holds the held item');
        });

        test('notifications', async () => {
          await make(k);
          const shown = async (c: Client) => json(await ok(c.request('GET', '/notifications')));
          if (k.producesMail) {
            h.t.clock.ms = at(9);
            await sweep().run();
            assert.ok((await shown(h.ben)).includes(k.marker), 'the reminder is in the assignee list before the report');
          }
          await report(k);
          h.t.clock.ms = at(10);
          await sweep().run();
          for (const c of [h.ben, h.ada, h.pm, h.own, h.dep, h.auditor, h.holder]) {
            const list = await shown(c);
            assert.ok(!list.includes(SECRET), 'a notification holds the marked text');
            // A cleaned record's reminders continue (spec 7.5), with the cleaned title; nothing else names a held item.
            if (!inWorkViews(k)) assert.ok(!list.includes(k.marker), 'a notification still names the held item');
          }
          const rows = (await h.t.pool.query(`SELECT summary, link FROM notifications`)).rows;
          if (mode === 'cleaned') assert.ok(!json(rows).includes(SECRET), 'a stored notification holds the marked text');
        });

        test('History lines carry no title or text, and the reporter only for managers', async () => {
          await make(k);
          await report(k);
          for (const c of [h.ben, h.ada, h.auditor, h.holder, h.pm, h.own]) {
            const body = await ok(c.request('GET', `/projects/${h.project}/history/deletions`));
            const line = (body.lines as Array<{ kind: string; action: string; actor: string | null; reason: string | null; itemKind?: string; title?: string; href?: string }>).find(
              (l) => l.kind === 'credential_report',
            );
            assert.ok(line, json(body));
            assert.equal(line.action, 'reported');
            assert.equal(line.itemKind, k.reportKind);
            assert.equal(line.reason, null);
            assert.equal(line.title, undefined);
            assert.equal(line.href, undefined);
            assert.equal(line.actor === null, c !== h.pm && c !== h.own, 'the reporter is named only to PM, Owner and Sponsor');
            assert.ok(!json(body).includes(k.marker) && !json(body).includes(SECRET), 'a History line holds the title or text');
          }
        });

        test('direct links answer 404', async () => {
          await make(k);
          for (const path of links(k)) {
            const r = await h.ben.request('GET', path);
            assert.equal(r.status, 200, path);
            assert.ok(json(r.body).includes(k.marker), `${path} shows the item before the report`);
          }
          await report(k);
          for (const c of [h.ben, h.ada, h.auditor, h.holder, h.pm, h.own]) {
            for (const path of links(k)) {
              const r = await c.request('GET', path);
              if (inWorkViews(k)) {
                // A cleaned record opens, labelled, with the cleaned title.
                assert.equal(r.status, 200, path);
                assert.ok(json(r.body).includes(MARKER) && json(r.body).includes(UNDER_REVIEW), json(r.body));
              } else {
                assert.equal(r.status, 404, `${path} ${json(r.body)}`);
              }
              assert.ok(!json(r.body).includes(SECRET));
            }
          }
          if (k === MESSAGE) {
            // The thread shows that a message is held, never its text.
            const view = await ok(h.ben.request('GET', `/threads/${threadId}`));
            const m = (view.messages as Array<{ id: string; text: string | null; notice: string | null }>).find((x) => x.id === itemId)!;
            assert.equal(m.text, null);
            assert.equal(m.notice, HELD_NOTICE);
            assert.ok(!json(view).includes(k.marker) && !json(view).includes(SECRET));
          }
        });

        test('a holder of Inspect Deleted Content cannot see it', async () => {
          await make(k);
          await report(k);
          assert.equal((await h.holder.request('GET', `/projects/${h.project}/deleted-items/${k.apiKind}/${itemId}`)).status, 404);
          const listed = json(await ok(h.holder.request('GET', `/projects/${h.project}/deleted-items`)));
          assert.ok(!listed.includes(itemId) && !listed.includes(k.marker) && !listed.includes(SECRET), listed);
          if (!inWorkViews(k)) assert.ok(!(await lists(k, h.holder)).includes(k.marker));
          assert.equal(await found(h.holder, k.marker), 0);
        });
      });
    }

    test('a Deleted message holding the same text is never shown to a holder of Inspect Deleted Content with the text', async () => {
      const { t, project } = h;
      threadId = (await ok(h.ada.request('POST', `/projects/${project}/threads`, { kind: 'discussion', title: 'Quay chat' }), 201)).id;
      const copy = (await ok(h.ben.request('POST', `/threads/${threadId}/messages`, { body: `Old jibsheet note: gate code ${SECRET}.` }), 201)).id as string;
      await ok(h.pm.request('POST', `/messages/${copy}/delete`, { reason: 'Off topic' }));
      const shown = async () => json(await ok(h.holder.request('GET', `/projects/${project}/deleted-items`)));
      assert.ok((await shown()).includes(copy), 'the holder lists the Deleted message before the report');
      assert.ok(json(await ok(h.holder.request('GET', `/projects/${project}/deleted-items/message/${copy}`))).includes(SECRET), 'and opens it');
      await make(SOURCE);
      await report(SOURCE);
      const copies = (await t.pool.query(`SELECT item_id, masked FROM quarantine_possible_copies WHERE case_id = $1`, [caseId])).rows;
      assert.deepEqual(copies, [{ item_id: copy, masked: mode === 'cleaned' }]);
      const after = await shown();
      assert.ok(!after.includes(SECRET), after);
      const one = await h.holder.request('GET', `/projects/${project}/deleted-items/message/${copy}`);
      if (mode === 'waiting') {
        // Held until the key appears: gone from the holder's Deleted items too.
        assert.ok(!after.includes(copy), after);
        assert.equal(one.status, 404, json(one.body));
      } else {
        // Masked, not held: the holder still sees it, with the marked text removed.
        assert.equal(one.status, 200, json(one.body));
        assert.ok(json(one.body).includes(MARKER) && !json(one.body).includes(SECRET), json(one.body));
      }
    });
  });
}

describe('after a report, the marked text is nowhere in the project', { skip: SKIP_NO_DB }, () => {
  const h = harness('cleaned');

  /** Every registered column value of the project holding one of `needles`, as `table.column`. */
  const holding = async (needles: string[]): Promise<string[]> => {
    const out = new Set<string>();
    for (const col of TEXT_COLUMNS) {
      const { rows } = await h.t.pool.query(col.projectSql, [h.project]);
      for (const r of rows) {
        const v = r.value;
        if (v === null || v === undefined) continue;
        const text = Buffer.isBuffer(v) ? v.toString('latin1') : typeof v === 'string' ? v : json(v);
        if (needles.some((n) => text.includes(n))) out.add(`${col.table}.${col.column}`);
      }
    }
    return [...out].sort();
  };

  /** Puts the secrets into as many kinds of stored text as the routes allow, and reports the note. */
  const spread = async () => {
    const { t, ids, project } = h;
    const plant = `The kestrel pump service is booked for Thursday. Vault ${SECRET}, panel ${SECRET_HTML}.`;
    const source = (await ok(h.pm.request('POST', `/projects/${project}/notes`, { title: 'Plant room', text: plant }), 201)).source.id as string;
    const thread = (await ok(h.pm.request('POST', `/projects/${project}/threads`, { kind: 'discussion', title: 'Plant' }), 201)).id as string;
    const m1 = (await ok(h.ben.request('POST', `/threads/${thread}/messages`, { body: `Use ${SECRET} for the vault.` }), 201)).id as string;
    const m2 = (await ok(h.ada.request('POST', `/threads/${thread}/messages`, { body: `Panel is ${SECRET_HTML} now.` }), 201)).id as string;
    const m3 = (await ok(h.ada.request('POST', `/threads/${thread}/messages`, { body: 'Kestrel pump noted.' }), 201)).id as string;
    // A reason that holds the secret (the credential check does not know it).
    await ok(h.pm.request('POST', `/messages/${m3}/delete`, { reason: `duplicate of the ${SECRET} note` }));
    const task = uuidv7();
    await t.pool.query(
      `INSERT INTO tasks (id, project_id, depth, title, assignee_id, due_on, status, authorised_by, authorised_at)
       VALUES ($1, $2, 0, $3, $4, '2026-11-16', 'not_started', $5, $6)`,
      [task, project, `Rotate the kestrel vault code, old ${SECRET}`, ids.ben, ids.own, new Date(at(8))],
    );
    await writeOutbox(t.pool, { toUserId: ids.ben, toAddress: 'ben@example.org', subject: 'Notice', body: `Vault ${SECRET}, panel ${SECRET_HTML}`, kind: 'notice', projectId: project, initiatedBy: 'trigger', now: t.clock.now() });
    // An AI request whose material snapshots the task and the passages.
    const asked = await ok(h.ben.request('POST', `/projects/${project}/questions`, { question: 'What is the kestrel vault code?' }), 201);
    if (asked.status === 'queued') {
      await byAttempt(t.pool, 'ai_requests', new AssistRunner({ pool: t.pool, spend: new SpendService(t.pool, t.clock.now), ...aiDeps(new CapturingModel()), clock: t.clock.now })).process(asked.id, 1, false);
    }
    t.clock.advanceSeconds(1);
    return { source, thread, m1, m2, task };
  };

  test('a search of every registered column of the project finds the marked text nowhere after report', async () => {
    const { source } = await spread();
    const before = await holding([SECRET, SECRET_HTML, ESCAPED_HTML]);
    for (const c of ['source_versions.text_content', 'passages.body', 'message_versions.body', 'tasks.title', 'discussion_events.reason', 'email_outbox.text_body', 'email_outbox.html_body', 'ai_request_material.snapshot']) {
      assert.ok(before.includes(c), `${c} holds the secret before the report: ${before}`);
    }
    const escaped = (await h.t.pool.query(`SELECT html_body FROM email_outbox WHERE html_body LIKE '%' || $1 || '%'`, [ESCAPED_HTML])).rowCount;
    assert.ok(escaped! > 0, 'the HTML body holds the escaped form');
    const r = await ok(h.ada.request('POST', `/projects/${h.project}/secret-reports`, { kind: 'source', id: source, marked: [SECRET, SECRET_HTML], reason: 'Vault and panel codes' }), 201);
    assert.ok(!json(r).includes(SECRET));
    assert.deepEqual(await holding([SECRET, SECRET_HTML, ESCAPED_HTML]), []);
    // Not even a fragment longer than three characters survives in a passage.
    const passages = (await h.t.pool.query(`SELECT body FROM passages`)).rows.map((x) => x.body as string).join('\n');
    for (let i = 0; i + 4 <= SECRET.length; i++) assert.ok(!passages.includes(SECRET.slice(i, i + 4)) || 'vault'.includes(SECRET.slice(i, i + 4).toLowerCase()), SECRET.slice(i, i + 4));
  });

  test('every kind of place masked at once stays visible with its label and without the text (I3)', async () => {
    const { t, ids, project } = h;
    const POSSIBLE = 'Possible credential removed — awaiting check';
    const source = (await ok(h.pm.request('POST', `/projects/${project}/notes`, { title: 'Plant room', text: `The kestrel pump. Vault ${SECRET}.` }), 201)).source.id as string;
    // A second note holding it (a place), and a plain one the proposal and summary are taken from.
    const note = (await ok(h.pm.request('POST', `/projects/${project}/notes`, { title: 'Copy', text: `Copied: ${SECRET}.` }), 201)).source.id as string;
    const plain = (await ok(h.pm.request('POST', `/projects/${project}/notes`, { title: 'Pump plan', text: 'Kestrel pump plan.' }), 201)).source;
    const version = (await t.pool.query(`SELECT id FROM source_versions WHERE source_id = $1`, [plain.id])).rows[0].id as string;
    const task = uuidv7();
    await t.pool.query(
      `INSERT INTO tasks (id, project_id, depth, title, assignee_id, due_on, status, authorised_by, authorised_at) VALUES ($1, $2, 0, $3, $4, '2026-11-16', 'not_started', $5, now())`,
      [task, project, `Rotate ${SECRET}`, ids.ben, ids.own],
    );
    const run = uuidv7();
    await t.pool.query(`INSERT INTO extraction_runs (id, source_version_id, requested_by, status, created_at) VALUES ($1, $2, $3, 'succeeded', now())`, [run, version, ids.pm]);
    const proposal = uuidv7();
    await t.pool.query(
      `INSERT INTO extraction_items (id, run_id, source_version_id, position, kind, text, quote, quote_start, quote_end, quote_matches, created_at)
       VALUES ($1, $2, $3, 0, 'action', $4, 'Kestrel pump plan.', 0, 18, 1, now())`,
      [proposal, run, version, `Rotate ${SECRET}`],
    );
    const human = uuidv7();
    await t.pool.query(`INSERT INTO human_proposals (id, project_id, kind, text, proposed_by, proposed_at) VALUES ($1, $2, 'action', $3, $4, now())`, [human, project, `Rotate ${SECRET}`, ids.pm]);
    // An answered question that used no material (a question asked through the API would find the reported note and
    // be withdrawn with it).
    const answer = uuidv7();
    await t.pool.query(`INSERT INTO ai_requests (id, project_id, kind, requested_by, status, scope, created_at, finished_at) VALUES ($1, $2, 'question', $3, 'succeeded', 'personal', now(), now())`, [answer, project, ids.pm]);
    await t.pool.query(`INSERT INTO ai_answers (request_id, project_id, question, answer_markdown, not_found) VALUES ($1, $2, $3, 'Nothing says.', true)`, [answer, project, `When does ${SECRET} expire?`]);
    const draft = uuidv7();
    await t.pool.query(`INSERT INTO report_drafts (id, project_id, kind, title, brief, created_by, created_at) VALUES ($1, $2, 'free_form', 'Kestrel brief', $3, $4, now())`, [draft, project, `Mention ${SECRET}`, ids.pm]);
    const summary = uuidv7();
    await t.pool.query(
      `INSERT INTO summaries (id, project_id, original_source_id, intended_audience, leave_out, created_by, created_at) VALUES ($1, $2, $3, $4, $5, $6, now())`,
      [summary, project, plain.id, json({ mode: 'project', namedUserIds: [] }), `Leave out ${SECRET}`, ids.pm],
    );
    const feedback = uuidv7();
    await t.pool.query(
      `INSERT INTO ai_feedback (id, project_id, target_kind, target_id, category, note, reporter_id, created_at) VALUES ($1, $2, 'proposal', $3, 'other', $4, $5, now())`,
      [feedback, project, proposal, `It missed ${SECRET}`, ids.pm],
    );
    const meeting = (await ok(h.pm.request('POST', `/projects/${project}/threads`, { kind: 'meeting', title: 'Pump meeting', meetingDate: '2026-11-13' }), 201)).id as string;
    await t.pool.query(
      `INSERT INTO minutes_drafts (id, thread_id, version_no, origin, body, covers_through_no, created_by, created_at) VALUES ($1, $2, 1, 'human', $3, 0, $4, now())`,
      [uuidv7(), meeting, `Minutes: ${SECRET}`, ids.pm],
    );
    t.clock.advanceSeconds(1);

    await ok(h.ada.request('POST', `/projects/${project}/secret-reports`, { kind: 'source', id: source, marked: [SECRET], reason: 'Vault code' }), 201);
    const listed = (await t.pool.query(`SELECT item_kind AS kind, item_id AS id FROM quarantine_possible_copies`)).rows.map((r) => `${r.kind}:${r.id}`).sort();
    const want = [`source:${note}`, `task:${task}`, `proposal:${proposal}`, `human_proposal:${human}`, `answer:${answer}`, `report_draft:${draft}`, `summary:${summary}`, `feedback:${feedback}`];
    for (const w of want) assert.ok(listed.includes(w), `${w} is a place: ${listed}`);
    assert.ok(listed.some((p) => p.startsWith('minutes_draft:')), `a minutes draft is a place: ${listed}`);

    const views: Array<[string, string]> = [
      ['note', `/notes/${note}`],
      ['notes list', `/projects/${project}/discussion`],
      ['record', `/projects/${project}/records`],
      ['proposal', `/extractions/${run}`],
      ['human proposal', `/projects/${project}/proposals`],
      ['AI answer', `/questions/${answer}`],
      ['report draft', `/reports/${draft}`],
      ['summary', `/summaries/${summary}`],
      ['feedback', `/projects/${project}/feedback`],
      ['minutes draft', `/threads/${meeting}/minutes`],
    ];
    for (const [kind, path] of views) {
      const r = await h.pm.request('GET', path);
      assert.equal(r.status, 200, `${kind} (${path}): ${json(r.body)}`);
      const body = json(r.body);
      assert.ok(body.includes(POSSIBLE), `${kind} (${path}) carries the label: ${body}`);
      assert.ok(!body.includes(SECRET), `${kind} (${path}) holds the marked text`);
    }
  });

  test('decrypting the case\'s originals gives it back', async () => {
    const { source } = await spread();
    const original = (await h.t.pool.query(`SELECT text_content FROM source_versions WHERE source_id = $1`, [source])).rows[0].text_content as string;
    const { caseId } = await ok(h.ada.request('POST', `/projects/${h.project}/secret-reports`, { kind: 'source', id: source, marked: [SECRET, SECRET_HTML], reason: 'Vault and panel codes' }), 201);
    const key = loadProtectedKey(h.keyFile, () => undefined);
    assert.ok(key);
    const rows = (await h.t.pool.query(`SELECT table_name, column_name, item_kind, ciphertext, nonce, tag, key_id FROM quarantine_originals WHERE case_id = $1`, [caseId])).rows;
    assert.ok(rows.length >= 8, `originals: ${rows.length}`);
    const plain = rows.map((o) => {
      assert.equal(o.key_id, key.id);
      // The stored bytes are not the plain text.
      assert.ok(!Buffer.from(o.ciphertext).toString('latin1').includes(SECRET));
      return key.decrypt({ ciphertext: o.ciphertext, nonce: o.nonce, tag: o.tag }).toString('utf8');
    });
    // Every text original held a mark; offsets (passage and span ends mapped through the replacements) are numbers.
    const without = rows.filter((o, i) => !/offset|_start$|_end$/.test(o.column_name) && ![SECRET, SECRET_HTML, ESCAPED_HTML].some((s) => plain[i].includes(s))).map((o) => `${o.table_name}.${o.column_name}`);
    assert.deepEqual(without, [], 'every original held the marked text');
    // Reveal's reader gives the source's own text back exactly.
    const client = await h.t.pool.connect();
    try {
      const revealed = await readOriginals(client, key, caseId, { kind: 'source', id: source });
      const text = revealed.find((v) => v.table === 'source_versions' && v.column === 'text_content')!;
      assert.equal(text.text, original);
      assert.ok(text.marks.length >= 2);
      for (const m of text.marks) assert.ok([SECRET, SECRET_HTML].includes(original.slice(m.start, m.end)));
    } finally {
      client.release();
    }
    // A different key cannot read them.
    const other = join(h.dir, 'other.key');
    writeFileSync(other, randomBytes(32));
    const wrong = loadProtectedKey(other, () => undefined)!;
    assert.throws(() => wrong.decrypt({ ciphertext: rows[0].ciphertext, nonce: rows[0].nonce, tag: rows[0].tag }));
  });

  test('a dismissed copy gets its original back and a confirmed one stays cleaned', async () => {
    const { source, m1, m2 } = await spread();
    const { caseId } = await ok(h.ada.request('POST', `/projects/${h.project}/secret-reports`, { kind: 'source', id: source, marked: [SECRET, SECRET_HTML], reason: 'Vault and panel codes' }), 201);
    const texts = async (m: string) => {
      const versions = (await h.t.pool.query(`SELECT body FROM message_versions WHERE message_id = $1`, [m])).rows.map((x) => x.body);
      const passages = (await h.t.pool.query(`SELECT p.body FROM passages p JOIN message_versions v ON p.owner_kind = 'message_version' AND p.owner_id = v.id WHERE v.message_id = $1`, [m])).rows.map((x) => x.body);
      return json([...versions, ...passages]);
    };
    for (const m of [m1, m2]) assert.ok(!(await texts(m)).includes(SECRET) && !(await texts(m)).includes(SECRET_HTML));
    await ok(h.pm.request('POST', `/quarantine/cases/${caseId}/copies`, { decisions: [{ kind: 'message', id: m1, decision: 'confirmed' }, { kind: 'message', id: m2, decision: 'dismissed' }] }));
    assert.ok(!(await texts(m1)).includes(SECRET) && (await texts(m1)).includes(MARKER), 'the confirmed copy stays cleaned');
    assert.ok((await texts(m2)).includes(SECRET_HTML) && !(await texts(m2)).includes(MARKER), 'the dismissed copy has its original back, passages too');
    // Release the case: the confirmed copy stays cleaned.
    await ok(h.pm.request('POST', `/quarantine/cases/${caseId}/release`, { reason: 'Checked the cleaned note' }));
    assert.ok(!(await texts(m1)).includes(SECRET));
  });

  test('event and notification rows never contain the marked text', async () => {
    const { source, m1, m2 } = await spread();
    const { caseId } = await ok(h.ada.request('POST', `/projects/${h.project}/secret-reports`, { kind: 'source', id: source, marked: [SECRET, SECRET_HTML], reason: 'Vault and panel codes', holderUserId: h.ids.dep }), 201);
    await ok(h.dep.request('POST', `/quarantine/cases/${caseId}/copies`, { decisions: [{ kind: 'message', id: m1, decision: 'confirmed' }, { kind: 'message', id: m2, decision: 'dismissed' }] }));
    await ok(h.pm.request('POST', `/quarantine/cases/${caseId}/release`, { reason: 'Checked the cleaned note' }));
    const tables = (
      await h.t.pool.query(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
            AND (table_name LIKE '%\\_events' OR table_name IN ('notifications', 'notification_triggers', 'quarantine_cases', 'quarantine_items', 'quarantine_possible_copies', 'quarantine_grants'))
          ORDER BY 1`,
      )
    ).rows.map((r) => r.table_name as string);
    assert.ok(tables.includes('quarantine_events') && tables.includes('audit_events') && tables.includes('discussion_events'), json(tables));
    for (const table of tables) {
      const all = json((await h.t.pool.query(`SELECT row_to_json(x) AS r FROM ${table} x`)).rows);
      for (const s of [SECRET, SECRET_HTML, ESCAPED_HTML]) assert.ok(!all.includes(s), `${table} holds the marked text`);
    }
    // The emails Kainow wrote about it hold none of it either.
    const mail = json((await h.t.pool.query(`SELECT subject, text_body, html_body FROM email_outbox WHERE kind IN ('credential_report', 'notice')`)).rows);
    for (const s of [SECRET, SECRET_HTML, ESCAPED_HTML]) assert.ok(!mail.includes(s));
  });
});
