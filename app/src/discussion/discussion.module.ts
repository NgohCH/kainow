import { type DynamicModule, Module } from '@nestjs/common';
import { AnalysisModule } from '../analysis/analysis.module';
import { AnalysisService } from '../analysis/analysis.service';
import type { AnalysisQueue } from '../analysis/queue';
import { NotesModule } from '../notes/notes.module';
import { ProjectsModule } from '../projects/projects.module';
import type { AutomaticAnalysis } from './automatic-analysis';
import { AudienceController } from './audience.controller';
import { AudienceModule } from './audience.module';
import { FeedbackController } from './feedback.controller';
import { FeedbackService } from './feedback.service';
import { MEETING_END_HOOK, type MeetingEndHook, MeetingsService } from './meetings.service';
import { MeetingsController } from './meetings.controller';
import { PublishingController } from './publishing.controller';
import { PublishingService } from './publishing.service';
import { ThreadsController } from './threads.controller';
import { ThreadsService } from './threads.service';

@Module({})
export class DiscussionModule {
  /**
   * When a meeting ends, AnalysisService requests the final draft; `meetingEndHook` replaces that in tests only.
   * `automaticAnalysis` and `analysisQueue` replace the real settings reader and queue in tests only (AnalysisModule binds them).
   */
  static register(meetingEndHook?: MeetingEndHook, automaticAnalysis?: AutomaticAnalysis, analysisQueue?: AnalysisQueue): DynamicModule {
    return {
      module: DiscussionModule,
      imports: [ProjectsModule, AudienceModule, NotesModule, AnalysisModule.register(automaticAnalysis, analysisQueue)],
      controllers: [AudienceController, ThreadsController, MeetingsController, PublishingController, FeedbackController],
      providers: [
        ThreadsService,
        MeetingsService,
        PublishingService,
        FeedbackService,
        { provide: MEETING_END_HOOK, inject: [AnalysisService], useFactory: (analysis: AnalysisService): MeetingEndHook => meetingEndHook ?? analysis },
      ],
      exports: [AudienceModule, ThreadsService, MeetingsService, FeedbackService],
    };
  }
}
