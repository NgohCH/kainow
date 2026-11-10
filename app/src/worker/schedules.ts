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
 * Both queues are 'stately' (see startQueues) and each worker has concurrency 1, so runs never overlap in or across processes.
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
