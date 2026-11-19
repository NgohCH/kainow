import { Module } from '@nestjs/common';
import { AnalyticsController } from './analytics.controller';
import { PanelsService } from './panels.service';
import { SystemService } from './system.service';
import { TrendsService } from './trends.service';

@Module({
  controllers: [AnalyticsController],
  providers: [PanelsService, SystemService, TrendsService],
  exports: [PanelsService],
})
export class AnalyticsModule {}
