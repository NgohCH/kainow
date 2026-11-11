import { Module } from '@nestjs/common';
import { NotesController } from './notes.controller';
import { NotesService } from './notes.service';
import { AudienceModule } from '../discussion/audience.module';
import { ProjectsModule } from '../projects/projects.module';

@Module({
  imports: [ProjectsModule, AudienceModule],
  controllers: [NotesController],
  providers: [NotesService],
  exports: [NotesService],
})
export class NotesModule {}
