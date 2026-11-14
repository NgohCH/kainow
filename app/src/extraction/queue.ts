import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import type { PgBoss } from 'pg-boss';
import { APP_CONFIG, type AppConfig } from '../config';
import { QUEUES, startQueues } from '../worker/queues';
import { MAX_ATTEMPTS } from './prompt';

export const EXTRACTION_QUEUE = Symbol('EXTRACTION_QUEUE');

/** How the API hands a run to the worker. Tests replace it; the real one is a durable pg-boss job. */
export interface ExtractionQueue {
  /** `explicit`: a person asked for it just now; it goes ahead of automatic work (R32). */
  enqueue(runId: string, opts?: EnqueueOptions): Promise<void>;
}

export interface EnqueueOptions {
  explicit?: boolean;
}

/** pg-boss runs a higher priority first: what a person is waiting for goes before automatic runs. */
export const EXPLICIT_PRIORITY = 10;
export const priorityOf = (opts?: EnqueueOptions): number => (opts?.explicit ? EXPLICIT_PRIORITY : 0);

export interface ExtractionJob {
  runId: string;
}

/** Retry timing for a failed attempt. The attempt count itself is MAX_ATTEMPTS. */
export const JOB_OPTIONS = {
  retryLimit: MAX_ATTEMPTS - 1,
  retryDelay: 30,
  retryBackoff: true,
  // Longer than the AI request timeout, so a slow but live request is not taken over by a second worker.
  expireInSeconds: 600,
} as const;

@Injectable()
export class PgBossExtractionQueue implements ExtractionQueue, OnApplicationShutdown {
  private boss: PgBoss | undefined;
  private starting: Promise<PgBoss> | undefined;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  /**
   * Started on first use rather than at boot, so the API still starts, and /health still reports
   * 'degraded', when the database is briefly unreachable. A failed start is tried again next time.
   */
  private start(): Promise<PgBoss> {
    this.starting ??= startQueues(this.config.databaseUrl, undefined, { supervise: false, schedule: false }).then(
      (boss) => (this.boss = boss),
      (err: unknown) => {
        this.starting = undefined;
        throw err;
      },
    );
    return this.starting;
  }

  async enqueue(runId: string, opts?: EnqueueOptions): Promise<void> {
    const boss = await this.start();
    const id = await boss.send(QUEUES.ai, { runId } satisfies ExtractionJob, { ...JOB_OPTIONS, singletonKey: runId, priority: priorityOf(opts) });
    if (!id) throw new Error('The job queue did not accept the job');
  }

  async onApplicationShutdown(): Promise<void> {
    await this.boss?.stop({ graceful: true, timeout: 5000 });
  }
}
