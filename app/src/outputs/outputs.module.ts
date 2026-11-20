import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { OutputSettingsService } from './output-settings.service';
import { OutputsController } from './outputs.controller';
import { OutputsService } from './outputs.service';
import { ReportTypesService } from './report-types.service';
import { SettingsController } from './settings.controller';

@Module({
  imports: [ProjectsModule],
  controllers: [SettingsController, OutputsController],
  providers: [ReportTypesService, OutputSettingsService, OutputsService],
  exports: [ReportTypesService, OutputSettingsService, OutputsService],
})
export class OutputsModule {}
