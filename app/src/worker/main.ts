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
import { OpenAiModelClient } from '../extraction/model';
import { SpendService } from '../spend/spend.service';
import { loadWorkerConfig } from '../config';
import { AI_CONCURRENCY, registerAiWorker } from './ai-worker';
import { EmailDispatcher } from '../email/dispatcher';
import { createTransport } from '../email/transport';
import type { EmailNudge } from '../email/nudge';
import { Sweep } from '../notifications/sweep';
import { Logger } from '@nestjs/common';
import { cleanWaitingCases } from '../quarantine/cases.service';
import { loadProtectedKey } from '../quarantine/protected-key';
import { QUEUES, startQueues } from './queues';
import { registerSchedules } from './schedules';

async function main(): Promise<void> {
  const config = loadWorkerConfig();
  const pool = new Pool({ connectionString: config.databaseUrl });
  const clock = () => new Date();
  const spend = new SpendService(pool, clock);
  const model = config.openAiApiKey ? new OpenAiModelClient(config.openAiApiKey) : null;
  const extraction = new ExtractionRunner({
    pool,
    spend,
    model,
    clock,
    log: (m) => console.error(m),
  });
  const minutes = new MinutesRunner({ pool, spend, model, clock, log: (m) => console.error(m) });
  const analysisRunner = new AnalysisRunner({ pool, clock, extraction, minutes, log: (m) => console.error(m) });
  const assist = new AssistRunner({ pool, spend, model, clock, log: (m) => console.error(m) });
  if (!config.openAiApiKey) {
    console.warn('OPENAI_API_KEY is not set: extraction runs will fail without sending anything.');
  }

  const boss = await startQueues(config.databaseUrl, undefined, { schedule: true });
  await registerAiWorker(boss, { extraction, analysis: analysisRunner, assist }, pool);

  // The sweep nudges the dispatcher through the same boss instance; a lost nudge is caught by the next tick.
  const nudge: EmailNudge = {
    async nudge() {
      try {
        await boss.send(QUEUES.email, { nudge: true }, { singletonSeconds: 5 });
      } catch {
        console.error('Could not nudge the email dispatch.');
      }
    },
  };
  const log = { warn: (m: string) => console.warn(m) };
  const sweep = new Sweep({ pool, clock, appUrl: config.appUrl, nudge, log });
  const dispatcher = new EmailDispatcher({
    pool,
    transport: createTransport(config.email, clock),
    from: config.email.provider === 'log' ? 'Kainow <no-reply@localhost>' : config.email.from,
    clock,
    log,
  });
  const analysis = new AnalysisTick({ pool, clock, queue: bossAnalysisQueue(boss), spend: new SpendService(pool, clock) });
  // The protected key (history spec 7.3): held in memory only; without it, waiting quarantine cases stay waiting.
  const keyLog = new Logger('ProtectedKey');
  const key = loadProtectedKey(config.protectedKeyFile, (m) => keyLog.warn(m));
  const quarantineLog = new Logger('Quarantine');
  const quarantine = key ? { cleanWaiting: () => cleanWaitingCases(pool, key, clock(), (m) => quarantineLog.warn(m)) } : undefined;
  await registerSchedules(boss, { sweep, dispatcher, analysis, quarantine });
  console.log(`kainow worker started (AI requests at once: ${AI_CONCURRENCY})`);

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
