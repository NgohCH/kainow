import { Module } from '@nestjs/common';
import { MaintainersService, ResourceSettingsService } from './settings.service';
import { MaintainersController, ResourceSettingsController } from './settings.controller';

@Module({
  controllers: [ResourceSettingsController, MaintainersController],
  providers: [ResourceSettingsService, MaintainersService],
  exports: [ResourceSettingsService, MaintainersService],
})
export class ResourcesModule {}
