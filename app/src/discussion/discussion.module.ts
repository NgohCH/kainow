import { type DynamicModule, Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { AudienceService } from './audience.service';
import { MEETING_END_HOOK, type MeetingEndHook, NO_MEETING_END_HOOK, MeetingsService } from './meetings.service';
import { MeetingsController } from './meetings.controller';
import { ThreadsController } from './threads.controller';
import { ThreadsService } from './threads.service';

@Module({})
export class DiscussionModule {
  /** Pass a hook only in tests (or when Task 10 binds the real one); the default does nothing when a meeting ends. */
  static register(meetingEndHook: MeetingEndHook = NO_MEETING_END_HOOK): DynamicModule {
    return {
      module: DiscussionModule,
      imports: [ProjectsModule],
      controllers: [ThreadsController, MeetingsController],
      providers: [AudienceService, ThreadsService, MeetingsService, { provide: MEETING_END_HOOK, useValue: meetingEndHook }],
      exports: [AudienceService, ThreadsService, MeetingsService],
    };
  }
}
