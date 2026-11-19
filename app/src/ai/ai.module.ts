import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { SpendModule } from '../spend/spend.module';
import { ConnectionsController } from './connections.controller';
import { ConnectionsService } from './connections.service';
import { LimitsController } from './limits.controller';
import { LimitsService } from './limits.service';
import { ModelsController } from './models.controller';
import { ModelsService } from './models.service';
import { UsageController } from './usage.controller';
import { UsageService } from './usage.service';

@Module({
  imports: [ProjectsModule, SpendModule],
  controllers: [ModelsController, LimitsController, ConnectionsController, UsageController],
  providers: [ModelsService, LimitsService, ConnectionsService, UsageService],
  exports: [ModelsService, LimitsService, ConnectionsService],
})
export class AiModule {}
