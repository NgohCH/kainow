import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import type { PgBoss } from 'pg-boss';
import { APP_CONFIG, type AppConfig } from '../config';
import { type EnqueueOptions, JOB_OPTIONS, priorityOf } from '../extraction/queue';
import { QUEUES, startQueues } from '../worker/queues';

export interface AnalysisJob {
  analysisRunId: string;
}

export const ANALYSIS_QUEUE = Symbol('ANALYSIS_QUEUE');

/** How the API and the tick hand an analysis run to the worker. Tests replace it. */
export interface AnalysisQueue {
  enqueue(analysisRunId: string, opts?: EnqueueOptions): Promise<void>;
}

/**
 * Analysis runs share the `ai` queue with extraction, so the installation-wide limit of two concurrent AI requests
 * covers all of them. Started on first use, like PgBossExtractionQueue.
 */
@Injectable()
export class PgBossAnalysisQueue implements AnalysisQueue, OnApplicationShutdown {
  private boss: PgBoss | undefined;
  private starting: Promise<PgBoss> | undefined;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

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

  async enqueue(analysisRunId: string, opts?: EnqueueOptions): Promise<void> {
    const boss = await this.start();
    const id = await boss.send(QUEUES.ai, { analysisRunId } satisfies AnalysisJob, { ...JOB_OPTIONS, singletonKey: analysisRunId, priority: priorityOf(opts) });
    if (!id) throw new Error('The job queue did not accept the job');
  }

  async onApplicationShutdown(): Promise<void> {
    await this.boss?.stop({ graceful: true, timeout: 5000 });
  }
}

/** For the worker, which builds plain classes: the tick enqueues through its own long-lived boss. */
export function bossAnalysisQueue(boss: Pick<PgBoss, 'send'>): AnalysisQueue {
  return {
    async enqueue(analysisRunId: string, opts?: EnqueueOptions) {
      const id = await boss.send(QUEUES.ai, { analysisRunId } satisfies AnalysisJob, { ...JOB_OPTIONS, singletonKey: analysisRunId, priority: priorityOf(opts) });
      if (!id) throw new Error('The job queue did not accept the job');
    },
  };
}
