import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { NotificationSettingsController } from './settings.controller';
import { NotificationSettingsService } from './settings.service';

@Module({
  imports: [ProjectsModule],
  controllers: [NotificationSettingsController],
  providers: [NotificationSettingsService],
  exports: [NotificationSettingsService],
})
export class NotificationsModule {}
