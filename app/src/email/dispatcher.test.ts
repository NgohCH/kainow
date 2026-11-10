import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { Pool } from 'pg';
import { loadDatabaseConfig } from '../config';
import { runMigrations } from '../db/migrate';
import { uuidv7 } from '../common/uuid7';
import { SKIP_NO_DB, resetPublicSchema, testDatabaseUrl } from '../testing/db';
import { FakeClock } from '../testing/fakes';
import { seedOrganisation, seedProject, seedUser } from '../testing/projects';
import { EmailDispatcher, NotResendable, RETRY_MINUTES, UNCERTAIN_AFTER_MINUTES, resend } from './dispatcher';
import { writeOutbox, type OutboxInput } from './outbox';
import { stillRelevant, type EmailRelevance } from './relevance';
import { SendError, type MailTransport, type OutgoingEmail } from './transport';

const START = Date.UTC(2026, 10, 10, 1, 0, 0); // Tue 10 Nov 2026, 09:00 UTC+8
let pool: Pool;
let clock: FakeClock;
let userId: string;
let adminId: string;
let projectId: string;

class ScriptedTransport implements MailTransport {
  readonly sent: OutgoingEmail[] = [];
  calls = 0;
  constructor(private readonly steps: Array<'ok' | SendError> = []) {}
  async send(m: OutgoingEmail): Promise<{ messageId: string | null }> {
    this.calls += 1;
    const step = this.steps.shift() ?? 'ok';
    if (step !== 'ok') throw step;
    this.sent.push(m);
    return { messageId: 'id' };
  }
}
const temp = () => new SendError('temporary', 451, 'The mail service could not take the message just now');
const perm = () => new SendError('permanent', 550, 'The mail service refused the message or the address');
const log = { warn: () => undefined };

const dispatcher = (t: MailTransport) => new EmailDispatcher({ pool, transport: t, from: 'Kainow <noreply@example.org>', clock: clock.now, log });

async function queue(over: Partial<OutboxInput> = {}): Promise<string> {
  return writeOutbox(pool, {
    toUserId: userId,
    toAddress: 'person@example.org',
    subject: 'Subject',
    body: 'Body',
    kind: 'notice',
    projectId,
    initiatedBy: 'trigger',
    now: clock.now(),
    relevance: { kind: 'none', scope: 'account' },
    ...over,
  });
}
const row = async (id: string) => (await pool.query(`SELECT * FROM email_outbox WHERE id = $1`, [id])).rows[0];
const attempts = async (id: string) => (await pool.query(`SELECT * FROM email_attempts WHERE outbox_id = $1 ORDER BY attempt_no, started_at`, [id])).rows;
const minutes = (d: Date | null, from: number = START) => (d ? (d.getTime() - from) / 60_000 : null);
const makeTask = async (title = 'Task', status = 'in_progress') => {
  const taskId = uuidv7();
  await pool.query(
    `INSERT INTO tasks (id, project_id, depth, title, assignee_id, due_on, status, authorised_by, authorised_at) VALUES ($1, $2, 0, $4, $3, '2026-11-20', $5, $3, now())`,
    [taskId, projectId, userId, title, status],
  );
  return taskId;
};

before(async () => {
  if (SKIP_NO_DB) return;
  pool = new Pool({ connectionString: testDatabaseUrl() });
  await resetPublicSchema(pool);
  await runMigrations(pool, loadDatabaseConfig({ DATABASE_URL: testDatabaseUrl() }).migrationsDir);
  await seedOrganisation(pool);
  adminId = await seedUser(pool, 'admin@kainow.test', 'enterprise_administrator');
});
beforeEach(async () => {
  if (SKIP_NO_DB) return;
  clock = new FakeClock(START);
  // rows left over from an earlier test must not be picked up by this one
  await pool.query(`UPDATE email_outbox SET status = 'cancelled', next_attempt_at = NULL WHERE status NOT IN ('sent', 'failed', 'cancelled')`);
  userId = await seedUser(pool, `p-${uuidv7().slice(-10)}@example.org`);
  projectId = await seedProject(pool, { status: 'active', members: [{ userId, role: 'member' }, { userId: adminId, role: 'pm' }] });
});
after(async () => {
  await pool?.end();
});

