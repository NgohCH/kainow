import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Pool } from 'pg';
import { uuidv7 } from '../common/uuid7';
import { loadDatabaseConfig } from '../config';
import { runMigrations } from '../db/migrate';
import { SKIP_NO_DB, resetPublicSchema, testDatabaseUrl } from '../testing/db';
import { seedProject, seedUser } from '../testing/projects';
import { NOTE_BAD_RESPONSE, NOTE_RATE_LIMITED, loadCandidates, loadCandidatesForProjects, previousOutcome } from './chooser';

const KEY_ID = 'key-1';

describe('loadCandidates', { skip: SKIP_NO_DB }, () => {
  let pool: Pool;
  let projectId: string;
  let userId: string;
  const migrationsDir = loadDatabaseConfig({ DATABASE_URL: 'x' }).migrationsDir;

  before(() => {
    pool = new Pool({ connectionString: testDatabaseUrl() });
  });
  after(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await resetPublicSchema(pool);
    await runMigrations(pool, migrationsDir);
    userId = await seedUser(pool, 'ann@example.org', 'enterprise_administrator');
    projectId = await seedProject(pool, { members: [{ userId, role: 'pm' }] });
  });

  async function model(o: { state?: string; purposes?: string[]; restricted?: boolean } = {}): Promise<string> {
    const id = uuidv7();
    await pool.query(
      `INSERT INTO ai_models (id, provider, model_id, display_name, input_usd_per_million_micro, cached_input_usd_per_million_micro,
         cache_write_usd_per_million_micro, output_usd_per_million_micro, data_terms, purposes, restricted_ok, state, updated_at)
       VALUES ($1, 'anthropic', $2, 'M', 3000000, 300000, 3750000, 15000000, 'terms', $3, $4, $5, now())`,
      [id, `m-${id}`, o.purposes ?? ['extraction'], o.restricted ?? false, o.state ?? 'approved'],
    );
    return id;
  }
  async function connection(position: number, modelRef: string, o: { state?: string; keyId?: string | null; project?: string } = {}): Promise<string> {
    const id = uuidv7();
    await pool.query(
      `INSERT INTO ai_connections (id, project_id, model_ref, label, position, state, created_at) VALUES ($1, $2, $3, 'L', $4, $5, now())`,
      [id, o.project ?? projectId, modelRef, position, o.state ?? 'ready'],
    );
    if (o.keyId !== null) {
      await pool.query(
        `INSERT INTO ai_connection_keys (id, connection_id, ciphertext, nonce, tag, key_id, saved_at) VALUES ($1, $2, $3, $3, $3, $4, now())`,
        [uuidv7(), id, Buffer.from([0]), o.keyId ?? KEY_ID],
      );
    }
    return id;
  }

  test('skips disabled, key_rejected, withdrawn model, purpose not approved, restricted not approved when carriesRestricted, key unreadable', async () => {
    const good = await model({ restricted: true });
    const ok = await connection(1, good);
    await connection(2, good, { state: 'disabled' });
    await connection(3, good, { state: 'key_rejected' });
    await connection(4, await model({ state: 'withdrawn' }));
    await connection(5, await model({ purposes: ['report_draft'] }));
    await connection(6, await model({ restricted: false }));
    await connection(7, good, { keyId: 'old-key' });
    await connection(8, good, { keyId: null });
    const unchecked = await connection(9, good, { state: 'unchecked' });

    const r = await loadCandidates(pool, projectId, 'extraction', true, KEY_ID);
    assert.equal(r.reason, undefined);
    assert.deepEqual(r.list.map((x) => x.position), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert.deepEqual(r.list.filter((x) => x.eligible).map((x) => x.id), [ok, unchecked]);
    assert.equal(r.list[0].prices.cacheWriteMicroUsdPerMillion, 3_750_000n);
    assert.equal(r.list[0].provider, 'anthropic');
    // Not carrying restricted material, the connection without restricted approval is fine.
    const open = await loadCandidates(pool, projectId, 'extraction', false, KEY_ID);
    assert.deepEqual(open.list.filter((x) => x.eligible).map((x) => x.position), [1, 6, 9]);
  });

  test('no connections → ai_not_set_up', async () => {
    const r = await loadCandidates(pool, projectId, 'extraction', false, KEY_ID);
    assert.deepEqual(r, { list: [], reason: 'ai_not_set_up' });
  });

  test('connections but none eligible → no_eligible_connection', async () => {
    await connection(1, await model(), { state: 'disabled' });
    const r = await loadCandidates(pool, projectId, 'extraction', false, KEY_ID);
    assert.equal(r.reason, 'no_eligible_connection');
    assert.equal(r.list.length, 1);
  });

  test('keyId null → protected_key_missing', async () => {
    await connection(1, await model());
    const r = await loadCandidates(pool, projectId, 'extraction', false, null);
    assert.deepEqual(r, { list: [], reason: 'protected_key_missing' });
  });

  test('many projects at once', async () => {
    const other = await seedProject(pool, { members: [{ userId, role: 'pm' }] });
    const m = await model();
    await connection(1, m);
    await connection(1, m, { project: other, state: 'disabled' });
    const map = await loadCandidatesForProjects(pool, [projectId, other], 'extraction', false, KEY_ID);
    assert.equal(map.get(projectId)?.[0].eligible, true);
    assert.equal(map.get(other)?.[0].eligible, false);
  });
});

