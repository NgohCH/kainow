import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Pool } from 'pg';
import { uuidv7 } from '../common/uuid7';
import { loadDatabaseConfig } from '../config';
import { runMigrations } from '../db/migrate';
import { SKIP_NO_DB, resetPublicSchema, testDatabaseUrl } from '../testing/db';
import { FakeClock } from '../testing/fakes';
import { seedProject, seedUser } from '../testing/projects';
import type { Prices } from './cost';
import { MVP_SPEND_SETTINGS } from './mvp-settings';
import { SpendService, type ReserveResult, type Scope } from './spend.service';
import { SpendSettingsService, type SpendSettingsInput } from './spend.settings';

const MYR = (n: number): bigint => BigInt(Math.round(n * 1_000_000));
const PRICES: Prices = {
  inputMicroUsdPerMillion: 3_000_000n,
  cachedInputMicroUsdPerMillion: 300_000n,
  cacheWriteMicroUsdPerMillion: 3_750_000n,
  outputMicroUsdPerMillion: 15_000_000n,
  myrPerUsdMicro: 4_100_000n,
};
type Rule = { mode: 'limit'; limitMicroMyr: bigint | null } | { mode: 'not_applied' };
interface ProjectLimitsSet {
  monthly: bigint | null;
  daily?: Rule;
  user?: Rule;
}