test('the retry constants', () => {
  assert.deepEqual(RETRY_MINUTES, [5, 30, 120]);
  assert.equal(UNCERTAIN_AFTER_MINUTES, 10);
});

test('sends once and records sent_at', { skip: SKIP_NO_DB }, async () => {
  const id = await queue();
  const t = new ScriptedTransport();
  const r = await dispatcher(t).dispatchDue();
  assert.deepEqual(r, { sent: 1, failed: 0, cancelled: 0 });
  const o = await row(id);
  assert.equal(o.status, 'sent');
  assert.equal(o.sent_at.getTime(), START);
  assert.equal(o.attempts, 1);
  assert.equal(t.sent[0].to, 'person@example.org');
  assert.equal(t.sent[0].from, 'Kainow <noreply@example.org>');
  assert.equal(t.sent[0].subject, 'Subject');
  const a = await attempts(id);
  assert.equal(a.length, 1);
  assert.equal(a[0].outcome, 'sent');
  assert.equal(a[0].started_at.getTime(), START);
  assert.equal(a[0].finished_at.getTime(), START);
  await dispatcher(t).dispatchDue();
  assert.equal(t.calls, 1, 'a sent row is never sent again');
});

test('temporary failures retry at +5, +30, +120 from the first failure, then failed', { skip: SKIP_NO_DB }, async () => {
  const id = await queue();
  const t = new ScriptedTransport([temp(), temp(), temp(), temp()]);
  const d = dispatcher(t);
  await d.dispatchDue();
  let o = await row(id);
  assert.equal(o.status, 'retry_wait');
  assert.equal(o.first_failure_at.getTime(), START);
  assert.equal(minutes(o.next_attempt_at), 5);
  assert.equal(o.last_reason, 'The mail service could not take the message just now');

  clock.advanceMinutes(4);
  await d.dispatchDue();
  assert.equal(t.calls, 1, 'nothing before the time');

  clock.advanceMinutes(1); // +5
  await d.dispatchDue();
  o = await row(id);
  assert.equal(o.status, 'retry_wait');
  assert.equal(o.attempts, 2);
  assert.equal(minutes(o.next_attempt_at), 30);

  clock.advanceMinutes(25); // +30
  await d.dispatchDue();
  o = await row(id);
  assert.equal(o.attempts, 3);
  assert.equal(minutes(o.next_attempt_at), 120);

  clock.advanceMinutes(90); // +120
  const r = await d.dispatchDue();
  o = await row(id);
  assert.equal(o.status, 'failed');
  assert.equal(o.attempts, 4);
  assert.equal(r.failed, 1);
  assert.deepEqual((await attempts(id)).map((a) => a.outcome), ['temporary', 'temporary', 'temporary', 'temporary']);
  clock.advanceMinutes(600);
  await d.dispatchDue();
  assert.equal(t.calls, 4, 'failed is final');
});

test('permanent failure is failed at once with the reason', { skip: SKIP_NO_DB }, async () => {
  const id = await queue();
  const r = await dispatcher(new ScriptedTransport([perm()])).dispatchDue();
  assert.equal(r.failed, 1);
  const o = await row(id);
  assert.equal(o.status, 'failed');
  assert.equal(o.last_reason, 'The mail service refused the message or the address');
  const a = await attempts(id);
  assert.equal(a[0].outcome, 'permanent');
  assert.equal(a[0].smtp_code, '550');
});

