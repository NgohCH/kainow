import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { EmailController } from '../email/email.controller';
import { NotificationsController } from './notifications.controller';
import { NotificationSettingsController } from './settings.controller';
import { NotificationSettingsService } from './settings.service';

@Module({
  imports: [ProjectsModule],
  controllers: [NotificationSettingsController, NotificationsController, EmailController],
  providers: [NotificationSettingsService],
  exports: [NotificationSettingsService],
})
export class NotificationsModule {}
