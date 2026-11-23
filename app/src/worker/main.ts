import { Pool } from 'pg';
import { AnalysisRunner } from '../analysis/analysis-runner';
import { MinutesRunner } from '../analysis/minutes-runner';
import { AnalysisTick } from '../analysis/tick';
import { bossAnalysisQueue } from '../analysis/queue';
import { AssistRunner } from '../assist/assist-runner';
import { ExtractionRunner } from '../extraction/runner';
import { type ModelClientFactory, realClientFactory } from '../ai/client-factory';
import { loadTestClientFactory } from '../loadtest/fake-ai';
import { assertLoadDatabase } from '../loadtest/guard';
import { SpendService } from '../spend/spend.service';
import { type AppConfig, loadWorkerConfig } from '../config';
import { AI_CONCURRENCY, registerAiWorker } from './ai-worker';
import { EmailDispatcher } from '../email/dispatcher';
import { createTransport } from '../email/transport';
import type { EmailNudge } from '../email/nudge';
import { Sweep } from '../notifications/sweep';
import { Logger } from '@nestjs/common';
import { AudienceService } from '../discussion/audience.service';
import { ProjectAccess } from '../projects/access.service';
import { CasesService, cleanWaitingCases } from '../quarantine/cases.service';
import type { PgBoss } from 'pg-boss';
import { reportKeyStatus } from '../quarantine/key-status';
import { loadRequiredProtectedKey } from '../quarantine/protected-key';
import { OperationsState } from '../ops/state';
import { runOpsSweep } from '../ops/sweep-ops';
import { runningVersion } from '../common/version';
import { checkReleases } from '../updater/release-check';
import { QUEUES, startQueues } from './queues';
import { registerSchedules } from './schedules';
import { DbStorageConnectorFactory } from '../storage/connector-factory';
import { type StorageDeps, runStorageDaily } from '../storage/jobs';
import { makeStorageNotify } from '../storage/notices';
import { sendStorageOutbox } from '../storage/outbox';
import { registerStorageWorker } from '../storage/storage-worker';
// Every job handler, final-failure hook and daily task the worker runs registers itself on import (one list, tested).
import './registrations';

