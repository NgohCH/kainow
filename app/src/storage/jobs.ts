import type { Pool, PoolClient } from 'pg';
import type { Clock } from '../auth/tokens';
import type { ProtectedKey } from '../quarantine/protected-key';
import type { StorageConnectorFactory } from './connector-factory';
import type { StorageErrorCode } from './types';

/** The storage job kinds (spec 5.6). Each names what its subject id is; job data carries ids only. */
export type StorageJob =
  | 'file-output' | 'store-source' | 'share-sync' | 'place-output' | 'check'
  | 'register-changed' | 'relocate' | 'withhold' | 'restore-withheld' | 'backfill-sources' | 'rename-output';

/**
 * What a storage job carries: its kind and subject id, and after a failure the attempt it is on and when the first failure
 * was (so the retry schedule and the attempt count survive restarts). Never names, content or secrets.
 */
export interface StorageJobData {
  job: StorageJob;
  subjectId: string;
  /** The attempt this run is (1 when absent). */
  attempt?: number;
  /** ISO time of the first failure, from which the retry schedule is measured. */
  firstFailureAt?: string;
}

/** A notice raised by storage work; the kinds and their wording are added by the features that raise them. */
export interface StorageNotice {
  kind: string;
  subjectId: string;
}

export interface StorageDeps {
  pool: Pool;
  connectors: StorageConnectorFactory;
  key: ProtectedKey | null;
  clock: Clock;
  notify: (c: PoolClient, n: StorageNotice) => Promise<void>;
  /** Fixed messages only (never names, paths, provider text or secrets); none in tests unless given. */
  log?: (message: string) => void;
}

/** An outcome that is not a StorageError: a bug or a database failure inside the handler. Its message is never kept. */
export type StorageFailureCode = StorageErrorCode | 'internal';

/**
 * Does one attempt of a job. Every attempt rechecks the subject's state before acting (A11). Throwing StorageError ends
 * the attempt with that code; StorageWaitingForKey waits for the protected key without counting an attempt.
 */
export type StorageHandler = (deps: StorageDeps, subjectId: string, attempt: number) => Promise<void>;

/** Marks the subject failed after its last attempt (or a code that is never retried). */
export type StorageFinalFailure = (deps: StorageDeps, subjectId: string, code: StorageFailureCode) => Promise<void>;

/** Runs once a day at 02:30 UTC+8 (checks and reconciliation register here). */
export type StorageDailyTask = (deps: StorageDeps) => Promise<void>;

const handlers = new Map<StorageJob, StorageHandler>();
const finalFailures = new Map<StorageJob, StorageFinalFailure>();
const dailyTasks = new Map<string, StorageDailyTask>();

/** The subject modules register their handler for a job kind; a later registration replaces an earlier one. */
export function registerStorageHandler(job: StorageJob, handler: StorageHandler): void {
  handlers.set(job, handler);
}

export function storageHandler(job: StorageJob): StorageHandler | undefined {
  return handlers.get(job);
}

/** The subject modules register how a job kind's subject is marked failed; with none, the attempts are only recorded. */
export function registerStorageFinalFailure(job: StorageJob, hook: StorageFinalFailure): void {
  finalFailures.set(job, hook);
}

export async function onFinalFailure(deps: StorageDeps, job: StorageJob, subjectId: string, code: StorageFailureCode): Promise<void> {
  await finalFailures.get(job)?.(deps, subjectId, code);
}

export function registerStorageDailyTask(name: string, task: StorageDailyTask): void {
  dailyTasks.set(name, task);
}

/** Runs every daily task in turn; one failing is logged with a fixed message and does not stop the others. */
export async function runStorageDaily(deps: StorageDeps, log: (message: string) => void): Promise<void> {
  for (const [name, task] of dailyTasks) {
    try {
      await task(deps);
    } catch {
      log(`The daily storage task ${name} failed; it will run again tomorrow.`);
    }
  }
}
