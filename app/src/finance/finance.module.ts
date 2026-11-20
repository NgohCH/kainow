import { Module } from '@nestjs/common';
import { ChangesModule } from '../changes/changes.module';
import { ChangesService } from '../changes/changes.service';
import { ProjectsModule } from '../projects/projects.module';
import { FinanceSettingsController } from './finance-settings.controller';
import { FinanceSettingsService } from './finance-settings.service';
import { FinanceController } from './finance.controller';
import { FinanceService } from './finance.service';
import { financeAdjustmentHandler, setBudgetHandler } from './handlers';

@Module({
  imports: [ProjectsModule, ChangesModule],
  controllers: [FinanceSettingsController, FinanceController],
  providers: [FinanceSettingsService, FinanceService],
  exports: [FinanceSettingsService, FinanceService],
})
export class FinanceModule {
  /** The budget and adjustment kinds go through the existing approval process (spec 3.6), as RecordsService registers its own. */
  constructor(changes: ChangesService) {
    changes.register(setBudgetHandler());
    changes.register(financeAdjustmentHandler());
  }
}
