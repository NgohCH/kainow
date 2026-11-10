import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { NotificationsController } from './notifications.controller';
import { NotificationSettingsController } from './settings.controller';
import { NotificationSettingsService } from './settings.service';

@Module({
  imports: [ProjectsModule],
  controllers: [NotificationSettingsController, NotificationsController],
  providers: [NotificationSettingsService],
  exports: [NotificationSettingsService],
})
export class NotificationsModule {}
