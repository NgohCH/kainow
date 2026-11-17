import { Module } from '@nestjs/common';
import { AudienceModule } from '../discussion/audience.module';
import { ProjectsModule } from '../projects/projects.module';
import { CasesService } from './cases.service';
import { QuarantineController } from './quarantine.controller';

/** Credential quarantine (history spec 7): reporting, holding, possible copies. The protected key comes from ProtectedKeyModule. */
@Module({
  imports: [ProjectsModule, AudienceModule],
  controllers: [QuarantineController],
  providers: [CasesService],
  exports: [CasesService],
})
export class QuarantineModule {}
