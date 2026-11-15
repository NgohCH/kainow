import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import type { PgBoss } from 'pg-boss';
import { APP_CONFIG, type AppConfig } from '../config';
import { JOB_OPTIONS, priorityOf } from '../extraction/queue';
import { QUEUES, startQueues } from '../worker/queues';

export interface AssistJob {
  assistRequestId: string;
}

export const ASSIST_QUEUE = Symbol('ASSIST_QUEUE');

/** How the API hands an AI assist request to the worker. Tests replace it. */
export interface AssistQueue {
  enqueue(assistRequestId: string): Promise<void>;
}

/**
 * Assist requests share the `ai` queue with extraction and analysis, so the installation-wide limit of two concurrent AI
 * requests covers all of them (A05). Every assist request is asked for by a person, so it always goes at the explicit
 * priority, ahead of automatic work.
 */
export async function enqueueAssist(boss: Pick<PgBoss, 'send'>, assistRequestId: string): Promise<void> {
  const id = await boss.send(QUEUES.ai, { assistRequestId } satisfies AssistJob, {
    ...JOB_OPTIONS,
    singletonKey: assistRequestId,
    priority: priorityOf({ explicit: true }),
  });
  if (!id) throw new Error('The job queue did not accept the job');
}

/** Started on first use, like PgBossAnalysisQueue. */
@Injectable()
export class PgBossAssistQueue implements AssistQueue, OnApplicationShutdown {
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

  async enqueue(assistRequestId: string): Promise<void> {
    await enqueueAssist(await this.start(), assistRequestId);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.boss?.stop({ graceful: true, timeout: 5000 });
  }
}
