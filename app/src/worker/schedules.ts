import type { PgBoss } from 'pg-boss';
import type { AnalysisTick } from '../analysis/tick';
import type { EmailDispatcher } from '../email/dispatcher';
import type { Sweep } from '../notifications/sweep';
import { QUEUES } from './queues';

export interface ScheduleDeps {
  sweep: Pick<Sweep, 'runIfDue'>;
  dispatcher: Pick<EmailDispatcher, 'dispatchDue'>;
  /** The per-minute analysis decision (spec 7.2). */
  analysis?: Pick<AnalysisTick, 'run'>;
  /** Cleans quarantine cases waiting for the protected key; only when the worker has the key (history spec 7.3). */
  quarantine?: { cleanWaiting(): Promise<number> };
  /** Storage jobs (external outputs spec 5.6): the outbox tick every minute and the daily tick at 02:30 UTC+8. */
  storage?: { sendOutbox(): Promise<number>; daily(): Promise<void> };
  /** Fixed messages only; never an error object or message. */
  log?: (message: string) => void;
}

const EVERY_MINUTE = '* * * * *';
export const SWEEP_FAILED = 'The notification sweep failed; it will run again on the next tick.';
export const ANALYSIS_FAILED = 'The analysis tick failed; it will run again on the next tick.';
export const DISPATCH_FAILED = 'The email dispatch failed; it will run again on the next tick.';
export const STORAGE_OUTBOX_FAILED = 'Sending the storage outbox failed; it will run again on the next tick.';
export const STORAGE_DAILY_FAILED = 'The daily storage tick failed; it will run again tomorrow.';
/** 02:30 in UTC+8, the time the daily storage work runs (spec 5.5). */
const DAILY_0230 = '30 2 * * *';
const UTC8 = 'Asia/Kuala_Lumpur';
export const QUARANTINE_FAILED = 'Cleaning the quarantine cases waiting for the protected key failed; it will run again on the next tick.';

/**
 * Schedules a tick every minute for the sweep, the email dispatch and the analysis decision, and processes jobs on both queues.
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
  if (deps.analysis) await boss.schedule(QUEUES.analysis, EVERY_MINUTE, null, { key: 'tick', singletonKey: 'tick' });

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
  const quarantine = deps.quarantine;
  if (quarantine) {
    // Every minute, and once at start, so cases reported without the key are cleaned as soon as the key is there.
    await boss.schedule(QUEUES.quarantine, EVERY_MINUTE, null, { key: 'tick', singletonKey: 'tick' });
    await boss.work(QUEUES.quarantine, { localConcurrency: 1 }, async () => {
      try {
        await quarantine.cleanWaiting();
      } catch {
        log(QUARANTINE_FAILED);
      }
    });
    await boss.send(QUEUES.quarantine, { start: true }, { singletonKey: 'start' });
  }
  const storage = deps.storage;
  if (storage) {
    await boss.schedule(QUEUES.storageOutbox, EVERY_MINUTE, null, { key: 'tick', singletonKey: 'tick' });
    // The daily run can take hours at real provider latency; it runs once (its tasks isolate their own failures), so
    // it is given four hours and never retried the same day.
    await boss.schedule(QUEUES.storageDaily, DAILY_0230, null, { key: 'tick', singletonKey: 'tick', tz: UTC8, expireInSeconds: 4 * 60 * 60, retryLimit: 0 });
    await boss.work(QUEUES.storageOutbox, { localConcurrency: 1 }, async () => {
      try {
        await storage.sendOutbox();
      } catch {
        log(STORAGE_OUTBOX_FAILED);
      }
    });
    await boss.work(QUEUES.storageDaily, { localConcurrency: 1 }, async () => {
      try {
        await storage.daily();
      } catch {
        log(STORAGE_DAILY_FAILED);
      }
    });
  }
  const analysis = deps.analysis;
  if (analysis) {
    // Overlapping ticks are harmless: a thread already queued or running is skipped by the partial unique index.
    await boss.work(QUEUES.analysis, { localConcurrency: 1 }, async () => {
      try {
        await analysis.run();
      } catch {
        log(ANALYSIS_FAILED);
      }
    });
  }
}
