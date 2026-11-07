import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QUEUES, startQueues } from './queues';
import { SKIP_NO_DB, testDatabaseUrl } from '../testing/db';

test('queue names are separate for AI, email and document work', () => {
  assert.deepEqual(Object.values(QUEUES).sort(), ['ai', 'document', 'email']);
});

test('creates every queue and a job survives a restart of the queue client', { skip: SKIP_NO_DB }, async () => {
  const url = testDatabaseUrl() as string;
  const schema = 'pgboss_test';

  const first = await startQueues(url, schema);
  for (const name of Object.values(QUEUES)) {
    assert.ok(await first.getQueue(name), `queue ${name} should exist`);
  }
  const payload = { note: `restart-${Date.now()}` };
  const jobId = await first.send(QUEUES.ai, payload);
  assert.ok(jobId, 'send() should return a job id');
  await first.stop({ graceful: true, timeout: 5000 });

  // A new client (like a restarted worker) must still find the same job, unprocessed.
  const second = await startQueues(url, schema);
  try {
    const [job] = await second.fetch<typeof payload>(QUEUES.ai);
    assert.ok(job, 'the job should still be there after restart');
    assert.equal(job.id, jobId);
    assert.deepEqual(job.data, payload);
    await second.complete(QUEUES.ai, job.id);
  } finally {
    await second.stop({ graceful: true, timeout: 5000 });
  }
});
