import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { DigestsController } from './digests.controller';
import { DigestsService } from './digests.service';

@Module({ imports: [ProjectsModule], controllers: [DigestsController], providers: [DigestsService] })
export class DigestsModule {}
