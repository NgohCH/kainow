import { Module } from '@nestjs/common';
import { PreferencesService } from '../dashboards/preferences.service';
import { LeadershipGrantsService } from './grants.service';
import { LeadershipController, LeadershipSummaryController } from './leadership.controller';
import { LeadershipSummaryService } from './summary.service';

@Module({
  controllers: [LeadershipController, LeadershipSummaryController],
  providers: [LeadershipGrantsService, LeadershipSummaryService, PreferencesService],
  exports: [LeadershipGrantsService],
})
export class LeadershipModule {}
