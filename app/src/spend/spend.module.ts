import { Module } from '@nestjs/common';
import { SpendController } from './spend.controller';
import { SpendService } from './spend.service';
import { SpendSettingsService } from './spend.settings';

@Module({
  controllers: [SpendController],
  providers: [SpendService, SpendSettingsService],
  exports: [SpendService, SpendSettingsService],
})
export class SpendModule {}
