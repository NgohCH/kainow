import { BadRequestException, Body, Controller, Get, HttpCode, HttpException, HttpStatus, Inject, Logger, Post, Req, Res, UnauthorizedException } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config';
import { AllowedWhenProtective, AnySignedInUser, Public, BeforeSetup } from './access';
import type { HttpRequest } from './auth.guard';
import { AuthService } from './auth.service';
import { clearedCookie, sessionCookie } from './cookies';
import { TOO_MANY_REQUESTS, WindowLimiter, clientAddress } from './request-limit';
import { CLOCK, SESSION_COOKIE, type Clock } from './tokens';

interface HttpResponse {
  setHeader(name: string, value: string): void;
}

function field(body: unknown, name: string): unknown {
  return body && typeof body === 'object' ? (body as Record<string, unknown>)[name] : undefined;
}

/** Signing in and out still works in protective read-only mode (spec 7.3): each route below is marked. */
@BeforeSetup()
@Controller('auth')
export class AuthController {
  private readonly requestCodeLimit: WindowLimiter;
  private readonly verifyLimit: WindowLimiter;
  private readonly log = new Logger('SignInLimits');
  private lastOverallWarning = -1;

  constructor(
    private readonly auth: AuthService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    const l = config.signInLimits;
    this.requestCodeLimit = new WindowLimiter({ perAddress: l.requestCodePerAddress, overall: l.requestCodeOverall }, clock);
    this.verifyLimit = new WindowLimiter({ perAddress: l.verifyPerAddress, overall: l.verifyOverall }, clock);
  }

  /** Refuses with 429 once the address, or everyone together, is over the minute's limit (review G03). */
  private limit(limiter: WindowLimiter, step: string, req: HttpRequest): void {
    const address = clientAddress(req.socket?.remoteAddress, req.headers['x-forwarded-for'], this.config.trustProxyHops);
    const refused = limiter.take(address);
    if (!refused) return;
    if (refused === 'overall') {
      // One warning a minute at most, for alerting; it never names an address or an email.
      const minute = Math.floor(this.clock().getTime() / 60_000);
      if (minute !== this.lastOverallWarning) {
        this.lastOverallWarning = minute;
        this.log.warn(`overall request limit reached on ${step}; further requests this minute are refused`);
      }
    }
    throw new HttpException(TOO_MANY_REQUESTS, HttpStatus.TOO_MANY_REQUESTS);
  }

  /** Always answers the same way, whether or not the address has an account. */
  @Post('request-code')
  @AllowedWhenProtective()
  @Public()
  @HttpCode(202)
  async requestCode(@Body() body: unknown, @Req() req: HttpRequest): Promise<{ status: 'ok' }> {
    this.limit(this.requestCodeLimit, 'request-code', req);
    const email = field(body, 'email');
    if (typeof email !== 'string') {
      throw new BadRequestException('email is required');
    }
    await this.auth.requestCode(email);
    return { status: 'ok' };
  }

  @Post('verify')
  @AllowedWhenProtective()
  @Public()
  @HttpCode(200)
  async verify(@Body() body: unknown, @Req() req: HttpRequest, @Res({ passthrough: true }) res: HttpResponse) {
    this.limit(this.verifyLimit, 'verify', req);
    const email = field(body, 'email');
    const code = field(body, 'code');
    if (typeof email !== 'string' || typeof code !== 'string') {
      throw new BadRequestException('email and code are required');
    }
    const result = await this.auth.verifyCode(email, code);
    if (!result) {
      throw new UnauthorizedException('Invalid or expired code');
    }
    const maxAge = this.config.auth.sessionHours * 3600;
    res.setHeader('Set-Cookie', sessionCookie(SESSION_COOKIE, result.token, maxAge, this.config.cookieSecure));
    const session = await this.auth.resolveSession(result.token);
    return { user: result.user, csrfToken: session ? this.auth.csrfToken(session.sessionId) : null };
  }

  @Get('me')
  @AnySignedInUser()
  me(@Req() req: HttpRequest) {
    return { user: req.auth?.user, csrfToken: req.auth ? this.auth.csrfToken(req.auth.sessionId) : null };
  }

  @Post('logout-all')
  @AllowedWhenProtective()
  @AnySignedInUser()
  @HttpCode(204)
  async logoutAll(@Req() req: HttpRequest, @Res({ passthrough: true }) res: HttpResponse): Promise<void> {
    if (req.auth) {
      await this.auth.signOutAll(req.auth);
    }
    res.setHeader('Set-Cookie', clearedCookie(SESSION_COOKIE, this.config.cookieSecure));
  }

  @Post('logout')
  @AllowedWhenProtective()
  @AnySignedInUser()
  @HttpCode(204)
  async logout(@Req() req: HttpRequest, @Res({ passthrough: true }) res: HttpResponse): Promise<void> {
    if (req.auth) {
      await this.auth.signOut(req.auth);
    }
    res.setHeader('Set-Cookie', clearedCookie(SESSION_COOKIE, this.config.cookieSecure));
  }
}
