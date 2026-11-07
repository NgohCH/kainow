import { Module, type DynamicModule, type Provider } from '@nestjs/common';
import { ExtractionController } from './extraction.controller';
import { ExtractionService } from './extraction.service';
import { EXTRACTION_QUEUE, PgBossExtractionQueue, type ExtractionQueue } from './queue';

@Module({})
export class ExtractionModule {
  /** Pass a queue only in tests; otherwise runs are handed to the worker through pg-boss. */
  static register(queue?: ExtractionQueue): DynamicModule {
    const providers: Provider[] = queue
      ? [{ provide: EXTRACTION_QUEUE, useValue: queue }]
      : [PgBossExtractionQueue, { provide: EXTRACTION_QUEUE, useExisting: PgBossExtractionQueue }];
    return { module: ExtractionModule, controllers: [ExtractionController], providers: [ExtractionService, ...providers] };
  }
}
