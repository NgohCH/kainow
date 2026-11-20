import { Global, Module, type DynamicModule } from '@nestjs/common';
import { AuthModule, type AuthOptions } from './auth/auth.module';
import type { Clock } from './auth/tokens';
import { ClockModule } from './common/clock.module';
import { APP_CONFIG, type AppConfig } from './config';
import { DatabaseModule } from './db/database.module';
import { HealthController } from './health/health.controller';
import type { AnalysisQueue } from './analysis/queue';
import { AssistModule } from './assist/assist.module';
import type { AssistQueue } from './assist/queue';
import { ChangesModule } from './changes/changes.module';
import { EmailModule, type EmailNudge } from './email/nudge';
import { ExtractionModule } from './extraction/extraction.module';
import type { ExtractionQueue } from './extraction/queue';
import { GoLiveModule } from './golive/golive.module';
import { HistoryModule } from './history/history.module';
import { NotesModule } from './notes/notes.module';
import { NotificationsModule } from './notifications/notifications.module';
import { DigestsModule } from './digests/digests.module';
import { DiscussionModule } from './discussion/discussion.module';
import type { AutomaticAnalysis } from './discussion/automatic-analysis';
import type { MeetingEndHook } from './discussion/meetings.service';
import { OrganisationModule } from './organisation/organisation.module';
import { ProjectsModule } from './projects/projects.module';
import { ProtectedKeyModule } from './quarantine/protected-key.module';
import { QuarantineModule } from './quarantine/quarantine.module';
import { SearchModule } from './search/search.module';
import { AiModule } from './ai/ai.module';
import { SpendModule } from './spend/spend.module';
import { DashboardsModule } from './dashboards/dashboards.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { LeadershipModule } from './leadership/leadership.module';
import type { StorageConnectorFactory } from './storage/connector-factory';
import { OutputsModule } from './outputs/outputs.module';
import { StorageModule } from './storage/storage.module';

@Global()
@Module({})
class ConfigModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: ConfigModule,
      providers: [{ provide: APP_CONFIG, useValue: config }],
      exports: [APP_CONFIG],
    };
  }
}

/** Replaceable pieces, so tests can capture sign-in codes and control time. */
export interface AppOptions extends AuthOptions {
  clock?: Clock;
  /** Tests only: replaces the pg-boss queue that carries runs to the worker. */
  extractionQueue?: ExtractionQueue;
  /** Tests only: replaces the pg-boss job that wakes the email worker. */
  emailNudge?: EmailNudge;
  /** Tests only: replaces the pg-boss queue that carries analysis runs to the worker. */
  analysisQueue?: AnalysisQueue;
  /** Tests only: replaces what happens when a meeting ends (the real one requests the final draft). */
  meetingEndHook?: MeetingEndHook;
  /** Tests only: replaces the reader of the project's automatic-analysis setting (Task 9 binds the real one). */
  automaticAnalysis?: AutomaticAnalysis;
  /** Tests only: replaces the pg-boss queue that carries AI assist requests to the worker. */
  assistQueue?: AssistQueue;
  /** Tests only: replaces the storage connector factory. */
  storageConnectors?: StorageConnectorFactory;
}

@Module({})
export class AppModule {
  /** Configuration is passed in so tests and the real entry point share one wiring. */
  static register(config: AppConfig, options: AppOptions = {}): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot(config),
        ClockModule.forRoot(options.clock),
        DatabaseModule,
        ProtectedKeyModule,
        AuthModule.register({ codeSender: options.codeSender }),
        SpendModule,
        AiModule,
        OutputsModule,
        OrganisationModule,
        ProjectsModule,
        NotesModule,
        EmailModule.register(options.emailNudge),
        ExtractionModule.register(options.extractionQueue),
        ChangesModule,
        NotificationsModule,
        DigestsModule,
        GoLiveModule,
        SearchModule,
        DiscussionModule.register(options.meetingEndHook, options.automaticAnalysis, options.analysisQueue),
        AssistModule.register(options.assistQueue),
        HistoryModule,
        QuarantineModule,
        DashboardsModule,
        LeadershipModule,
        AnalyticsModule,
        StorageModule.register(options.storageConnectors),
      ],
      controllers: [HealthController],
    };
  }
}
