import { Pool } from 'pg';
import { ExtractionRunner } from '../extraction/runner';
import { OpenAiModelClient } from '../extraction/model';
import { SpendService } from '../spend/spend.service';
import { loadWorkerConfig } from '../config';
import { AI_CONCURRENCY, registerAiWorker } from './ai-worker';
import { startQueues } from './queues';

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

  const boss = await startQueues(config.databaseUrl);
  await registerAiWorker(boss, runner, pool);
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
