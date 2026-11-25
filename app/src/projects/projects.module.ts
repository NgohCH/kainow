import { Module } from '@nestjs/common';
import { ProfileController } from '../users/profile.controller';
import { ProfileService } from '../users/profile.service';
import { ProjectAccess } from './access.service';
import { InvitationsController } from './invitations.controller';
import { InvitationsService } from './invitations.service';
import { HoldsService } from './holds.service';
import { DepartmentTransferService } from './department-transfer.service';
import { GrantsController } from './grants.controller';
import { GrantsService } from './grants.service';
import { MembersController } from './members.controller';
import { MembershipsService } from './memberships.service';
import { OrganisationController } from './organisation.controller';
import { OrganisationService } from './organisation.service';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';
import { StageTemplatesController } from './stage-templates.controller';
import { StageTemplatesService } from './stage-templates.service';

@Module({
  controllers: [OrganisationController, ProjectsController, MembersController, InvitationsController, GrantsController, StageTemplatesController, ProfileController],
  providers: [ProjectAccess, OrganisationService, ProjectsService, MembershipsService, InvitationsService, HoldsService, GrantsService, DepartmentTransferService, StageTemplatesService, ProfileService],
  exports: [ProjectAccess, OrganisationService, InvitationsService, StageTemplatesService],
})
export class ProjectsModule {}
