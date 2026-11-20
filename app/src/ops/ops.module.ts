import { Module } from '@nestjs/common';
import { OperationsController } from './operations.controller';
import { OperationsService } from './operations.service';
import { OpsSettingsService } from './settings.service';

@Module({
  controllers: [OperationsController],
  providers: [OperationsService, OpsSettingsService],
  exports: [OperationsService, OpsSettingsService],
})
export class OpsModule {}
