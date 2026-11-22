import { timingSafeEqual } from 'node:crypto';
import { CanActivate, ConflictException, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { OrganisationState } from '../organisation/state';
import { SAFE_METHODS, protectiveRefusal } from '../ops/protective';
import { OperationsState } from '../ops/state';
import { ACCESS_KEY, ALLOWED_WHEN_PROTECTIVE_KEY, BEFORE_SETUP_KEY, type Access } from './access';
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
    private readonly operations: OperationsState,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const access = this.reflector.getAllAndOverride<Access | undefined>(ACCESS_KEY, [context.getHandler(), context.getClass()]);
    if (!access) {
      throw new ForbiddenException();
    }
    const request = context.switchToHttp().getRequest<HttpRequest>();
    const changes = !SAFE_METHODS.has((request.method ?? '').toUpperCase());
    // Protective read-only mode (spec 7.3): before the public early return, so public routes are refused too. Only a
    // request that could change something asks, so reads never wait on the state.
    if (changes) {
      const allowed = this.reflector.getAllAndOverride<boolean | undefined>(ALLOWED_WHEN_PROTECTIVE_KEY, [context.getHandler(), context.getClass()]);
      if (!allowed && (await this.operations.isProtective())) {
        throw protectiveRefusal((await this.operations.current()).reason);
      }
    }
    // Until the organisation is set up, only sign-in, setup and onboarding answer. Someone not signed in is told to
    // sign in first, as before; the setup state is no one else's business.
    const beforeSetup = this.reflector.getAllAndOverride<boolean | undefined>(BEFORE_SETUP_KEY, [context.getHandler(), context.getClass()]);
    const gate = async () => {
      if (!beforeSetup && !(await this.organisation.isRegistered())) throw new ConflictException('Set up the organisation first.');
    };
    if (access.kind === 'public') {
      await gate();
      return true;
    }
    const token = readCookie(request.headers.cookie, SESSION_COOKIE);
    const auth = token ? await this.auth.resolveSession(token) : null;
    if (!auth) {
      throw new UnauthorizedException();
    }
    await gate();
    if (access.kind === 'action' && ![access.action, ...(access.alsoAllowed ?? [])].some((a) => can(auth.user.role, a))) {
      throw new ForbiddenException();
    }
    // Anti-forgery: a request that changes anything must carry the token that only this page was given.
    if (changes) {
      const sent = request.headers[CSRF_HEADER];
      if (typeof sent !== 'string' || !sameToken(sent, this.auth.csrfToken(auth.sessionId))) {
        throw new ForbiddenException('Missing or wrong anti-forgery token. Reload the page and try again.');
      }
    }
    request.auth = auth;
    return true;
  }
}
