import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PgBoss } from 'pg-boss';
import type { EmailDispatcher } from '../email/dispatcher';
import type { Sweep } from '../notifications/sweep';
import { SKIP_NO_DB, testDatabaseUrl } from '../testing/db';
import { QUEUES, startQueues } from './queues';
import { registerSchedules } from './schedules';

const SCHEMA = 'pgboss_test';

async function until(cond: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function setup(sweep: object, dispatcher: object, logs: string[]): Promise<PgBoss> {
  const boss = await startQueues(testDatabaseUrl() as string, SCHEMA, { schedule: true });
  await registerSchedules(boss, { sweep: sweep as Sweep, dispatcher: dispatcher as EmailDispatcher, log: (m) => logs.push(m) });
  return boss;
}

test('registers a once-a-minute schedule for the sweep and for the email dispatch', { skip: SKIP_NO_DB }, async () => {
  const boss = await setup({ runIfDue: async () => true }, { dispatchDue: async () => ({}) }, []);
  try {
    const schedules = await boss.getSchedules();
    for (const name of [QUEUES.sweep, QUEUES.email]) {
      const s = schedules.find((x) => x.name === name);
      assert.ok(s, `${name} should be scheduled`);
      assert.equal(s.cron, '* * * * *');
    }
  } finally {
    await boss.stop({ graceful: true, timeout: 5000 });
  }
});

test('a job on the email queue runs the dispatcher once, and a job on the sweep queue runs the sweep once', { skip: SKIP_NO_DB }, async () => {
  let dispatched = 0;
  let swept = 0;
  const boss = await setup({ runIfDue: async () => { swept++; return true; } }, { dispatchDue: async () => { dispatched++; return {}; } }, []);
  try {
    // The once-a-minute ticks are covered by the test above. Remove them here so a tick landing on a minute boundary
    // cannot add a run, then count only the runs caused by the two jobs this test sends.
    await boss.unschedule(QUEUES.email, 'tick');
    await boss.unschedule(QUEUES.sweep, 'tick');
    await new Promise((r) => setTimeout(r, 500));
    const dispatchedBefore = dispatched;
    const sweptBefore = swept;
    await boss.send(QUEUES.email, { nudge: true });
    await boss.send(QUEUES.sweep, {});
    await until(() => dispatched - dispatchedBefore >= 1 && swept - sweptBefore >= 1);
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(dispatched - dispatchedBefore, 1);
    assert.equal(swept - sweptBefore, 1);
  } finally {
    await boss.stop({ graceful: true, timeout: 5000 });
  }
});

test('a handler that throws is logged with a fixed message and does not stop later runs', { skip: SKIP_NO_DB }, async () => {
  const logs: string[] = [];
  let calls = 0;
  const dispatcher = {
    dispatchDue: async () => {
      calls++;
      if (calls === 1) throw new Error('smtp://user:hunter2@mail.example.org exploded');
      return {};
    },
  };
  const boss = await setup({ runIfDue: async () => true }, dispatcher, logs);
  try {
    await boss.send(QUEUES.email, { nudge: true });
    await until(() => calls >= 1 && logs.length >= 1);
    assert.deepEqual(logs, ['The email dispatch failed; it will run again on the next tick.']);
    assert.ok(!logs.join(' ').includes('hunter2'));
    await boss.send(QUEUES.email, { nudge: true, again: true });
    await until(() => calls >= 2);
  } finally {
    await boss.stop({ graceful: true, timeout: 5000 });
  }
});
