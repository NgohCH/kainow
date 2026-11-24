import { type DynamicModule, Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { ChangesModule } from '../changes/changes.module';
import { GoLiveModule } from '../golive/golive.module';
import { LeadershipModule } from '../leadership/leadership.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { OpsModule } from '../ops/ops.module';
import { OrganisationModule } from '../organisation/organisation.module';
import { OutputsModule } from '../outputs/outputs.module';
import { ProjectsModule } from '../projects/projects.module';
import { QuarantineModule } from '../quarantine/quarantine.module';
import { ResourcesModule } from '../resources/resources.module';
import { SettingsSummaryController } from './settings-summary.controller';
import { SettingsSummaryService } from './settings-summary.service';

@Module({})
export class SettingsSummaryModule {
  /** `discussion` is the app's own DiscussionModule instance (it is dynamic); it exports the feedback service. */
  static register(discussion: DynamicModule): DynamicModule {
    return {
      module: SettingsSummaryModule,
      imports: [
        AiModule, ChangesModule, GoLiveModule, LeadershipModule, NotificationsModule, OpsModule, OrganisationModule, OutputsModule,
        ProjectsModule, QuarantineModule, ResourcesModule, discussion,
      ],
      controllers: [SettingsSummaryController],
      providers: [SettingsSummaryService],
    };
  }
}
