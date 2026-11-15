import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { ASSIST_QUEUE, type AssistQueue, PgBossAssistQueue } from './queue';
import { QuestionsController } from './questions.controller';
import { QuestionsService } from './questions.service';

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
      imports: [ProjectsModule],
      controllers: [QuestionsController],
      providers: [QuestionsService, ...queueProviders],
      exports: [QuestionsService],
    };
  }
}
