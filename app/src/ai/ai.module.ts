import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { LimitsController } from './limits.controller';
import { LimitsService } from './limits.service';
import { ModelsController } from './models.controller';
import { ModelsService } from './models.service';

@Module({
  imports: [ProjectsModule],
  controllers: [ModelsController, LimitsController],
  providers: [ModelsService, LimitsService],
  exports: [ModelsService, LimitsService],
})
export class AiModule {}
