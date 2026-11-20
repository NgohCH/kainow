import { Module } from '@nestjs/common';
import { FinanceModule } from '../finance/finance.module';
import { ProjectsModule } from '../projects/projects.module';
import { CatalogueController } from './catalogue.controller';
import { CatalogueService } from './catalogue.service';
import { LinesController } from './lines.controller';
import { LinesService } from './lines.service';
import { ResourcesReportService } from './report.service';
import { MaintainersService, ResourceSettingsService } from './settings.service';
import { MaintainersController, ResourceSettingsController } from './settings.controller';

@Module({
  imports: [ProjectsModule, FinanceModule],
  controllers: [ResourceSettingsController, MaintainersController, CatalogueController, LinesController],
  providers: [ResourceSettingsService, MaintainersService, CatalogueService, LinesService, ResourcesReportService],
  exports: [ResourceSettingsService, MaintainersService, CatalogueService, LinesService, ResourcesReportService],
})
export class ResourcesModule {}
