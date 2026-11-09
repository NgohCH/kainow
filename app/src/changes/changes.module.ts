import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { PolicyController } from './policy.controller';
import { PolicyService } from './policy.service';

@Module({
  imports: [ProjectsModule],
  controllers: [PolicyController],
  providers: [PolicyService],
  exports: [PolicyService],
})
export class ChangesModule {}