test('an unexpected error is recorded with a fixed reason, never its text', { skip: SKIP_NO_DB }, async () => {
  const id = await queue();
  const t: MailTransport = {
    async send() {
      throw new Error('password=secret-value-xyz');
    },
  };
  await dispatcher(t).dispatchDue();
  const o = await row(id);
  assert.equal(o.status, 'retry_wait');
  assert.ok(!JSON.stringify(o).includes('secret-value-xyz'));
  assert.ok(!JSON.stringify(await attempts(id)).includes('secret-value-xyz'));
});

test('attempt count survives a new dispatcher instance', { skip: SKIP_NO_DB }, async () => {
  const id = await queue();
  await dispatcher(new ScriptedTransport([temp()])).dispatchDue();
  clock.advanceMinutes(5);
  await dispatcher(new ScriptedTransport([temp()])).dispatchDue();
  const o = await row(id);
  assert.equal(o.attempts, 2);
  assert.equal(minutes(o.next_attempt_at), 30);
});

test('two dispatchers at once send a row only once', { skip: SKIP_NO_DB }, async () => {
  await queue();
  const t = new ScriptedTransport();
  await Promise.all([dispatcher(t).dispatchDue(), dispatcher(t).dispatchDue()]);
  assert.equal(t.calls, 1);
});

test('a row left sending for 10 minutes becomes uncertain, is resent once at the next slot with possible_duplicate true, and a second uncertain stays uncertain', { skip: SKIP_NO_DB }, async () => {
  const id = await queue();
  // the worker stopped mid-send: the row was claimed (attempt 1 at START) and nothing was recorded
  await pool.query(`UPDATE email_outbox SET status = 'sending', attempts = 1, next_attempt_at = $2 WHERE id = $1`, [id, new Date(START)]);
  const t = new ScriptedTransport();
  const d = dispatcher(t);

  clock.advanceMinutes(9);
  await d.dispatchDue();
  assert.equal((await row(id)).status, 'sending', 'not uncertain before 10 minutes');
  assert.equal(t.calls, 0);

  clock.advanceMinutes(1);
  await d.dispatchDue(); // marks uncertain; its slot (first failure + 5) has passed, so it goes out in the same pass
  let o = await row(id);
  assert.equal(o.first_failure_at.getTime(), START);
  assert.equal(o.possible_duplicate, true);
  assert.equal(o.status, 'sent');
  assert.equal(o.attempts, 2);
  assert.equal(t.calls, 1);
  const a = await attempts(id);
  assert.deepEqual(a.map((x) => x.outcome), ['uncertain', 'sent']);
  assert.equal(a[0].finished_at, null);
  assert.equal(a[0].started_at.getTime(), START);

  // second uncertain: stays uncertain and is left for an Administrator
  const id2 = await queue();
  await pool.query(
    `UPDATE email_outbox SET status = 'sending', attempts = 2, first_failure_at = $2, next_attempt_at = $2, possible_duplicate = true WHERE id = $1`,
    [id2, new Date(START)],
  );
  await pool.query(`INSERT INTO email_attempts (id, outbox_id, attempt_no, started_at, outcome) VALUES ($1, $2, 1, $3, 'uncertain')`, [uuidv7(), id2, new Date(START - 3_600_000)]);
  clock.advanceMinutes(10);
  await d.dispatchDue();
  o = await row(id2);
  assert.equal(o.status, 'uncertain');
  assert.equal(o.next_attempt_at, null);
  assert.equal(t.calls, 1);
  clock.advanceMinutes(5000);
  await d.dispatchDue();
  assert.equal(t.calls, 1, 'never picked up automatically');
  assert.equal((await attempts(id2)).filter((x) => x.outcome === 'uncertain').length, 2);
});

