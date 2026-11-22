import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { uuidv7 } from '../common/uuid7';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedUser } from '../testing/projects';
import { shortTime } from './operations.service';
import { PROTECTIVE_BANNER } from './protective';
import { OperationsState } from './state';

const GB = 1024 ** 3;

test('banner times use fixed month names in UTC+8, never a locale short month such as "Sept"', () => {
  assert.equal(shortTime(new Date('2026-09-21T18:04:00Z')), '22 Sep 02:04');
  assert.equal(shortTime(new Date('2026-11-20T18:04:00Z')), '21 Nov 02:04');
  assert.equal(shortTime(new Date('2026-06-01T00:00:00Z')), '1 Jun 08:00');
});

describe('operations API', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let admin: Client;
  let member: Client;
  let createdJobTable = false;

  beforeEach(async () => {
    t = await startTestApp();
    await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    await seedUser(t.pool, 'member@example.org');
    admin = await t.signIn('admin@example.org');
    member = await t.signIn('member@example.org');
  });
  afterEach(async () => {
    if (createdJobTable) await t.pool.query(`DROP TABLE pgboss.job`);
    createdJobTable = false;
    await t?.close();
  });

  const hoursAgo = (h: number) => new Date(t.clock.now().getTime() - h * 3_600_000);
  async function run(o: { id?: string; startedAt: Date; finishedAt?: Date | null; outcome?: string; failureCode?: string | null; folder?: string | null; keyId?: string | null; bytes?: number | null; kind?: string }) {
    const id = o.id ?? uuidv7();
    await t.pool.query(
      `INSERT INTO backup_runs (id, kind, started_at, finished_at, outcome, failure_code, set_name, folder_label, key_id, database_bytes, files_total, files_new, source_area)
       VALUES ($1, $2, $3, $4, $5, $6, 'set-1', $7, $8, $9, 3, 1, 'not_in_use')`,
      [id, o.kind ?? 'daily', o.startedAt, o.finishedAt === undefined ? new Date(o.startedAt.getTime() + 600_000) : o.finishedAt, o.outcome ?? 'succeeded', o.failureCode ?? null, o.folder === undefined ? 'backup-disk-1' : o.folder, o.keyId === undefined ? 'key-aa11' : o.keyId, o.bytes ?? 1_000_000],
    );
    return id;
  }
  async function drill(o: { startedAt: Date; outcome?: string; checks?: unknown; failureCode?: string | null; kept?: string | null }) {
    const id = uuidv7();
    await t.pool.query(
      `INSERT INTO restore_drills (id, set_name, started_at, finished_at, outcome, duration_seconds, checks, failure_code, kept_database, key_id, folder_label)
       VALUES ($1, 'set-1', $2, $2, $3, 120, $4, $5, $6, 'key-aa11', 'backup-disk-1')`,
      [id, o.startedAt, o.outcome ?? 'passed', JSON.stringify(o.checks ?? []), o.failureCode ?? null, o.kept ?? null],
    );
    return id;
  }
  const reading = (location: string, usedPct: number, at: Date = t.clock.now(), totalGb = 100) =>
    t.pool.query(
      `INSERT INTO storage_readings (id, at, location, total_bytes, free_bytes, used_bytes, unavailable) VALUES ($1, $2, $3, $4, $5, $6, false)`,
      [uuidv7(), at, location, totalGb * GB, Math.round(totalGb * GB * (1 - usedPct / 100)), Math.round(totalGb * GB * (usedPct / 100))],
    );
  const protective = async (on: boolean) => {
    await t.pool.query(`UPDATE operations_state SET protective = $1, reason = $2, since = $3`, [on, on ? 'low_space' : null, on ? t.clock.now() : null]);
    t.app.get(OperationsState).invalidate();
  };

  test('overview: shape, 30 runs newest first with a tie-break on id, no paths or key material', async () => {
    const same = hoursAgo(2);
    const ids = [uuidv7(), uuidv7(), uuidv7()].sort();
    for (const id of ids) await run({ id, startedAt: same });
    for (let i = 0; i < 40; i++) await run({ startedAt: hoursAgo(10 + i) });
    await run({ startedAt: hoursAgo(5), outcome: 'failed', failureCode: 'no_space', finishedAt: hoursAgo(5) });
    await reading('database_disk', 60);
    await reading('backup_disk', 85);
    await t.pool.query(`INSERT INTO storage_daily (day, location, max_used_bytes, min_free_bytes, total_bytes) VALUES ('2026-11-08', 'database_disk', 1, 2, 3), ('2026-01-01', 'database_disk', 1, 2, 3)`);
    const r = await admin.request('GET', '/admin/operations');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const b = r.body;
    assert.equal(b.backups.runs.length, 30);
    // started_at DESC, id DESC: the three tied runs come first among themselves in descending id order.
    const tied = b.backups.runs.filter((x: any) => x.startedAt === same.toISOString()).map((x: any) => x.id);
    assert.deepEqual(tied, [...ids].sort().reverse());
    const times = b.backups.runs.map((x: any) => Date.parse(x.startedAt));
    assert.deepEqual(times, [...times].sort((x, y) => y - x));
    assert.equal(b.backups.status, 'healthy');
    assert.equal(b.backups.retentionDays, 30);
    assert.equal(b.backups.folderLabel, 'backup-disk-1');
    assert.equal(b.backups.keyId, 'key-aa11');
    assert.equal(b.backups.drillAgain, null);
    assert.equal(b.backups.runs[0].databaseEncryptedBytes, 1_000_000);
    assert.ok(!('databaseBytes' in b.backups.runs[0]));
    const failed = b.backups.runs.find((x: any) => x.outcome === 'failed');
    assert.equal(failed.failureText, 'The backup folder has run out of space.');
    assert.deepEqual(b.storage.locations.map((l: any) => [l.location, l.level]), [['database_disk', 'normal'], ['backup_disk', 'warning']]);
    assert.equal(b.storage.safeFloorGb, 5);
    assert.deepEqual(b.growth.map((g: any) => g.day), ['2026-11-08'], 'only the last 30 days');
    assert.deepEqual(b.protective, { on: false, reason: null, since: null, setTime: null, setName: null, text: PROTECTIVE_BANNER });
    assert.equal(b.health.database, 'up');
    assert.equal(b.health.migrationsCurrent, true);
    assert.deepEqual(b.health.queues, []);
    assert.deepEqual(b.drills, { last: null, earlier: [], kept: [], stray: [] });
  });

  test('drills: last, ten earlier, checks shown for a failed drill without a failure code, kept databases listed', async () => {
    for (let i = 0; i < 13; i++) await drill({ startedAt: hoursAgo(100 + i) });
    const checks = [{ name: 'restore', result: 'passed' }, { name: 'row_counts', result: 'failed', detail: 'projects differs' }];
    const failedId = await drill({ startedAt: hoursAgo(1), outcome: 'failed', checks, failureCode: null, kept: 'kainow_drill_abc123' });
    const r = await admin.request('GET', '/admin/operations');
    assert.equal(r.body.drills.last.id, failedId);
    assert.equal(r.body.drills.last.failureCode, null);
    assert.deepEqual(r.body.drills.last.checks, checks);
    assert.equal(r.body.drills.earlier.length, 10);
    assert.deepEqual(r.body.drills.kept, [{ name: 'kainow_drill_abc123', drillId: failedId }]);
    assert.ok(!r.body.drills.stray.includes('kainow_drill_abc123'));
  });

  test('a drill database on the server that no row names is listed as stray, read-only', async () => {
    const name = `kainow_drill_stray${Date.now().toString(36)}`;
    await t.pool.query(`CREATE DATABASE ${name}`);
    try {
      const r = await admin.request('GET', '/admin/operations');
      assert.ok(r.body.drills.stray.includes(name), JSON.stringify(r.body.drills));
    } finally {
      await t.pool.query(`DROP DATABASE ${name}`);
    }
  });

  test('health reads the queue table read-only', async () => {
    await t.pool.query(`CREATE SCHEMA IF NOT EXISTS pgboss`);
    await t.pool.query(`CREATE TABLE pgboss.job (name text NOT NULL, state text NOT NULL, created_on timestamptz NOT NULL DEFAULT now(), start_after timestamptz NOT NULL DEFAULT now(), completed_on timestamptz)`);
    createdJobTable = true;
    const now = t.clock.now();
    await t.pool.query(`INSERT INTO pgboss.job (name, state, completed_on) VALUES ('email', 'created', NULL), ('email', 'active', NULL), ('email', 'failed', $1), ('email', 'failed', $2)`, [hoursAgo(1), hoursAgo(30)]);
    assert.ok(now);
    const r = await admin.request('GET', '/admin/operations');
    assert.deepEqual(r.body.health.queues, [{ name: 'email', queued: 1, active: 1, failed24h: 1 }]);
  });

  test('a member gets 403 on the overview, the settings and resume', async () => {
    assert.equal((await member.request('GET', '/admin/operations')).status, 403);
    assert.equal((await member.request('GET', '/admin/operations/settings')).status, 403);
    assert.equal((await member.request('PUT', '/admin/operations/settings', { safeFloorGb: 6, reason: 'Bigger disk' })).status, 403);
    assert.equal((await member.request('POST', '/admin/operations/resume', { reason: 'Cleared space' })).status, 403);
  });

  test('settings: GET shows bounds and the critical-above-warning rule; PUT needs a reason and records history', async () => {
    const g = await admin.request('GET', '/admin/operations/settings');
    assert.equal(g.status, 200);
    assert.equal(g.body.settings.storageWarningPct, 80);
    assert.equal(g.body.bounds.storageCriticalPct.min, 51);
    assert.equal(g.body.rules.criticalAboveWarning, true);
    assert.equal(g.body.rules.storageCriticalEffectiveMin, 81);
    assert.equal((await admin.request('PUT', '/admin/operations/settings', { safeFloorGb: 6 })).status, 400);
    assert.equal((await admin.request('PUT', '/admin/operations/settings', { safeFloorGb: 6, reason: '   ' })).status, 400);
    assert.equal((await admin.request('PUT', '/admin/operations/settings', { storageCriticalPct: 70, reason: 'Too low' })).status, 400);
    const p = await admin.request('PUT', '/admin/operations/settings', { safeFloorGb: 6, reason: 'Bigger disk' });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.equal(p.body.settings.safeFloorGb, 6);
    assert.equal(p.body.changes.length, 1);
    assert.equal(p.body.changes[0].previous.safeFloorGb, 5);
    assert.equal(p.body.changes[0].next.safeFloorGb, 6);
    // R23: with a fresh database-disk reading of 10 GB free, a floor of 10 GB is refused with the fixed text.
    await reading('database_disk', 90);
    const high = await admin.request('PUT', '/admin/operations/settings', { safeFloorGb: 10, reason: 'Far too high' });
    assert.equal(high.status, 400);
    assert.match(JSON.stringify(high.body), /The safe floor must be lower than the free space on the database disk now/);
    assert.equal((await admin.request('PUT', '/admin/operations/settings', { safeFloorGb: 9, reason: 'Just below' })).status, 200);
  });

  test('banner: a member sees protective mode only; an administrator also sees backup trouble', async () => {
    await run({ startedAt: hoursAgo(30) });
    await protective(true);
    const m = await member.request('GET', '/operations/banner');
    assert.equal(m.status, 200);
    assert.deepEqual(m.body, { protective: true, scheduled: null });
    const a = await admin.request('GET', '/operations/banner');
    assert.equal(a.body.protective, true);
    assert.equal(a.body.admin.backups, 'target_exceeded');
    assert.match(a.body.admin.text, /^Backups: 24-hour recovery target exceeded\. Last successful backup \d{1,2} [A-Z][a-z]{2} \d\d:\d\d\./);
    assert.equal(a.body.admin.link, '#/admin/operations');
    await protective(false);
    assert.deepEqual((await member.request('GET', '/operations/banner')).body, { protective: false, scheduled: null });
  });

  test('banner: an administrator with healthy backups and normal storage has empty text; critical storage shows', async () => {
    await run({ startedAt: hoursAgo(3) });
    await reading('database_disk', 50);
    await reading('backup_disk', 50);
    let a = await admin.request('GET', '/operations/banner');
    assert.deepEqual(a.body.admin, { backups: 'healthy', storage: 'normal', text: '', link: '#/admin/operations', recovery: null });
    await reading('backup_disk', 95);
    a = await admin.request('GET', '/operations/banner');
    assert.equal(a.body.admin.storage, 'critical');
    assert.match(a.body.admin.text, /Storage: a disk is at its critical level\./);
  });

  /** An update row as the updater leaves it (approved by the administrator). */
  async function update(o: { state: string; startsAt: Date; approvedAt?: Date; toVersion?: string }) {
    const approver = (await t.pool.query(`SELECT id FROM users WHERE email = 'admin@example.org'`)).rows[0].id;
    const v = o.toVersion ?? '1.0.0';
    await t.pool.query(
      `INSERT INTO updates (id, from_version, to_version, tag, commit, state, starts_at, expected_minutes, approved_by, approved_at, reason)
       VALUES ($1, '0.0.0', $2, $3, $4, $5, $6, 30, $7, $8, 'Routine update')`,
      [uuidv7(), v, `v${v}`, 'c'.repeat(40), o.state, o.startsAt, approver, o.approvedAt ?? hoursAgo(1)],
    );
  }
  const check = (at: Date, outcome: 'found' | 'none_newer' | 'failed', tag: string | null = null) =>
    t.pool.query(`INSERT INTO release_checks (id, at, trigger, outcome, failure_code, newest_tag, newest_commit) VALUES ($1, $2, 'daily', $3, $4, $5, $6)`, [
      uuidv7(),
      at,
      outcome,
      outcome === 'failed' ? 'unreachable' : null,
      tag,
      tag ? 'c'.repeat(40) : null,
    ]);

  test('status strip Updates item: up to date, available, scheduled, failed, not checked for 3 days', async () => {
    const strip = async () => (await admin.request('GET', '/admin/operations')).body.updates;
    // No check and no update yet.
    assert.deepEqual(await strip(), { latestState: null, latestToVersion: null, startsAt: null, available: null, lastCheckAt: null, stale: false });
    await check(hoursAgo(2), 'none_newer');
    let u = await strip();
    assert.equal(u.available, null);
    assert.equal(u.stale, false);
    assert.equal(u.lastCheckAt, hoursAgo(2).toISOString());
    // A newer release was found.
    await check(hoursAgo(1), 'found', 'v1.0.0');
    await t.pool.query(`INSERT INTO releases_seen (tag, commit, first_seen_at, notified_at) VALUES ('v1.0.0', $1, $2, $2)`, ['c'.repeat(40), hoursAgo(1)]);
    u = await strip();
    assert.equal(u.available, 'v1.0.0');
    // Approved: scheduled, with its start.
    const startsAt = new Date(t.clock.now().getTime() + 48 * 3_600_000);
    await update({ state: 'approved', startsAt });
    u = await strip();
    assert.equal(u.latestState, 'approved');
    assert.equal(u.startsAt, startsAt.toISOString());
    // Failed: the start is no longer reported, the state is.
    await t.pool.query(`UPDATE updates SET state = 'failed_before_install', failure_code = 'build_failed', finished_at = $1`, [t.clock.now()]);
    u = await strip();
    assert.equal(u.latestState, 'failed_before_install');
    assert.equal(u.latestToVersion, '1.0.0');
    assert.equal(u.startsAt, null);
    // Three days of failed checks after the last success.
    await t.pool.query(`DELETE FROM release_checks`);
    await check(hoursAgo(80), 'none_newer');
    await check(hoursAgo(1), 'failed');
    assert.equal((await strip()).stale, true);
  });

  test('banner: the scheduled update for everyone; the failed-update warning for an administrator only', async () => {
    const startsAt = new Date(t.clock.now().getTime() + 48 * 3_600_000);
    await update({ state: 'approved', startsAt });
    const m = await member.request('GET', '/operations/banner');
    assert.equal(m.body.scheduled.startsAt, startsAt.toISOString());
    assert.equal(m.body.scheduled.expectedMinutes, 30);
    assert.match(m.body.scheduled.text, /^Kainow will be unavailable on [A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2} from \d\d:\d\d for about 30 minutes for an update\.$/);
    assert.equal(m.body.admin, undefined);
    await t.pool.query(`UPDATE updates SET state = 'failed_after_migration', failure_code = 'migration_failed', finished_at = $1`, [t.clock.now()]);
    const a = await admin.request('GET', '/operations/banner');
    assert.equal(a.body.scheduled, null);
    assert.equal(
      a.body.admin.recovery,
      "The update to v1.0.0 failed. Kainow is on the notice page for everyone else; the server operator must run the recovery command (INSTALL.md, 'After a failed update').",
    );
    assert.deepEqual((await member.request('GET', '/operations/banner')).body, { protective: false, scheduled: null });
  });

  test('analytics: updates by outcome for the period, and the Updates item in the status', async () => {
    await update({ state: 'succeeded', startsAt: hoursAgo(50), approvedAt: hoursAgo(80), toVersion: '0.1.0' });
    await update({ state: 'failed_before_install', startsAt: hoursAgo(30), approvedAt: hoursAgo(70), toVersion: '0.2.0' });
    await update({ state: 'cancelled', startsAt: hoursAgo(20), approvedAt: hoursAgo(60), toVersion: '0.2.0' });
    await update({ state: 'recovered', startsAt: hoursAgo(10), approvedAt: hoursAgo(50), toVersion: '0.3.0' });
    await update({ state: 'succeeded', startsAt: hoursAgo(24 * 200), approvedAt: hoursAgo(24 * 201), toVersion: '0.0.1' }); // outside the period
    const r = await admin.request('GET', '/admin/analytics?panel=operations');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.data.period.updates, { total: 4, succeeded: 1, failed: 2, cancelled: 1, open: 0 });
    assert.equal(r.body.data.status.updates.latestState, 'recovered'); // newest approval first
    const csv = await admin.raw('GET', '/admin/analytics/export?panel=operations');
    assert.match(csv.text, /Updates in the period.*Failed.*2/);
    assert.match(csv.text, /Updates.*Latest update/);
  });

  test('banner needs a session', async () => {
    assert.equal((await t.anonymous('GET', '/operations/banner')).status, 401);
  });

  test('public state answers before sign-in', async () => {
    const off = await t.anonymous('GET', '/operations/public-state');
    assert.equal(off.status, 200);
    assert.deepEqual(off.body, { protective: false });
    await protective(true);
    assert.deepEqual((await t.anonymous('GET', '/operations/public-state')).body, { protective: true });
  });

  test('resume: non-blank reason; 409 naming the failing checks; 200 when they pass and this process sees it at once', async () => {
    await protective(true);
    assert.equal((await admin.request('POST', '/admin/operations/resume', {})).status, 400);
    assert.equal((await admin.request('POST', '/admin/operations/resume', { reason: '  ' })).status, 400);
    // No reading: the reading and space checks fail.
    const no = await admin.request('POST', '/admin/operations/resume', { reason: 'Cleared space' });
    assert.equal(no.status, 409, JSON.stringify(no.body));
    assert.equal(no.body.code, 'resume_checks_failed');
    assert.deepEqual(no.body.failing, ['reading_fresh', 'space_above_floor']);
    assert.equal((await t.pool.query(`SELECT protective FROM operations_state`)).rows[0].protective, true);
    // A backup running fails its check too.
    await reading('database_disk', 50);
    await run({ startedAt: hoursAgo(1), outcome: 'running', finishedAt: null });
    const busy = await admin.request('POST', '/admin/operations/resume', { reason: 'Cleared space' });
    assert.equal(busy.status, 409);
    assert.deepEqual(busy.body.failing, ['no_backup_running']);
    await t.pool.query(`UPDATE backup_runs SET outcome = 'failed', finished_at = now()`);
    const ok = await admin.request('POST', '/admin/operations/resume', { reason: 'Cleared space' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.resumed, true);
    // Seen at once: a write is not refused with 503.
    assert.notEqual((await admin.request('PUT', '/admin/operations/settings', { safeFloorGb: 7, reason: 'Check' })).status, 503);
    assert.equal((await t.anonymous('GET', '/operations/public-state')).body.protective, false);
  });

  test('resume stays reachable while protective mode is on (the other settings change is refused)', async () => {
    await protective(true);
    const refused = await admin.request('PUT', '/admin/operations/settings', { safeFloorGb: 7, reason: 'Check' });
    assert.equal(refused.status, 503);
    assert.notEqual((await admin.request('POST', '/admin/operations/resume', { reason: 'Cleared space' })).status, 503);
  });

  test('analytics: the operations panel answers for an administrator and exports as CSV; a member gets 403', async () => {
    await run({ startedAt: hoursAgo(3) });
    await run({ startedAt: hoursAgo(30), outcome: 'failed', failureCode: 'dump_failed' });
    await drill({ startedAt: hoursAgo(5) });
    await reading('database_disk', 40);
    const r = await admin.request('GET', '/admin/analytics?panel=operations');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.panel, 'operations');
    assert.equal(r.body.data.status.backups.status, 'healthy');
    assert.ok(!('runs' in r.body.data.status.backups), 'no run tables in the panel');
    assert.deepEqual(r.body.data.period.backups, { total: 2, succeeded: 1, failed: 1 });
    assert.deepEqual(r.body.data.period.drills, { total: 1, passed: 1, failed: 0 });
    assert.equal((await member.request('GET', '/admin/analytics?panel=operations')).status, 403);
    const csv = await admin.raw('GET', '/admin/analytics/export?panel=operations');
    assert.equal(csv.status, 200, csv.text);
    assert.match(csv.text, /Panel,Operations|"Panel","Operations"|# Panel: Operations/);
    assert.match(csv.text, /Backups.*Status.*Healthy/);
    assert.match(csv.text, /Backups in the period.*Failed.*1/);
  });

  test('protective after a restore shows the set time and name from the state detail', async () => {
    await t.pool.query(
      `UPDATE operations_state SET protective = true, reason = 'restored_from_backup', since = $1, detail = $2`,
      [t.clock.now(), JSON.stringify({ setTime: '2026-11-08T01:00:00.000Z', setName: 'set-2026-11-08' })],
    );
    t.app.get(OperationsState).invalidate();
    const r = await admin.request('GET', '/admin/operations');
    assert.equal(r.body.protective.on, true);
    assert.equal(r.body.protective.reason, 'restored_from_backup');
    assert.equal(r.body.protective.setTime, '2026-11-08T01:00:00.000Z');
    assert.equal(r.body.protective.setName, 'set-2026-11-08');
    await protective(false);
    const off = await admin.request('GET', '/admin/operations');
    assert.equal(off.body.protective.setTime, null);
  });

  test('a running drill database is not listed as stray', async () => {
    const id = uuidv7();
    const name = `kainow_drill_${id.replace(/-/g, '').slice(-12)}`;
    await t.pool.query(`INSERT INTO restore_drills (id, started_at, outcome) VALUES ($1, $2, 'running')`, [id, t.clock.now()]);
    await t.pool.query(`CREATE DATABASE ${name}`);
    try {
      const r = await admin.request('GET', '/admin/operations');
      assert.ok(!r.body.drills.stray.includes(name), JSON.stringify(r.body.drills));
    } finally {
      await t.pool.query(`DROP DATABASE ${name}`);
    }
  });

  test('resume-checks: a member gets 403; an administrator gets each check and whether the mode is on; nothing changes', async () => {
    assert.equal((await member.request('GET', '/admin/operations/resume-checks')).status, 403);
    await protective(true);
    const r = await admin.request('GET', '/admin/operations/resume-checks');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.protective, true);
    assert.deepEqual(
      r.body.checks,
      [
        { name: 'reading_fresh', passed: false },
        { name: 'space_above_floor', passed: false },
        { name: 'database', passed: true },
        { name: 'migrations_current', passed: true },
        { name: 'no_backup_running', passed: true },
      ],
    );
    await reading('database_disk', 50);
    const ok = await admin.request('GET', '/admin/operations/resume-checks');
    assert.ok(ok.body.checks.every((c: any) => c.passed), JSON.stringify(ok.body));
    assert.equal((await t.pool.query(`SELECT protective FROM operations_state`)).rows[0].protective, true);
  });

  test('analytics growth follows the chosen period, not a fixed 30 days', async () => {
    // Clock: 2026-11-09 UTC+8. last_4w covers 28 days; last_12w covers about 84.
    await t.pool.query(
      `INSERT INTO storage_daily (day, location, max_used_bytes, min_free_bytes, total_bytes) VALUES
         ('2026-11-08', 'database_disk', 1, 2, 3), ('2026-10-01', 'database_disk', 1, 2, 3), ('2026-09-07', 'database_disk', 1, 2, 3)`,
    );
    const days = async (q: string) => (await admin.request('GET', `/admin/analytics?panel=operations${q}`)).body.data.status.growth.map((g: any) => g.day);
    assert.deepEqual(await days('&period=last_4w'), ['2026-11-08']);
    assert.deepEqual(await days('&period=last_12w'), ['2026-09-07', '2026-10-01', '2026-11-08']);
    const page = (await admin.request('GET', '/admin/operations')).body.growth.map((g: any) => g.day);
    assert.deepEqual(page, ['2026-11-08'], 'the Operations page keeps 30 days');
  });

  test('no container path, host path or key material in any response', async () => {
    // The label the backup command records when KAINOW_BACKUP_DIR_LABEL is not set is the container path: never shown.
    await run({ startedAt: hoursAgo(3), folder: '/backups', keyId: 'key-aa11' });
    await reading('database_disk', 40);
    await drill({ startedAt: hoursAgo(5) });
    await protective(true);
    const texts: string[] = [];
    for (const path of ['/admin/operations', '/admin/operations/settings', '/operations/banner', '/admin/analytics?panel=operations']) {
      const r = await admin.raw('GET', path);
      assert.equal(r.status, 200, path);
      texts.push(r.text);
    }
    texts.push((await t.anonymous('GET', '/operations/public-state')).body ? JSON.stringify((await t.anonymous('GET', '/operations/public-state')).body) : '');
    const csv = await admin.raw('GET', '/admin/analytics/export?panel=operations');
    texts.push(csv.text);
    for (const text of texts) {
      assert.ok(!text.includes('/backups'), 'no container path');
      assert.ok(!/[0-9a-f]{64}/i.test(text), 'no 64-hex string (key material, digests)');
      assert.ok(!/postgres(ql)?:\/\//.test(text), 'no connection string');
    }
    const view = await admin.request('GET', '/admin/operations');
    assert.equal(view.body.backups.folderLabel, null);
    assert.equal(view.body.backups.keyId, 'key-aa11');
  });
});
