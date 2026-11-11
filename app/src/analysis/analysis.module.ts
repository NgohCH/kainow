import { type DynamicModule, Module } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from '../db/database.module';
import { AUTOMATIC_ANALYSIS, type AutomaticAnalysis } from '../discussion/automatic-analysis';
import { ProjectsModule } from '../projects/projects.module';
import { AnalysisSettingsController } from './settings.controller';
import { AnalysisSettingsService, effectiveAnalysisSettings } from './settings.service';

@Module({})
export class AnalysisModule {
  /** `automaticAnalysis` replaces the real reader in tests only. */
  static register(automaticAnalysis?: AutomaticAnalysis): DynamicModule {
    return {
      module: AnalysisModule,
      imports: [ProjectsModule],
      controllers: [AnalysisSettingsController],
      providers: [
        AnalysisSettingsService,
        {
          provide: AUTOMATIC_ANALYSIS,
          inject: [PG_POOL],
          useFactory: (pool: Pool): AutomaticAnalysis =>
            automaticAnalysis ?? { isOn: async (projectId: string) => (await effectiveAnalysisSettings(pool, projectId)).automatic },
        },
      ],
      exports: [AnalysisSettingsService, AUTOMATIC_ANALYSIS],
    };
  }
}
