import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { DashboardsController } from './dashboards.controller';
import { PreferencesService } from './preferences.service';
import { ProjectDashboardService } from './project-dashboard.service';
import { TimelineService } from './timeline.service';

@Module({
  imports: [ProjectsModule],
  controllers: [DashboardsController],
  providers: [ProjectDashboardService, TimelineService, PreferencesService],
})
export class DashboardsModule {}
