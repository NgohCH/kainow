import { Body, Controller, Get, NotFoundException, Put, Req } from '@nestjs/common';
import { AnySignedInUser } from '../auth/access';
import type { HttpRequest } from '../auth/auth.guard';
import type { AuthUser } from '../auth/tokens';
import { ProfileService } from './profile.service';
import { UsersService } from './users.service';

const who = (req: HttpRequest): AuthUser => {
  const user = req.auth?.user;
  if (!user) throw new NotFoundException();
  return user;
};

/** The signed-in person's own profile (D134); no route here takes another person's id. */
@Controller('me')
export class ProfileController {
  constructor(
    private readonly profiles: ProfileService,
    private readonly users: UsersService,
  ) {}

  /** → { name, email, department, roles, pastRoles } */
  @Get('profile')
  @AnySignedInUser()
  profile(@Req() req: HttpRequest) {
    return this.profiles.profile(who(req));
  }

  /** { departmentId | null } → { department }; information only, it gives no access. */
  @Put('department')
  @AnySignedInUser()
  async department(@Body() body: unknown, @Req() req: HttpRequest) {
    const user = who(req);
    return { department: await this.users.setDepartment(user.id, (body as { departmentId?: unknown } | null | undefined)?.departmentId, user.id) };
  }
}
