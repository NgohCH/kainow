import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { Pool } from 'pg';
import { uuidv7 } from '../common/uuid7';
import { loadDatabaseConfig } from '../config';
import { runMigrations } from '../db/migrate';
import { SKIP_NO_DB, resetPublicSchema, testDatabaseUrl } from '../testing/db';
import { STEPS, refreshChecklist } from './checklist';

const migrationsDir = loadDatabaseConfig({ DATABASE_URL: 'x' }).migrationsDir;
const NOW = new Date('2026-12-01T04:00:00Z');
const HOUR = 60 * 60_000;
const at = (ms: number): Date => new Date(NOW.getTime() + ms);

describe('go-live step: Schedule the updater', { skip: SKIP_NO_DB }, () => {
  let pool: Pool;

  before(async () => {
    pool = new Pool({ connectionString: testDatabaseUrl() });
    await resetPublicSchema(pool);
    await runMigrations(pool, migrationsDir);
  });
  after(async () => {
    await pool.end();
  });

  const step = async () => (await pool.query(`SELECT position, ticked_at, ticked_by FROM golive_steps WHERE key = 'updates'`)).rows[0];
  const events = async () =>
    (await pool.query(`SELECT action FROM golive_events WHERE step_key = 'updates' ORDER BY at, id`)).rows.map((r) => r.action);
  const tick = (when: Date, runningTag: string | null) =>
    pool.query(`INSERT INTO updater_ticks (id, at, did, running_tag, key_fingerprint) VALUES ($1, $2, 'nothing', $3, NULL)`, [uuidv7(), when, runningTag]);

  test('the step is the 13th, automatic, and points at INSTALL.md', async () => {
    const def = STEPS.find((s) => s.key === 'updates');
    assert.deepEqual(def, {
      key: 'updates',
      mode: 'auto',
      link: 'INSTALL.md, the section on Updates',
      text: 'Schedule the updater',
      explanation: 'Kainow ticks this once the updater has run in the last 24 hours on a release.',
    });
    assert.equal(STEPS.indexOf(def!), 12);
    assert.equal((await step()).position, 13);
  });

  test('go-live step updates ticks with a recent tick on a release and unticks after 24 h', async () => {
    await refreshChecklist(pool, NOW);
    assert.equal((await step()).ticked_at, null, 'no tick yet');

    await tick(at(-HOUR), null); // the updater ran, but the folder is not on a release
    await refreshChecklist(pool, NOW);
    assert.equal((await step()).ticked_at, null);

    await tick(at(-25 * HOUR), 'v1.0.0'); // on a release, but too long ago
    await refreshChecklist(pool, NOW);
    assert.equal((await step()).ticked_at, null);

    await tick(at(-HOUR), 'v1.0.0');
    await refreshChecklist(pool, NOW);
    const s = await step();
    assert.equal(s.ticked_at?.getTime(), NOW.getTime());
    assert.equal(s.ticked_by, null, 'ticked by Kainow');
    assert.deepEqual(await events(), ['ticked']);

    // The cron line was removed: a day later the step is no longer done.
    await refreshChecklist(pool, at(24 * HOUR));
    assert.equal((await step()).ticked_at, null);
    assert.deepEqual(await events(), ['ticked', 'unticked']);
  });
});
