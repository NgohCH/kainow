import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { DashboardsController } from './dashboards.controller';
import { ProjectDashboardService } from './project-dashboard.service';

@Module({
  imports: [ProjectsModule],
  controllers: [DashboardsController],
  providers: [ProjectDashboardService],
})
export class DashboardsModule {}
