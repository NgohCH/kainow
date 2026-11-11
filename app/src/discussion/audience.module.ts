import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { AudienceService } from './audience.service';

/** The audience rule on its own, so notes, extraction and discussion can all use it without importing each other. */
@Module({ imports: [ProjectsModule], providers: [AudienceService], exports: [AudienceService] })
export class AudienceModule {}
