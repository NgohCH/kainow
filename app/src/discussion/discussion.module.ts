import { type DynamicModule, Module } from '@nestjs/common';
import { AnalysisModule } from '../analysis/analysis.module';
import { NotesModule } from '../notes/notes.module';
import { ProjectsModule } from '../projects/projects.module';
import type { AutomaticAnalysis } from './automatic-analysis';
import { AudienceController } from './audience.controller';
import { AudienceModule } from './audience.module';
import { MEETING_END_HOOK, type MeetingEndHook, NO_MEETING_END_HOOK, MeetingsService } from './meetings.service';
import { MeetingsController } from './meetings.controller';
import { PublishingController } from './publishing.controller';
import { PublishingService } from './publishing.service';
import { ThreadsController } from './threads.controller';
import { ThreadsService } from './threads.service';

@Module({})
export class DiscussionModule {
  /**
   * Pass a hook only in tests (or when Task 10 binds the real one); the default does nothing when a meeting ends.
   * `automaticAnalysis` replaces the real settings reader in tests only (AnalysisModule binds the token).
   */
  static register(meetingEndHook: MeetingEndHook = NO_MEETING_END_HOOK, automaticAnalysis?: AutomaticAnalysis): DynamicModule {
    return {
      module: DiscussionModule,
      imports: [ProjectsModule, AudienceModule, NotesModule, AnalysisModule.register(automaticAnalysis)],
      controllers: [AudienceController, ThreadsController, MeetingsController, PublishingController],
      providers: [
        ThreadsService,
        MeetingsService,
        PublishingService,
        { provide: MEETING_END_HOOK, useValue: meetingEndHook },
      ],
      exports: [AudienceModule, ThreadsService, MeetingsService],
    };
  }
}