test('the uncertain resend waits for its retry slot', { skip: SKIP_NO_DB }, async () => {
  const id = await queue();
  await pool.query(`UPDATE email_outbox SET status = 'sending', attempts = 2, first_failure_at = $2, next_attempt_at = $3 WHERE id = $1`, [id, new Date(START), new Date(START + 6 * 60_000)]);
  clock.advanceMinutes(16); // the second attempt has been sending for 10 minutes
  const t = new ScriptedTransport();
  const d = dispatcher(t);
  await d.dispatchDue();
  const o = await row(id);
  assert.equal(o.status, 'uncertain');
  assert.equal(minutes(o.next_attempt_at), 30, 'first failure + 30');
  assert.equal(t.calls, 0);
  clock.advanceMinutes(14);
  await d.dispatchDue();
  assert.equal(t.calls, 1);
  assert.equal((await row(id)).status, 'sent');
});

test('an uncertain row with no attempts left fails', { skip: SKIP_NO_DB }, async () => {
  const id = await queue();
  await pool.query(`UPDATE email_outbox SET status = 'sending', attempts = 4, first_failure_at = $2, next_attempt_at = $2 WHERE id = $1`, [id, new Date(START)]);
  clock.advanceMinutes(10);
  const t = new ScriptedTransport();
  await dispatcher(t).dispatchDue();
  const o = await row(id);
  assert.equal(o.status, 'failed');
  assert.equal(o.last_reason, 'No more attempts after an uncertain send');
  assert.equal(t.calls, 0);
});

test('task amended before the attempt cancels the reminder email', { skip: SKIP_NO_DB }, async () => {
  const taskId = await makeTask();
  const relevance: EmailRelevance = { kind: 'task', taskId, dueOn: '2026-11-20', reopenCount: 0, scope: 'project' };
  const id = await queue({ relevance });
  const t = new ScriptedTransport([temp()]);
  const d = dispatcher(t);
  await d.dispatchDue();
  assert.equal((await row(id)).status, 'retry_wait');
  await pool.query(`UPDATE tasks SET due_on = '2026-11-27' WHERE id = $1`, [taskId]);
  clock.advanceMinutes(5);
  const r = await d.dispatchDue();
  assert.equal(r.cancelled, 1);
  const o = await row(id);
  assert.equal(o.status, 'cancelled');
  assert.equal(o.last_reason, 'no longer relevant');
  assert.equal(t.calls, 1);
});

test('stillRelevant rules for tasks, risks and projects', { skip: SKIP_NO_DB }, async () => {
  const taskId = await makeTask();
  const r = { kind: 'task', taskId, dueOn: '2026-11-20', reopenCount: 0 } as const;
  assert.equal(await stillRelevant(pool, r), true);
  await pool.query(`UPDATE tasks SET deadline_review_required = true WHERE id = $1`, [taskId]);
  assert.equal(await stillRelevant(pool, r), false);
  await pool.query(`UPDATE tasks SET deadline_review_required = false WHERE id = $1`, [taskId]);
  await pool.query(`INSERT INTO task_events (id, task_id, kind, actor_id, at) VALUES ($1, $2, 'reopened', $3, now())`, [uuidv7(), taskId, userId]);
  assert.equal(await stillRelevant(pool, r), false, 'a reopened task is a new episode');
  assert.equal(await stillRelevant(pool, { ...r, reopenCount: 1 }), true);
  await pool.query(`UPDATE tasks SET status = 'completed' WHERE id = $1`, [taskId]);
  assert.equal(await stillRelevant(pool, { ...r, reopenCount: 1 }), false);
  assert.equal(await stillRelevant(pool, { ...r, taskId: uuidv7() }), false);

  const riskId = uuidv7();
  const proposal = uuidv7();
  await pool.query(`INSERT INTO human_proposals (id, project_id, kind, text, proposed_by, proposed_at) VALUES ($1, $2, 'risk', 'R', $3, now())`, [proposal, projectId, userId]);
  await pool.query(
    `INSERT INTO risks (id, project_id, description, severity, review_on, origin_proposal_id, authorised_by, authorised_at) VALUES ($1, $2, 'R', 'low', '2026-11-20', $3, $4, now())`,
    [riskId, projectId, proposal, userId],
  );
  assert.equal(await stillRelevant(pool, { kind: 'risk', riskId, reviewOn: '2026-11-20' }), true);
  assert.equal(await stillRelevant(pool, { kind: 'risk', riskId, reviewOn: '2026-11-21' }), false);
  await pool.query(`UPDATE risks SET status = 'resolved' WHERE id = $1`, [riskId]);
  assert.equal(await stillRelevant(pool, { kind: 'risk', riskId, reviewOn: '2026-11-20' }), false);

  assert.equal(await stillRelevant(pool, { kind: 'project_active', projectId }), true);
  await pool.query(`UPDATE projects SET status = 'deferred' WHERE id = $1`, [projectId]);
  assert.equal(await stillRelevant(pool, { kind: 'project_active', projectId }), false);
  assert.equal(await stillRelevant(pool, { kind: 'none' }), true);
});

