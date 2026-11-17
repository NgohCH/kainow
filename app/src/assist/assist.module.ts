import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { AudienceModule } from '../discussion/audience.module';
import { NotesModule } from '../notes/notes.module';
import { ProjectsModule } from '../projects/projects.module';
import { ASSIST_QUEUE, type AssistQueue, PgBossAssistQueue } from './queue';
import { QuestionsController } from './questions.controller';
import { QuestionsService } from './questions.service';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { ReviewController } from './review.controller';
import { ReviewService } from './review.service';
import { SummariesController } from './summaries.controller';
import { SummariesService } from './summaries.service';

/** AI questions, report drafts and summaries (sub-project 4b). The AI part runs on the worker (AssistRunner). */
@Module({})
export class AssistModule {
  /** `queue` replaces the pg-boss queue in tests only. */
  static register(queue?: AssistQueue): DynamicModule {
    const queueProviders: Provider[] = queue
      ? [{ provide: ASSIST_QUEUE, useValue: queue }]
      : [PgBossAssistQueue, { provide: ASSIST_QUEUE, useExisting: PgBossAssistQueue }];
    return {
      module: AssistModule,
      imports: [ProjectsModule, AudienceModule, NotesModule],
      controllers: [QuestionsController, ReportsController, ReviewController, SummariesController],
      providers: [QuestionsService, ReportsService, ReviewService, SummariesService, ...queueProviders],
      exports: [QuestionsService],
    };
  }
}
