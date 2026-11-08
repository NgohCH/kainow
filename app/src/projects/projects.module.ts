import { Module } from '@nestjs/common';
import { ProjectAccess } from './access.service';
import { OrganisationController } from './organisation.controller';
import { OrganisationService } from './organisation.service';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';

@Module({
  controllers: [OrganisationController, ProjectsController],
  providers: [ProjectAccess, OrganisationService, ProjectsService],
  exports: [ProjectAccess, OrganisationService],
})
export class ProjectsModule {}
