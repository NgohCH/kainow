import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ACCESS_KEY, type Access } from './access';
import { AuthService } from './auth.service';
import { readCookie } from './cookies';
import { can } from './permissions';
import { SESSION_COOKIE, type AuthContext } from './tokens';

export interface HttpRequest {
  headers: Record<string, string | string[] | undefined>;
  auth?: AuthContext;
}

/** Applied to every route. Default deny. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const access = this.reflector.getAllAndOverride<Access | undefined>(ACCESS_KEY, [context.getHandler(), context.getClass()]);
    if (!access) {
      throw new ForbiddenException();
    }
    if (access.kind === 'public') {
      return true;
    }
    const request = context.switchToHttp().getRequest<HttpRequest>();
    const token = readCookie(request.headers.cookie, SESSION_COOKIE);
    const auth = token ? await this.auth.resolveSession(token) : null;
    if (!auth) {
      throw new UnauthorizedException();
    }
    if (access.kind === 'action' && !can(auth.user.role, access.action)) {
      throw new ForbiddenException();
    }
    request.auth = auth;
    return true;
  }
}
