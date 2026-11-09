import { Module } from '@nestjs/common';
import { OrganisationProfileController } from './organisation.controller';
import { OrganisationProfileService } from './organisation.service';
import { SetupController } from './setup.controller';
import { SetupService } from './setup.service';
import { LetterheadWiring } from './letterhead-wiring';

@Module({
  controllers: [OrganisationProfileController, SetupController],
  providers: [OrganisationProfileService, SetupService, LetterheadWiring],
  exports: [OrganisationProfileService, SetupService],
})
export class OrganisationModule {}
