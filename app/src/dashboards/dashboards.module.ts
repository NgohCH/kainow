import { Module } from '@nestjs/common';
import { ChangesModule } from '../changes/changes.module';
import { ProjectsModule } from '../projects/projects.module';
import { DashboardsController } from './dashboards.controller';
import { PersonalDashboardService } from './personal.service';
import { PreferencesService } from './preferences.service';
import { ProjectDashboardService } from './project-dashboard.service';
import { TimelineService } from './timeline.service';

@Module({
  imports: [ProjectsModule, ChangesModule],
  controllers: [DashboardsController],
  providers: [ProjectDashboardService, TimelineService, PreferencesService, PersonalDashboardService],
})
export class DashboardsModule {}
