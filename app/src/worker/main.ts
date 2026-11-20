import { Pool } from 'pg';
import { AnalysisRunner } from '../analysis/analysis-runner';
import { MinutesRunner } from '../analysis/minutes-runner';
import { AnalysisTick } from '../analysis/tick';
import { bossAnalysisQueue } from '../analysis/queue';
import { AssistRunner } from '../assist/assist-runner';
// Register the report and summary kinds' input, completion and removal check with the assist runner.
import '../assist/reports.service';
import '../assist/summaries.service';
import { ExtractionRunner } from '../extraction/runner';
import { realClientFactory } from '../ai/client-factory';
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
import { loadProtectedKey } from '../quarantine/protected-key';
import { QUEUES, startQueues } from './queues';
import { registerSchedules } from './schedules';
import { DbStorageConnectorFactory } from '../storage/connector-factory';
import { type StorageDeps, runStorageDaily } from '../storage/jobs';
import { makeStorageNotify } from '../storage/notices';
import { sendStorageOutbox } from '../storage/outbox';
import { registerStorageWorker } from '../storage/storage-worker';
// Register the source-area handlers (store-source, backfill-sources) and their daily tick.
import '../storage/sources';
// Register the daily source-file check.
import '../storage/source-files';
// Register the file-output handler, its final failure and the daily drop of unfiled output bytes.
import '../outputs/filing';

async function main(): Promise<void> {
  const config = loadWorkerConfig();
  const pool = new Pool({ connectionString: config.databaseUrl });
  const clock = () => new Date();
  const spend = new SpendService(pool, clock);
  // The protected key (history spec 7.3): held in memory only; without it, waiting quarantine cases stay waiting.
  const keyLog = new Logger('ProtectedKey');
  const key = loadProtectedKey(config.protectedKeyFile, (m) => keyLog.warn(m));
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
  // No model client is built here: each attempt builds the client for its project connection, opening that connection's
  // key with the protected key (spec 6.3). Without the protected key every AI request ends blocked protected_key_missing.
  const extraction = new ExtractionRunner({
    pool,
    spend,
    factory: realClientFactory,
    key,
    clock,
    log: (m) => console.error(m),
    quarantine,
  });
  const minutes = new MinutesRunner({ pool, spend, factory: realClientFactory, key, clock, quarantine, log: (m) => console.error(m) });
  const analysisRunner = new AnalysisRunner({ pool, clock, extraction, minutes, quarantine, log: (m) => console.error(m) });
  const assist = new AssistRunner({ pool, spend, factory: realClientFactory, key, clock, quarantine, log: (m) => console.error(m) });

  boss = await startQueues(config.databaseUrl, undefined, { schedule: true });
  await registerAiWorker(boss, { extraction, analysis: analysisRunner, assist }, pool);

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
  const storageDeps: StorageDeps = {
    pool,
    connectors: new DbStorageConnectorFactory(pool, clock, key),
    key,
    clock,
    // Source-file notices (Task 8); the notices of Task 13 and 17 are added to the same function.
    notify: makeStorageNotify(pool, clock),
  };
  await registerStorageWorker(boss, storageDeps);
  const storageLog = new Logger('Storage');
  const storage = {
    sendOutbox: () => sendStorageOutbox(pool, boss),
    daily: () => runStorageDaily(storageDeps, (m) => storageLog.warn(m)),
  };
  await registerSchedules(boss, { sweep, dispatcher, analysis, quarantine: quarantineJob, storage });
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
