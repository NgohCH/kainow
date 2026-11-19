import { Module } from '@nestjs/common';
import { OrganisationProfileController } from './organisation.controller';
import { OrganisationProfileService } from './organisation.service';
import { SetupController } from './setup.controller';
import { SetupService } from './setup.service';
import { LetterheadWiring } from './letterhead-wiring';
import { AccessSettingsController } from './access-settings.controller';
import { AccessSettingsService } from './access-settings.service';

@Module({
  controllers: [OrganisationProfileController, SetupController, AccessSettingsController],
  providers: [OrganisationProfileService, SetupService, LetterheadWiring, AccessSettingsService],
  exports: [OrganisationProfileService, SetupService, AccessSettingsService],
})
export class OrganisationModule {}
