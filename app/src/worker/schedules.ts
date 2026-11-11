import type { PgBoss } from 'pg-boss';
import type { EmailDispatcher } from '../email/dispatcher';
import type { Sweep } from '../notifications/sweep';
import { QUEUES } from './queues';

export interface ScheduleDeps {
  sweep: Pick<Sweep, 'runIfDue'>;
  dispatcher: Pick<EmailDispatcher, 'dispatchDue'>;
  /** Fixed messages only; never an error object or message. */
  log?: (message: string) => void;
}

const EVERY_MINUTE = '* * * * *';
export const SWEEP_FAILED = 'The notification sweep failed; it will run again on the next tick.';
export const DISPATCH_FAILED = 'The email dispatch failed; it will run again on the next tick.';

/**
 * Schedules a tick every minute for the sweep and the email dispatch, and processes jobs on both queues.
 * The sweep decides for itself whether it is due (its interval is a setting); the dispatcher reads the outbox.
 * Nudges from the API are jobs on the email queue and are handled exactly like a tick.
 * Each worker has concurrency 1, so runs do not overlap inside one process. Across processes (and for ticks versus nudges,
 * which use different singleton keys) overlap is not prevented by the queue policy, which only applies to newly created queues;
 * it is made harmless by the dispatcher's row claiming (SKIP LOCKED) and the sweep's trigger keys.
 */
export async function registerSchedules(boss: PgBoss, deps: ScheduleDeps): Promise<void> {
  const log = deps.log ?? ((m: string) => console.error(m));

  await boss.schedule(QUEUES.sweep, EVERY_MINUTE, null, { key: 'tick', singletonKey: 'tick' });
  await boss.schedule(QUEUES.email, EVERY_MINUTE, null, { key: 'tick', singletonKey: 'tick' });

  // A failed run must not make pg-boss retry or crash the worker: the next tick looks at everything again.
  await boss.work(QUEUES.sweep, { localConcurrency: 1 }, async () => {
    try {
      await deps.sweep.runIfDue();
    } catch {
      log(SWEEP_FAILED);
    }
  });
  await boss.work(QUEUES.email, { localConcurrency: 1 }, async () => {
    try {
      await deps.dispatcher.dispatchDue();
    } catch {
      log(DISPATCH_FAILED);
    }
  });
}