describe('project spend scopes', { skip: SKIP_NO_DB }, () => {
  let pool: Pool;
  let clock: FakeClock;
  let spend: SpendService;
  let settings: SpendSettingsService;
  let ann: string;
  let projectId: string;
  let otherProjectId: string;
  let connectionId: string;
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
    clock = new FakeClock(Date.UTC(2026, 10, 9, 2, 0, 0));
    spend = new SpendService(pool, clock.now);
    settings = new SpendSettingsService(pool, clock.now);
    ann = await seedUser(pool, 'ann@example.org');
    projectId = await seedProject(pool, { status: 'active', members: [{ userId: ann, role: 'pm' }] });
    otherProjectId = await seedProject(pool, { status: 'active', members: [{ userId: ann, role: 'pm' }] });
    const modelRef = uuidv7();
    await pool.query(
      `INSERT INTO ai_models (id, provider, model_id, display_name, input_usd_per_million_micro, cached_input_usd_per_million_micro,
                              cache_write_usd_per_million_micro, output_usd_per_million_micro, data_terms, purposes, restricted_ok, state, updated_at)
       VALUES ($1, 'anthropic', 'claude-test', 'Test', 3000000, 300000, 3750000, 15000000, 'terms', '{extraction}', false, 'approved', now())`,
      [modelRef],
    );
    connectionId = uuidv7();
    await pool.query(
      `INSERT INTO ai_connections (id, project_id, model_ref, label, position, state, created_at, created_by)
       VALUES ($1, $2, $3, 'Main', 1, 'ready', now(), $4)`,
      [connectionId, projectId, modelRef, ann],
    );
  });

  /** Generous everywhere unless the test says otherwise: the organisation at MYR 1,000 a month, nothing else applied. */
  const org = (patch: Partial<SpendSettingsInput> = {}): Promise<void> =>
    settings.apply({ ...MVP_SPEND_SETTINGS, monthlyLimitMicroMyr: MYR(1000), ...patch }, ann);

  const setProject = async (limits: ProjectLimitsSet, id: string = projectId): Promise<void> => {
    const daily = limits.daily ?? { mode: 'not_applied' };
    const user = limits.user ?? { mode: 'not_applied' };
    await pool.query(
      `INSERT INTO project_ai_limits (project_id, monthly_limit_micro_myr, daily_mode, daily_limit_micro_myr,
                                      user_monthly_mode, user_monthly_limit_micro_myr, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (project_id) DO UPDATE SET monthly_limit_micro_myr = $2, daily_mode = $3, daily_limit_micro_myr = $4,
                                              user_monthly_mode = $5, user_monthly_limit_micro_myr = $6`,
      [
        id,
        limits.monthly?.toString() ?? null,
        daily.mode,
        daily.mode === 'limit' ? daily.limitMicroMyr?.toString() ?? null : null,
        user.mode,
        user.mode === 'limit' ? user.limitMicroMyr?.toString() ?? null : null,
      ],
    );
  };

  const ask = (estimate: bigint, opts: { actor?: string | null; project?: string; request?: string } = {}): Promise<ReserveResult> =>
    spend.reserve({
      requestId: opts.request ?? uuidv7(),
      attemptNo: 1,
      estimateMicroMyr: estimate,
      purpose: 'extraction',
      actorUserId: opts.actor === undefined ? ann : opts.actor,
      projectId: opts.project ?? projectId,
      connectionId,
      provider: 'anthropic',
      modelId: 'claude-test',
      prices: PRICES,
    });

  const blockedAs = (r: ReserveResult) => {
    assert.equal(r.status, 'blocked', 'expected the reservation to be refused');
    const b = r as Extract<ReserveResult, { status: 'blocked' }>;
    return [b.reason, b.scope];
  };

  const SCOPES: Scope[] = ['monthly', 'daily', 'user_monthly', 'project_monthly', 'project_daily', 'project_user_monthly'];

  /** Configure so that only `scope` has a tight limit; every other level has plenty. */
  async function onlyTight(scope: Scope, limit: bigint | null): Promise<void> {
    const lim = (s: Scope): bigint | null => (s === scope ? limit : MYR(500));
    await org({
      monthlyLimitMicroMyr: lim('monthly'),
      daily: { mode: 'limit', limitMicroMyr: lim('daily') },
      userMonthly: { mode: 'limit', limitMicroMyr: lim('user_monthly') },
    });
    await setProject({
      monthly: lim('project_monthly'),
      daily: { mode: 'limit', limitMicroMyr: lim('project_daily') },
      user: { mode: 'limit', limitMicroMyr: lim('project_user_monthly') },
    });
  }

  for (const scope of SCOPES) {
    test(`${scope} blocks alone: cap_would_be_exceeded`, async () => {
      await onlyTight(scope, MYR(3));
      assert.deepEqual(blockedAs(await ask(MYR(4))), ['cap_would_be_exceeded', scope]);
      assert.equal((await ask(MYR(3))).status, 'reserved', 'an estimate equal to what is left is allowed');
    });
    test(`${scope} blocks alone: a blank or zero limit is no_allowance`, async () => {
      for (const limit of [null, 0n]) {
        await onlyTight(scope, limit);
        assert.deepEqual(blockedAs(await ask(1n)), ['no_allowance', scope]);
      }
    });
  }

  test('no project row blocks as project_not_configured', async () => {
    await org();
    assert.deepEqual(blockedAs(await ask(1n)), ['project_not_configured', 'project_monthly']);
  });

  test('blank and zero project monthly each block with no_allowance', async () => {
    await org();
    for (const monthly of [null, 0n]) {
      await setProject({ monthly });
      assert.deepEqual(blockedAs(await ask(1n)), ['no_allowance', 'project_monthly']);
    }
  });

  test('the tightest wins: organisation left 5, project left 3, estimate 4 is project_monthly', async () => {
    await org({ monthlyLimitMicroMyr: MYR(5) });
    await setProject({ monthly: MYR(3) });
    const r = await ask(MYR(4));
    assert.deepEqual(blockedAs(r), ['cap_would_be_exceeded', 'project_monthly']);
    assert.equal((r as { remainingMicroMyr?: bigint }).remainingMicroMyr, MYR(3));
  });

  test('the organisation is checked first when both would refuse', async () => {
    await org({ monthlyLimitMicroMyr: MYR(2) });
    await setProject({ monthly: MYR(3) });
    assert.deepEqual(blockedAs(await ask(MYR(4))), ['cap_would_be_exceeded', 'monthly']);
  });

  test('an automatic request (no actor) skips both per-person scopes', async () => {
    await org({ userMonthly: { mode: 'limit', limitMicroMyr: MYR(1) } });
    await setProject({ monthly: MYR(100), user: { mode: 'limit', limitMicroMyr: MYR(1) } });
    assert.equal((await ask(MYR(5), { actor: null })).status, 'reserved');
    assert.deepEqual(blockedAs(await ask(MYR(5), { actor: ann })), ['cap_would_be_exceeded', 'user_monthly']);
  });

  test('the per-person project limit counts only that person in that project', async () => {
    const bob = await seedUser(pool, 'bob@example.org');
    await org();
    await setProject({ monthly: MYR(100), user: { mode: 'limit', limitMicroMyr: MYR(5) } });
    await setProject({ monthly: MYR(100) }, otherProjectId);
    assert.equal((await ask(MYR(4), { actor: ann })).status, 'reserved');
    assert.deepEqual(blockedAs(await ask(MYR(2), { actor: ann })), ['cap_would_be_exceeded', 'project_user_monthly']);
    assert.equal((await ask(MYR(5), { actor: bob })).status, 'reserved', 'another person has their own allowance');
  });

  test('entries from before projects (ruled = false) count for the organisation and not for any project', async () => {
    await org({ monthlyLimitMicroMyr: MYR(10) });
    await setProject({ monthly: MYR(10) });
    await pool.query(
      `INSERT INTO ai_spend_entries (id, request_id, attempt_no, created_at, updated_at, status, purpose, model_id,
                                     input_usd_per_million_micro, cached_input_usd_per_million_micro, output_usd_per_million_micro,
                                     myr_per_usd_micro, estimate_micro_myr, amount_micro_myr, ruled)
       VALUES ($1, $2, 1, $3, $3, 'confirmed', 'extraction', 'old', 1, 1, 1, 1, $4, $4, false)`,
      [uuidv7(), uuidv7(), clock.now(), MYR(8).toString()],
    );
    assert.deepEqual(blockedAs(await ask(MYR(3))), ['cap_would_be_exceeded', 'monthly']);
    await org({ monthlyLimitMicroMyr: MYR(100) });
    assert.equal((await ask(MYR(10))).status, 'reserved', 'the project allowance is untouched by the old entry');
    const s = await spend.summary(ann, projectId);
    assert.equal(s.project?.usedMicroMyr, MYR(10));
    assert.equal(s.monthly?.usedMicroMyr, MYR(18));
  });

  test('a reservation writes project, connection, provider, model and the price snapshot from the input', async () => {
    await org();
    await setProject({ monthly: MYR(100) });
    const r = await ask(MYR(1));
    assert.equal(r.status, 'reserved');
    const { rows } = await pool.query(`SELECT * FROM ai_spend_entries WHERE id = $1`, [(r as { entryId: string }).entryId]);
    const e = rows[0];
    assert.equal(e.project_id, projectId);
    assert.equal(e.connection_id, connectionId);
    assert.equal(e.provider, 'anthropic');
    assert.equal(e.model_id, 'claude-test');
    assert.equal(e.ruled, true);
    assert.deepEqual(
      [e.input_usd_per_million_micro, e.cached_input_usd_per_million_micro, e.cache_write_usd_per_million_micro, e.output_usd_per_million_micro, e.myr_per_usd_micro],
      ['3000000', '300000', '3750000', '15000000', '4100000'],
    );
  });

  test('settle prices cache writes from the snapshot and records the tokens', async () => {
    await org();
    await setProject({ monthly: MYR(100) });
    const r = (await ask(MYR(50))) as { entryId: string };
    await spend.settle(r.entryId, { inputTokens: 1_000_000, cachedInputTokens: 0, cacheWriteTokens: 200_000, outputTokens: 0 });
    const { rows } = await pool.query(`SELECT amount_micro_myr::text AS a, cache_write_tokens::text AS t FROM ai_spend_entries WHERE id = $1`, [r.entryId]);
    assert.deepEqual([rows[0].a, rows[0].t], ['12915000', '200000']);
  });

  test('ai.request_blocked audit detail includes projectId and scope', async () => {
    await org();
    await setProject({ monthly: MYR(1) });
    await ask(MYR(2));
    const { rows } = await pool.query(`SELECT detail FROM audit_events WHERE action = 'ai.request_blocked'`);
    assert.equal(rows[0].detail.projectId, projectId);
    assert.equal(rows[0].detail.scope, 'project_monthly');
    assert.equal(rows[0].detail.reason, 'cap_would_be_exceeded');
  });

  test('summary adds the project, its daily and the caller\'s own project figures', async () => {
    await org();
    await setProject({ monthly: MYR(10), daily: { mode: 'limit', limitMicroMyr: MYR(4) }, user: { mode: 'limit', limitMicroMyr: MYR(2) } });
    await ask(MYR(1));
    const s = await spend.summary(ann, projectId);
    assert.deepEqual([s.project?.limitMicroMyr, s.project?.usedMicroMyr, s.project?.remainingMicroMyr], [MYR(10), MYR(1), MYR(9)]);
    assert.deepEqual([s.projectDaily?.limitMicroMyr, s.projectDaily?.remainingMicroMyr], [MYR(4), MYR(3)]);
    assert.deepEqual([s.projectMine?.limitMicroMyr, s.projectMine?.remainingMicroMyr], [MYR(2), MYR(1)]);
    const none = await spend.summary(ann);
    assert.deepEqual([none.project, none.projectDaily, none.projectMine], [null, null, null]);
  });
});
