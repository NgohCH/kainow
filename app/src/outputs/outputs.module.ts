import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { OutputSettingsService } from './output-settings.service';
import { ReportTypesService } from './report-types.service';
import { SettingsController } from './settings.controller';

@Module({
  imports: [ProjectsModule],
  controllers: [SettingsController],
  providers: [ReportTypesService, OutputSettingsService],
  exports: [ReportTypesService, OutputSettingsService],
})
export class OutputsModule {}