async function main(): Promise<void> {
  const config = loadWorkerConfig();
  const pool = new Pool({ connectionString: config.databaseUrl });
  const clock = () => new Date();
  const spend = new SpendService(pool, clock);
  // The protected key (history spec 7.3): held in memory only; without it, waiting quarantine cases stay waiting.
  const keyLog = new Logger('ProtectedKey');
  const key = loadRequiredProtectedKey(config.protectedKeyFile, config.requireProtectedKey, (m) => keyLog.warn(m));
  // Which key the worker started with, for the go-live checklist (second review, G05). Never fatal.
  await reportKeyStatus(pool, 'worker', key?.id ?? null).catch(() => keyLog.warn('could not record whether the protected key is loaded'));
  // The email nudge needs the queue, which starts later; a nudge before then is simply lost and the next tick catches it.
  let boss: PgBoss | undefined;
  const nudge: EmailNudge = {
    async nudge() {
      try {
        await boss?.send(QUEUES.email, { nudge: true }, { singletonSeconds: 5 });
      } catch {
        console.error('Could not nudge the email dispatch.');
      }
    },
  };
  // Kainow's own reports of a secret found in stored text (history spec 7.1): the runners open the case themselves.
  const access = new ProjectAccess(pool, clock);
  const quarantine = new CasesService(pool, clock, key, { appUrl: config.appUrl } as AppConfig, nudge, access, new AudienceService(pool, clock, access));
  // A load-test installation only (KAINOW_LOAD_TEST=1, docs/operations/load-test.md): AI calls go to the local fake
  // provider, and the worker refuses to start on a database that is not the seeded load-test organisation.
  const loadTest = loadTestClientFactory(process.env);
  if (loadTest) {
    await assertLoadDatabase(pool);
    console.warn('LOAD TEST: every AI call goes to the local fake provider named in KAINOW_LOAD_TEST_AI_URL.');
  }
  const factory: ModelClientFactory = loadTest ?? realClientFactory;
  // No model client is built here: each attempt builds the client for its project connection, opening that connection's
  // key with the protected key (spec 6.3). Without the protected key every AI request ends blocked protected_key_missing.
  const extraction = new ExtractionRunner({
    pool,
    spend,
    factory,
    key,
    clock,
    log: (m) => console.error(m),
    quarantine,
  });
  const minutes = new MinutesRunner({ pool, spend, factory, key, clock, quarantine, log: (m) => console.error(m) });
  const analysisRunner = new AnalysisRunner({ pool, clock, extraction, minutes, quarantine, log: (m) => console.error(m) });
  const assist = new AssistRunner({ pool, spend, factory, key, clock, quarantine, log: (m) => console.error(m) });

  // Protective read-only mode (spec 7.3): every handler asks first; the answer is cached for 5 s, so Resume in the API
  // is seen here within 5 s.
  const operations = new OperationsState(pool);
  boss = await startQueues(config.databaseUrl, undefined, { schedule: true });
  await registerAiWorker(boss, { extraction, analysis: analysisRunner, assist }, pool, AI_CONCURRENCY, operations);

  // The sweep nudges the dispatcher through the same boss instance; a lost nudge is caught by the next tick.
  const log = { warn: (m: string) => console.warn(m) };
  const sweep = new Sweep({ pool, clock, appUrl: config.appUrl, nudge, log });
  const dispatcher = new EmailDispatcher({
    pool,
    transport: createTransport(config.email, clock),
    from: config.email.provider === 'log' ? 'Kainow <no-reply@localhost>' : config.email.from,
    clock,
    log,
  });
  const analysis = new AnalysisTick({ pool, clock, queue: bossAnalysisQueue(boss), spend: new SpendService(pool, clock), key });
  const quarantineLog = new Logger('Quarantine');
  const quarantineJob = key ? { cleanWaiting: () => cleanWaitingCases(pool, key, clock(), (m) => quarantineLog.warn(m)) } : undefined;
  // Storage jobs (external outputs spec 5.6). Without the protected key, jobs needing the storage secret wait.
  const storageLog = new Logger('Storage');
  const storageDeps: StorageDeps = {
    pool,
    connectors: new DbStorageConnectorFactory(pool, clock, key),
    key,
    clock,
    // Source-file notices (Task 8); the notices of Task 13 and 17 are added to the same function.
    notify: makeStorageNotify(pool, clock),
    log: (m) => storageLog.warn(m),
  };
  // Paused in protective mode like the other external work (spec 7.3): a fetched job waits a minute and is tried again.
  await registerStorageWorker(boss, storageDeps, (m) => storageLog.warn(m), operations);
  const storage = {
    sendOutbox: () => sendStorageOutbox(pool, boss),
    daily: () => runStorageDaily(storageDeps, (m) => storageLog.warn(m)),
  };
  // The daily release check runs at a minute fixed per installation (from the organisation name), so installations do
  // not all call GitHub together. Before onboarding the minute is 0; it moves once a name is saved and the worker restarts.
  const minuteRow = (await pool.query(`SELECT ((hashtext(name)::bigint % 60) + 60) % 60 AS minute FROM organisation WHERE id = 1`)).rows[0] as
    | { minute: number }
    | undefined;
  const releaseCheck = {
    minute: minuteRow?.minute ?? 0,
    run: async () => {
      await checkReleases({ pool, fetch, repo: config.release.repo, api: config.release.api, runningVersion: runningVersion(), now: clock() }, 'daily');
    },
  };
  await registerSchedules(boss, { sweep, dispatcher, analysis, quarantine: quarantineJob, storage, operations, opsSweep: () => runOpsSweep(pool, clock()), releaseCheck });
  console.log(`kainow worker started (at most ${AI_CONCURRENCY} AI jobs at once in this process; the AI places setting is the real limit)`);

  const stop = async (): Promise<void> => {
    await boss.stop({ graceful: true, timeout: 10000 });
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop());
  process.on('SIGINT', () => void stop());
}

main().catch((err: unknown) => {
  console.error('Worker failed to start:', err instanceof Error ? err.message : err);
  process.exit(1);
});
