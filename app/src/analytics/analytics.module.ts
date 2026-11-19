import { Module } from '@nestjs/common';
import { AnalyticsController } from './analytics.controller';
import { PanelsService } from './panels.service';

@Module({
  controllers: [AnalyticsController],
  providers: [PanelsService],
  exports: [PanelsService],
})
export class AnalyticsModule {}