test('recipient disabled cancels with recipient no longer eligible', { skip: SKIP_NO_DB }, async () => {
  const id = await queue({ relevance: { kind: 'none', scope: 'project' } });
  await pool.query(`UPDATE memberships SET revoked_at = now(), revoked_by = $2 WHERE user_id = $1`, [userId, adminId]);
  const t = new ScriptedTransport();
  const r = await dispatcher(t).dispatchDue();
  assert.equal(r.cancelled, 1);
  assert.equal(t.calls, 0);
  const o = await row(id);
  assert.equal(o.status, 'cancelled');
  assert.equal(o.last_reason, 'recipient no longer eligible');
  assert.equal(o.attempts, 0);
});

test('an account that is no longer Active is not sent to (account scope is the default)', { skip: SKIP_NO_DB }, async () => {
  const id = await queue({ relevance: undefined });
  await pool.query(`UPDATE users SET status = 'disabled' WHERE id = $1`, [userId]);
  const t = new ScriptedTransport();
  await dispatcher(t).dispatchDue();
  assert.equal((await row(id)).last_reason, 'recipient no longer eligible');
  assert.equal(t.calls, 0);
});

test('admin scope needs an active Administrator', { skip: SKIP_NO_DB }, async () => {
  const ok = await queue({ toUserId: adminId, projectId: null, relevance: { kind: 'none', scope: 'admin' } });
  const bad = await queue({ toUserId: userId, projectId: null, relevance: { kind: 'none', scope: 'admin' } });
  await dispatcher(new ScriptedTransport()).dispatchDue();
  assert.equal((await row(ok)).status, 'sent');
  assert.equal((await row(bad)).status, 'cancelled');
});

test('a row with no recipient user and no relevance is sent without checks', { skip: SKIP_NO_DB }, async () => {
  const id = await queue({ toUserId: null, projectId: null, relevance: undefined });
  await dispatcher(new ScriptedTransport()).dispatchDue();
  assert.equal((await row(id)).status, 'sent');
});

async function twoItems() {
  const a = await makeTask('A');
  const b = await makeTask('B');
  const relevance: EmailRelevance = {
    scope: 'project',
    projectName: 'Example Project',
    items: [
      { triggerId: uuidv7(), projectId, check: { kind: 'task', taskId: a, dueOn: '2026-11-20', reopenCount: 0 }, line: 'Task A is due on 20 Nov' },
      { triggerId: uuidv7(), projectId, check: { kind: 'task', taskId: b, dueOn: '2026-11-20', reopenCount: 0 }, line: 'Task B is due on 20 Nov' },
    ],
  };
  return { a, b, relevance };
}

