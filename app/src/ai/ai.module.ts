import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { ConnectionsController } from './connections.controller';
import { ConnectionsService } from './connections.service';
import { LimitsController } from './limits.controller';
import { LimitsService } from './limits.service';
import { ModelsController } from './models.controller';
import { ModelsService } from './models.service';

@Module({
  imports: [ProjectsModule],
  controllers: [ModelsController, LimitsController, ConnectionsController],
  providers: [ModelsService, LimitsService, ConnectionsService],
  exports: [ModelsService, LimitsService, ConnectionsService],
})
export class AiModule {}
