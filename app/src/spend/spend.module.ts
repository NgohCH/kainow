import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { SpendController } from './spend.controller';
import { SpendService } from './spend.service';
import { SpendSettingsService } from './spend.settings';

@Module({
  imports: [ProjectsModule],
  controllers: [SpendController],
  providers: [SpendService, SpendSettingsService],
  exports: [SpendService, SpendSettingsService],
})
export class SpendModule {}