test('one of two items obsolete cancels with content changed and writes a replacement holding only the other item', { skip: SKIP_NO_DB }, async () => {
  const { a, relevance } = await twoItems();
  const id = await queue({ relevance, subject: 'Kainow: 2 items need your attention in Example Project', body: 'Task A is due on 20 Nov\nTask B is due on 20 Nov' });
  await pool.query(`UPDATE tasks SET status = 'completed' WHERE id = $1`, [a]);
  const t = new ScriptedTransport();
  const r = await dispatcher(t).dispatchDue();
  assert.equal(r.cancelled, 1);
  const o = await row(id);
  assert.equal(o.status, 'cancelled');
  assert.equal(o.last_reason, 'content changed');
  const rep = (await pool.query(`SELECT * FROM email_outbox WHERE replaces = $1`, [id])).rows;
  assert.equal(rep.length, 1);
  assert.equal(rep[0].status, 'sent', 'the replacement goes out in the same run');
  assert.equal(rep[0].subject, 'Kainow: 1 item needs your attention in Example Project');
  assert.match(rep[0].text_body, /Task B is due on 20 Nov/);
  assert.ok(!/Task A/.test(rep[0].text_body));
  assert.equal(rep[0].to_user_id, userId);
  assert.equal(rep[0].project_id, projectId);
  assert.equal(rep[0].kind, 'notice');
  assert.equal(rep[0].relevance.items.length, 1);
  assert.equal(rep[0].relevance.items[0].line, 'Task B is due on 20 Nov');
  assert.deepEqual(rep[0].trigger_ids, [relevance && 'items' in relevance ? relevance.items[1].triggerId : '']);
  assert.equal(t.calls, 1);
  assert.equal(t.sent[0].subject, 'Kainow: 1 item needs your attention in Example Project');
});

test('all items obsolete cancels with content changed and no replacement', { skip: SKIP_NO_DB }, async () => {
  const { a, b, relevance } = await twoItems();
  const id = await queue({ relevance });
  await pool.query(`UPDATE tasks SET status = 'cancelled' WHERE id IN ($1, $2)`, [a, b]);
  await dispatcher(new ScriptedTransport()).dispatchDue();
  assert.equal((await row(id)).last_reason, 'content changed');
  assert.equal((await pool.query(`SELECT 1 FROM email_outbox WHERE replaces = $1`, [id])).rows.length, 0);
});

test('all items relevant sends the email as composed', { skip: SKIP_NO_DB }, async () => {
  const { relevance } = await twoItems();
  const id = await queue({ relevance });
  await dispatcher(new ScriptedTransport()).dispatchDue();
  assert.equal((await row(id)).status, 'sent');
});

test('resend creates a linked row with fresh attempts', { skip: SKIP_NO_DB }, async () => {
  const relevance: EmailRelevance = { kind: 'none', scope: 'account' };
  const id = await queue({ relevance });
  await dispatcher(new ScriptedTransport([perm()])).dispatchDue();
  const original = await row(id);
  const newId = await resend(pool, id, adminId, clock.now());
  const n = await row(newId);
  assert.equal(n.resend_of, id);
  assert.equal(n.status, 'queued');
  assert.equal(n.attempts, 0);
  assert.equal(n.initiated_by, 'person');
  assert.equal(n.initiated_by_user, adminId);
  assert.equal(n.subject, original.subject);
  assert.equal(n.text_body, original.text_body);
  assert.equal(n.html_body, original.html_body);
  assert.deepEqual(n.attachments, original.attachments);
  assert.deepEqual(n.relevance, relevance);
  assert.equal(n.to_user_id, userId);
  assert.equal(n.to_address, 'person@example.org');
  assert.equal(n.project_id, projectId);
  assert.equal(n.kind, 'notice');
  assert.equal(n.first_failure_at, null);
  assert.equal(n.possible_duplicate, false);
  await dispatcher(new ScriptedTransport()).dispatchDue();
  assert.equal((await row(newId)).status, 'sent');
});

test('only failed or uncertain rows can be resent', { skip: SKIP_NO_DB }, async () => {
  const id = await queue();
  await assert.rejects(resend(pool, id, adminId, clock.now()), NotResendable);
  await dispatcher(new ScriptedTransport()).dispatchDue();
  await assert.rejects(resend(pool, id, adminId, clock.now()), NotResendable);
  await assert.rejects(resend(pool, uuidv7(), adminId, clock.now()), NotResendable);
});