describe('previousOutcome', { skip: SKIP_NO_DB }, () => {
  let pool: Pool;
  const migrationsDir = loadDatabaseConfig({ DATABASE_URL: 'x' }).migrationsDir;
  before(() => {
    pool = new Pool({ connectionString: testDatabaseUrl() });
  });
  after(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await resetPublicSchema(pool);
    await runMigrations(pool, migrationsDir);
  });

  async function entry(requestId: string, attemptNo: number, status: string, note: string | null, connectionId: string | null) {
    await pool.query(
      `INSERT INTO ai_spend_entries (id, request_id, attempt_no, created_at, updated_at, status, purpose, model_id,
         input_usd_per_million_micro, cached_input_usd_per_million_micro, output_usd_per_million_micro, myr_per_usd_micro,
         estimate_micro_myr, amount_micro_myr, note, connection_id, ruled)
       VALUES ($1, $2, $3, now(), now(), $4, 'extraction', 'm', 1, 1, 1, 1, 5, $5, $6, $7, false)`,
      [uuidv7(), requestId, attemptNo, status, status === 'released' ? 0 : 5, note, connectionId],
    );
  }
  async function conn(): Promise<string> {
    const userId = await seedUser(pool, `u${uuidv7()}@example.org`);
    const projectId = await seedProject(pool, { members: [{ userId, role: 'pm' }] });
    const mid = uuidv7();
    await pool.query(
      `INSERT INTO ai_models (id, provider, model_id, display_name, input_usd_per_million_micro, cached_input_usd_per_million_micro,
         output_usd_per_million_micro, data_terms, state, updated_at) VALUES ($1, 'openai', $2, 'M', 1, 1, 1, 't', 'approved', now())`,
      [mid, `m-${mid}`],
    );
    const id = uuidv7();
    await pool.query(`INSERT INTO ai_connections (id, project_id, model_ref, label, position, state, created_at) VALUES ($1, $2, $3, 'L', 1, 'ready', now())`, [id, projectId, mid]);
    return id;
  }

  test('reads the highest earlier attempt and decides moveOn', async () => {
    const req = uuidv7();
    const a = await conn();
    const b = await conn();
    assert.equal(await previousOutcome(pool, req, 1), null);
    await entry(req, 1, 'uncertain', null, a);
    assert.deepEqual(await previousOutcome(pool, req, 2), { connectionId: a, moveOn: true });
    await entry(req, 2, 'released', NOTE_RATE_LIMITED, b);
    assert.deepEqual(await previousOutcome(pool, req, 3), { connectionId: b, moveOn: true });
    assert.deepEqual(await previousOutcome(pool, req, 2), { connectionId: a, moveOn: true });
    await entry(req, 3, 'confirmed', NOTE_BAD_RESPONSE, a);
    assert.deepEqual(await previousOutcome(pool, req, 4), { connectionId: a, moveOn: true });
    await entry(req, 4, 'confirmed', null, b);
    assert.deepEqual(await previousOutcome(pool, req, 5), { connectionId: b, moveOn: false });
  });
});
