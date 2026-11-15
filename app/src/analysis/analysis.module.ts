import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from '../db/database.module';
import { AUTOMATIC_ANALYSIS, type AutomaticAnalysis } from '../discussion/automatic-analysis';
import { AudienceModule } from '../discussion/audience.module';
import { ThreadsService } from '../discussion/threads.service';
import { ProjectsModule } from '../projects/projects.module';
import { SpendModule } from '../spend/spend.module';
import { AnalysisController } from './analysis.controller';
import { AnalysisService } from './analysis.service';
import { ANALYSIS_QUEUE, type AnalysisQueue, PgBossAnalysisQueue } from './queue';
import { AnalysisSettingsController } from './settings.controller';
import { AnalysisSettingsService, effectiveAnalysisSettings } from './settings.service';

@Module({})
export class AnalysisModule {
  /**
   * `automaticAnalysis` and `queue` replace the real reader and the pg-boss queue in tests only.
   * DiscussionModule imports this module (it needs AnalysisService for the meeting-end hook), so this module must not
   * import DiscussionModule back. It builds its own ThreadsService instead: that class is stateless (pool, clock, access
   * and the audience rule), so a second instance behaves the same.
   */
  static register(automaticAnalysis?: AutomaticAnalysis, queue?: AnalysisQueue): DynamicModule {
    const queueProviders: Provider[] = queue
      ? [{ provide: ANALYSIS_QUEUE, useValue: queue }]
      : [PgBossAnalysisQueue, { provide: ANALYSIS_QUEUE, useExisting: PgBossAnalysisQueue }];
    return {
      module: AnalysisModule,
      imports: [ProjectsModule, AudienceModule, SpendModule],
      controllers: [AnalysisSettingsController, AnalysisController],
      providers: [
        AnalysisSettingsService,
        AnalysisService,
        ThreadsService,
        ...queueProviders,
        {
          provide: AUTOMATIC_ANALYSIS,
          inject: [PG_POOL],
          useFactory: (pool: Pool): AutomaticAnalysis =>
            automaticAnalysis ?? { isOn: async (projectId: string) => (await effectiveAnalysisSettings(pool, projectId)).automatic },
        },
      ],
      exports: [AnalysisSettingsService, AnalysisService, AUTOMATIC_ANALYSIS],
    };
  }
}
