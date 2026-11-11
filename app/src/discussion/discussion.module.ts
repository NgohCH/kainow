import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { AudienceService } from './audience.service';
import { ThreadsController } from './threads.controller';
import { ThreadsService } from './threads.service';

@Module({
  imports: [ProjectsModule],
  controllers: [ThreadsController],
  providers: [AudienceService, ThreadsService],
  exports: [AudienceService, ThreadsService],
})
export class DiscussionModule {}
