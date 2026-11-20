import { Module } from '@nestjs/common';
import { ChangesModule } from '../changes/changes.module';
import { ProjectsModule } from '../projects/projects.module';
import { OutputAudienceService } from './audience';
import { ExportsController } from './exports.controller';
import { ExportsService } from './exports';
import { OutputFilesService } from './output-files.service';
import { OutputSettingsService } from './output-settings.service';
import { OutputsController } from './outputs.controller';
import { OutputsService } from './outputs.service';
import { ReportTypesService } from './report-types.service';
import { SettingsController } from './settings.controller';

@Module({
  imports: [ProjectsModule, ChangesModule],
  controllers: [SettingsController, OutputsController, ExportsController],
  providers: [ReportTypesService, OutputSettingsService, OutputsService, OutputAudienceService, OutputFilesService, ExportsService],
  exports: [ReportTypesService, OutputSettingsService, OutputsService],
})
export class OutputsModule {}
