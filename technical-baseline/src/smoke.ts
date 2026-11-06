// Spike: confirm pg-boss (durable PostgreSQL queue) can create, send, process and complete
// a job against a real PostgreSQL instance. Reads DATABASE_URL from the environment.
import { PgBoss, type Job } from 'pg-boss';

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set');
  }

  const boss = new PgBoss({ connectionString, schema: 'pgboss_spike' });
  boss.on('error', (err: Error) => console.error('pg-boss error:', err));
  await boss.start();

  const queue = 'spike-ai-requests';
  await boss.createQueue(queue);

  const received = new Promise<unknown>((resolve) => {
    void boss.work<{ hello: string }>(queue, async (jobs: Job<{ hello: string }>[]) => {
      resolve(jobs[0]?.data);
    });
  });

  const jobId = await boss.send(queue, { hello: 'kainow' });
  if (!jobId) {
    throw new Error('send() returned no job id');
  }

  const data = await Promise.race([
    received,
    new Promise((_, reject) => setTimeout(() => reject(new Error('job not processed within 15s')), 15000)),
  ]);

  console.log('job id:', jobId);
  console.log('processed payload:', JSON.stringify(data));
  await boss.stop({ graceful: true, timeout: 5000 });
  console.log('SMOKE OK');
}

main().catch((err: unknown) => {
  console.error('SMOKE FAILED:', err);
  process.exit(1);
});
