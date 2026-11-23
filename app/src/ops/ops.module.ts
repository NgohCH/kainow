import { Module } from '@nestjs/common';
import { OperationsController } from './operations.controller';
import { OperationsService } from './operations.service';
import { OpsSettingsService } from './settings.service';
import { UpdatesController } from '../updater/updates.controller';

@Module({
  controllers: [OperationsController, UpdatesController],
  providers: [OperationsService, OpsSettingsService],
  exports: [OperationsService, OpsSettingsService],
})
export class OpsModule {}
