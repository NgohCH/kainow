import { Module } from '@nestjs/common';
import { AudienceModule } from '../discussion/audience.module';
import { ProjectsModule } from '../projects/projects.module';
import { HistoryController } from './history.controller';
import { RecordDelegationService } from './delegation.service';
import { HistoryService } from './history.service';
import { RecordsDeletionService } from './records-deletion.service';
import { SourcesDeletionService } from './sources-deletion.service';

/** Deleting and restoring sources and records, and the project's history of it (history spec 4). */
@Module({
  imports: [ProjectsModule, AudienceModule],
  controllers: [HistoryController],
  providers: [SourcesDeletionService, RecordsDeletionService, RecordDelegationService, HistoryService],
  exports: [SourcesDeletionService, RecordsDeletionService],
})
export class HistoryModule {}
