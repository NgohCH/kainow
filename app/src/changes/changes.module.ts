import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { ChangesController } from './changes.controller';
import { ChangesService } from './changes.service';
import { PolicyController } from './policy.controller';
import { PolicyService } from './policy.service';

@Module({
  imports: [ProjectsModule],
  controllers: [PolicyController, ChangesController],
  providers: [PolicyService, ChangesService],
  exports: [PolicyService, ChangesService],
})
export class ChangesModule {}
