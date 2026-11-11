import { Module, type DynamicModule, type Provider } from '@nestjs/common';
import { ExtractionController } from './extraction.controller';
import { ExtractionService } from './extraction.service';
import { ChangesModule } from '../changes/changes.module';
import { AudienceModule } from '../discussion/audience.module';
import { ProjectsModule } from '../projects/projects.module';
import { RecordsController } from '../records/records.controller';
import { RecordsService } from '../records/records.service';
import { EXTRACTION_QUEUE, PgBossExtractionQueue, type ExtractionQueue } from './queue';

@Module({})
export class ExtractionModule {
  /** Pass a queue only in tests; otherwise runs are handed to the worker through pg-boss. */
  static register(queue?: ExtractionQueue): DynamicModule {
    const providers: Provider[] = queue
      ? [{ provide: EXTRACTION_QUEUE, useValue: queue }]
      : [PgBossExtractionQueue, { provide: EXTRACTION_QUEUE, useExisting: PgBossExtractionQueue }];
    // Global so publishing (discussion) can ask for an automatic run through the one service built with the real queue.
    return {
      module: ExtractionModule,
      global: true,
      imports: [ProjectsModule, ChangesModule, AudienceModule],
      controllers: [ExtractionController, RecordsController],
      providers: [ExtractionService, RecordsService, ...providers],
      exports: [ExtractionService],
    };
  }
}
