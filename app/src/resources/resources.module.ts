import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { CatalogueController } from './catalogue.controller';
import { CatalogueService } from './catalogue.service';
import { LinesController } from './lines.controller';
import { LinesService } from './lines.service';
import { MaintainersService, ResourceSettingsService } from './settings.service';
import { MaintainersController, ResourceSettingsController } from './settings.controller';

@Module({
  imports: [ProjectsModule],
  controllers: [ResourceSettingsController, MaintainersController, CatalogueController, LinesController],
  providers: [ResourceSettingsService, MaintainersService, CatalogueService, LinesService],
  exports: [ResourceSettingsService, MaintainersService, CatalogueService, LinesService],
})
export class ResourcesModule {}
