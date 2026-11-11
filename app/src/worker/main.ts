import { Pool } from 'pg';
import { ExtractionRunner } from '../extraction/runner';
import { OpenAiModelClient } from '../extraction/model';
import { SpendService } from '../spend/spend.service';
import { loadWorkerConfig } from '../config';
import { AI_CONCURRENCY, registerAiWorker } from './ai-worker';
import { EmailDispatcher } from '../email/dispatcher';
import { createTransport } from '../email/transport';
import type { EmailNudge } from '../email/nudge';
import { Sweep } from '../notifications/sweep';
import { QUEUES, startQueues } from './queues';
import { registerSchedules } from './schedules';

async function main(): Promise<void> {
  const config = loadWorkerConfig();
  const pool = new Pool({ connectionString: config.databaseUrl });
  const clock = () => new Date();
  const runner = new ExtractionRunner({
    pool,
    spend: new SpendService(pool, clock),
    model: config.openAiApiKey ? new OpenAiModelClient(config.openAiApiKey) : null,
    clock,
    log: (m) => console.error(m),
  });
  if (!config.openAiApiKey) {
    console.warn('OPENAI_API_KEY is not set: extraction runs will fail without sending anything.');
  }

  const boss = await startQueues(config.databaseUrl, undefined, { schedule: true });
  await registerAiWorker(boss, runner, pool);

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
  await registerSchedules(boss, { sweep, dispatcher });
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
