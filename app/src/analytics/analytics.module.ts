import { Module } from '@nestjs/common';
import { AnalyticsController } from './analytics.controller';
import { DrillService } from './drill.service';
import { PanelsService } from './panels.service';
import { OpsModule } from '../ops/ops.module';
import { OperationsPanelService } from './operations.service';
import { ResourcesModule } from '../resources/resources.module';
import { ResourcesPanelService } from './resources-panel';
import { SystemService } from './system.service';
import { TrendsService } from './trends.service';
import { ViewsService } from './views.service';

@Module({
  imports: [ResourcesModule, OpsModule],
  controllers: [AnalyticsController],
  providers: [PanelsService, ResourcesPanelService, SystemService, TrendsService, DrillService, ViewsService, OperationsPanelService],
  exports: [PanelsService],
})
export class AnalyticsModule {}
