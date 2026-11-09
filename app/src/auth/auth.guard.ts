import { timingSafeEqual } from 'node:crypto';
import { CanActivate, ConflictException, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { OrganisationState } from '../organisation/state';
import { ACCESS_KEY, BEFORE_SETUP_KEY, type Access } from './access';
import { AuthService } from './auth.service';
import { readCookie } from './cookies';
import { can } from './permissions';
import { SESSION_COOKIE, type AuthContext } from './tokens';

export interface HttpRequest {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  auth?: AuthContext;
}

export const CSRF_HEADER = 'x-csrf-token';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Applied to every route. Default deny. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
    private readonly organisation: OrganisationState,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const access = this.reflector.getAllAndOverride<Access | undefined>(ACCESS_KEY, [context.getHandler(), context.getClass()]);
    if (!access) {
      throw new ForbiddenException();
    }
    // Until the organisation is set up, only sign-in, setup and onboarding answer.
    const beforeSetup = this.reflector.getAllAndOverride<boolean | undefined>(BEFORE_SETUP_KEY, [context.getHandler(), context.getClass()]);
    if (!beforeSetup && !(await this.organisation.isRegistered())) {
      throw new ConflictException('Set up the organisation first.');
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
    // Anti-forgery: a request that changes anything must carry the token that only this page was given.
    if (!SAFE_METHODS.has((request.method ?? '').toUpperCase())) {
      const sent = request.headers[CSRF_HEADER];
      if (typeof sent !== 'string' || !sameToken(sent, this.auth.csrfToken(auth.sessionId))) {
        throw new ForbiddenException('Missing or wrong anti-forgery token. Reload the page and try again.');
      }
    }
    request.auth = auth;
    return true;
  }
}
