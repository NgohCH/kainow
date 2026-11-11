import { Module } from '@nestjs/common';
import { ProjectAccess } from './access.service';
import { InvitationsController } from './invitations.controller';
import { InvitationsService } from './invitations.service';
import { HoldsService } from './holds.service';
import { GrantsController } from './grants.controller';
import { GrantsService } from './grants.service';
import { MembersController } from './members.controller';
import { MembershipsService } from './memberships.service';
import { OrganisationController } from './organisation.controller';
import { OrganisationService } from './organisation.service';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';

@Module({
  controllers: [OrganisationController, ProjectsController, MembersController, InvitationsController, GrantsController],
  providers: [ProjectAccess, OrganisationService, ProjectsService, MembershipsService, InvitationsService, HoldsService, GrantsService],
  exports: [ProjectAccess, OrganisationService],
})
export class ProjectsModule {}
