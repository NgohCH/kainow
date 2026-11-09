import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';

@Module({
  imports: [ProjectsModule],
  controllers: [SearchController],
  providers: [SearchService],
})
export class SearchModule {}
