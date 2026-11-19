import { Module } from '@nestjs/common';
import { AnalyticsController } from './analytics.controller';
import { DrillService } from './drill.service';
import { PanelsService } from './panels.service';
import { SystemService } from './system.service';
import { TrendsService } from './trends.service';
import { ViewsService } from './views.service';

@Module({
  controllers: [AnalyticsController],
  providers: [PanelsService, SystemService, TrendsService, DrillService, ViewsService],
  exports: [PanelsService],
})
export class AnalyticsModule {}
