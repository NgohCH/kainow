import { Global, Inject, Injectable, Module, type DynamicModule, type OnApplicationShutdown } from '@nestjs/common';
import type { PgBoss } from 'pg-boss';
import { APP_CONFIG, type AppConfig } from '../config';
import { QUEUES, startQueues } from '../worker/queues';

export const EMAIL_NUDGE = Symbol('EMAIL_NUDGE');

/** Tells the worker there is outbox work now. Callers nudge after their transaction commits. Never throws. */
export interface EmailNudge {
  nudge(): Promise<void>;
}

@Injectable()
export class PgBossEmailNudge implements EmailNudge, OnApplicationShutdown {
  private boss: PgBoss | undefined;
  private starting: Promise<PgBoss> | undefined;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  /** Started on first use, like the extraction queue, so the API starts even when the database is briefly unreachable. */
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

  async nudge(): Promise<void> {
    try {
      const boss = await this.start();
      // The outbox row is the source of truth; the once-a-minute tick still finds it if this job is lost.
      await boss.send(QUEUES.email, { nudge: true }, { singletonSeconds: 5 });
    } catch (err) {
      console.error('Could not nudge the email worker:', err instanceof Error ? err.message : 'unknown error');
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.boss?.stop({ graceful: true, timeout: 5000 });
  }
}

@Global()
@Module({})
export class EmailModule {
  /** Pass a nudge only in tests; otherwise the real one sends a pg-boss job to the email queue. */
  static register(nudge?: EmailNudge): DynamicModule {
    return {
      module: EmailModule,
      providers: nudge ? [{ provide: EMAIL_NUDGE, useValue: nudge }] : [PgBossEmailNudge, { provide: EMAIL_NUDGE, useExisting: PgBossEmailNudge }],
      exports: [EMAIL_NUDGE],
    };
  }
}
