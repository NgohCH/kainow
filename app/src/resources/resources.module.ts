import { Module } from '@nestjs/common';
import { CatalogueController } from './catalogue.controller';
import { CatalogueService } from './catalogue.service';
import { MaintainersService, ResourceSettingsService } from './settings.service';
import { MaintainersController, ResourceSettingsController } from './settings.controller';

@Module({
  controllers: [ResourceSettingsController, MaintainersController, CatalogueController],
  providers: [ResourceSettingsService, MaintainersService, CatalogueService],
  exports: [ResourceSettingsService, MaintainersService, CatalogueService],
})
export class ResourcesModule {}
