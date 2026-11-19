import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { FinanceSettingsController } from './finance-settings.controller';
import { FinanceSettingsService } from './finance-settings.service';
import { FinanceController } from './finance.controller';
import { FinanceService } from './finance.service';

@Module({
  imports: [ProjectsModule],
  controllers: [FinanceSettingsController, FinanceController],
  providers: [FinanceSettingsService, FinanceService],
  exports: [FinanceSettingsService, FinanceService],
})
export class FinanceModule {}
