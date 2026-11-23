import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Pool } from 'pg';
import { uuidv7 } from '../common/uuid7';
import { loadDatabaseConfig } from '../config';
import { runMigrations } from '../db/migrate';
import { runOpsSweep } from '../ops/sweep-ops';
import { SKIP_NO_DB, resetPublicSchema, testDatabaseUrl } from '../testing/db';
import { seedUser } from '../testing/projects';
import { checkReleases, latestCheck, newestAvailable } from './release-check';

const migrationsDir = loadDatabaseConfig({ DATABASE_URL: 'x' }).migrationsDir;
const NOW = new Date('2026-12-01T12:00:00Z');
const DAY = 86_400_000;
const SHA = (n: number): string => n.toString(16).padStart(40, '0');

const tags = (...names: string[]) => names.map((name, i) => ({ name, commit: { sha: SHA(i + 1) } }));
const json = (body: unknown, init: ResponseInit = {}): Response => new Response(JSON.stringify(body), { status: 200, ...init });

describe('release checks', { skip: SKIP_NO_DB }, () => {
  let pool: Pool;
  let a1: string;
  let a2: string;
  before(async () => {
    pool = new Pool({ connectionString: testDatabaseUrl() });
    await resetPublicSchema(pool);
    await runMigrations(pool, migrationsDir);
    a1 = await seedUser(pool, 'rc-a1@example.org', 'enterprise_administrator');
    a2 = await seedUser(pool, 'rc-a2@example.org', 'enterprise_administrator');
  });
  after(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    for (const t of ['notifications', 'email_outbox', 'release_checks', 'releases_seen', 'updater_ticks']) await pool.query(`DELETE FROM ${t}`);
    auditBase = await audits();
  });

  let auditBase = 0;
  const audits = async (): Promise<number> =>
    (await pool.query(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'ops.release_available'`)).rows[0].n;
  const run = (fetchImpl: typeof fetch, at = NOW, running = '1.0.0', trigger: 'daily' | 'manual' = 'daily', actor?: string) =>
    checkReleases({ pool, fetch: fetchImpl, repo: 'owner/name', api: 'http://stand-in.test', runningVersion: running, now: at }, trigger, actor);
  const notices = async () =>
    (await pool.query(`SELECT user_id, summary, link FROM notifications WHERE kind = 'release_available' ORDER BY user_id, summary`)).rows;

  test('records found with the newest valid tag and ignores v1.0.0-rc.1 and nonsense', async () => {
    const f = (async () => json(tags('v1.0.0-rc.1', 'nonsense', 'v1.2.0', 'v1.10.0', 'v1.9.9', 'v01.0.0', 'v1.0.0'))) as typeof fetch;
    const r = await run(f);
    assert.deepEqual(r, { outcome: 'found', newest: { tag: 'v1.10.0', commit: SHA(4) } });
    const row = (await pool.query('SELECT outcome, newest_tag, newest_commit, trigger, failure_code FROM release_checks')).rows;
    assert.deepEqual(row, [{ outcome: 'found', newest_tag: 'v1.10.0', newest_commit: SHA(4), trigger: 'daily', failure_code: null }]);
    assert.equal((await audits()) - auditBase, 1);
  });

  test('none_newer when every tag is at or below the running version', async () => {
    const r = await run((async () => json(tags('v1.0.0', 'v0.9.0', 'v1.0.1-rc.1'))) as typeof fetch, NOW, '1.0.0');
    assert.deepEqual(r, { outcome: 'none_newer' });
    assert.equal((await notices()).length, 0);
    assert.equal((await pool.query('SELECT outcome FROM release_checks')).rows[0].outcome, 'none_newer');
  });

  test('notifies every Active Enterprise Administrator once per tag; a second check finds the same tag with no new notice', async () => {
    const f = (async () => json(tags('v1.1.0'))) as typeof fetch;
    await run(f);
    await run(f, new Date(NOW.getTime() + DAY));
    const rows = await notices();
    assert.deepEqual(rows.map((r) => r.user_id).sort(), [a1, a2].sort());
    assert.equal(rows[0].summary, 'Kainow v1.1.0 is available. Review it on the Operations page.');
    assert.equal(rows[0].link, '#/admin/operations');
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM email_outbox WHERE kind = 'release_available'`)).rows[0].n, 2);
    assert.equal((await audits()) - auditBase, 1);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM release_checks')).rows[0].n, 2);
  });

  test('a newer tag later gives a second notice', async () => {
    await run((async () => json(tags('v1.1.0'))) as typeof fetch);
    await run((async () => json(tags('v1.1.0', 'v1.2.0'))) as typeof fetch, new Date(NOW.getTime() + DAY));
    assert.equal((await notices()).length, 4);
    assert.equal((await newestAvailable(pool, '1.0.0'))?.tag, 'v1.2.0');
    assert.equal(await newestAvailable(pool, '1.2.0'), null);
  });

  test('a 403 with rate-limit headers records rate_limited and notifies nobody', async () => {
    const f = (async () => new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1' } })) as typeof fetch;
    const r = await run(f);
    assert.deepEqual(r, { outcome: 'failed', failureCode: 'rate_limited' });
    assert.equal((await pool.query('SELECT failure_code FROM release_checks')).rows[0].failure_code, 'rate_limited');
    assert.equal((await notices()).length, 0);
  });

  test('a timeout or network error records unreachable; a bad body records bad_response', async () => {
    const r1 = await run((async () => {
      throw new DOMException('timed out', 'TimeoutError');
    }) as typeof fetch);
    assert.deepEqual(r1, { outcome: 'failed', failureCode: 'unreachable' });
    const r2 = await run((async () => new Response('<html>', { status: 200 })) as typeof fetch);
    assert.deepEqual(r2, { outcome: 'failed', failureCode: 'bad_response' });
    const r3 = await run((async () => new Response('{}', { status: 500 })) as typeof fetch);
    assert.deepEqual(r3, { outcome: 'failed', failureCode: 'bad_response' });
    assert.equal((await notices()).length, 0);
  });

  test('the request carries User-Agent kainow-update-check and no other identifying header', async () => {
    let seen: { url: string; headers: Record<string, string>; signal: boolean } | undefined;
    const f = (async (url: string, init?: RequestInit) => {
      seen = { url: String(url), headers: Object.fromEntries(new Headers(init?.headers).entries()), signal: !!init?.signal };
      return json([]);
    }) as unknown as typeof fetch;
    await run(f);
    assert.equal(seen?.url, 'http://stand-in.test/repos/owner/name/tags?per_page=100');
    assert.deepEqual(seen?.headers, { 'user-agent': 'kainow-update-check' });
    assert.ok(seen?.signal, 'has a timeout signal');
  });

  test('runs while protective mode is on', async () => {
    await pool.query(`UPDATE operations_state SET protective = true, reason = 'low_space', since = $1`, [NOW]);
    try {
      const r = await run((async () => json(tags('v1.1.0'))) as typeof fetch);
      assert.equal(r.outcome, 'found');
      assert.equal((await notices()).length, 2);
    } finally {
      await pool.query(`UPDATE operations_state SET protective = false, reason = NULL, since = NULL`);
    }
  });

  test('three days without a successful check makes latestCheck report stale', async () => {
    assert.equal((await latestCheck(pool, NOW)).stale, false, 'nothing yet is not stale');
    const bad = (async () => {
      throw new Error('x');
    }) as typeof fetch;
    await run(bad, new Date(NOW.getTime() - 2 * DAY));
    let l = await latestCheck(pool, NOW);
    assert.equal(l.stale, false);
    assert.equal(l.latest?.failureCode, 'unreachable');
    await run(bad, NOW);
    l = await latestCheck(pool, new Date(NOW.getTime() + 2 * DAY));
    assert.equal(l.stale, true);
    await run((async () => json([])) as typeof fetch, new Date(NOW.getTime() + 2 * DAY));
    l = await latestCheck(pool, new Date(NOW.getTime() + 2 * DAY));
    assert.equal(l.stale, false);
    assert.equal(l.latest?.outcome, 'none_newer');
  });

  test('old release checks and ticks expire with the diagnostic retention; the newest tick and first-found rows stay', async () => {
    const old = new Date(NOW.getTime() - 40 * DAY);
    await run((async () => json(tags('v1.1.0'))) as typeof fetch, old); // first found: stays
    await run((async () => json(tags('v1.1.0'))) as typeof fetch, new Date(old.getTime() + DAY)); // repeat: goes
    await run((async () => {
      throw new Error('x');
    }) as typeof fetch, new Date(old.getTime() + 2 * DAY)); // old failure: goes
    await run((async () => json([])) as typeof fetch, new Date(NOW.getTime() - DAY)); // recent: stays
    for (const d of [41, 40, 39]) {
      await pool.query(`INSERT INTO updater_ticks (id, at, did) VALUES ($1, $2, 'nothing')`, [uuidv7(), new Date(NOW.getTime() - d * DAY)]);
    }
    await runOpsSweep(pool, NOW);
    const checks = (await pool.query('SELECT at, outcome FROM release_checks ORDER BY at')).rows;
    assert.equal(checks.length, 2);
    assert.equal(checks[0].outcome, 'found');
    assert.equal(+checks[0].at, +old);
    const ticks = (await pool.query('SELECT at FROM updater_ticks')).rows;
    assert.equal(ticks.length, 1);
    assert.equal(+ticks[0].at, NOW.getTime() - 39 * DAY);
  });
});
