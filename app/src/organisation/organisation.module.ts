import { Module } from '@nestjs/common';
import { OrganisationProfileController } from './organisation.controller';
import { OrganisationProfileService } from './organisation.service';

@Module({
  controllers: [OrganisationProfileController],
  providers: [OrganisationProfileService],
  exports: [OrganisationProfileService],
})
export class OrganisationModule {}
