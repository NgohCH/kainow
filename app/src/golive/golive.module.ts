import { Module } from '@nestjs/common';
import { GoLiveController } from './golive.controller';
import { GoLiveService } from './golive.service';

@Module({ controllers: [GoLiveController], providers: [GoLiveService] })
export class GoLiveModule {}
