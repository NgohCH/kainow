import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { ChangesController } from './changes.controller';
import { ChangesService } from './changes.service';
import { ClosureController } from './closure.controller';
import { ClosureService } from './closure.service';
import { FlagsService } from './flags.service';
import { PolicyController } from './policy.controller';
import { PolicyService } from './policy.service';

@Module({
  imports: [ProjectsModule],
  controllers: [PolicyController, ChangesController, ClosureController],
  providers: [PolicyService, ChangesService, FlagsService, ClosureService],
  exports: [PolicyService, ChangesService, FlagsService],
})
export class ChangesModule {}
