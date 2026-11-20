import { Module } from '@nestjs/common';
import { StorageController } from './storage.controller';
import { StorageSettingsService } from './settings.service';

@Module({
  controllers: [StorageController],
  providers: [StorageSettingsService],
  exports: [StorageSettingsService],
})
export class StorageModule {}
