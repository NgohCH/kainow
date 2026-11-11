import { Controller, Get, NotFoundException, Query, Req } from '@nestjs/common';
import { AnySignedInUser } from '../auth/access';
import type { HttpRequest } from '../auth/auth.guard';
import type { AuthUser } from '../auth/tokens';
import { SearchService } from './search.service';

const who = (req: HttpRequest): AuthUser => {
  const user = req.auth?.user;
  if (!user) throw new NotFoundException();
  return user;
};

/** Cross-project search. Which projects are searched is decided per project inside the service. */
@Controller('search')
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  /** ?q=…&kinds=task,decision&archived=1&project=<uuid>&offset=0 */
  @Get()
  @AnySignedInUser()
  search(@Query() query: Record<string, unknown>, @Req() req: HttpRequest) {
    return this.searchService.search(who(req), query ?? {});
  }
}
