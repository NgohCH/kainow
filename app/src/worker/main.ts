import { loadConfig } from '../config';
import { startQueues } from './queues';

async function main(): Promise<void> {
  const config = loadConfig();
  const boss = await startQueues(config.databaseUrl);
  console.log('kainow worker started');

  const stop = async (): Promise<void> => {
    await boss.stop({ graceful: true, timeout: 10000 });
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop());
  process.on('SIGINT', () => void stop());
}

main().catch((err: unknown) => {
  console.error('Worker failed to start:', err instanceof Error ? err.message : err);
  process.exit(1);
});
