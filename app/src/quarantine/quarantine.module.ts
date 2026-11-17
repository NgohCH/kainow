import { Module } from '@nestjs/common';
import { AudienceModule } from '../discussion/audience.module';
import { ProjectsModule } from '../projects/projects.module';
import { CasesService } from './cases.service';
import { QuarantineController, SecurityController } from './quarantine.controller';
import { SecurityService } from './security.service';

/** Credential quarantine (history spec 7): reporting, holding, possible copies, review and release; security reviewers, grants, reveal and release unchanged. The protected key comes from ProtectedKeyModule. */
@Module({
  imports: [ProjectsModule, AudienceModule],
  controllers: [QuarantineController, SecurityController],
  providers: [CasesService, SecurityService],
  exports: [CasesService, SecurityService],
})
export class QuarantineModule {}
