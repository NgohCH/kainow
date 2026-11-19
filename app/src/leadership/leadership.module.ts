import { Module } from '@nestjs/common';
import { LeadershipGrantsService } from './grants.service';
import { LeadershipController } from './leadership.controller';

@Module({
  controllers: [LeadershipController],
  providers: [LeadershipGrantsService],
  exports: [LeadershipGrantsService],
})
export class LeadershipModule {}
