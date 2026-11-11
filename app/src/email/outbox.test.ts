import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { Pool } from 'pg';
import { loadDatabaseConfig } from '../config';
import { runMigrations } from '../db/migrate';
import { SKIP_NO_DB, resetPublicSchema, testDatabaseUrl } from '../testing/db';
import { seedOrganisation } from '../testing/projects';
import { writeOutbox, type OutboxInput } from './outbox';

const SECRET = 'secret-value-xyz';
const now = new Date(Date.UTC(2026, 10, 10, 1, 0, 0));
let pool: Pool;

const input = (over: Partial<OutboxInput> = {}): OutboxInput => ({
  toUserId: null,
  toAddress: 'person@example.org',
  subject: 'Kainow: 1 item needs your attention in Example Project',
  body: 'Task A is due soon.',
  kind: 'notice',
  projectId: null,
  initiatedBy: 'trigger',
  now,
  ...over,
});

before(async () => {
  if (SKIP_NO_DB) return;
  pool = new Pool({ connectionString: testDatabaseUrl() });
  await resetPublicSchema(pool);
  await runMigrations(pool, loadDatabaseConfig({ DATABASE_URL: testDatabaseUrl() }).migrationsDir);
  await seedOrganisation(pool);
});
after(async () => {
  await pool?.end();
});

test('writeOutbox stores the composed email with the organisation name and a base64 logo', { skip: SKIP_NO_DB }, async () => {
  const id = await writeOutbox(pool, input());
  const row = (await pool.query(`SELECT * FROM email_outbox WHERE id = $1`, [id])).rows[0];
  const org = (await pool.query(`SELECT name FROM organisation WHERE id = 1`)).rows[0].name as string;
  assert.equal(row.status, 'queued');
  assert.equal(row.attempts, 0);
  assert.equal(row.to_address, 'person@example.org');
  assert.equal(row.subject, 'Kainow: 1 item needs your attention in Example Project');
  assert.ok(row.text_body.startsWith(`${org}\n\n`));
  assert.match(row.text_body, /Task A is due soon\./);
  assert.match(row.html_body, /cid:logo/);
  assert.equal(row.created_at.getTime(), now.getTime());
  assert.deepEqual(row.trigger_ids, []);
  assert.equal(row.possible_duplicate, false);

  assert.equal(row.attachments.length, 1);
  const a = row.attachments[0];
  assert.equal(a.cid, 'logo');
  assert.match(a.contentType, /^image\//);
  assert.ok(Buffer.from(a.contentBase64, 'base64').length > 0);
});

test('writeOutbox keeps the links and relevance, and works inside the caller\'s transaction', { skip: SKIP_NO_DB }, async () => {
  const c = await pool.connect();
  let first: string;
  let second: string;
  try {
    await c.query('BEGIN');
    first = await writeOutbox(c, input());
    second = await writeOutbox(c, input({ body: 'b2', replaces: first, relevance: { kind: 'none' } }));
    await c.query('ROLLBACK');
  } finally {
    c.release();
  }
  assert.equal((await pool.query(`SELECT 1 FROM email_outbox WHERE id = ANY($1)`, [[first, second]])).rowCount, 0);

  const id1 = await writeOutbox(pool, input({ initiatedBy: 'person' }));
  const id2 = await writeOutbox(pool, input({ initiatedBy: 'person', replaces: id1, resendOf: id1, relevance: { kind: 'none' } }));
  const row = (await pool.query(`SELECT replaces, resend_of, relevance FROM email_outbox WHERE id = $1`, [id2])).rows[0];
  assert.equal(row.replaces, id1);
  assert.equal(row.resend_of, id1);
  assert.deepEqual(row.relevance, { kind: 'none' });
});

test('no stored column holds the client secret', { skip: SKIP_NO_DB }, async () => {
  const saved = process.env.M365_CLIENT_SECRET;
  process.env.M365_CLIENT_SECRET = SECRET;
  try {
    await writeOutbox(pool, input({ initiatedBy: 'system' }));
  } finally {
    if (saved === undefined) delete process.env.M365_CLIENT_SECRET;
    else process.env.M365_CLIENT_SECRET = saved;
  }
  const rows = (await pool.query(`SELECT row_to_json(e)::text AS j FROM email_outbox e`)).rows;
  assert.ok(rows.length > 0);
  for (const r of rows) assert.ok(!r.j.includes(SECRET));
});
