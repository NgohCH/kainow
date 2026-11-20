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

test('the analysis tick is scheduled every minute, and a failing tick is logged with a fixed message', { skip: SKIP_NO_DB }, async () => {
  const logs: string[] = [];
  let calls = 0;
  const analysis = {
    run: async () => {
      calls++;
      throw new Error('postgres://user:hunter2@db.example.org refused');
    },
  };
  const boss = await startQueues(testDatabaseUrl() as string, SCHEMA, { schedule: true });
  await registerSchedules(boss, { sweep: { runIfDue: async () => true } as unknown as Sweep, dispatcher: { dispatchDue: async () => ({}) } as unknown as EmailDispatcher, analysis, log: (m) => logs.push(m) });
  try {
    const s = (await boss.getSchedules()).find((x) => x.name === QUEUES.analysis);
    assert.equal(s?.cron, '* * * * *');
    await boss.unschedule(QUEUES.analysis, 'tick');
    await boss.send(QUEUES.analysis, {});
    await until(() => calls >= 1 && logs.length >= 1);
    assert.deepEqual(logs, ['The analysis tick failed; it will run again on the next tick.']);
    assert.ok(!logs.join(' ').includes('hunter2'));
  } finally {
    await boss.stop({ graceful: true, timeout: 5000 });
  }
});

test('with the protected key, the quarantine.clean-waiting job runs at start and every minute; a failure is logged with a fixed message', { skip: SKIP_NO_DB }, async () => {
  const logs: string[] = [];
  let calls = 0;
  const quarantine = {
    cleanWaiting: async () => {
      calls++;
      if (calls === 1) throw new Error('quarantine failed near Kp9vault-Rotor42');
      return 0;
    },
  };
  const boss = await startQueues(testDatabaseUrl() as string, SCHEMA, { schedule: true });
  await registerSchedules(boss, { sweep: { runIfDue: async () => true } as unknown as Sweep, dispatcher: { dispatchDue: async () => ({}) } as unknown as EmailDispatcher, quarantine, log: (m) => logs.push(m) });
  try {
    const s = (await boss.getSchedules()).find((x) => x.name === QUEUES.quarantine);
    assert.equal(s?.cron, '* * * * *');
    // The start job runs without waiting for the first tick.
    await until(() => calls >= 1 && logs.length >= 1);
    assert.deepEqual(logs, ['Cleaning the quarantine cases waiting for the protected key failed; it will run again on the next tick.']);
    assert.ok(!logs.join(' ').includes('Kp9vault'));
  } finally {
    await boss.unschedule(QUEUES.quarantine, 'tick');
    await boss.stop({ graceful: true, timeout: 5000 });
  }
});

test('the storage outbox is sent every minute and the daily storage tick runs at 02:30 UTC+8; failures are logged with fixed messages', { skip: SKIP_NO_DB }, async () => {
  const logs: string[] = [];
  let sends = 0;
  let dailies = 0;
  const storage = {
    sendOutbox: async () => {
      sends++;
      throw new Error('postgres://user:hunter2@db.example.org refused');
    },
    daily: async () => {
      dailies++;
      throw new Error('Bearer hunter2');
    },
  };
  const boss = await startQueues(testDatabaseUrl() as string, SCHEMA, { schedule: true });
  await registerSchedules(boss, { sweep: { runIfDue: async () => true } as unknown as Sweep, dispatcher: { dispatchDue: async () => ({}) } as unknown as EmailDispatcher, storage, log: (m) => logs.push(m) });
  try {
    const schedules = await boss.getSchedules();
    const outbox = schedules.find((x) => x.name === QUEUES.storageOutbox);
    const daily = schedules.find((x) => x.name === QUEUES.storageDaily);
    assert.equal(outbox?.cron, '* * * * *');
    assert.equal(daily?.cron, '30 2 * * *');
    assert.equal(daily?.timezone, 'Asia/Kuala_Lumpur');
    await boss.unschedule(QUEUES.storageOutbox, 'tick');
    await boss.unschedule(QUEUES.storageDaily, 'tick');
    await boss.send(QUEUES.storageOutbox, {});
    await boss.send(QUEUES.storageDaily, {});
    await until(() => sends >= 1 && dailies >= 1 && logs.length >= 2);
    assert.deepEqual([...logs].sort(), [
      'Sending the storage outbox failed; it will run again on the next tick.',
      'The daily storage tick failed; it will run again tomorrow.',
    ]);
    assert.ok(!logs.join(' ').includes('hunter2'));
  } finally {
    await boss.stop({ graceful: true, timeout: 5000 });
  }
});
